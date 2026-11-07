import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { HashManager } from './hash-manager.js';

// A real, mountable forensic container: a VHDX file (MS-VHDX) holding a disk with one MBR partition formatted
// exFAT, so files of any size fit and Windows, Autopsy, FTK and EnCase open it. The image is written once,
// then every file is read back out of the VHDX through the structures just written and compared by SHA-256.

const KB = 1024;
const MB = 1024 * KB;
const SECTOR = 512;
const PHYSICAL_SECTOR = 4096;
const VHDX_BLOCK = 32 * MB;
const CHUNK_RATIO = (2 ** 23 * SECTOR) / VHDX_BLOCK;
const PARTITION_START_LBA = 2048;
const CLUSTER = 64 * KB;
const COPY_CHUNK = 4 * MB;

const GUIDS = {
  BAT: '2DC27766-F623-4200-9D64-115E9BFD4A08',
  METADATA: '8B7CA206-4790-4B9A-B8FE-575F050F886E',
  FILE_PARAMETERS: 'CAA16737-FA36-4D43-B3B6-33F0AA44E76B',
  VIRTUAL_DISK_SIZE: '2FA54224-CD1B-4876-B211-5DBED83BF4B8',
  PAGE_83: 'BECA12AB-B2E6-4523-93EF-C309E000C746',
  LOGICAL_SECTOR: '8141BF1D-A96F-4709-BA47-F233A8FAAB5F',
  PHYSICAL_SECTOR: 'CDA348C7-445D-4471-9CC9-E9885251C556',
};

function guidBytes(text) {
  const hex = text.replace(/-/g, '');
  const b = Buffer.from(hex, 'hex');
  // The first three fields of a GUID are little-endian on disk.
  return Buffer.concat([Buffer.from(b.subarray(0, 4)).reverse(), Buffer.from(b.subarray(4, 6)).reverse(), Buffer.from(b.subarray(6, 8)).reverse(), b.subarray(8)]);
}

function randomGuid() {
  return crypto.randomBytes(16);
}

const CRC32C_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? (c >>> 1) ^ 0x82F63B78 : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32c(data) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) crc = CRC32C_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ── exFAT ──

const UPCASE = (() => {
  const table = Buffer.alloc(65536 * 2);
  for (let i = 0; i < 65536; i++) {
    const ch = String.fromCharCode(i);
    const up = i >= 0xD800 && i <= 0xDFFF ? ch : ch.toUpperCase();
    table.writeUInt16LE(up.length === 1 ? up.charCodeAt(0) : i, i * 2);
  }
  return table;
})();

function upcaseChecksum() {
  let sum = 0;
  for (let i = 0; i < UPCASE.length; i++) sum = (((sum >>> 1) | ((sum & 1) << 31)) + UPCASE[i]) >>> 0;
  return sum;
}

function exfatNameHash(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    const up = UPCASE.readUInt16LE(name.charCodeAt(i) * 2);
    hash = (((hash >>> 1) | ((hash & 1) << 15)) + (up & 0xFF)) & 0xFFFF;
    hash = (((hash >>> 1) | ((hash & 1) << 15)) + (up >>> 8)) & 0xFFFF;
  }
  return hash;
}

function exfatTimestamp(d) {
  const date = ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  return ((date << 16) | time) >>> 0;
}

