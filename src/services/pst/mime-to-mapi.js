// Turns an RFC 5322 message (the bytes collected from the server) into the MAPI properties Outlook
// expects of a received message. Nothing is invented: a value the message does not carry is left out.
import crypto from 'crypto';
import path from 'path';
import { simpleParser } from 'mailparser';
import { PT } from './ltp.js';
import { P, MSGFLAG, PS_PUBLIC_STRINGS, PS_INTERNET_HEADERS, ORIGINAL_SHA256_NAME } from './pst-writer.js';

const ONE_OFF_PROVIDER = Buffer.from('812B1FA4BEA310199D6E00DD010F5402', 'hex');
const MAX_EMBED_DEPTH = 5;

function oneOffEntryId(name, address) {
  return Buffer.concat([
    Buffer.alloc(4),
    ONE_OFF_PROVIDER,
    Buffer.from([0x00, 0x00, 0x01, 0x80]),  // version 0; MAPI_UNICODE | MAPI_ONE_OFF_NO_RICH_INFO
    Buffer.from(`${name}\0SMTP\0${address}\0`, 'utf16le'),
  ]);
}
const searchKey = address => Buffer.from(`SMTP:${address.toUpperCase()}\0`, 'latin1');

function addressList(field) {
  const out = [];
  const walk = list => {
    for (const a of list || []) {
      if (a.group) walk(a.group);
      else if (a.address || a.name) out.push({ name: (a.name || '').trim(), address: (a.address || '').trim() });
    }
  };
  for (const obj of [].concat(field || [])) walk(obj.value);
  return out;
}

// The stored subject carries its prefix length (MS-PST section 2.5.3.1.1), so "RE: x" keeps
// "RE: " as its prefix and "x" as the normalized subject.
export function encodeSubject(subject) {
  const m = subject.match(/^([^\s\d:]{1,3}):( *)/);
  const prefix = m ? m[0] : '';
  return { stored: `\u0001${String.fromCharCode(prefix.length + 1)}${subject}`, normalized: subject.slice(prefix.length) };
}

function headerBlock(raw) {
  const crlf = raw.indexOf('\r\n\r\n');
  const lf = raw.indexOf('\n\n');
  const end = crlf !== -1 && (lf === -1 || crlf < lf) ? crlf + 2 : lf !== -1 ? lf + 1 : raw.length;
  const bytes = raw.subarray(0, end);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return bytes.toString('latin1'); }
}

const validDate = d => (d instanceof Date && !isNaN(d.getTime()) ? d : null);
const parseDate = v => (v ? validDate(new Date(v)) : null);

function receivedDate(headers) {
  const received = [].concat(headers.get('received') || [])[0];
  if (typeof received !== 'string') return null;
  const at = received.lastIndexOf(';');
  return at === -1 ? null : parseDate(received.slice(at + 1).trim());
}

function importance(headers) {
  const imp = String(headers.get('importance') || '').toLowerCase();
  if (imp === 'high') return 2;
  if (imp === 'low') return 0;
  const prio = parseInt(String(headers.get('x-priority') || ''), 10);
  if (prio === 1 || prio === 2) return 2;
  if (prio === 4 || prio === 5) return 0;
  return 1;
}

function sensitivity(headers) {
  const s = String(headers.get('sensitivity') || '').toLowerCase();
  return { personal: 1, private: 2, 'company-confidential': 3 }[s] || 0;
}

function recipientProps(r, type, order) {
  const name = r.name || r.address;
  const entryId = oneOffEntryId(name, r.address);
  return new Map([
    [P.RecipientType, type],
    [P.Responsibility, false],
    [P.RecordKey, entryId],
    [P.ObjectType, 6],                       // MAPI_MAILUSER
    [P.EntryId, entryId],
    [P.DisplayName, name],
    [P.AddressType, 'SMTP'],
    [P.EmailAddress, r.address],
    [P.SearchKey, searchKey(r.address)],
    [P.DisplayType, 0],                      // DT_MAILUSER
    [P.SevenBitDisplayName, name],
    [P.SendRichInfo, false],
    [P.SmtpAddress, r.address],
    [P.TransmittableDisplayName, name],
    [P.RecipientOrder, order],
    [P.RecipientDisplayName, name],
    [P.RecipientFlags, 1],                   // recipSendable
  ]);
}

/**
 * raw: the message bytes. writer: the PstWriter (for named properties).
 * meta: { flags, readState: 'read'|'unread'|undefined, labels, sha256, sourceFolder, acquiredAt, internalDate }
 */
