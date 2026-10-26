// Reads Outlook PST files (Unicode and ANSI; unencoded, permute- or cyclic-encoded) following MS-PST:
// the node and block B-trees, data and subnode trees, heaps, property and table contexts, and the
// folder, message, recipient and attachment objects on top of them. The file is opened read-only.
import fs from 'fs';
import { decodeBlock } from './crypt.js';
import { pstCrc } from './crc.js';
import { PT, tag } from './ltp.js';

const PAGE = 512;
const NID_MESSAGE_STORE = 0x21;
const NID_NAME_TO_ID_MAP = 0x61;
const NID_ROOT_FOLDER = 0x122;
const NID_RECIPIENT_TABLE = 0x692;
const NID_ATTACHMENT_TABLE = 0x671;
const NID_TYPE_NORMAL_FOLDER = 0x02;
const PAGE_CACHE = 2048;

const FIXED = { [PT.I2]: 2, [PT.I4]: 4, [PT.R4]: 4, [PT.ERROR]: 4, [PT.BOOL]: 1, [PT.R8]: 8, [PT.CY]: 8, [PT.APPTIME]: 8, [PT.I8]: 8, [PT.SYSTIME]: 8 };
const MV_FIXED = { [PT.I2]: 2, [PT.I4]: 4, [PT.R4]: 4, [PT.R8]: 8, [PT.CY]: 8, [PT.APPTIME]: 8, [PT.I8]: 8, [PT.SYSTIME]: 8, [PT.GUID]: 16 };
const FILETIME_EPOCH = 11644473600000n;
const cp1252 = new TextDecoder('windows-1252');

export class PstFormatError extends Error {}

function filetimeToDate(ft) {
  if (ft === 0n) return null;
  const ms = ft / 10000n - FILETIME_EPOCH;
  const d = new Date(Number(ms));
  return isNaN(d.getTime()) ? null : d;
}

export function decodeValue(type, buf) {
  const base = type & ~0x1000;
  if (type & 0x1000) {
    if (MV_FIXED[base]) {
      const out = [];
      for (let o = 0; o + MV_FIXED[base] <= buf.length; o += MV_FIXED[base]) out.push(decodeValue(base, buf.subarray(o, o + MV_FIXED[base])));
      return out;
    }
    if (buf.length < 4) return [];
    const count = buf.readUInt32LE(0);
    const out = [];
    for (let k = 0; k < count && 4 + k * 4 + 4 <= buf.length; k++) {
      const start = buf.readUInt32LE(4 + k * 4);
      const end = k + 1 < count ? buf.readUInt32LE(8 + k * 4) : buf.length;
      out.push(decodeValue(base, buf.subarray(start, end)));
    }
    return out;
  }
  switch (type) {
    case PT.I2: return buf.readInt16LE(0);
    case PT.I4: return buf.readInt32LE(0);
    case PT.ERROR: return buf.readUInt32LE(0);
    case PT.R4: return buf.readFloatLE(0);
    case PT.BOOL: return buf[0] !== 0;
    case PT.R8: case PT.APPTIME: return buf.readDoubleLE(0);
    case PT.CY: case PT.I8: return Number(buf.readBigInt64LE(0));
    case PT.SYSTIME: return filetimeToDate(buf.readBigUInt64LE(0));
    case PT.UNICODE: return buf.toString('utf16le', 0, buf.length & ~1).replace(/\0+$/, '');
    case PT.STRING8: return cp1252.decode(buf).replace(/\0+$/, '');
    case PT.OBJECT: return buf.length >= 8 ? { nid: buf.readUInt32LE(0), size: buf.readUInt32LE(4) } : null;
    default: return Buffer.from(buf);             // binary, GUID and anything unrecognised: the raw bytes
  }
}

export class PstReader {
  constructor(filePath) {
    this.filePath = filePath;
    this.fd = fs.openSync(filePath, 'r');
    this.pageCache = new Map();
    try {
      this._readHeader();
    } catch (err) {
      this.close();
      throw err;
    }
  }

  close() {
    if (this.fd !== null) { fs.closeSync(this.fd); this.fd = null; }
  }

  _read(ib, size) {
    const buf = Buffer.alloc(size);
    const n = fs.readSync(this.fd, buf, 0, size, ib);
    if (n !== size) throw new PstFormatError(`Truncated PST: wanted ${size} bytes at offset ${ib}, file ends first`);
    return buf;
  }