// A file directory entry set: File, Stream Extension and File Name entries, with their checksum.
function directoryEntrySet({ name, isDirectory, firstCluster, size, mtime }) {
  const nameUnits = name.length;
  const nameEntries = Math.ceil(nameUnits / 15);
  const set = Buffer.alloc((2 + nameEntries) * 32);
  set[0] = 0x85;
  set[1] = 1 + nameEntries;
  set.writeUInt16LE(isDirectory ? 0x10 : 0x20, 4);
  const stamp = exfatTimestamp(mtime);
  set.writeUInt32LE(stamp, 8);
  set.writeUInt32LE(stamp, 12);
  set.writeUInt32LE(stamp, 16);
  // UTC offset valid, offset 0.
  set[22] = 0x80; set[23] = 0x80; set[24] = 0x80;

  const stream = 32;
  set[stream] = 0xC0;
  set[stream + 1] = size > 0 ? 0x03 : 0x01; // allocation possible; contiguous (no FAT chain) when it has data
  set[stream + 3] = nameUnits;
  set.writeUInt16LE(exfatNameHash(name), stream + 4);
  set.writeBigUInt64LE(BigInt(size), stream + 8);
  set.writeUInt32LE(size > 0 ? firstCluster : 0, stream + 20);
  set.writeBigUInt64LE(BigInt(size), stream + 24);

  for (let i = 0; i < nameEntries; i++) {
    const at = (2 + i) * 32;
    set[at] = 0xC1;
    set.write(name.slice(i * 15, i * 15 + 15), at + 2, 'utf16le');
  }
  let checksum = 0;
  for (let i = 0; i < set.length; i++) {
    if (i === 2 || i === 3) continue;
    checksum = (((checksum >>> 1) | ((checksum & 1) << 15)) + set[i]) & 0xFFFF;
  }
  set.writeUInt16LE(checksum, 2);
  return set;
}

function safeExfatName(name) {
  // exFAT forbids these; names are kept readable and the original is recorded in the manifest.
  const cleaned = name.replace(/[\x00-\x1f"*/:<>?\\|]/g, '_');
  return cleaned.length > 255 ? cleaned.slice(0, 200) + cleaned.slice(-40) : cleaned;
}

function walkTree(dir, rel = '') {
  const node = { name: path.basename(dir), rel, dirs: [], files: [] };
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) node.dirs.push(walkTree(full, r));
    else if (entry.isFile()) {
      const st = fs.statSync(full);
      node.files.push({ name: entry.name, rel: r, full, size: st.size, mtime: st.mtime });
    }
  }
  return node;
}

function clustersFor(bytes) {
  return Math.max(1, Math.ceil(bytes / CLUSTER));
}

// Assigns clusters to every directory and file, depth first. Everything is contiguous, so no FAT chains are
// needed beyond the system structures.
function layoutVolume(root, extraFiles) {
  let next = 2;
  const take = (bytes) => { const first = next; next += clustersFor(bytes); return first; };
  const allFiles = [];
  const directorySize = (node) => {
    let total = 0;
    const used = new Set();
    for (const child of [...node.dirs, ...node.files]) {
      let shown = safeExfatName(child.name);
      for (let n = 2; used.has(shown.toUpperCase()); n++) {
        const ext = path.extname(child.name);
        shown = `${safeExfatName(path.basename(child.name, ext)).slice(0, 200)} (${n})${ext}`;
      }
      used.add(shown.toUpperCase());
      child.shownName = shown;
      total += (2 + Math.ceil(shown.length / 15)) * 32;
    }
    return total + 32; // end-of-directory marker space
  };
  const assign = (node, isRoot) => {
    if (!isRoot) { node.dirBytes = directorySize(node); node.cluster = take(node.dirBytes); }
    for (const child of node.dirs) assign(child, false);
    for (const file of node.files) {
      file.cluster = file.size > 0 ? take(file.size) : 0;
      allFiles.push(file);
    }
  };
  root.files.push(...extraFiles);
  const bitmapPlaceholder = take(1); // sized once the cluster count is known; reserved here and below
  next = bitmapPlaceholder;
  return { take: () => next, assign, directorySize, root, allFiles, setNext: v => { next = v; }, reserve: take };
}

