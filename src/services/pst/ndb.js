// Node Database layer of a Unicode PST (MS-PST section 2.2): blocks, data trees, subnode trees,
// the node and block B-trees, the allocation maps and the header. The file is written front to back
// in one pass; nothing already written is rewritten except the map pages and the header at the end.
import crypto from 'crypto';
import fs from 'fs';
import { pstCrc, blockSignature } from './crc.js';

const PAGE = 512;
const AMAP_START = 0x4400;
const AMAP_INTERVAL = 253952;            // 496 bytes * 8 bits * 64-byte slots
const SLOTS_PER_AMAP = 496 * 8;
const DLIST_IB = 0x4200;
export const MAX_BLOCK_DATA = 8176;      // 8192-byte block minus its 16-byte trailer
const XBLOCK_MAX = 1021;                 // BIDs per XBLOCK / XXBLOCK
const SL_MAX = 340;                      // SLENTRYs per SLBLOCK
const SI_MAX = 510;                      // SIENTRYs per SIBLOCK
// The header carries the first 128 bytes of the free maps, so the first FMap page covers AMap 128
// onwards (one FMap per 496 AMaps) and the first FPMap page covers PMap 1024 = AMap 8192 onwards.
const FMAP_FIRST = 128, FMAP_EVERY = 496;
const FPMAP_FIRST = 8192, FPMAP_EVERY = 496 * 8 * 8;
const PT = { BBT: 0x80, NBT: 0x81, FMAP: 0x82, PMAP: 0x83, AMAP: 0x84, FPMAP: 0x85, DL: 0x86 };
const WRITE_BUFFER = 8 * 1024 * 1024;

const align = (n, a) => Math.ceil(n / a) * a;
const regionStart = r => AMAP_START + r * AMAP_INTERVAL;
const hasFmap = r => r >= FMAP_FIRST && (r - FMAP_FIRST) % FMAP_EVERY === 0;
const hasFpmap = r => r >= FPMAP_FIRST && (r - FPMAP_FIRST) % FPMAP_EVERY === 0;

// Map pages at the start of each AMap's data section, in the order they occupy it.
function mapPages(r) {
  const pages = ['amap'];
  if (r % 8 === 0) pages.push('pmap');
  if (hasFmap(r)) pages.push('fmap');
  if (hasFpmap(r)) pages.push('fpmap');
  return pages;
}

export class NdbWriter {
  constructor(filePath) {
    this.filePath = filePath;
    this.fd = fs.openSync(filePath, 'w');
    this.buf = Buffer.alloc(WRITE_BUFFER);
    this.bufStart = 0;
    this.bufHigh = 0;
    this.bidNextB = 4;
    this.bidNextP = 1;
    this.bbt = { bid: [], ib: [], cb: [] };
    this.nbt = [];
    this.regions = [];                   // per AMap: { free, longest }
    this._enterRegion(0);
  }

  get bytesWritten() { return this.pos; }

  // ── Space allocation ──

  _enterRegion(r) {
    this.region = r;
    this.bits = new Uint8Array(496);
    const reserved = mapPages(r).length * PAGE;
    this._markBits(0, reserved);
    this.pos = regionStart(r) + reserved;
  }

  _markBits(rel, size) {
    for (let s = Math.floor(rel / 64), end = Math.ceil((rel + size) / 64); s < end; s++) this.bits[s >> 3] |= 0x80 >> (s & 7);
  }

  _alloc(size, alignment) {
    let p = align(this.pos, alignment);
    if (p + size > regionStart(this.region + 1)) {
      this._closeRegion();
      this._enterRegion(this.region + 1);
      p = align(this.pos, alignment);
    }
    this._markBits(p - regionStart(this.region), size);
    this.pos = p + size;
    return p;
  }

  // An AMap's contents are final once allocation moves past it, so its pages are written then.
  _closeRegion() {
    let free = 0, run = 0, longest = 0;
    for (let s = 0; s < SLOTS_PER_AMAP; s++) {
      if (this.bits[s >> 3] & (0x80 >> (s & 7))) run = 0;
      else { free++; run++; if (run > longest) longest = run; }
    }
    this.regions[this.region] = { free, longest };
    const start = regionStart(this.region);
    this._put(start, this._mapPage(PT.AMAP, Buffer.from(this.bits), start));
    // Every page in this PST is allocated as it is written, so no PMap page has free pages.
    if (this.region % 8 === 0) this._put(start + PAGE, this._mapPage(PT.PMAP, Buffer.alloc(496, 0xFF), start + PAGE));
  }

