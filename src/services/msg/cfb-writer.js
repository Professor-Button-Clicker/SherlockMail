// Compound File Binary writer (MS-CFB, version 3): nested storages and streams, 512-byte sectors, a mini
// stream for streams under 4096 bytes, and DIFAT sectors once the FAT outgrows the header's 109 slots.
// Each storage's children form a binary search tree in CFB name order with every node black, which
// MS-CFB section 2.6.4 allows ("the simplest implementation ... mark every node as black").

const SECTOR = 512;
const MINI_SECTOR = 64;
const MINI_CUTOFF = 4096;
const FREESECT = 0xFFFFFFFF;
const ENDOFCHAIN = 0xFFFFFFFE;
const FATSECT = 0xFFFFFFFD;
const DIFSECT = 0xFFFFFFFC;
const NOSTREAM = 0xFFFFFFFF;
const PER_SECTOR = SECTOR / 4;
const HEADER_DIFAT = 109;

// Shorter names sort first; equal lengths compare by upper-cased code unit (MS-CFB section 2.6.4).
function compareNames(a, b) {
  if (a.length !== b.length) return a.length - b.length;
  const ua = a.toUpperCase(), ub = b.toUpperCase();
  return ua < ub ? -1 : ua > ub ? 1 : 0;
}

/**
 * root: { children: [node] }, node: { name, data: Buffer } (stream) or { name, children: [node] } (storage).
 * Returns the compound file as one Buffer.
 */
