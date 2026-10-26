// Lists and Tables layer of a PST (MS-PST section 2.3): the heap-on-node, the BTree-on-heap, and the
// property context (PC) and table context (TC) built on them.
import { MAX_BLOCK_DATA } from './ndb.js';

export const PT = {
  I2: 0x0002, I4: 0x0003, R4: 0x0004, R8: 0x0005, CY: 0x0006, APPTIME: 0x0007, ERROR: 0x000A,
  BOOL: 0x000B, OBJECT: 0x000D, I8: 0x0014, STRING8: 0x001E, UNICODE: 0x001F, SYSTIME: 0x0040,
  GUID: 0x0048, BINARY: 0x0102, MV_I4: 0x1003, MV_UNICODE: 0x101F, MV_BINARY: 0x1102,
};
export const tag = (id, type) => ((id << 16) | type) >>> 0;
export const tagType = t => t & 0xFFFF;
export const tagId = t => t >>> 16;

const MAX_HEAP_ITEM = 3580;
const FILETIME_EPOCH_MS = 11644473600000n;

const isMultiValued = type => (type & 0x1000) !== 0;
const FIXED_SIZE = { [PT.I2]: 2, [PT.I4]: 4, [PT.R4]: 4, [PT.ERROR]: 4, [PT.BOOL]: 1, [PT.R8]: 8, [PT.CY]: 8, [PT.APPTIME]: 8, [PT.I8]: 8, [PT.SYSTIME]: 8 };

export function toFiletime(date) {
  const ms = date instanceof Date ? date.getTime() : Number(date);
  return (BigInt(Math.round(ms)) + FILETIME_EPOCH_MS) * 10000n;
}

// The bytes of a property value as the PST stores them.
export function encodeValue(type, value) {
  switch (type) {
    case PT.I2: { const b = Buffer.alloc(2); b.writeInt16LE(value); return b; }
    case PT.I4: case PT.ERROR: { const b = Buffer.alloc(4); b.writeUInt32LE(value >>> 0); return b; }
    case PT.R4: { const b = Buffer.alloc(4); b.writeFloatLE(value); return b; }
    case PT.BOOL: return Buffer.from([value ? 1 : 0]);
    case PT.R8: case PT.APPTIME: { const b = Buffer.alloc(8); b.writeDoubleLE(value); return b; }
    case PT.CY: case PT.I8: { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(value)); return b; }
    case PT.SYSTIME: { const b = Buffer.alloc(8); b.writeBigUInt64LE(typeof value === 'bigint' ? value : toFiletime(value)); return b; }
    case PT.UNICODE: return Buffer.from(String(value), 'utf16le');
    case PT.STRING8: return Buffer.from(String(value), 'latin1');
    case PT.GUID: case PT.BINARY: case PT.OBJECT: return Buffer.from(value);
    case PT.MV_I4: { const b = Buffer.alloc(value.length * 4); value.forEach((v, i) => b.writeUInt32LE(v >>> 0, i * 4)); return b; }
    case PT.MV_UNICODE: case PT.MV_BINARY: {
      const items = value.map(v => (type === PT.MV_UNICODE ? Buffer.from(String(v), 'utf16le') : Buffer.from(v)));
      const head = Buffer.alloc(4 + items.length * 4);
      head.writeUInt32LE(items.length, 0);
      let off = head.length;
      items.forEach((it, i) => { head.writeUInt32LE(off, 4 + i * 4); off += it.length; });
      return Buffer.concat([head, ...items]);
    }
    default: throw new Error(`Unsupported PST property type 0x${type.toString(16)}`);
  }
}

// ── Heap-on-node ──

const blockHeaderSize = i => (i === 0 ? 12 : (i >= 8 && (i - 8) % 128 === 0 ? 66 : 2));

function fillLevel(free) {
  const steps = [3584, 2560, 2048, 1792, 1536, 1280, 1024, 768, 512, 256, 128, 64, 32, 16, 8];
  const i = steps.findIndex(s => free >= s);
  return i === -1 ? 15 : i;
}

export class Heap {
  constructor(clientSig) {
    this.clientSig = clientSig;
    this.blocks = [{ items: [], used: 0 }];
    this.userRoot = 0;
  }

  // Items are kept by reference, so a caller may fill an item in after allocating it.
  alloc(buf) {
    if (buf.length > MAX_HEAP_ITEM) throw new Error(`Heap item too large (${buf.length} bytes)`);
    let bi = this.blocks.length - 1;
    const fits = (b, i) => {
      const n = b.items.length + 1;
      const mapAt = align2(blockHeaderSize(i) + b.used + buf.length);
      return n < 2048 && mapAt + 4 + 2 * (n + 1) <= MAX_BLOCK_DATA;
    };
    if (!fits(this.blocks[bi], bi)) {
      this.blocks.push({ items: [], used: 0 });
      bi++;
      if (bi > 0xFFFF) throw new Error('Heap exceeds 65536 blocks');
    }
    const b = this.blocks[bi];
    b.items.push(buf);
    b.used += buf.length;
    return ((b.items.length << 5) | (bi << 16)) >>> 0;
  }