  _mapPage(ptype, body, ib) {
    const page = Buffer.alloc(PAGE);
    body.copy(page, 0, 0, 496);
    page[496] = ptype; page[497] = ptype;
    page.writeUInt16LE(0, 498);
    page.writeUInt32LE(pstCrc(page, 0, 496), 500);
    page.writeBigUInt64LE(BigInt(ib), 504);
    return page;
  }

  // ── Buffered output ──

  _put(ib, data) {
    if (ib < this.bufStart) { fs.writeSync(this.fd, data, 0, data.length, ib); return; }
    if (ib + data.length > this.bufStart + this.buf.length) { this._flush(); this.bufStart = ib; this.bufHigh = ib; }
    data.copy(this.buf, ib - this.bufStart);
    if (ib + data.length > this.bufHigh) this.bufHigh = ib + data.length;
  }

  _flush() {
    const n = this.bufHigh - this.bufStart;
    if (n > 0) {
      fs.writeSync(this.fd, this.buf, 0, n, this.bufStart);
      this.buf.fill(0, 0, n);
    }
    this.bufStart = this.bufHigh;
  }

  // ── Blocks ──

  writeBlock(data, internal = false) {
    if (data.length > MAX_BLOCK_DATA) throw new Error(`PST block too large (${data.length} bytes)`);
    const bid = this.bidNextB + (internal ? 2 : 0);
    this.bidNextB += 4;
    const size = align(data.length + 16, 64);
    const ib = this._alloc(size, 64);
    const block = Buffer.alloc(size);
    data.copy(block);
    const t = size - 16;
    block.writeUInt16LE(data.length, t);
    block.writeUInt16LE(blockSignature(ib, bid), t + 2);
    block.writeUInt32LE(pstCrc(data), t + 4);
    block.writeBigUInt64LE(BigInt(bid), t + 8);
    this._put(ib, block);
    this.bbt.bid.push(bid); this.bbt.ib.push(ib); this.bbt.cb.push(data.length);
    return bid;
  }

  // A node's data stream: one block, or data blocks under an XBLOCK (or XXBLOCK). Callers that need
  // particular block boundaries (heaps, table row matrices) pass the blocks pre-cut.
  writeDataTree(dataOrBlocks) {
    let blocks = dataOrBlocks;
    if (Buffer.isBuffer(dataOrBlocks)) {
      blocks = [];
      for (let o = 0; o < dataOrBlocks.length || o === 0; o += MAX_BLOCK_DATA) blocks.push(dataOrBlocks.subarray(o, o + MAX_BLOCK_DATA));
    }
    if (blocks.length === 1) return this.writeBlock(blocks[0]);
    const total = blocks.reduce((n, b) => n + b.length, 0);
    if (total > 0xFFFFFFFF) throw new Error('PST node data exceeds 4 GB');
    const bids = blocks.map(b => this.writeBlock(b));
    const sizes = blocks.map(b => b.length);
    const xblock = (level, ids, lcb) => {
      const x = Buffer.alloc(8 + ids.length * 8);
      x[0] = 1; x[1] = level;
      x.writeUInt16LE(ids.length, 2);
      x.writeUInt32LE(lcb, 4);
      ids.forEach((id, i) => x.writeBigUInt64LE(BigInt(id), 8 + i * 8));
      return this.writeBlock(x, true);
    };
    if (bids.length <= XBLOCK_MAX) return xblock(1, bids, total);
    if (bids.length > XBLOCK_MAX * XBLOCK_MAX) throw new Error('PST node data too large for an XXBLOCK');
    const xbids = [];
    for (let i = 0; i < bids.length; i += XBLOCK_MAX) {
      xbids.push(xblock(1, bids.slice(i, i + XBLOCK_MAX), sizes.slice(i, i + XBLOCK_MAX).reduce((a, b) => a + b, 0)));
    }
    return xblock(2, xbids, total);
  }

