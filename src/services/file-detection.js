import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const SIGNATURES = [
  { ext: 'pdf',  mime: 'application/pdf',                    magic: Buffer.from([0x25, 0x50, 0x44, 0x46]) },
  { ext: 'zip',  mime: 'application/zip',                    magic: Buffer.from([0x50, 0x4B, 0x03, 0x04]) },
  { ext: 'rar',  mime: 'application/x-rar-compressed',       magic: Buffer.from([0x52, 0x61, 0x72, 0x21]) },
  { ext: '7z',   mime: 'application/x-7z-compressed',        magic: Buffer.from([0x37, 0x7A, 0xBC, 0xAF]) },
  { ext: 'gz',   mime: 'application/gzip',                   magic: Buffer.from([0x1F, 0x8B]) },
  { ext: 'bz2',  mime: 'application/x-bzip2',                magic: Buffer.from([0x42, 0x5A, 0x68]) },
  { ext: 'png',  mime: 'image/png',                          magic: Buffer.from([0x89, 0x50, 0x4E, 0x47]) },
  { ext: 'jpg',  mime: 'image/jpeg',                         magic: Buffer.from([0xFF, 0xD8, 0xFF]) },
  { ext: 'gif',  mime: 'image/gif',                          magic: Buffer.from([0x47, 0x49, 0x46, 0x38]) },
  { ext: 'bmp',  mime: 'image/bmp',                          magic: Buffer.from([0x42, 0x4D]) },
  { ext: 'tiff', mime: 'image/tiff',                         magic: Buffer.from([0x49, 0x49, 0x2A, 0x00]) },
  { ext: 'tiff', mime: 'image/tiff',                         magic: Buffer.from([0x4D, 0x4D, 0x00, 0x2A]) },
  { ext: 'webp', mime: 'image/webp',                         magic: Buffer.from('RIFF') },
  { ext: 'doc',  mime: 'application/msword',                 magic: Buffer.from([0xD0, 0xCF, 0x11, 0xE0]) },
  { ext: 'exe',  mime: 'application/x-msdownload',           magic: Buffer.from([0x4D, 0x5A]) },
  { ext: 'elf',  mime: 'application/x-elf',                  magic: Buffer.from([0x7F, 0x45, 0x4C, 0x46]) },
  { ext: 'pst',  mime: 'application/vnd.ms-outlook',         magic: Buffer.from([0x21, 0x42, 0x44, 0x4E]) },
  { ext: 'msg',  mime: 'application/vnd.ms-outlook',         magic: Buffer.from([0xD0, 0xCF, 0x11, 0xE0]) },
  { ext: 'eml',  mime: 'message/rfc822',                     magic: null },
  { ext: 'mbox', mime: 'application/mbox',                   magic: Buffer.from('From ') },
  { ext: 'sqlite', mime: 'application/x-sqlite3',            magic: Buffer.from('SQLite format 3') },
  { ext: 'xml',  mime: 'application/xml',                    magic: Buffer.from('<?xml') },
  { ext: 'html', mime: 'text/html',                          magic: Buffer.from('<!DOCTYPE') },
  { ext: 'rtf',  mime: 'application/rtf',                    magic: Buffer.from('{\\rtf') },
  { ext: 'vhdx', mime: 'application/x-vhdx',                 magic: Buffer.from('vhdxfile') },
];

const EXTENSION_MAP = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt':  'application/vnd.oasis.opendocument.text',
  '.ods':  'application/vnd.oasis.opendocument.spreadsheet',
  '.csv':  'text/csv',
  '.json': 'application/json',
  '.txt':  'text/plain',
  '.md':   'text/markdown',
  '.log':  'text/plain',
  '.eml':  'message/rfc822',
  '.mbox': 'application/mbox',
  '.pst':  'application/vnd.ms-outlook',
  '.ost':  'application/vnd.ms-outlook',
  '.p7m':  'application/pkcs7-mime',
  '.p7s':  'application/pkcs7-signature',
  '.ics':  'text/calendar',
  '.vcf':  'text/vcard',
};

export class FileTypeDetector {

