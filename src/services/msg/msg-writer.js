// Outlook MSG writer (MS-OXMSG). Each MSG is converted from the original collected MIME by the same code
// that fills PST items: transport headers, plain and HTML bodies, sender and recipients, byte-identical
// attachments and attached emails, and the SHA-256 of the source message as a named property.
import { writeCfb } from './cfb-writer.js';
import { PT, tag, tagId, tagType } from '../pst/ltp.js';
import { P, NameMap, ATTACH_BY_VALUE, ATTACH_EMBEDDED_MSG } from '../pst/pst-writer.js';
import { mimeToMessage } from '../pst/mime-to-mapi.js';

const PROPATTR_READ_WRITE = 0x6;
const STORE_UNICODE_OK = 0x00040000;
const MSG_BUCKETS = 0x1F;
const X = {
  SubjectPrefix: tag(0x003D, PT.UNICODE),
  NormalizedSubject: tag(0x0E1D, PT.UNICODE),
  Rowid: tag(0x3000, PT.I4),
  StoreSupportMask: tag(0x340D, PT.I4),
};

const hex = (n, width) => n.toString(16).toUpperCase().padStart(width, '0');
const streamName = (t, suffix = '') => `__substg1.0_${hex(tagId(t), 4)}${hex(tagType(t), 4)}${suffix}`;
const fileTime = d => (BigInt(d.getTime()) + 11644473600000n) * 10000n;

// The PST stores a subject with its prefix length in front (MS-PST 2.5.3.1.1); an MSG keeps the plain
// subject, with the prefix and the normalized subject as properties of their own.
function msgProps(props) {
  const out = new Map(props);
  const stored = out.get(P.Subject);
  if (typeof stored === 'string' && stored.charCodeAt(0) === 1 && stored.length >= 2) {
    const subject = stored.slice(2);
    const prefixLength = stored.charCodeAt(1) - 1;
    out.set(P.Subject, subject);
    out.set(X.SubjectPrefix, subject.slice(0, prefixLength));
    out.set(X.NormalizedSubject, subject.slice(prefixLength));
  }
  return out;
}

// The property stream (header + 16-byte entries) and the streams holding variable-length values.
function propertyStreams(props, header) {
  const entries = [];
  const streams = [];
  for (const t of [...props.keys()].sort((a, b) => a - b)) {
    const v = props.get(t);
    const type = tagType(t);
    const e = Buffer.alloc(16);
    e.writeUInt32LE(t, 0);
    e.writeUInt32LE(PROPATTR_READ_WRITE, 4);
    switch (type) {
      case PT.I2: e.writeInt16LE(v | 0, 8); break;
      case PT.I4: case PT.ERROR:
        if (v < 0) e.writeInt32LE(v, 8); else e.writeUInt32LE(v >>> 0, 8);
        break;
      case PT.BOOL: e.writeUInt16LE(v ? 1 : 0, 8); break;
      case PT.R4: e.writeFloatLE(v, 8); break;
      case PT.R8: case PT.APPTIME: e.writeDoubleLE(v, 8); break;
      case PT.CY: case PT.I8: e.writeBigInt64LE(BigInt(v), 8); break;
      case PT.SYSTIME: e.writeBigUInt64LE(fileTime(v), 8); break;
      case PT.UNICODE: {
        const data = Buffer.from(String(v), 'utf16le');
        streams.push({ name: streamName(t), data });
        e.writeUInt32LE(data.length + 2, 8);
        break;
      }
      case PT.STRING8: {
        const data = Buffer.from(String(v), 'latin1');
        streams.push({ name: streamName(t), data });
        e.writeUInt32LE(data.length + 1, 8);
        break;
      }
      case PT.BINARY: case PT.GUID: {
        const data = Buffer.from(v);
        streams.push({ name: streamName(t), data });
        e.writeUInt32LE(data.length, 8);
        break;
      }
      case PT.MV_UNICODE: case PT.MV_BINARY: {
        // A length stream, then one stream per value (strings keep their terminating null).
        const values = v.map(x => (type === PT.MV_UNICODE ? Buffer.from(`${x}\0`, 'utf16le') : Buffer.from(x)));
        const width = type === PT.MV_UNICODE ? 4 : 8;
        const lengths = Buffer.alloc(values.length * width);
        values.forEach((data, i) => {
          lengths.writeUInt32LE(data.length, i * width);
          streams.push({ name: streamName(t, `-${hex(i, 8)}`), data });
        });
        streams.push({ name: streamName(t), data: lengths });
        e.writeUInt32LE(lengths.length, 8);
        break;
      }
      case PT.MV_I4: {
        const data = Buffer.alloc(v.length * 4);
        v.forEach((n, i) => data.writeInt32LE(n | 0, i * 4));
        streams.push({ name: streamName(t), data });
        e.writeUInt32LE(data.length, 8);
        break;
      }
      case PT.OBJECT: e.writeUInt32LE(0xFFFFFFFF, 8); break;
      default:
        throw new Error(`MSG writer: property 0x${hex(t, 8)} has a type it cannot store`);
    }
    entries.push(e);
  }
  return [{ name: '__properties_version1.0', data: Buffer.concat([header, ...entries]) }, ...streams];
}