  // entries: [{ nid, bidData, bidSub }] for the subnodes of one node. Returns the bidSub (0 if none).
  writeSubnodeTree(entries) {
    if (!entries.length) return 0;
    const sorted = [...entries].sort((a, b) => a.nid - b.nid);
    const slblock = (list) => {
      const b = Buffer.alloc(8 + list.length * 24);
      b[0] = 2; b[1] = 0;
      b.writeUInt16LE(list.length, 2);
      list.forEach((e, i) => {
        b.writeBigUInt64LE(BigInt(e.nid), 8 + i * 24);
        b.writeBigUInt64LE(BigInt(e.bidData), 16 + i * 24);
        b.writeBigUInt64LE(BigInt(e.bidSub || 0), 24 + i * 24);
      });
      return this.writeBlock(b, true);
    };
    if (sorted.length <= SL_MAX) return slblock(sorted);
    const groups = [];
    for (let i = 0; i < sorted.length; i += SL_MAX) groups.push({ nid: sorted[i].nid, bid: slblock(sorted.slice(i, i + SL_MAX)) });
    if (groups.length > SI_MAX) throw new Error('Too many subnodes for one PST node');
    const b = Buffer.alloc(8 + groups.length * 16);
    b[0] = 2; b[1] = 1;
    b.writeUInt16LE(groups.length, 2);
    groups.forEach((g, i) => {
      b.writeBigUInt64LE(BigInt(g.nid), 8 + i * 16);
      b.writeBigUInt64LE(BigInt(g.bid), 16 + i * 16);
    });
    return this.writeBlock(b, true);
  }

  addNode(nid, bidData, bidSub = 0, nidParent = 0) {
    this.nbt.push({ nid, bidData, bidSub, nidParent });
  }

  // ── B-trees ──

  _writeBtPage(ptype, level, cbEnt, cEntMax, entries, writeEntry) {
    const ib = this._alloc(PAGE, PAGE);
    const bid = this.bidNextP++;
    const page = Buffer.alloc(PAGE);
    entries.forEach((e, i) => writeEntry(page, i * cbEnt, e));
    page[488] = entries.length; page[489] = cEntMax; page[490] = cbEnt; page[491] = level;
    page[496] = ptype; page[497] = ptype;
    page.writeUInt16LE(blockSignature(ib, bid), 498);
    page.writeUInt32LE(pstCrc(page, 0, 496), 500);
    page.writeBigUInt64LE(BigInt(bid), 504);
    this._put(ib, page);
    return { bid, ib };
  }

  _writeBtree(ptype, leaves, leafCbEnt, leafMax, writeLeaf) {
    let level = [];
    for (let i = 0; i < leaves.length; i += leafMax) {
      const chunk = leaves.slice(i, i + leafMax);
      level.push({ key: chunk[0].key, ...this._writeBtPage(ptype, 0, leafCbEnt, leafMax, chunk, writeLeaf) });
    }
    for (let depth = 1; level.length > 1; depth++) {
      const next = [];
      for (let i = 0; i < level.length; i += 20) {
        const chunk = level.slice(i, i + 20);
        next.push({
          key: chunk[0].key,
          ...this._writeBtPage(ptype, depth, 24, 20, chunk, (p, o, e) => {
            p.writeBigUInt64LE(BigInt(e.key), o);
            p.writeBigUInt64LE(BigInt(e.bid), o + 8);
            p.writeBigUInt64LE(BigInt(e.ib), o + 16);
          }),
        });
      }
      level = next;
    }
    return level[0];
  }

  // ── Finish: B-trees, map pages, density list, header ──

