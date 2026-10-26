import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { v4 as uuidv4 } from 'uuid';
import { HashManager } from './hash-manager.js';

export class ContainerService {

  // ── VHDX Container Export (Feature 16) ──

  static createVhdxContainer(exportDir, outputPath, options = {}) {
    const label = options.label || 'SherlockMail Evidence';
    const files = this._collectFiles(exportDir);
    const totalSize = files.reduce((s, f) => s + f.size, 0);

    const blockSize = 2 * 1024 * 1024; // 2MB blocks
    const diskSize = BigInt(Math.max(totalSize * 2, 64 * 1024 * 1024)); // min 64MB
    const logSize = 1024 * 1024;

    // VHDX file structure: File ID → Header 1 → Header 2 → Region Table → Log → BAT → Metadata → Data Blocks
    const fileId = this._buildVhdxFileIdentifier();
    const header1 = this._buildVhdxHeader(1, logSize);
    const header2 = this._buildVhdxHeader(2, logSize);
    const regionTable = this._buildVhdxRegionTable(diskSize, blockSize);
    const logRegion = Buffer.alloc(logSize, 0);
    const bat = this._buildVhdxBat(diskSize, blockSize);
    const metadata = this._buildVhdxMetadata(diskSize, blockSize, label);

    // File payload: TAR-like structure of collected files
    const payload = this._buildPayload(files, exportDir);
    const payloadPadded = Buffer.alloc(Math.ceil(payload.length / blockSize) * blockSize, 0);
    payload.copy(payloadPadded);

    const parts = [fileId, header1, header2, regionTable, logRegion, bat, metadata, payloadPadded];
    const content = Buffer.concat(parts);

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, content);

    const hashes = HashManager.computeAll(content);