  toBlocks() {
    const out = this.blocks.map((b, i) => {
      const hdr = blockHeaderSize(i);
      const mapAt = align2(hdr + b.used);
      const buf = Buffer.alloc(mapAt + 4 + 2 * (b.items.length + 1));
      let off = hdr;
      const offsets = [];
      for (const it of b.items) { offsets.push(off); it.copy(buf, off); off += it.length; }
      offsets.push(off);
      buf.writeUInt16LE(mapAt, 0);
      buf.writeUInt16LE(b.items.length, mapAt);
      buf.writeUInt16LE(0, mapAt + 2);
      offsets.forEach((o, k) => buf.writeUInt16LE(o, mapAt + 4 + k * 2));
      return buf;
    });
    const levels = out.map(b => fillLevel(MAX_BLOCK_DATA - b.length));
    const first = out[0];
    first[2] = 0xEC;
    first[3] = this.clientSig;
    first.writeUInt32LE(this.userRoot >>> 0, 4);
    for (let k = 0; k < 8 && k < levels.length; k++) first[8 + (k >> 1)] |= levels[k] << ((k & 1) * 4);
    for (let i = 8; i < out.length; i += 128) {
      for (let k = 0; k < 128 && i + k < levels.length; k++) out[i][2 + (k >> 1)] |= levels[i + k] << ((k & 1) * 4);
    }
    return out;
  }
}

const align2 = n => n + (n & 1);

// ── BTree-on-heap ──

// Outlook (and readers that follow it) expect a heap's BTHHEADER to be its first item, HID 0x20,
// so the header is allocated before anything else and filled in once the records are placed.
export function allocBthHeader(heap, cbKey, cbEnt) {
  const header = Buffer.alloc(8);
  header[0] = 0xB5; header[1] = cbKey; header[2] = cbEnt;
  return { header, hid: heap.alloc(header) };
}

// records: [{ key: Buffer(cbKey), data: Buffer(cbEnt) }], sorted by key. Returns the BTHHEADER's HID.
export function buildBth(heap, cbKey, cbEnt, records, bth = allocBthHeader(heap, cbKey, cbEnt)) {
  const { header, hid: headerHid } = bth;
  if (!records.length) return headerHid;
  let level = [];
  const perLeaf = Math.floor(MAX_HEAP_ITEM / (cbKey + cbEnt));
  for (let i = 0; i < records.length; i += perLeaf) {
    const chunk = records.slice(i, i + perLeaf);
    level.push({ key: chunk[0].key, hid: heap.alloc(Buffer.concat(chunk.flatMap(r => [r.key, r.data]))) });
  }
  let depth = 0;
  const perIndex = Math.floor(MAX_HEAP_ITEM / (cbKey + 4));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += perIndex) {
      const chunk = level.slice(i, i + perIndex);
      const item = Buffer.alloc(chunk.length * (cbKey + 4));
      chunk.forEach((e, k) => { e.key.copy(item, k * (cbKey + 4)); item.writeUInt32LE(e.hid, k * (cbKey + 4) + cbKey); });
      next.push({ key: chunk[0].key, hid: heap.alloc(item) });
    }
    level = next;
    depth++;
  }
  header[3] = depth;
  header.writeUInt32LE(level[0].hid, 4);
  return headerHid;
}

// Values too large for the heap go to a subnode of the node that owns the heap.
export class Subnodes {
  constructor(ndb) { this.ndb = ndb; this.entries = []; this.next = 0x8000; }
  addData(dataOrBlocks) {
    const nid = ((this.next++ << 5) | 0x1F) >>> 0;   // NID_TYPE_LTP
    this.entries.push({ nid, bidData: this.ndb.writeDataTree(dataOrBlocks), bidSub: 0 });
    return nid;
  }
  addNode(nid, bidData, bidSub = 0) { this.entries.push({ nid, bidData, bidSub }); }
  write() { return this.ndb.writeSubnodeTree(this.entries); }
}

function storeVariable(heap, sub, raw) {
  if (raw.length === 0) return 0;
  return raw.length <= MAX_HEAP_ITEM ? heap.alloc(raw) : sub.addData(raw);
}

// ── Property context ──

// props: Map(tag -> value). Returns the heap's data blocks.
export function buildPC(props, sub) {
  const heap = new Heap(0xBC);
  const bth = allocBthHeader(heap, 2, 6);
  const records = [];
  const byId = [...props.entries()].sort((a, b) => tagId(a[0]) - tagId(b[0]) || tagType(a[0]) - tagType(b[0]));
  for (const [t, value] of byId) {
    if (value === undefined || value === null) continue;
    const type = tagType(t);
    const raw = encodeValue(type, value);
    let hnid;
    if (!isMultiValued(type) && FIXED_SIZE[type] && FIXED_SIZE[type] <= 4) {
      const b = Buffer.alloc(4); raw.copy(b); hnid = b.readUInt32LE(0);
    } else {
      hnid = storeVariable(heap, sub, raw);
    }
    const key = Buffer.alloc(2); key.writeUInt16LE(tagId(t));
    const data = Buffer.alloc(6); data.writeUInt16LE(type, 0); data.writeUInt32LE(hnid >>> 0, 2);
    records.push({ key, data });
  }
  for (let i = 1; i < records.length; i++) {
    if (records[i].key.equals(records[i - 1].key)) throw new Error(`Property 0x${records[i].key.readUInt16LE(0).toString(16)} set twice`);
  }
  heap.userRoot = buildBth(heap, 2, 6, records, bth);
  return heap.toBlocks();
}

