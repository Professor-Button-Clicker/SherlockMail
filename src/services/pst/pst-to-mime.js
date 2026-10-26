// Rebuilds an RFC 5322 message from a PST item's MAPI properties. A PST does not keep the MIME it was
// made from, so the result is a reconstruction and says so in an X-SherlockMail-Reconstructed header.
// Where the PST kept the original transport headers they are reused as-is (apart from the
// Content-* headers, which have to describe the rebuilt body).
import crypto from 'crypto';
import { PT, tag } from './ltp.js';

const T = (id, type) => tag(id, type);
const str = (props, id) => props.get(T(id, PT.UNICODE)) ?? props.get(T(id, PT.STRING8));
const bin = (props, id) => props.get(T(id, PT.BINARY));

// MS-OXRTFCP: the dictionary every compressed RTF stream starts with.
const RTF_PREBUF = '{\\rtf1\\ansi\\mac\\deff0\\deftab720{\\fonttbl;}{\\f0\\fnil \\froman \\fswiss \\fmodern \\fscript \\fdecor MS Sans SerifSymbolArialTimes New RomanCourier{\\colortbl\\red0\\green0\\blue0\r\n\\par \\pard\\plain\\f0\\fs20\\b\\i\\u\\tab\\tx';

export function decompressRtf(buf) {
  if (!buf || buf.length < 16) return null;
  const rawSize = buf.readUInt32LE(4);
  const kind = buf.readUInt32LE(8);
  if (kind === 0x414C454D) return buf.subarray(16, 16 + rawSize);   // "MELA": stored uncompressed
  if (kind !== 0x75465A4C) return null;                              // not "LZFu"
  const dict = Buffer.alloc(4096);
  dict.write(RTF_PREBUF, 0, 'latin1');
  let w = RTF_PREBUF.length;
  const out = Buffer.alloc(rawSize);
  let n = 0;
  let i = 16;
  while (i < buf.length && n < rawSize) {
    const control = buf[i++];
    for (let bit = 0; bit < 8 && n < rawSize; bit++) {
      if (control & (1 << bit)) {
        if (i + 1 >= buf.length) return out.subarray(0, n);
        const ref = (buf[i] << 8) | buf[i + 1];
        i += 2;
        const offset = ref >> 4;
        const length = (ref & 0x0F) + 2;
        if (offset === w) return out.subarray(0, n);                // end marker
        for (let k = 0; k < length && n < rawSize; k++) {
          const c = dict[(offset + k) & 0xFFF];
          out[n++] = c;
          dict[w] = c;
          w = (w + 1) & 0xFFF;
        }
      } else {
        if (i >= buf.length) return out.subarray(0, n);
        const c = buf[i++];
        out[n++] = c;
        dict[w] = c;
        w = (w + 1) & 0xFFF;
      }
    }
  }
  return out.subarray(0, n);
}

// Strips the prefix-length marker a PST may store in front of a subject (MS-PST 2.5.3.1.1).
export function storedSubject(s) {
  if (typeof s !== 'string') return '';
  return s.charCodeAt(0) === 1 && s.length >= 2 ? s.slice(2) : s;
}