function buildVolume(root, extraFiles, label) {
  // Sizes first: the bitmap's size depends on the cluster count, which depends on the file sizes.
  const v = layoutVolume(root, extraFiles);
  const rootEntriesReserve = 3 * 32; // label, bitmap and upcase entries
  const rootDirBytes = v.directorySize(root) + rootEntriesReserve;

  let totalData = 0;
  const sizeWalk = (node, isRoot) => {
    if (!isRoot) totalData += clustersFor(v.directorySize(node));
    for (const d of node.dirs) sizeWalk(d, false);
    for (const f of node.files) if (f.size > 0) totalData += clustersFor(f.size);
  };
  sizeWalk(root, true);
  const upcaseClusters = clustersFor(UPCASE.length);
  const rootClusters = clustersFor(rootDirBytes);
  // Spare room so the volume is not exactly full (Windows wants free clusters to mount it writable-looking).
  const estimateClusters = totalData + upcaseClusters + rootClusters + 16;
  const clusterCount = Math.max(estimateClusters + Math.ceil(estimateClusters / 8) + 64, 256);
  const bitmapBytes = Math.ceil(clusterCount / 8);
  const bitmapClusters = clustersFor(bitmapBytes);

  v.setNext(2);
  const bitmapCluster = v.reserve(bitmapBytes);
  const upcaseCluster = v.reserve(UPCASE.length);
  const rootCluster = v.reserve(rootDirBytes);
  v.assign(root, true);
  const usedClusters = v.take() - 2;
  if (usedClusters > clusterCount) throw new Error('Internal layout error: more clusters used than allocated');

  const clusterSectors = CLUSTER / SECTOR;
  const fatOffsetSectors = 128;
  const fatBytes = (clusterCount + 2) * 4;
  const fatSectors = Math.ceil(fatBytes / SECTOR);
  const heapOffsetSectors = Math.ceil((fatOffsetSectors + fatSectors) / clusterSectors) * clusterSectors;
  const volumeSectors = heapOffsetSectors + clusterCount * clusterSectors;
  return { v, label, clusterCount, bitmapBytes, bitmapCluster, bitmapClusters, upcaseCluster, rootCluster, rootDirBytes, usedClusters, fatOffsetSectors, fatSectors, heapOffsetSectors, volumeSectors, clusterSectors };
}

function exfatBootRegion(geo) {
  const sectors = Buffer.alloc(12 * SECTOR);
  const b = sectors;
  b[0] = 0xEB; b[1] = 0x76; b[2] = 0x90;
  b.write('EXFAT   ', 3, 'ascii');
  b.writeBigUInt64LE(BigInt(PARTITION_START_LBA), 64);
  b.writeBigUInt64LE(BigInt(geo.volumeSectors), 72);
  b.writeUInt32LE(geo.fatOffsetSectors, 80);
  b.writeUInt32LE(geo.fatSectors, 84);
  b.writeUInt32LE(geo.heapOffsetSectors, 88);
  b.writeUInt32LE(geo.clusterCount, 92);
  b.writeUInt32LE(geo.rootCluster, 96);
  b.writeUInt32LE(crypto.randomBytes(4).readUInt32LE(0), 100);
  b.writeUInt16LE(0x0100, 104); // revision 1.00
  b.writeUInt16LE(0, 106);
  b[108] = Math.log2(SECTOR);
  b[109] = Math.log2(geo.clusterSectors);
  b[110] = 1; // one FAT
  b[111] = 0x80;
  b[112] = Math.round(((geo.usedClusters) / geo.clusterCount) * 100);
  b.writeUInt16LE(0xAA55, 510);
  for (let s = 1; s <= 8; s++) b.writeUInt16LE(0xAA55, s * SECTOR + 510);
  // Sector 11: the boot checksum, repeated. Volume flags and percent-in-use are excluded from it.
  let sum = 0;
  for (let i = 0; i < 11 * SECTOR; i++) {
    if (i === 106 || i === 107 || i === 112) continue;
    sum = (((sum >>> 1) | ((sum & 1) << 31)) + b[i]) >>> 0;
  }
  for (let i = 0; i < SECTOR; i += 4) b.writeUInt32LE(sum, 11 * SECTOR + i);
  return sectors;
}

function exfatFat(geo) {
  const fat = Buffer.alloc(geo.fatSectors * SECTOR);
  fat.writeUInt32LE(0xFFFFFFF8, 0);
  fat.writeUInt32LE(0xFFFFFFFF, 4);
  const chain = (first, count) => {
    for (let i = 0; i < count; i++) fat.writeUInt32LE(i === count - 1 ? 0xFFFFFFFF : first + i + 1, (first + i) * 4);
  };
  chain(geo.bitmapCluster, geo.bitmapClusters);
  chain(geo.upcaseCluster, clustersFor(UPCASE.length));
  chain(geo.rootCluster, clustersFor(geo.rootDirBytes));
  return fat;
}