  _readHeader() {
    const h = this._read(0, 564);
    const client = h.toString('latin1', 8, 10);
    if (h.toString('latin1', 0, 4) !== '!BDN' || (client !== 'SM' && client !== 'SO')) throw new PstFormatError('Not a PST file (bad magic number)');
    this.isOst = client === 'SO';
    const ver = h.readUInt16LE(10);
    // Version 36 is the 4 KB-page layout of Outlook 2013+ offline (.ost) caches, which MS-PST does not document.
    if (ver === 36) throw new PstFormatError('This is an Outlook 2013+ offline cache (OST, 4 KB pages), not a PST; export it to PST from Outlook first');
    this.unicode = ver >= 23;
    if (!this.unicode && ver !== 14 && ver !== 15) throw new PstFormatError(`Unsupported PST version ${ver}`);
    if (this.unicode) {
      if (h.readUInt32LE(4) !== pstCrc(h, 8, 8 + 471)) throw new PstFormatError('PST header checksum mismatch: the file is damaged');
      this.size = Number(h.readBigUInt64LE(184));
      this.nbtRoot = { bid: Number(h.readBigUInt64LE(216)), ib: Number(h.readBigUInt64LE(224)) };
      this.bbtRoot = { bid: Number(h.readBigUInt64LE(232)), ib: Number(h.readBigUInt64LE(240)) };
      this.crypt = h[513];
    } else {
      this.size = h.readUInt32LE(168);
      this.nbtRoot = { bid: h.readUInt32LE(184), ib: h.readUInt32LE(188) };
      this.bbtRoot = { bid: h.readUInt32LE(192), ib: h.readUInt32LE(196) };
      this.crypt = h[461];
    }
    this.version = ver;
    this.idSize = this.unicode ? 8 : 4;
    this.blockTrailer = this.unicode ? 16 : 12;
    this.maxBlockData = 8192 - this.blockTrailer;
  }

  _id(buf, o) { return this.unicode ? Number(buf.readBigUInt64LE(o)) : buf.readUInt32LE(o); }

  // NIDs are 32-bit; in Unicode files they sit in 8-byte fields whose upper half Outlook does not
  // always zero, so only the low four bytes are read.
  _nid(buf, o) { return buf.readUInt32LE(o); }

  // ── B-trees ──

  _page(ib) {
    let p = this.pageCache.get(ib);
    if (p) return p;
    p = this._read(ib, PAGE);
    const t = this.unicode ? 496 : 500;
    const crcAt = this.unicode ? 500 : 508;
    if (p.readUInt32LE(crcAt) !== pstCrc(p, 0, this.unicode ? 496 : 500)) throw new PstFormatError(`B-tree page at offset ${ib} fails its checksum`);
    p.ptype = p[t];
    const meta = this.unicode ? 488 : 496;
    p.cEnt = p[meta]; p.cbEnt = p[meta + 2]; p.cLevel = p[meta + 3];
    if (this.pageCache.size >= PAGE_CACHE) this.pageCache.delete(this.pageCache.keys().next().value);
    this.pageCache.set(ib, p);
    return p;
  }