// ── Table context ──

export const TAG_ROW_ID = tag(0x67F2, PT.I4);
export const TAG_ROW_VER = tag(0x67F3, PT.I4);

function cellWidth(type) {
  if (isMultiValued(type)) return 4;
  return FIXED_SIZE[type] ?? 4;              // variable-size values are HNIDs
}

// columns: array of tags; rows: [{ id, values: Map(tag -> value) }]. Returns the heap's data blocks.
export function buildTC(columns, rows, sub) {
  const heap = new Heap(0x7C);
  const rowIndexBth = allocBthHeader(heap, 4, 4);
  const tags = [...new Set([TAG_ROW_ID, TAG_ROW_VER, ...columns])].sort((a, b) => a - b);
  const cols = tags.map(t => ({ tag: t, type: tagType(t), width: cellWidth(tagType(t)) }));
  const rowId = cols.find(c => c.tag === TAG_ROW_ID);
  const rowVer = cols.find(c => c.tag === TAG_ROW_VER);
  rowId.ib = 0; rowId.bit = 0;
  rowVer.ib = 4; rowVer.bit = 1;
  let ib = 8, bit = 2;
  const rgib = [];
  for (const width of [8, 4, 2, 1]) {
    for (const c of cols) if (c.ib === undefined && c.width === width) { c.ib = ib; c.bit = bit++; ib += width; }
    if (width === 4) rgib.push(ib);          // end of the 8- and 4-byte group
    if (width === 2) rgib.push(ib);
    if (width === 1) rgib.push(ib);
  }
  const cebSize = Math.ceil(cols.length / 8);
  const rowSize = ib + cebSize;
  rgib.push(rowSize);

  const info = Buffer.alloc(22 + cols.length * 8);
  info[0] = 0x7C;
  info[1] = cols.length;
  rgib.forEach((v, i) => info.writeUInt16LE(v, 2 + i * 2));
  cols.forEach((c, i) => {
    const o = 22 + i * 8;
    info.writeUInt32LE(c.tag, o);
    info.writeUInt16LE(c.ib, o + 4);
    info[o + 6] = c.width;
    info[o + 7] = c.bit;
  });
  heap.userRoot = heap.alloc(info);

  const index = rows.map((r, i) => ({ id: r.id >>> 0, i })).sort((a, b) => a.id - b.id);
  info.writeUInt32LE(buildBth(heap, 4, 4, index.map(e => {
    const key = Buffer.alloc(4); key.writeUInt32LE(e.id);
    const data = Buffer.alloc(4); data.writeUInt32LE(e.i);
    return { key, data };
  }), rowIndexBth), 10);

  const matrix = Buffer.alloc(rows.length * rowSize);
  rows.forEach((r, n) => {
    const base = n * rowSize;
    const ceb = ib;
    const set = c => { matrix[base + ceb + (c.bit >> 3)] |= 0x80 >> (c.bit & 7); };
    matrix.writeUInt32LE(r.id >>> 0, base);
    matrix.writeUInt32LE((r.values.get(TAG_ROW_VER) ?? n + 1) >>> 0, base + 4);
    set(rowId); set(rowVer);
    for (const c of cols) {
      if (c === rowId || c === rowVer) continue;
      const value = r.values.get(c.tag);
      if (value === undefined || value === null) continue;
      const raw = encodeValue(c.type, value);
      if (!isMultiValued(c.type) && FIXED_SIZE[c.type]) raw.copy(matrix, base + c.ib, 0, c.width);
      else matrix.writeUInt32LE(storeVariable(heap, sub, raw) >>> 0, base + c.ib);
      set(c);
    }
  });

  let hnidRows = 0;
  if (rows.length && matrix.length <= MAX_HEAP_ITEM) {
    hnidRows = heap.alloc(matrix);
  } else if (rows.length) {
    // Rows never straddle blocks, and every block but the last is a full 8 KB block.
    const perBlock = Math.floor(MAX_BLOCK_DATA / rowSize);
    const blocks = [];
    for (let n = 0; n < rows.length; n += perBlock) {
      const chunk = matrix.subarray(n * rowSize, Math.min(rows.length, n + perBlock) * rowSize);
      const last = n + perBlock >= rows.length;
      blocks.push(last ? chunk : Buffer.concat([chunk, Buffer.alloc(MAX_BLOCK_DATA - chunk.length)]));
    }
    hnidRows = sub.addData(blocks);
  }
  info.writeUInt32LE(hnidRows >>> 0, 14);
  return heap.toBlocks();
}