export function writeCfb(root) {
  // ── Directory entries ──
  const entries = [{ name: 'Root Entry', type: 5, left: NOSTREAM, right: NOSTREAM, child: NOSTREAM }];
  const addChildren = (parentIndex, children) => {
    const names = new Set();
    for (const c of children) {
      if (!c.name || c.name.length > 31) throw new Error(`Compound file entry name "${c.name}" must be 1-31 characters`);
      const key = c.name.toUpperCase();
      if (names.has(key)) throw new Error(`Duplicate compound file entry "${c.name}"`);
      names.add(key);
    }
    const sorted = [...children].sort((a, b) => compareNames(a.name, b.name));
    const ids = sorted.map(c => {
      entries.push(c.children
        ? { name: c.name, type: 1, left: NOSTREAM, right: NOSTREAM, child: NOSTREAM, node: c }
        : { name: c.name, type: 2, left: NOSTREAM, right: NOSTREAM, child: NOSTREAM, data: c.data || Buffer.alloc(0) });
      return entries.length - 1;
    });
    const build = (lo, hi) => {
      if (lo > hi) return NOSTREAM;
      const mid = (lo + hi) >> 1;
      entries[ids[mid]].left = build(lo, mid - 1);
      entries[ids[mid]].right = build(mid + 1, hi);
      return ids[mid];
    };
    entries[parentIndex].child = build(0, ids.length - 1);
    for (const id of ids) if (entries[id].node) addChildren(id, entries[id].node.children);
  };
  addChildren(0, root.children || []);

  // ── Stream placement: small streams in the mini stream, the rest in regular sectors ──
  const miniParts = [];
  const miniFat = [];
  const regular = [];
  for (const e of entries) {
    if (e.type !== 2) continue;
    e.size = e.data.length;
    if (e.size === 0) { e.start = ENDOFCHAIN; continue; }
    if (e.size < MINI_CUTOFF) {
      const count = Math.ceil(e.size / MINI_SECTOR);
      e.start = miniFat.length;
      for (let i = 0; i < count; i++) miniFat.push(i < count - 1 ? miniFat.length + 1 : ENDOFCHAIN);
      const padded = Buffer.alloc(count * MINI_SECTOR);
      e.data.copy(padded);
      miniParts.push(padded);
    } else {
      regular.push(e);
    }
  }
  const miniStream = Buffer.concat(miniParts);

  const dirSectors = Math.ceil(entries.length / 4);
  const miniStreamSectors = Math.ceil(miniStream.length / SECTOR);
  const miniFatSectors = Math.ceil(miniFat.length / PER_SECTOR);
  const regularSectors = regular.reduce((n, e) => n + Math.ceil(e.size / SECTOR), 0);
  const dataSectors = dirSectors + miniStreamSectors + miniFatSectors + regularSectors;

  // The FAT must also cover its own sectors and the DIFAT sectors.
  let fatSectors = 1, difatSectors = 0;
  for (;;) {
    difatSectors = fatSectors > HEADER_DIFAT ? Math.ceil((fatSectors - HEADER_DIFAT) / (PER_SECTOR - 1)) : 0;
    const needed = Math.ceil((dataSectors + fatSectors + difatSectors) / PER_SECTOR);
    if (needed <= fatSectors) break;
    fatSectors = needed;
  }

  // ── Sector layout: directory, mini stream, mini FAT, regular streams, FAT, DIFAT ──
  let next = 0;
  const dirStart = next; next += dirSectors;
  const miniStreamStart = next; next += miniStreamSectors;
  const miniFatStart = next; next += miniFatSectors;
  for (const e of regular) { e.start = next; next += Math.ceil(e.size / SECTOR); }
  const fatStart = next; next += fatSectors;
  const difatStart = next; next += difatSectors;
  const totalSectors = next;

  const fat = new Uint32Array(fatSectors * PER_SECTOR).fill(FREESECT);
  const chain = (start, count) => { for (let i = 0; i < count; i++) fat[start + i] = i < count - 1 ? start + i + 1 : ENDOFCHAIN; };
  chain(dirStart, dirSectors);
  chain(miniStreamStart, miniStreamSectors);
  chain(miniFatStart, miniFatSectors);
  for (const e of regular) chain(e.start, Math.ceil(e.size / SECTOR));
  for (let i = 0; i < fatSectors; i++) fat[fatStart + i] = FATSECT;
  for (let i = 0; i < difatSectors; i++) fat[difatStart + i] = DIFSECT;

  // ── Header ──
  const header = Buffer.alloc(SECTOR);
  Buffer.from('D0CF11E0A1B11AE1', 'hex').copy(header, 0);
  header.writeUInt16LE(0x003E, 24);          // minor version
  header.writeUInt16LE(0x0003, 26);          // major version 3
  header.writeUInt16LE(0xFFFE, 28);          // byte order
  header.writeUInt16LE(9, 30);               // sector shift (512)
  header.writeUInt16LE(6, 32);               // mini sector shift (64)
  header.writeUInt32LE(0, 40);               // directory sectors (must be 0 in version 3)
  header.writeUInt32LE(fatSectors, 44);
  header.writeUInt32LE(dirStart, 48);
  header.writeUInt32LE(0, 52);               // transaction signature
  header.writeUInt32LE(MINI_CUTOFF, 56);
  header.writeUInt32LE(miniFatSectors ? miniFatStart : ENDOFCHAIN, 60);
  header.writeUInt32LE(miniFatSectors, 64);
  header.writeUInt32LE(difatSectors ? difatStart : ENDOFCHAIN, 68);
  header.writeUInt32LE(difatSectors, 72);
  for (let i = 0; i < HEADER_DIFAT; i++) header.writeUInt32LE(i < fatSectors ? fatStart + i : FREESECT, 76 + i * 4);

  // ── Directory ──
  const dir = Buffer.alloc(dirSectors * SECTOR);
  for (let i = 0; i < dirSectors * 4; i++) {
    const o = i * 128;
    const e = entries[i];
    if (!e) {
      dir.writeUInt32LE(NOSTREAM, o + 68);
      dir.writeUInt32LE(NOSTREAM, o + 72);
      dir.writeUInt32LE(NOSTREAM, o + 76);
      continue;
    }
    const name = Buffer.from(`${e.name}\0`, 'utf16le');
    name.copy(dir, o);
    dir.writeUInt16LE(name.length, o + 64);
    dir[o + 66] = e.type;
    dir[o + 67] = 1;                          // black
    dir.writeUInt32LE(e.left, o + 68);
    dir.writeUInt32LE(e.right, o + 72);
    dir.writeUInt32LE(e.child, o + 76);
    if (e.type === 5) {
      dir.writeUInt32LE(miniStream.length ? miniStreamStart : ENDOFCHAIN, o + 116);
      dir.writeUInt32LE(miniStream.length, o + 120);
    } else if (e.type === 2) {
      dir.writeUInt32LE(e.start, o + 116);
      dir.writeUInt32LE(e.size, o + 120);
    }
  }

  // ── Mini FAT, FAT, DIFAT ──
  const miniFatBuf = Buffer.alloc(miniFatSectors * SECTOR, 0xFF);
  miniFat.forEach((v, i) => miniFatBuf.writeUInt32LE(v, i * 4));
  const fatBuf = Buffer.from(fat.buffer, fat.byteOffset, fat.byteLength);
  const difatBuf = Buffer.alloc(difatSectors * SECTOR, 0xFF);
  for (let d = 0; d < difatSectors; d++) {
    for (let j = 0; j < PER_SECTOR - 1; j++) {
      const k = HEADER_DIFAT + d * (PER_SECTOR - 1) + j;
      if (k < fatSectors) difatBuf.writeUInt32LE(fatStart + k, d * SECTOR + j * 4);
    }
    difatBuf.writeUInt32LE(d < difatSectors - 1 ? difatStart + d + 1 : ENDOFCHAIN, d * SECTOR + (PER_SECTOR - 1) * 4);
  }

  const pad = b => (b.length % SECTOR ? Buffer.concat([b, Buffer.alloc(SECTOR - (b.length % SECTOR))]) : b);
  const out = Buffer.concat([
    header, dir, pad(miniStream), miniFatBuf,
    ...regular.map(e => pad(e.data)),
    fatBuf, difatBuf,
  ]);
  if (out.length !== SECTOR * (1 + totalSectors)) throw new Error('Compound file layout error');
  return out;
}