  // Leaf entry offset for key, or null.
  _btFind(root, key, readKey = (p, o) => this._id(p, o)) {
    let page = this._page(root.ib);
    for (let depth = 0; depth < 16; depth++) {
      if (page.cLevel === 0) {
        let lo = 0, hi = page.cEnt - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const k = readKey(page, mid * page.cbEnt);
          if (k === key) return { page, o: mid * page.cbEnt };
          if (k < key) lo = mid + 1; else hi = mid - 1;
        }
        return null;
      }
      let pick = -1;
      for (let i = 0; i < page.cEnt; i++) {
        if (readKey(page, i * page.cbEnt) <= key) pick = i; else break;
      }
      if (pick < 0) return null;
      page = this._page(this._id(page, pick * page.cbEnt + 2 * this.idSize));
    }
    throw new PstFormatError('B-tree deeper than the format allows');
  }

  node(nid) {
    const hit = this._btFind(this.nbtRoot, nid, (p, o) => this._nid(p, o));
    if (!hit) return null;
    const { page, o } = hit;
    const s = this.idSize;
    return { nid, bidData: this._id(page, o + s), bidSub: this._id(page, o + 2 * s), nidParent: page.readUInt32LE(o + 3 * s) };
  }

  _blockRef(bid) {
    const key = bid - (bid % 2);                   // the lowest BID bit is reserved and ignored
    const hit = this._btFind(this.bbtRoot, key);
    if (!hit) throw new PstFormatError(`Block 0x${bid.toString(16)} is not in the block index`);
    const { page, o } = hit;
    return { ib: this._id(page, o + this.idSize), cb: page.readUInt16LE(o + 2 * this.idSize) };
  }

  _block(bid) {
    const { ib, cb } = this._blockRef(bid);
    const data = this._read(ib, cb);
    const trailer = this._read(ib + Math.ceil((cb + this.blockTrailer) / 64) * 64 - this.blockTrailer, this.blockTrailer);
    const crc = trailer.readUInt32LE(this.unicode ? 4 : 8);
    if (crc !== pstCrc(data)) throw new PstFormatError(`Block 0x${bid.toString(16)} fails its checksum`);
    return data;
  }

  // A node's data stream as its data blocks (decoded), in order.
  dataBlocks(bid) {
    if (!bid) return [];
    const internal = (bid & 2) !== 0;
    const data = this._block(bid);
    if (!internal) return [decodeBlock(data, this.crypt, bid)];
    if (data[0] !== 1) throw new PstFormatError(`Unexpected internal block type ${data[0]}`);
    const count = data.readUInt16LE(2);
    const out = [];
    for (let i = 0; i < count; i++) out.push(...this.dataBlocks(this._id(data, 8 + i * this.idSize)));
    return out;
  }

  data(bid) { return Buffer.concat(this.dataBlocks(bid)); }

  // The subnodes of a node: Map(nid -> { bidData, bidSub }).
  subnodes(bidSub, into = new Map()) {
    if (!bidSub) return into;
    const b = this._block(bidSub);
    if (b[0] !== 2) throw new PstFormatError('Bad subnode block');
    const count = b.readUInt16LE(2);
    const start = this.unicode ? 8 : 4;
    const s = this.idSize;
    if (b[1] === 0) {
      for (let i = 0; i < count; i++) {
        const o = start + i * 3 * s;
        into.set(this._nid(b, o), { bidData: this._id(b, o + s), bidSub: this._id(b, o + 2 * s) });
      }
    } else {
      for (let i = 0; i < count; i++) this.subnodes(this._id(b, start + i * 2 * s + s), into);
    }
    return into;
  }

  // ── LTP ──

  // An LTP object (PC or TC) stored as node data, with the subnodes its large values live in.
  ltp(bidData, bidSub) {
    const blocks = this.dataBlocks(bidData);
    if (!blocks.length || blocks[0][2] !== 0xEC) throw new PstFormatError('Not a heap-on-node');
    return new Ltp(this, blocks, this.subnodes(bidSub));
  }

  ltpNode(nid) {
    const n = this.node(nid);
    if (!n) throw new PstFormatError(`Node 0x${nid.toString(16)} not found`);
    return this.ltp(n.bidData, n.bidSub);
  }

  // ── Messaging ──

  store() { return this.ltpNode(NID_MESSAGE_STORE).properties(); }

  // Named property IDs (0x8000+) -> { guid, name | id }.
  namedProperties() {
    if (this._named) return this._named;
    const map = new Map();
    try {
      const props = this.ltpNode(NID_NAME_TO_ID_MAP).properties();
      const guids = props.get(tag(0x0002, PT.BINARY)) || Buffer.alloc(0);
      const entries = props.get(tag(0x0003, PT.BINARY)) || Buffer.alloc(0);
      const strings = props.get(tag(0x0004, PT.BINARY)) || Buffer.alloc(0);
      const guidAt = k => {
        if (k === 1) return '00020328-0000-0000-C000-000000000046';
        if (k === 2) return '00020329-0000-0000-C000-000000000046';
        const g = guids.subarray((k - 3) * 16, (k - 2) * 16);
        if (g.length < 16) return null;
        const hex = b => b.toString('hex').toUpperCase();
        return `${hex(Buffer.from(g.subarray(0, 4)).reverse())}-${hex(Buffer.from(g.subarray(4, 6)).reverse())}-${hex(Buffer.from(g.subarray(6, 8)).reverse())}-${hex(g.subarray(8, 10))}-${hex(g.subarray(10, 16))}`;
      };
      for (let o = 0; o + 8 <= entries.length; o += 8) {
        const dw = entries.readUInt32LE(o);
        const gn = entries.readUInt16LE(o + 4);
        const idx = entries.readUInt16LE(o + 6);
        const entry = { guid: guidAt(gn >> 1) };
        if (gn & 1) {
          const len = strings.readUInt32LE(dw);
          entry.name = strings.toString('utf16le', dw + 4, dw + 4 + len);
        } else {
          entry.id = dw;
        }
        map.set(0x8000 + idx, entry);
      }
    } catch { /* a missing or damaged map only loses the names of named properties */ }
    this._named = map;
    return map;
  }

  // Walks the folder tree from the root. Search folders and the search root hold links to items
  // stored elsewhere, so they are skipped to avoid importing the same message twice.
  *folders() {
    const store = this.store();
    const finder = entryIdNid(store.get(tag(0x35E7, PT.BINARY)));
    const ipm = entryIdNid(store.get(tag(0x35E0, PT.BINARY)));
    const seen = new Set();
    const self = this;
    function* walk(nid, trail) {
      if (seen.has(nid) || seen.size > 1e6) return;
      seen.add(nid);
      let props;
      try { props = self.ltpNode(nid).properties(); } catch (err) { yield { nid, path: trail, error: err.message }; return; }
      const name = String(props.get(tag(0x3001, PT.UNICODE)) ?? props.get(tag(0x3001, PT.STRING8)) ?? '');
      const here = nid === NID_ROOT_FOLDER || nid === ipm ? trail : [...trail, name];
      yield { nid, path: here, name, props, isRoot: nid === NID_ROOT_FOLDER, isIpmSubtree: nid === ipm };
      let children = [];
      try {
        const hierarchy = self.node((nid & ~0x1F) | 0x0D);
        if (hierarchy) children = self.ltp(hierarchy.bidData, hierarchy.bidSub).rows().map(r => r.rowId);
      } catch (err) { yield { nid, path: here, error: `hierarchy table: ${err.message}` }; }
      for (const child of children) {
        if ((child & 0x1F) !== NID_TYPE_NORMAL_FOLDER || child === finder) continue;
        yield* walk(child, here);
      }
    }
    yield* walk(NID_ROOT_FOLDER, []);
  }

  // NIDs of the messages listed in a folder's contents table.
  folderMessages(folderNid) {
    const contents = this.node((folderNid & ~0x1F) | 0x0E);
    if (!contents) return [];
    return this.ltp(contents.bidData, contents.bidSub).rows().map(r => r.rowId);
  }

  message(nid) {
    const n = this.node(nid);
    if (!n) throw new PstFormatError(`Message node 0x${nid.toString(16)} not found`);
    return this._message(n.bidData, n.bidSub);
  }

  _message(bidData, bidSub) {
    const sub = this.subnodes(bidSub);
    const pc = this.ltp(bidData, bidSub);
    const props = pc.properties();
    const table = (nid) => {
      const s = sub.get(nid);
      return s ? this.ltp(s.bidData, s.bidSub).rows() : [];
    };
    const recipients = table(NID_RECIPIENT_TABLE).map(r => r.values);
    const attachments = table(NID_ATTACHMENT_TABLE).map(row => {
      const s = sub.get(row.rowId);
      if (!s) return { props: row.values, error: 'attachment object missing' };
      try {
        const apc = this.ltp(s.bidData, s.bidSub);
        const ap = apc.properties();
        const att = { props: ap };
        const obj = ap.get(tag(0x3701, PT.OBJECT));
        if (obj && ap.get(tag(0x3705, PT.I4)) === 5) {
          const es = apc.subnodes.get(obj.nid);
          if (es) att.embedded = this._message(es.bidData, es.bidSub);
          else att.error = 'embedded message missing';
        }
        return att;
      } catch (err) {
        return { props: row.values, error: err.message };
      }
    });
    return { props, recipients, attachments };
  }
}