// Writes into the VHDX by virtual disk offset; blocks are laid out in order after the metadata.
class VirtualDisk {
  constructor(fd, dataStart) {
    this.fd = fd;
    this.dataStart = dataStart;
    this.highWater = 0;
  }

  write(buf, virtualOffset) {
    fs.writeSync(this.fd, buf, 0, buf.length, this.dataStart + virtualOffset);
    this.highWater = Math.max(this.highWater, virtualOffset + buf.length);
  }

  read(buf, virtualOffset) {
    return fs.readSync(this.fd, buf, 0, buf.length, this.dataStart + virtualOffset);
  }
}

function vhdxHeader(sequence, logOffset, logLength) {
  const h = Buffer.alloc(4 * KB);
  h.write('head', 0, 'ascii');
  h.writeBigUInt64LE(BigInt(sequence), 8);
  randomGuid().copy(h, 16); // FileWriteGuid
  randomGuid().copy(h, 32); // DataWriteGuid
  // LogGuid stays zero: nothing to replay.
  h.writeUInt16LE(0, 64); // LogVersion
  h.writeUInt16LE(1, 66); // Version
  h.writeUInt32LE(logLength, 68);
  h.writeBigUInt64LE(BigInt(logOffset), 72);
  h.writeUInt32LE(crc32c(h), 4);
  const full = Buffer.alloc(64 * KB);
  h.copy(full);
  return full;
}

function vhdxRegionTable(batOffset, batLength, metaOffset, metaLength) {
  const r = Buffer.alloc(64 * KB);
  r.write('regi', 0, 'ascii');
  r.writeUInt32LE(2, 8);
  guidBytes(GUIDS.BAT).copy(r, 16);
  r.writeBigUInt64LE(BigInt(batOffset), 32);
  r.writeUInt32LE(batLength, 40);
  r.writeUInt32LE(1, 44); // required
  guidBytes(GUIDS.METADATA).copy(r, 48);
  r.writeBigUInt64LE(BigInt(metaOffset), 64);
  r.writeUInt32LE(metaLength, 72);
  r.writeUInt32LE(1, 76);
  r.writeUInt32LE(crc32c(r), 4);
  return r;
}

function vhdxMetadata(virtualSize, length) {
  const m = Buffer.alloc(length);
  m.write('metadata', 0, 'ascii');
  const items = [
    [GUIDS.FILE_PARAMETERS, 0x4, (() => { const b = Buffer.alloc(8); b.writeUInt32LE(VHDX_BLOCK, 0); b.writeUInt32LE(0, 4); return b; })()],
    [GUIDS.VIRTUAL_DISK_SIZE, 0x6, (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(virtualSize), 0); return b; })()],
    [GUIDS.PAGE_83, 0x6, randomGuid()],
    [GUIDS.LOGICAL_SECTOR, 0x6, (() => { const b = Buffer.alloc(4); b.writeUInt32LE(SECTOR, 0); return b; })()],
    [GUIDS.PHYSICAL_SECTOR, 0x6, (() => { const b = Buffer.alloc(4); b.writeUInt32LE(PHYSICAL_SECTOR, 0); return b; })()],
  ];
  m.writeUInt16LE(items.length, 10);
  let dataOffset = 64 * KB;
  items.forEach(([guid, flags, value], i) => {
    const at = 32 + i * 32;
    guidBytes(guid).copy(m, at);
    m.writeUInt32LE(dataOffset, at + 16);
    m.writeUInt32LE(value.length, at + 20);
    m.writeUInt32LE(flags, at + 24); // bit 1 = virtual disk metadata, bit 2 = required
    value.copy(m, dataOffset);
    dataOffset += value.length;
  });
  return m;
}

export class ContainerService {

  // ── VHDX Container Export (Feature 16) ──