export async function mimeToMessage(raw, writer, meta = {}, depth = 0) {
  const parsed = await simpleParser(raw, { keepCidLinks: true, skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true });
  const h = parsed.headers;
  const props = new Map();
  const now = new Date();

  props.set(P.MessageClass, 'IPM.Note');
  const subject = typeof parsed.subject === 'string' ? parsed.subject : '';
  const subj = encodeSubject(subject);
  props.set(P.Subject, subj.stored);
  props.set(P.ConversationTopic, subj.normalized);

  const dateHeader = validDate(h.get('date'));
  const delivered = parseDate(meta.internalDate) || receivedDate(h) || dateHeader;
  if (dateHeader) props.set(P.ClientSubmitTime, dateHeader);
  if (delivered) props.set(P.MessageDeliveryTime, delivered);
  const stamped = parseDate(meta.acquiredAt) || now;
  props.set(P.CreationTime, stamped);
  props.set(P.LastModificationTime, stamped);

  const from = addressList(parsed.from)[0] || addressList(h.get('sender'))[0];
  if (from) {
    const name = from.name || from.address;
    const entryId = oneOffEntryId(name, from.address);
    for (const [tName, tAddr, tType, tEntry, tKey, tSmtp] of [
      [P.SenderName, P.SenderEmailAddress, P.SenderAddressType, P.SenderEntryId, P.SenderSearchKey, P.SenderSmtpAddress],
      [P.SentRepresentingName, P.SentRepresentingEmailAddress, P.SentRepresentingAddressType, P.SentRepresentingEntryId, P.SentRepresentingSearchKey, P.SentRepresentingSmtpAddress],
    ]) {
      props.set(tName, name);
      props.set(tAddr, from.address);
      props.set(tType, 'SMTP');
      props.set(tEntry, entryId);
      props.set(tKey, searchKey(from.address));
      props.set(tSmtp, from.address);
    }
  }

  const recipients = [];
  const display = {};
  for (const [field, type, tDisplay] of [['to', 1, P.DisplayTo], ['cc', 2, P.DisplayCc], ['bcc', 3, P.DisplayBcc]]) {
    const list = addressList(parsed[field]);
    list.forEach(r => recipients.push(recipientProps(r, type, recipients.length)));
    display[tDisplay] = list.map(r => r.name || r.address).join('; ');
  }
  for (const [t, v] of Object.entries(display)) if (v) props.set(Number(t), v);

  props.set(P.TransportMessageHeaders, headerBlock(raw));
  if (parsed.messageId) props.set(P.InternetMessageId, parsed.messageId);
  if (parsed.inReplyTo) props.set(P.InReplyToId, parsed.inReplyTo);
  if (parsed.references) props.set(P.InternetReferences, [].concat(parsed.references).join(' '));
  props.set(P.Importance, importance(h));
  props.set(P.Sensitivity, sensitivity(h));
  props.set(P.Priority, 0);

  if (typeof parsed.text === 'string' && parsed.text) props.set(P.Body, parsed.text);
  if (typeof parsed.html === 'string' && parsed.html) {
    props.set(P.Html, Buffer.from(parsed.html, 'utf8'));
    props.set(P.InternetCodepage, 65001);
  }
  props.set(P.NativeBody, typeof parsed.html === 'string' && parsed.html ? 3 : 1);

  const attachments = [];
  for (const att of parsed.attachments || []) {
    const isMessage = /^message\/rfc822$/i.test(att.contentType || '');
    let embedded = null;
    if (isMessage && depth < MAX_EMBED_DEPTH) {
      try { embedded = await mimeToMessage(att.content, writer, {}, depth + 1); } catch { embedded = null; }
    }
    const filename = att.filename || (embedded ? `${(embedded.subject || 'message').slice(0, 60)}.eml` : `attachment${attachments.length + 1}`);
    const hidden = !!(att.related && att.cid && typeof parsed.html === 'string' && parsed.html.includes(`cid:${att.cid}`));
    const ap = new Map([
      [P.AttachSize, att.content.length],
      [P.AttachFilename, filename],
      [P.AttachLongFilename, filename],
      [P.DisplayName, filename],
      [P.AttachExtension, path.extname(filename)],
      [P.AttachMimeTag, att.contentType || 'application/octet-stream'],
      [P.RenderingPosition, 0xFFFFFFFF],
      [P.CreationTime, stamped],
      [P.LastModificationTime, stamped],
      [P.AttachmentHidden, hidden],
    ]);
    if (att.cid) ap.set(P.AttachContentId, att.cid);
    if (hidden) ap.set(P.AttachFlags, 4);   // ATT_MHTML_REF
    attachments.push(embedded
      ? { props: ap, embedded: embedded.spec, embeddedSize: att.content.length }
      : { props: ap, data: att.content });
  }

  let flags = MSGFLAG.UNMODIFIED;
  if (meta.readState !== 'unread') flags |= MSGFLAG.READ;
  if (attachments.length) flags |= MSGFLAG.HASATTACH;
  props.set(P.MessageFlags, flags);
  props.set(P.MessageStatus, 0);
  props.set(P.MessageSize, Math.min(raw.length, 0x7FFFFFFF));
  props.set(P.SearchKey, crypto.createHash('sha256').update(raw).digest().subarray(0, 16));
  if (meta.flagged) props.set(P.FlagStatus, 2);

  if (depth === 0) {
    if (meta.labels?.length) props.set(writer.namedTag(PS_PUBLIC_STRINGS, 'Keywords', PT.MV_UNICODE), meta.labels.map(String));
    const sha256 = crypto.createHash('sha256').update(raw).digest('hex');
    props.set(writer.namedTag(PS_INTERNET_HEADERS, ORIGINAL_SHA256_NAME, PT.UNICODE), sha256);
    if (meta.sourceFolder) props.set(writer.namedTag(PS_INTERNET_HEADERS, 'x-sherlockmail-source-folder', PT.UNICODE), meta.sourceFolder);
    if (meta.acquiredAt) props.set(writer.namedTag(PS_INTERNET_HEADERS, 'x-sherlockmail-acquired', PT.UNICODE), String(meta.acquiredAt));
  }

  return { spec: { props, recipients, attachments }, subject, messageId: parsed.messageId || '' };
}