// The NID at the end of a PST-internal ENTRYID.
function entryIdNid(eid) {
  return Buffer.isBuffer(eid) && eid.length >= 24 ? eid.readUInt32LE(20) : null;
}

class Ltp {
  constructor(reader, blocks, subnodes) {
    this.r = reader;
    this.blocks = blocks;
    this.subnodes = subnodes;
    this.clientSig = blocks[0][3];
    this.userRoot = blocks[0].readUInt32LE(4);
  }

  item(hid) {
    if (!hid) return Buffer.alloc(0);
    const b = this.blocks[hid >>> 16];
    const index = (hid >>> 5) & 0x7FF;
    if (!b || !index) throw new PstFormatError(`Bad heap reference 0x${hid.toString(16)}`);
    const map = b.readUInt16LE(0);
    const count = b.readUInt16LE(map);
    if (index > count) throw new PstFormatError(`Heap reference 0x${hid.toString(16)} out of range`);
    return b.subarray(b.readUInt16LE(map + 4 + (index - 1) * 2), b.readUInt16LE(map + 4 + index * 2));
  }

  // A heap item, or a subnode's data for values too large for the heap.
  hnid(h) {
    if ((h & 0x1F) === 0) return this.item(h);
    const s = this.subnodes.get(h);
    if (!s) throw new PstFormatError(`Value subnode 0x${h.toString(16)} missing`);
    return this.r.data(s.bidData);
  }