  finish({ rgnid }) {
    const nbt = [...this.nbt].sort((a, b) => a.nid - b.nid).map(e => ({ key: e.nid, ...e }));
    for (let i = 1; i < nbt.length; i++) if (nbt[i].key === nbt[i - 1].key) throw new Error(`Duplicate PST node 0x${nbt[i].key.toString(16)}`);
    const nbtRoot = this._writeBtree(PT.NBT, nbt, 32, 15, (p, o, e) => {
      p.writeBigUInt64LE(BigInt(e.nid), o);
      p.writeBigUInt64LE(BigInt(e.bidData), o + 8);
      p.writeBigUInt64LE(BigInt(e.bidSub), o + 16);
      p.writeUInt32LE(e.nidParent >>> 0, o + 24);
    });
    const bbt = this.bbt.bid.map((bid, i) => ({ key: bid, i }));
    const bbtRoot = this._writeBtree(PT.BBT, bbt, 24, 20, (p, o, e) => {
      p.writeBigUInt64LE(BigInt(this.bbt.bid[e.i]), o);
      p.writeBigUInt64LE(BigInt(this.bbt.ib[e.i]), o + 8);
      p.writeUInt16LE(this.bbt.cb[e.i], o + 16);
      p.writeUInt16LE(2, o + 18);            // referenced by its BBT entry and by its one parent
    });

    this._closeRegion();
    const lastRegion = this.region;
    const eof = regionStart(lastRegion + 1);

    for (let r = 0; r <= lastRegion; r++) {
      const pages = mapPages(r);
      if (hasFmap(r)) {
        const body = Buffer.alloc(496);
        for (let k = 0; k < 496 && r + k <= lastRegion; k++) body[k] = Math.min(255, this.regions[r + k].longest);
        const ib = regionStart(r) + pages.indexOf('fmap') * PAGE;
        this._put(ib, this._mapPage(PT.FMAP, body, ib));
      }
      if (hasFpmap(r)) {
        const ib = regionStart(r) + pages.indexOf('fpmap') * PAGE;
        this._put(ib, this._mapPage(PT.FPMAP, Buffer.alloc(496, 0xFF), ib));
      }
    }

    // Density list: AMaps with the most free space first.
    const dl = Buffer.alloc(PAGE);
    const dense = this.regions.map((s, i) => ({ i, free: s.free })).filter(e => e.free > 0).sort((a, b) => b.free - a.free).slice(0, 119);
    dl[0] = 0x01;                            // DFL_BACKFILL_COMPLETE
    dl[1] = dense.length;
    dl.writeUInt32LE(dense.length ? dense[0].i : lastRegion, 4);
    dense.forEach((e, k) => dl.writeUInt32LE(((e.free & 0xFFF) << 20 | (e.i & 0xFFFFF)) >>> 0, 8 + k * 4));
    const dlBid = this.bidNextP++;
    dl[496] = PT.DL; dl[497] = PT.DL;
    dl.writeUInt16LE(blockSignature(DLIST_IB, dlBid), 498);
    dl.writeUInt32LE(pstCrc(dl, 0, 496), 500);
    dl.writeBigUInt64LE(BigInt(dlBid), 504);
    this._put(DLIST_IB, dl);

    const h = Buffer.alloc(564);
    h.write('!BDN', 0, 'latin1');
    h.write('SM', 8, 'latin1');
    h.writeUInt16LE(23, 10);                 // Unicode PST
    h.writeUInt16LE(19, 12);
    h[14] = 1; h[15] = 1;
    h.writeBigUInt64LE(BigInt(this.bidNextP), 32);
    h.writeUInt32LE(crypto.randomBytes(4).readUInt32LE(0), 40);
    for (let t = 0; t < 32; t++) h.writeUInt32LE(rgnid[t] >>> 0, 44 + t * 4);
    // ROOT
    h.writeBigUInt64LE(BigInt(eof), 184);
    h.writeBigUInt64LE(BigInt(regionStart(lastRegion)), 192);
    h.writeBigUInt64LE(BigInt(this.regions.reduce((n, s) => n + s.free * 64, 0)), 200);
    h.writeBigUInt64LE(BigInt(nbtRoot.bid), 216);
    h.writeBigUInt64LE(BigInt(nbtRoot.ib), 224);
    h.writeBigUInt64LE(BigInt(bbtRoot.bid), 232);
    h.writeBigUInt64LE(BigInt(bbtRoot.ib), 240);
    h[248] = 0x02;                           // VALID_AMAP2
    h.fill(0xFF, 256, 512);                  // deprecated rgbFM / rgbFP
    h[512] = 0x80;
    h[513] = 0x00;                           // NDB_CRYPT_NONE
    h.writeBigUInt64LE(BigInt(this.bidNextB), 516);
    h.writeUInt32LE(pstCrc(h, 8, 8 + 471), 4);
    h.writeUInt32LE(pstCrc(h, 8, 8 + 516), 524);
    this._put(0, h);

    this._flush();
    fs.ftruncateSync(this.fd, eof);
    fs.fsyncSync(this.fd);
    fs.closeSync(this.fd);
    this.fd = null;
    return { size: eof, nodes: this.nbt.length, blocks: this.bbt.bid.length };
  }

  abort() {
    if (this.fd !== null) { try { fs.closeSync(this.fd); } catch { /* already closed */ } this.fd = null; }
    try { fs.unlinkSync(this.filePath); } catch { /* nothing to remove */ }
  }
}