const encodeWord = s => (/^[\x20-\x7E]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
const quoteName = s => (/^[\w .'-]*$/.test(s) ? s : `"${s.replace(/["\\]/g, '\\$&')}"`);
const rfc2822Date = d => {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = n => String(n).padStart(2, '0');
  return `${days[d.getUTCDay()]}, ${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
};
const wrapBase64 = buf => buf.toString('base64').replace(/.{76}(?=.)/g, '$&\r\n');
const qpEncode = text => Buffer.from(text, 'utf8').toString('latin1').split(/\r?\n/).map(line => {
  let out = '', len = 0;
  for (const ch of line) {
    const c = ch.charCodeAt(0);
    const enc = (c === 61 || c > 126 || (c < 32 && c !== 9)) ? `=${c.toString(16).toUpperCase().padStart(2, '0')}` : ch;
    if (len + enc.length > 75) { out += '=\r\n'; len = 0; }
    out += enc; len += enc.length;
  }
  return out.replace(/[ \t]$/, m => `=${m.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}).join('\r\n');

function address(name, email) {
  if (!email) return name ? encodeWord(name) : '';
  return name && name !== email ? `${quoteName(encodeWord(name))} <${email}>` : `<${email}>`;
}

function recipientAddress(r) {
  const smtp = r.get(T(0x39FE, PT.UNICODE)) ?? r.get(T(0x39FE, PT.STRING8));
  const type = str(r, 0x3002);
  const email = smtp || (/^smtp$/i.test(type || 'SMTP') ? str(r, 0x3003) : null) || str(r, 0x3003) || '';
  return { name: str(r, 0x3001) || '', email, type: r.get(T(0x0C15, PT.I4)) ?? 1 };
}

function textFromHtml(html) {
  return html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();
}

function htmlString(props) {
  const html = bin(props, 0x1013) ?? str(props, 0x1013);
  if (html === undefined || html === null) return null;
  if (typeof html === 'string') return html;
  const cp = props.get(T(0x3FDE, PT.I4));
  const label = { 65001: 'utf-8', 1252: 'windows-1252', 28591: 'iso-8859-1', 20127: 'us-ascii', 1200: 'utf-16le', 936: 'gbk', 932: 'shift_jis', 949: 'euc-kr', 950: 'big5', 1251: 'windows-1251', 1250: 'windows-1250' }[cp];
  try { return new TextDecoder(label || 'utf-8').decode(html); } catch { return html.toString('utf8'); }
}

// Header lines from the stored transport headers, minus the Content-* and MIME-Version headers.
function keptHeaders(transport) {
  const unfolded = transport.replace(/\r?\n(?=[ \t])/g, '\u0000').split(/\r?\n/).filter(Boolean);
  return unfolded.filter(l => !/^(content-[\w-]+|mime-version)\s*:/i.test(l)).map(l => l.replace(/\u0000/g, '\r\n'));
}

function boundary() { return `----=_SherlockMail_${crypto.randomBytes(12).toString('hex')}`; }

function bodyParts(props) {
  const text = str(props, 0x1000);
  const html = htmlString(props);
  const rtf = decompressRtf(bin(props, 0x1009));
  const parts = [];
  const plain = typeof text === 'string' ? text : html ? textFromHtml(html) : null;
  if (plain !== null) parts.push({ headers: ['Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable'], body: qpEncode(plain) });
  if (html) parts.push({ headers: ['Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable'], body: qpEncode(html) });
  else if (rtf) parts.push({ headers: ['Content-Type: text/rtf', 'Content-Transfer-Encoding: base64'], body: wrapBase64(Buffer.from(rtf)) });
  if (!parts.length) parts.push({ headers: ['Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 7bit'], body: '' });
  return parts;
}

const renderPart = p => `${p.headers.join('\r\n')}\r\n\r\n${p.body}`;
const multipart = (type, parts) => {
  const b = boundary();
  return { headers: [`Content-Type: multipart/${type}; boundary="${b}"`], body: `${parts.map(p => `--${b}\r\n${renderPart(p)}\r\n`).join('')}--${b}--` };
};

function attachmentPart(att, notes) {
  const ap = att.props;
  const name = str(ap, 0x3707) || str(ap, 0x3704) || str(ap, 0x3001) || 'attachment';
  if (att.embedded) {
    return { headers: ['Content-Type: message/rfc822', `Content-Disposition: attachment; filename="${encodeWord(name.endsWith('.eml') ? name : `${name}.eml`)}"`], body: buildMime(att.embedded, { notes, nested: true }) };
  }
  const data = ap.get(T(0x3701, PT.BINARY));
  if (!Buffer.isBuffer(data)) {
    notes.push(`attachment "${name}" has no stored data (method ${ap.get(T(0x3705, PT.I4)) ?? 'unknown'}${att.error ? `: ${att.error}` : ''})`);
    return null;
  }
  const mime = str(ap, 0x370E) || 'application/octet-stream';
  const cid = str(ap, 0x3712);
  const inline = !!cid && ap.get(T(0x7FFE, PT.BOOL)) === true;
  const headers = [`Content-Type: ${mime}; name="${encodeWord(name)}"`, 'Content-Transfer-Encoding: base64', `Content-Disposition: ${inline ? 'inline' : 'attachment'}; filename="${encodeWord(name)}"`];
  if (cid) headers.push(`Content-ID: <${cid.replace(/^<|>$/g, '')}>`);
  return { headers, body: wrapBase64(data), inline };
}

/**
 * msg: { props, recipients, attachments } from PstReader. Returns the MIME text (CRLF line endings).
 * options.provenance: one line describing where the item came from; options.notes collects what could not be carried over.
 */
export function buildMime(msg, { provenance = '', notes = [], nested = false } = {}) {
  const p = msg.props;
  const transport = str(p, 0x007D);
  const headers = [];
  if (transport && transport.trim()) {
    headers.push(...keptHeaders(transport));
  } else {
    const fromEmail = str(p, 0x5D01) || str(p, 0x0C1F) || str(p, 0x0065) || '';
    const fromName = str(p, 0x0C1A) || str(p, 0x0042) || '';
    if (fromEmail || fromName) headers.push(`From: ${address(fromName, fromEmail)}`);
    const lists = { 1: [], 2: [], 3: [] };
    for (const r of msg.recipients) { const a = recipientAddress(r); (lists[a.type] || lists[1]).push(address(a.name, a.email)); }
    if (lists[1].length) headers.push(`To: ${lists[1].join(', ')}`);
    if (lists[2].length) headers.push(`Cc: ${lists[2].join(', ')}`);
    if (lists[3].length) headers.push(`Bcc: ${lists[3].join(', ')}`);
    headers.push(`Subject: ${encodeWord(storedSubject(str(p, 0x0037) || ''))}`);
    const date = p.get(T(0x0039, PT.SYSTIME)) || p.get(T(0x0E06, PT.SYSTIME));
    if (date) headers.push(`Date: ${rfc2822Date(date)}`);
    const mid = str(p, 0x1035);
    if (mid) headers.push(`Message-ID: ${mid}`);
    const irt = str(p, 0x1042);
    if (irt) headers.push(`In-Reply-To: ${irt}`);
    const refs = str(p, 0x1039);
    if (refs) headers.push(`References: ${refs}`);
  }
  if (!nested) headers.push(`X-SherlockMail-Reconstructed: rebuilt from Outlook PST properties; not the original MIME${provenance ? ` (${provenance})` : ''}`);

  const bodies = bodyParts(p);
  let content = bodies.length > 1 ? multipart('alternative', bodies) : bodies[0];
  const atts = msg.attachments.map(a => attachmentPart(a, notes)).filter(Boolean);
  const inline = atts.filter(a => a.inline);
  const regular = atts.filter(a => !a.inline);
  if (inline.length) content = multipart('related', [content, ...inline]);
  if (regular.length) content = multipart('mixed', [content, ...regular]);
  return [...headers, 'MIME-Version: 1.0', ...content.headers].join('\r\n') + '\r\n\r\n' + content.body + '\r\n';
}