  static detect(filePath) {
    const result = { filePath, detectedType: null, mime: null, extension: null, confidence: 0, method: null };

    try {
      const fd = fs.openSync(filePath, 'r');
      const header = Buffer.alloc(32);
      fs.readSync(fd, header, 0, 32, 0);
      fs.closeSync(fd);

      for (const sig of SIGNATURES) {
        if (!sig.magic) continue;
        if (header.subarray(0, sig.magic.length).equals(sig.magic)) {
          result.detectedType = sig.ext;
          result.mime = sig.mime;
          result.extension = `.${sig.ext}`;
          result.confidence = 95;
          result.method = 'magic-bytes';
          return result;
        }
      }

      const text = header.toString('utf8');
      if (text.match(/^(From|To|Subject|Date|Received|MIME-Version):/im)) {
        result.detectedType = 'eml';
        result.mime = 'message/rfc822';
        result.extension = '.eml';
        result.confidence = 85;
        result.method = 'header-detection';
        return result;
      }
    } catch {}

    const ext = path.extname(filePath).toLowerCase();
    if (EXTENSION_MAP[ext]) {
      result.detectedType = ext.slice(1);
      result.mime = EXTENSION_MAP[ext];
      result.extension = ext;
      result.confidence = 60;
      result.method = 'extension';
    }

    return result;
  }

  static detectBuffer(data, filename = null) {
    for (const sig of SIGNATURES) {
      if (!sig.magic) continue;
      if (data.length >= sig.magic.length && data.subarray(0, sig.magic.length).equals(sig.magic)) {
        return { detectedType: sig.ext, mime: sig.mime, confidence: 95, method: 'magic-bytes' };
      }
    }
    const text = data.subarray(0, 200).toString('utf8');
    if (text.match(/^(From|To|Subject|Date|Received|MIME-Version):/im)) {
      return { detectedType: 'eml', mime: 'message/rfc822', confidence: 85, method: 'header-detection' };
    }
    if (filename) {
      const ext = path.extname(filename).toLowerCase();
      if (EXTENSION_MAP[ext]) return { detectedType: ext.slice(1), mime: EXTENSION_MAP[ext], confidence: 60, method: 'extension' };
    }
    return { detectedType: 'unknown', mime: 'application/octet-stream', confidence: 0, method: 'none' };
  }

  static isArchive(filePath) {
    const det = this.detect(filePath);
    return ['zip', 'rar', '7z', 'gz', 'bz2'].includes(det.detectedType);
  }

  static isEmailFile(filePath) {
    const det = this.detect(filePath);
    return ['eml', 'msg', 'mbox', 'pst'].includes(det.detectedType);
  }

  static classifyAttachment(filename, data) {
    const det = data ? this.detectBuffer(data, filename) : { detectedType: null, mime: null };
    const ext = path.extname(filename || '').toLowerCase();

    const categories = {
      document: ['.doc', '.docx', '.pdf', '.odt', '.rtf', '.txt', '.md', '.xlsx', '.pptx', '.ods', '.csv'],
      image: ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.webp', '.svg', '.ico'],
      audio: ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'],
      video: ['.mp4', '.avi', '.mkv', '.mov', '.wmv', '.webm'],
      archive: ['.zip', '.rar', '.7z', '.gz', '.bz2', '.tar'],
      email: ['.eml', '.msg'],
      calendar: ['.ics'],
      contact: ['.vcf'],
      crypto: ['.p7m', '.p7s', '.pem', '.pfx', '.cer', '.crt'],
      executable: ['.exe', '.dll', '.bat', '.cmd', '.ps1', '.sh'],
    };

    let category = 'other';
    for (const [cat, exts] of Object.entries(categories)) {
      if (exts.includes(ext)) { category = cat; break; }
    }

    return {
      filename,
      extension: ext,
      detectedType: det.detectedType || ext.slice(1) || 'unknown',
      mime: det.mime || EXTENSION_MAP[ext] || 'application/octet-stream',
      category,
      forensicRisk: category === 'executable' ? 'high' : category === 'archive' ? 'medium' : 'low',
    };
  }
}