// A message object's storage entries. kind: 'top' (32-byte header) or 'embedded' (24-byte header).
function messageNodes(spec, kind) {
  const props = msgProps(spec.props);
  if (kind === 'top') props.set(X.StoreSupportMask, STORE_UNICODE_OK);
  const recipients = spec.recipients || [];
  const attachments = spec.attachments || [];
  const header = Buffer.alloc(kind === 'top' ? 32 : 24);
  header.writeUInt32LE(recipients.length, 8);    // next recipient ID
  header.writeUInt32LE(attachments.length, 12);  // next attachment ID
  header.writeUInt32LE(recipients.length, 16);
  header.writeUInt32LE(attachments.length, 20);

  const nodes = propertyStreams(props, header);
  recipients.forEach((r, i) => {
    const rp = new Map(r);
    rp.set(X.Rowid, i);
    nodes.push({ name: `__recip_version1.0_#${hex(i, 8)}`, children: propertyStreams(rp, Buffer.alloc(8)) });
  });
  attachments.forEach((a, i) => {
    const ap = msgProps(a.props);
    ap.set(P.AttachNumber, i);
    const children = [];
    if (a.embedded) {
      ap.set(P.AttachMethod, ATTACH_EMBEDDED_MSG);
      ap.set(P.AttachDataObject, null);
      children.push({ name: streamName(P.AttachDataObject), children: messageNodes(a.embedded, 'embedded') });
    } else {
      ap.set(P.AttachMethod, ATTACH_BY_VALUE);
      ap.set(P.AttachDataBinary, a.data || Buffer.alloc(0));
    }
    children.unshift(...propertyStreams(ap, Buffer.alloc(8)));
    nodes.push({ name: `__attach_version1.0_#${hex(i, 8)}`, children });
  });
  return nodes;
}

function nameIdNodes(names) {
  const s = names.streams(MSG_BUCKETS);
  const nodes = [
    { name: streamName(tag(0x0002, PT.BINARY)), data: s.guids },
    { name: streamName(tag(0x0003, PT.BINARY)), data: s.entries },
    { name: streamName(tag(0x0004, PT.BINARY)), data: s.strings },
  ];
  for (const [b, data] of s.buckets) nodes.push({ name: streamName(tag(0x1000 + b, PT.BINARY)), data });
  return nodes;
}

export function buildMsg(spec, names) {
  return writeCfb({ children: [...messageNodes(spec, 'top'), { name: '__nameid_version1.0', children: nameIdNodes(names) }] });
}

/**
 * raw: the original message bytes. meta: as for PST items ({ readState, flagged, labels, sourceFolder,
 * acquiredAt, internalDate }). Returns { content: Buffer, subject, messageId }.
 */
export async function mimeToMsg(raw, meta = {}) {
  const names = new NameMap();
  const { spec, subject, messageId } = await mimeToMessage(raw, { namedTag: (g, n, t) => names.tag(g, n, t) }, meta);
  return { content: buildMsg(spec, names), subject, messageId };
}