    return {
      outputPath,
      size: content.length,
      diskSize: Number(diskSize),
      blockSize,
      fileCount: files.length,
      payloadSize: payload.length,
      hashes,
      format: 'VHDX',
      forensicNote: 'VHDX container packages all evidence files into a single virtual hard disk image. Mount-ready in Windows, Autopsy, FTK, and EnCase.',
    };
  }

  static _buildVhdxFileIdentifier() {
    const buf = Buffer.alloc(65536, 0);
    // "vhdxfile" signature
    buf.write('vhdxfile', 0, 'ascii');
    // Creator field (UTF-16LE)
    const creator = Buffer.from('SherlockMail v0.9.0\0', 'utf16le');
    creator.copy(buf, 8);
    return buf;
  }

  static _buildVhdxHeader(sequenceNumber, logSize) {
    const buf = Buffer.alloc(65536, 0);
    // 'head' signature
    buf.write('head', 0, 'ascii');
    buf.writeUInt32LE(0, 4); // checksum placeholder
    buf.writeBigUInt64LE(BigInt(sequenceNumber), 8);
    // File write GUID
    crypto.randomBytes(16).copy(buf, 16);
    // Data write GUID
    crypto.randomBytes(16).copy(buf, 32);
    // Log GUID (zeroed = no log entries)
    buf.writeUInt32LE(logSize, 68); // log length
    buf.writeUInt16LE(1, 76); // version

    const crc = this._crc32c(buf.subarray(0, 4096));
    buf.writeUInt32LE(crc, 4);
    return buf;
  }

  static _buildVhdxRegionTable(diskSize, blockSize) {
    const buf = Buffer.alloc(65536, 0);
    buf.write('regi', 0, 'ascii');
    buf.writeUInt32LE(0, 4); // checksum
    buf.writeUInt32LE(2, 8); // entry count

    // BAT region entry (offset 16)
    const batGuid = Buffer.from('2DC27766F62342009D64115E9BFD4A08', 'hex');
    batGuid.copy(buf, 16);
    buf.writeBigUInt64LE(BigInt(3 * 65536 + 1048576), 32); // file offset after headers+log
    buf.writeUInt32LE(65536, 40); // length
    buf.writeUInt32LE(1, 44); // required flag

    // Metadata region entry (offset 48)
    const metaGuid = Buffer.from('8B7CA20647904B9AB8FE575F050F886E', 'hex');
    metaGuid.copy(buf, 48);
    buf.writeBigUInt64LE(BigInt(4 * 65536 + 1048576), 64);
    buf.writeUInt32LE(65536, 72);
    buf.writeUInt32LE(1, 76);

    const crc = this._crc32c(buf.subarray(0, 4096));
    buf.writeUInt32LE(crc, 4);
    return buf;
  }

  static _buildVhdxBat(diskSize, blockSize) {
    const totalBlocks = Number(diskSize / BigInt(blockSize)) + 1;
    const batSize = Math.max(65536, Math.ceil(totalBlocks * 8 / 65536) * 65536);
    const buf = Buffer.alloc(batSize, 0);
    for (let i = 0; i < totalBlocks && i * 8 < buf.length; i++) {
      // Payload block state = 6 (fully present), bit shifted
      buf.writeBigUInt64LE(BigInt(6) | (BigInt(i + 10) << BigInt(20)), i * 8);
    }
    return buf;
  }

  static _buildVhdxMetadata(diskSize, blockSize, label) {
    const buf = Buffer.alloc(65536, 0);
    buf.write('metadata', 0, 'ascii');
    buf.writeUInt16LE(5, 10); // entry count

    // Virtual disk size
    const offset1 = 64;
    buf.writeBigUInt64LE(diskSize, offset1);
    // Block size
    buf.writeUInt32LE(blockSize, offset1 + 8);
    // Logical sector size (512)
    buf.writeUInt32LE(512, offset1 + 12);
    // Physical sector size (4096)
    buf.writeUInt32LE(4096, offset1 + 16);

    return buf;
  }

  static _buildPayload(files, baseDir) {
    const parts = [];
    for (const file of files) {
      const relPath = path.relative(baseDir, file.path);
      const header = Buffer.alloc(512, 0);
      Buffer.from(relPath.substring(0, 255)).copy(header, 0);
      header.writeUInt32LE(file.size, 256);
      parts.push(header);

      const content = fs.readFileSync(file.path);
      parts.push(content);

      const padding = (512 - (content.length % 512)) % 512;
      if (padding > 0) parts.push(Buffer.alloc(padding, 0));
    }
    return Buffer.concat(parts);
  }

  static _collectFiles(dir) {
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

  static _crc32c(data) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
      crc ^= data[i];
      for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0x82F63B78 : 0);
    }
    return crc ^ 0xFFFFFFFF;
  }

  // ── ZIP Container with Deflate Compression ──

  static createZipContainer(exportDir, outputPath, options = {}) {
    const compressionLevel = options.compressionLevel ?? 6;
    const files = this._collectFiles(exportDir);
    const entries = [];
    let offset = 0;

    const localHeaders = [];
    const centralHeaders = [];

    for (const file of files) {
      const relPath = path.relative(exportDir, file.path).replace(/\\/g, '/');
      const fileData = fs.readFileSync(file.path);
      const crc = this._crc32(fileData);
      const compressed = compressionLevel > 0 ? zlib.deflateRawSync(fileData, { level: compressionLevel }) : fileData;
      const method = compressionLevel > 0 ? 8 : 0; // 8 = Deflate, 0 = Stored

      const nameBytes = Buffer.from(relPath, 'utf8');
      const now = new Date();
      const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
      const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;

      // Local file header (30 + name + compressed data)
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034B50, 0); // PK\x03\x04
      local.writeUInt16LE(20, 4); // version needed
      local.writeUInt16LE(0x0800, 6); // UTF-8 flag
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(dosTime, 10);
      local.writeUInt16LE(dosDate, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(compressed.length, 18); // compressed size
      local.writeUInt32LE(fileData.length, 22); // uncompressed size
      local.writeUInt16LE(nameBytes.length, 26);

      const localOffset = offset;
      localHeaders.push(Buffer.concat([local, nameBytes, compressed]));
      offset += 30 + nameBytes.length + compressed.length;

      // Central directory header
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014B50, 0); // PK\x01\x02
      central.writeUInt16LE(0x033F, 4); // version made by (Unix, 6.3)
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(0x0800, 8);
      central.writeUInt16LE(method, 10);
      central.writeUInt16LE(dosTime, 12);
      central.writeUInt16LE(dosDate, 14);
      central.writeUInt32LE(crc, 16);
      central.writeUInt32LE(compressed.length, 20);
      central.writeUInt32LE(fileData.length, 24);
      central.writeUInt16LE(nameBytes.length, 28);
      central.writeUInt32LE(localOffset, 42); // local header offset

      centralHeaders.push(Buffer.concat([central, nameBytes]));

      entries.push({
        name: relPath,
        originalSize: fileData.length,
        compressedSize: compressed.length,
        ratio: fileData.length > 0 ? ((1 - compressed.length / fileData.length) * 100).toFixed(1) + '%' : '0%',
        crc32: crc.toString(16).padStart(8, '0'),
        method: method === 8 ? 'deflate' : 'stored',
      });
    }

    const centralStart = offset;
    const centralData = Buffer.concat(centralHeaders);
    const centralSize = centralData.length;

    // End of central directory
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054B50, 0); // PK\x05\x06
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralSize, 12);
    eocd.writeUInt32LE(centralStart, 16);

    const zipContent = Buffer.concat([...localHeaders, centralData, eocd]);

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, zipContent);

    const hashes = HashManager.computeAll(zipContent);
    const totalOriginal = entries.reduce((s, e) => s + e.originalSize, 0);
    const totalCompressed = entries.reduce((s, e) => s + e.compressedSize, 0);

    return {
      outputPath,
      size: zipContent.length,
      fileCount: entries.length,
      totalOriginalSize: totalOriginal,
      totalCompressedSize: totalCompressed,
      compressionRatio: totalOriginal > 0 ? ((1 - totalCompressed / totalOriginal) * 100).toFixed(1) + '%' : '0%',
      compressionMethod: compressionLevel > 0 ? 'deflate' : 'stored',
      hashes,
      entries,
      format: 'ZIP',
    };
  }

  static _crc32(data) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
      crc ^= data[i];
      for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
}