  static async createVhdxContainer(sourceDir, outputPath, options = {}) {
    const label = (options.label || 'SherlockMail').replace(/[^\w -]/g, '_').slice(0, 11);
    if (path.resolve(outputPath).startsWith(path.resolve(sourceDir) + path.sep)) {
      throw new Error('The container cannot be written inside the folder being packaged');
    }
    const root = walkTree(sourceDir);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    // Hash every source file first; the list goes into the image and beside it.
    const flat = [];
    const collect = (n) => { n.files.forEach(f => flat.push(f)); n.dirs.forEach(collect); };
    collect(root);
    const manifestRows = ['Path,Size,SHA256'];
    for (const f of flat) {
      f.sha256 = (await HashManager.computeFileStreaming(f.full, ['sha256'])).sha256;
      manifestRows.push(`"${f.rel.replace(/"/g, '""')}",${f.size},${f.sha256}`);
    }
    const manifestText = `${manifestRows.join('\r\n')}\r\n`;
    const manifestPath = `${outputPath}.contents.csv`;
    fs.writeFileSync(manifestPath, manifestText);
    const manifestEntry = { name: 'container_contents.csv', rel: 'container_contents.csv', full: manifestPath, size: Buffer.byteLength(manifestText), mtime: new Date(), sha256: crypto.createHash('sha256').update(manifestText).digest('hex') };

    const geo = buildVolume(root, [manifestEntry], label);
    const volumeStart = PARTITION_START_LBA * SECTOR;
    const diskBytes = volumeStart + geo.volumeSectors * SECTOR + MB;
    const virtualSize = Math.ceil(diskBytes / VHDX_BLOCK) * VHDX_BLOCK;

    // File layout: identifiers, headers and regions in the first MB, then log, BAT, metadata, data.
    const logOffset = MB;
    const logLength = MB;
    const payloadBlocks = virtualSize / VHDX_BLOCK;
    const batEntries = payloadBlocks + Math.floor((payloadBlocks - 1) / CHUNK_RATIO);
    const batOffset = logOffset + logLength;
    const batLength = Math.ceil((batEntries * 8) / MB) * MB;
    const metaOffset = batOffset + batLength;
    const metaLength = MB;
    const dataStart = metaOffset + metaLength;

    const tmp = `${outputPath}.partial`;
    const fd = fs.openSync(tmp, 'w+');
    try {
      const creator = Buffer.alloc(64 * KB);
      creator.write('vhdxfile', 0, 'ascii');
      creator.write('SherlockMail v0.9.0', 8, 'utf16le');
      fs.writeSync(fd, creator, 0, creator.length, 0);
      fs.writeSync(fd, vhdxHeader(1, logOffset, logLength), 0, 64 * KB, 64 * KB);
      fs.writeSync(fd, vhdxHeader(2, logOffset, logLength), 0, 64 * KB, 128 * KB);
      const regions = vhdxRegionTable(batOffset, batLength, metaOffset, metaLength);
      fs.writeSync(fd, regions, 0, regions.length, 192 * KB);
      fs.writeSync(fd, regions, 0, regions.length, 256 * KB);
      const metadata = vhdxMetadata(virtualSize, metaLength);
      fs.writeSync(fd, metadata, 0, metadata.length, metaOffset);

      const disk = new VirtualDisk(fd, dataStart);

      // MBR with one exFAT partition.
      const mbr = Buffer.alloc(SECTOR);
      crypto.randomBytes(4).copy(mbr, 440);
      const p = 446;
      mbr[p + 4] = 0x07;
      mbr.writeUInt32LE(PARTITION_START_LBA, p + 8);
      mbr.writeUInt32LE(geo.volumeSectors, p + 12);
      mbr.fill(0xFE, p + 1, p + 4);
      mbr.fill(0xFF, p + 5, p + 8);
      mbr.writeUInt16LE(0xAA55, 510);
      disk.write(mbr, 0);

      const at = sector => volumeStart + sector * SECTOR;
      const clusterAt = c => volumeStart + (geo.heapOffsetSectors * SECTOR) + (c - 2) * CLUSTER;
      const boot = exfatBootRegion(geo);
      disk.write(boot, at(0));
      disk.write(boot, at(12));
      disk.write(exfatFat(geo), at(geo.fatOffsetSectors));

      const bitmap = Buffer.alloc(geo.bitmapBytes);
      for (let c = 0; c < geo.usedClusters; c++) bitmap[c >> 3] |= 1 << (c & 7);
      disk.write(bitmap, clusterAt(geo.bitmapCluster));
      disk.write(UPCASE, clusterAt(geo.upcaseCluster));

      // Root directory: label, bitmap, upcase, then the tree.
      const rootEntries = [];
      const labelEntry = Buffer.alloc(32);
      labelEntry[0] = 0x83;
      labelEntry[1] = label.length;
      labelEntry.write(label, 2, 'utf16le');
      rootEntries.push(labelEntry);
      const bitmapEntry = Buffer.alloc(32);
      bitmapEntry[0] = 0x81;
      bitmapEntry.writeUInt32LE(geo.bitmapCluster, 20);
      bitmapEntry.writeBigUInt64LE(BigInt(geo.bitmapBytes), 24);
      rootEntries.push(bitmapEntry);
      const upcaseEntry = Buffer.alloc(32);
      upcaseEntry[0] = 0x82;
      upcaseEntry.writeUInt32LE(upcaseChecksum(), 4);
      upcaseEntry.writeUInt32LE(geo.upcaseCluster, 20);
      upcaseEntry.writeBigUInt64LE(BigInt(UPCASE.length), 24);
      rootEntries.push(upcaseEntry);

      const entriesFor = (node) => [
        ...node.dirs.map(d => directoryEntrySet({ name: d.shownName, isDirectory: true, firstCluster: d.cluster, size: clustersFor(d.dirBytes) * CLUSTER, mtime: new Date() })),
        ...node.files.map(f => directoryEntrySet({ name: f.shownName, isDirectory: false, firstCluster: f.cluster, size: f.size, mtime: f.mtime })),
      ];
      disk.write(Buffer.concat([...rootEntries, ...entriesFor(root)]), clusterAt(geo.rootCluster));
      const writeDirs = (node) => {
        for (const d of node.dirs) {
          disk.write(Buffer.concat(entriesFor(d)), clusterAt(d.cluster));
          writeDirs(d);
        }
      };
      writeDirs(root);

      const copy = Buffer.allocUnsafe(COPY_CHUNK);
      for (const f of geo.v.allFiles) {
        if (!f.size) continue;
        const src = fs.openSync(f.full, 'r');
        try {
          let done = 0;
          for (;;) {
            const n = fs.readSync(src, copy, 0, COPY_CHUNK, done);
            if (!n) break;
            disk.write(copy.subarray(0, n), clusterAt(f.cluster) + done);
            done += n;
          }
          if (done !== f.size) throw new Error(`${f.rel} changed size while being packaged`);
        } finally {
          fs.closeSync(src);
        }
      }

      // BAT: every block up to the last one written is present; the rest of the disk is sparse.
      const usedBlocks = Math.ceil(disk.highWater / VHDX_BLOCK);
      const bat = Buffer.alloc(batLength);
      for (let block = 0; block < usedBlocks; block++) {
        const entry = (BigInt(dataStart + block * VHDX_BLOCK) >> 20n) << 20n | 6n; // PAYLOAD_BLOCK_FULLY_PRESENT
        const index = block + Math.floor(block / CHUNK_RATIO);
        bat.writeBigUInt64LE(entry, index * 8);
      }
      fs.writeSync(fd, bat, 0, bat.length, batOffset);
      fs.ftruncateSync(fd, dataStart + usedBlocks * VHDX_BLOCK);

      // Read every file back through the virtual disk layout and compare.
      const mismatches = [];
      const readBuf = Buffer.allocUnsafe(COPY_CHUNK);
      for (const f of geo.v.allFiles) {
        const hash = crypto.createHash('sha256');
        for (let done = 0; done < f.size;) {
          const want = Math.min(COPY_CHUNK, f.size - done);
          const n = disk.read(readBuf.subarray(0, want), clusterAt(f.cluster) + done);
          if (!n) break;
          hash.update(readBuf.subarray(0, n));
          done += n;
        }
        if (hash.digest('hex') !== f.sha256) mismatches.push(f.rel);
      }
      if (mismatches.length) throw new Error(`Files did not read back correctly from the container: ${mismatches.slice(0, 5).join(', ')}`);
    } catch (err) {
      fs.closeSync(fd);
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    fs.closeSync(fd);
    fs.renameSync(tmp, outputPath);

    const hashes = await HashManager.computeFileStreaming(outputPath, ['md5', 'sha1', 'sha256']);
    fs.writeFileSync(`${outputPath}.sha256`, `${hashes.sha256}  ${path.basename(outputPath)}\n`);
    return {
      outputPath,
      size: hashes.byteLength,
      virtualDiskSize: virtualSize,
      fileCount: flat.length,
      payloadSize: flat.reduce((s, f) => s + f.size, 0),
      fileSystem: 'exFAT',
      contentsManifest: manifestPath,
      hashes,
      format: 'VHDX',
      note: 'Every file was read back from the container and matched its SHA-256 before the image was finished. Attach it read-only in Disk Management or with Mount-DiskImage -Access ReadOnly.',
    };
  }

  // ── ZIP Container with Deflate Compression ──

  static collectFiles(dir) {
    const files = [];
    const walk = (d) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else files.push({ path: full, name: entry.name, size: fs.statSync(full).size });
      }
    };
    walk(dir);
    return files;
  }

  // entries: [{ name (archive path), path (file on disk) }]. Returns the archive buffer's summary after writing.
  static writeZip(entriesToAdd, outputPath, options = {}) {
    const compressionLevel = options.compressionLevel ?? 6;
    const locals = [];
    const centrals = [];
    const entries = [];
    let offset = 0;

    for (const item of entriesToAdd) {
      const fileData = fs.readFileSync(item.path);
      const crc = zlib.crc32(fileData);
      const compressed = compressionLevel > 0 ? zlib.deflateRawSync(fileData, { level: compressionLevel }) : fileData;
      const method = compressionLevel > 0 ? 8 : 0;
      const nameBytes = Buffer.from(item.name.replace(/\\/g, '/'), 'utf8');
      const when = fs.statSync(item.path).mtime;
      const dosTime = ((when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1)) & 0xFFFF;
      const dosDate = (((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate()) & 0xFFFF;

      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034B50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6); // UTF-8 names
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(dosTime, 10);
      local.writeUInt16LE(dosDate, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(compressed.length, 18);
      local.writeUInt32LE(fileData.length, 22);
      local.writeUInt16LE(nameBytes.length, 26);
      locals.push(local, nameBytes, compressed);

      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014B50, 0);
      central.writeUInt16LE(0x033F, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(0x0800, 8);
      central.writeUInt16LE(method, 10);
      central.writeUInt16LE(dosTime, 12);
      central.writeUInt16LE(dosDate, 14);
      central.writeUInt32LE(crc, 16);
      central.writeUInt32LE(compressed.length, 20);
      central.writeUInt32LE(fileData.length, 24);
      central.writeUInt16LE(nameBytes.length, 28);
      central.writeUInt32LE(offset, 42);
      centrals.push(central, nameBytes);
      offset += 30 + nameBytes.length + compressed.length;

      entries.push({ name: item.name, originalSize: fileData.length, compressedSize: compressed.length, crc32: crc.toString(16).padStart(8, '0') });
    }

    const centralData = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054B50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralData.length, 12);
    eocd.writeUInt32LE(offset, 16);
    const archive = Buffer.concat([...locals, centralData, eocd]);

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, archive);
    const totalOriginal = entries.reduce((s, e) => s + e.originalSize, 0);
    return {
      outputPath,
      size: archive.length,
      fileCount: entries.length,
      totalOriginalSize: totalOriginal,
      compressionRatio: totalOriginal > 0 ? `${((1 - archive.length / totalOriginal) * 100).toFixed(1)}%` : '0%',
      hashes: HashManager.computeAll(archive),
      entries,
      format: 'ZIP',
    };
  }
}