  bth(hid) {
    const h = this.item(hid);
    if (h[0] !== 0xB5) throw new PstFormatError('Bad BTH header');
    const cbKey = h[1], cbEnt = h[2], levels = h[3], root = h.readUInt32LE(4);
    const out = [];
    const walk = (itemHid, level) => {
      if (!itemHid) return;
      const buf = this.item(itemHid);
      if (level > 0) {
        for (let o = 0; o + cbKey + 4 <= buf.length; o += cbKey + 4) walk(buf.readUInt32LE(o + cbKey), level - 1);
      } else {
        for (let o = 0; o + cbKey + cbEnt <= buf.length; o += cbKey + cbEnt) out.push({ key: buf.subarray(o, o + cbKey), data: buf.subarray(o + cbKey, o + cbKey + cbEnt) });
      }
    };
    walk(root, levels);
    return out;
  }

  // Property context: Map(tag -> value).
  properties() {
    if (this.clientSig !== 0xBC) throw new PstFormatError('Not a property context');
    const props = new Map();
    for (const { key, data } of this.bth(this.userRoot)) {
      const id = key.readUInt16LE(0);
      const type = data.readUInt16LE(0);
      const dw = data.readUInt32LE(2);
      try {
        let value;
        if (!(type & 0x1000) && FIXED[type] && FIXED[type] <= 4) {
          const b = Buffer.alloc(4); b.writeUInt32LE(dw >>> 0); value = decodeValue(type, b);
        } else {
          value = decodeValue(type, this.hnid(dw));
        }
        props.set(tag(id, type), value);
      } catch { /* an unreadable value is left out rather than guessed */ }
    }
    return props;
  }

  // Table context rows: [{ rowId, values: Map(tag -> value) }].
  rows() {
    if (this.clientSig !== 0x7C) throw new PstFormatError('Not a table context');
    const info = this.item(this.userRoot);
    const cCols = info[1];
    const rowSize = info.readUInt16LE(8);
    const cebStart = info.readUInt16LE(6);
    const cols = [];
    for (let i = 0; i < cCols; i++) {
      const o = 22 + i * 8;
      cols.push({ tag: info.readUInt32LE(o), ib: info.readUInt16LE(o + 4), cb: info[o + 6], bit: info[o + 7] });
    }
    const index = this.bth(info.readUInt32LE(10)).map(e => ({ id: e.key.readUInt32LE(0), i: e.data.length >= 4 ? e.data.readUInt32LE(0) : e.data.readUInt16LE(0) }));
    const hnidRows = info.readUInt32LE(14);
    if (!hnidRows || !index.length) return [];
    let blocks;
    if ((hnidRows & 0x1F) === 0) blocks = [this.item(hnidRows)];
    else {
      const s = this.subnodes.get(hnidRows);
      if (!s) throw new PstFormatError('Table rows subnode missing');
      blocks = this.r.dataBlocks(s.bidData);
    }
    const perBlock = blocks.length > 1 ? Math.floor(this.r.maxBlockData / rowSize) : Infinity;
    const rows = [];
    for (const { id, i } of index.sort((a, b) => a.i - b.i)) {
      const block = blocks[perBlock === Infinity ? 0 : Math.floor(i / perBlock)];
      const base = (perBlock === Infinity ? i : i % perBlock) * rowSize;
      if (!block || base + rowSize > block.length) continue;
      const row = block.subarray(base, base + rowSize);
      const values = new Map();
      for (const c of cols) {
        if (!(row[cebStart + (c.bit >> 3)] & (0x80 >> (c.bit & 7)))) continue;
        const type = c.tag & 0xFFFF;
        try {
          if (!(type & 0x1000) && FIXED[type]) values.set(c.tag, decodeValue(type, row.subarray(c.ib, c.ib + FIXED[type])));
          else values.set(c.tag, decodeValue(type, this.hnid(row.readUInt32LE(c.ib))));
        } catch { /* unreadable cell left out */ }
      }
      rows.push({ rowId: id, values });
    }
    return rows;
  }
}
