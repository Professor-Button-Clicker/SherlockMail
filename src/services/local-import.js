import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { simpleParser } from 'mailparser';
import { HashManager } from './hash-manager.js';
import { PstReader } from './pst/pst-reader.js';
import { buildMime } from './pst/pst-to-mime.js';
import { hashFile } from './pst/pst-export.js';

const safeSegment = s => (s || '_').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '_').slice(0, 80);

export class LocalImportService {

  static async importMbox(filePath, projectId, options = {}) {
    const content = fs.readFileSync(filePath, 'utf8');
    const messages = this._parseMbox(content);
    const results = [];

    for (let i = 0; i < messages.length; i++) {
      try {
        const parsed = await simpleParser(messages[i].raw);
        const hashes = HashManager.computeAll(messages[i].raw);
        results.push({
          id: uuidv4(),
          projectId,
          folder: options.targetFolder || 'Imported/MBOX',
          subject: parsed.subject || '(no subject)',
          fromAddress: parsed.from?.text || '',
          toAddresses: parsed.to?.value?.map(a => a.address) || [],
          ccAddresses: parsed.cc?.value?.map(a => a.address) || [],
          date: parsed.date?.toISOString() || null,
          messageId: parsed.messageId || null,
          inReplyTo: parsed.inReplyTo || null,
          size: Buffer.byteLength(messages[i].raw),
          hasAttachments: (parsed.attachments?.length || 0) > 0,
          attachmentCount: parsed.attachments?.length || 0,
          hashMd5: hashes.md5,
          hashSha1: hashes.sha1,
          hashSha256: hashes.sha256,
          hashSha384: hashes.sha384,
          hashSha512: hashes.sha512,
          bodyText: parsed.text || '',
          bodyHtml: parsed.html || '',
          headers: parsed.headers ? Object.fromEntries(parsed.headers) : {},
          isEncrypted: this._detectEncryption(parsed),
          isSigned: this._detectSignature(parsed),
          source: 'mbox_import',
          sourceFile: path.basename(filePath),
          attachments: (parsed.attachments || []).map(att => ({
            id: uuidv4(),
            filename: att.filename || 'unnamed',
            contentType: att.contentType,
            size: att.size,
            hashSha256: crypto.createHash('sha256').update(att.content).digest('hex'),
            hashMd5: crypto.createHash('md5').update(att.content).digest('hex'),
            content: att.content,
          })),
        });
      } catch (err) {
        results.push({ error: err.message, index: i, source: 'mbox_import' });
      }
    }

    return {
      source: filePath,
      format: 'mbox',
      totalParsed: messages.length,
      successful: results.filter(r => !r.error).length,
      failed: results.filter(r => r.error).length,
      messages: results,
    };
  }

  static async importEmlDirectory(dirPath, projectId, options = {}) {
    const files = fs.readdirSync(dirPath).filter(f => f.toLowerCase().endsWith('.eml'));
    const results = [];

    for (const file of files) {
      try {
        const filePath = path.join(dirPath, file);
        const raw = fs.readFileSync(filePath);
        const parsed = await simpleParser(raw);
        const hashes = HashManager.computeAll(raw);

        results.push({
          id: uuidv4(),
          projectId,
          folder: options.targetFolder || 'Imported/EML',
          subject: parsed.subject || '(no subject)',
          fromAddress: parsed.from?.text || '',
          toAddresses: parsed.to?.value?.map(a => a.address) || [],
          ccAddresses: parsed.cc?.value?.map(a => a.address) || [],
          date: parsed.date?.toISOString() || null,
          messageId: parsed.messageId || null,
          size: raw.length,
          hasAttachments: (parsed.attachments?.length || 0) > 0,
          attachmentCount: parsed.attachments?.length || 0,
          hashMd5: hashes.md5,
          hashSha1: hashes.sha1,
          hashSha256: hashes.sha256,
          hashSha384: hashes.sha384,
          hashSha512: hashes.sha512,
          bodyText: parsed.text || '',
          bodyHtml: parsed.html || '',
          emlPath: filePath,
          source: 'eml_import',
          sourceFile: file,
        });
      } catch (err) {
        results.push({ error: err.message, file, source: 'eml_import' });
      }
    }

    return {
      source: dirPath,
      format: 'eml',
      totalFiles: files.length,
      successful: results.filter(r => !r.error).length,
      failed: results.filter(r => r.error).length,
      messages: results,
    };
  }

  // Reads a real Outlook PST (Unicode or ANSI, any encoding) without modifying it. Each item is rebuilt
  // as an EML under options.outputDir (labelled as a reconstruction: a PST keeps properties, not MIME),
  // hashed, and handed to options.save in batches. The PST's own SHA-256 is taken before and after.
  static async importPst(filePath, projectId, options = {}) {
    const outputDir = options.outputDir;
    if (!outputDir) throw new Error('importPst needs an output folder for the rebuilt messages');
    const save = options.save || (() => {});
    const baseFolder = options.targetFolder || `Imported/PST/${path.basename(filePath, path.extname(filePath))}`;
    const sourceSha256 = await hashFile(filePath);
    const reader = new PstReader(filePath);
    fs.mkdirSync(outputDir, { recursive: true });
    const items = [];
    const errors = [];
    const folderCounts = {};
    let successful = 0;
    let batch = [];
    let storeInfo = {};
    const flush = () => { if (batch.length) { save(batch); batch = []; } };
    try {
      const named = reader.namedProperties();
      const namedTag = (name, type) => {
        for (const [id, e] of named) if (e.name && e.name.toLowerCase() === name) return ((id << 16) | type) >>> 0;
        return null;
      };
      const keywordsTag = namedTag('keywords', 0x101F);
      const originalShaTag = namedTag('x-sherlockmail-original-sha256', 0x001F);
      const store = reader.store();
      storeInfo = {
        displayName: store.get(0x3001001F) || store.get(0x3001001E) || '',
        // A PST password only gates Outlook's UI (MS-PST 2.4.3.3); the data is readable without it.
        passwordProtected: !!store.get(0x67FF0003),
        pstFormat: `${reader.unicode ? 'Unicode' : 'ANSI'} ${reader.isOst ? 'OST' : 'PST'} (version ${reader.version}, encoding ${['none', 'permute', 'cyclic'][reader.crypt] ?? reader.crypt})`,
      };

      for (const folder of reader.folders()) {
        if (folder.error) { errors.push({ folder: folder.path.join('/'), error: folder.error }); continue; }
        if (folder.isRoot) continue;
        let nids;
        try { nids = reader.folderMessages(folder.nid); } catch (err) { errors.push({ folder: folder.path.join('/'), error: `contents table: ${err.message}` }); continue; }
        const pstFolder = folder.path.join('/');
        const dbFolder = [baseFolder, ...folder.path].filter(Boolean).join('/');
        const dir = path.join(outputDir, ...folder.path.map(safeSegment));
        if (nids.length) fs.mkdirSync(dir, { recursive: true });
        for (const nid of nids) {
          const ref = `0x${nid.toString(16)}`;
          try {
            const msg = reader.message(nid);
            const notes = [];
            const eml = Buffer.from(buildMime(msg, { provenance: `${path.basename(filePath)}, folder "${pstFolder}", item ${ref}`, notes }), 'utf8');
            const emlPath = path.join(dir, `${String(++folderCounts[pstFolder] || (folderCounts[pstFolder] = 1)).padStart(6, '0')}_${ref}.eml`);
            fs.writeFileSync(emlPath, eml, { flag: 'wx' });
            const parsed = await simpleParser(eml);
            const hashes = HashManager.computeAll(eml);
            const p = msg.props;
            const flags = [];
            if ((p.get(0x0E070003) || 0) & 0x01) flags.push('\\Seen');
            if (p.get(0x10900003) === 2) flags.push('\\Flagged');
            const delivered = p.get(0x0E060040);
            const keywords = keywordsTag ? p.get(keywordsTag) : null;
            const record = {
              id: uuidv4(),
              projectId,
              folder: dbFolder,
              subject: parsed.subject || '(no subject)',
              fromAddress: parsed.from?.text || '',
              toAddresses: parsed.to?.value?.map(a => a.address) || [],
              ccAddresses: parsed.cc?.value?.map(a => a.address) || [],
              bccAddresses: parsed.bcc?.value?.map(a => a.address) || [],
              date: parsed.date?.toISOString() || null,
              internalDate: delivered instanceof Date ? delivered.toISOString() : null,
              messageId: parsed.messageId || null,
              inReplyTo: parsed.inReplyTo || null,
              size: eml.length,
              flags,
              gmailLabels: Array.isArray(keywords) && keywords.length ? keywords : undefined,
              hasAttachments: (parsed.attachments?.length || 0) > 0,
              attachmentCount: parsed.attachments?.length || 0,
              contentType: parsed.headers.get('content-type')?.value || 'text/plain',
              hashMd5: hashes.md5,
              hashSha256: hashes.sha256,
              hashSha512: hashes.sha512,
              emlPath,
              bodyText: parsed.text || '',
              bodyHtml: parsed.html || '',
              headers: parsed.headers ? Object.fromEntries(parsed.headers) : {},
              isEncrypted: this._detectEncryption(parsed),
              isSigned: this._detectSignature(parsed),
              source: 'pst_import',
              sourceFile: path.basename(filePath),
              attachments: (parsed.attachments || []).map(att => ({
                id: uuidv4(),
                filename: att.filename || 'unnamed',
                contentType: att.contentType,
                size: att.size,
                hashSha256: crypto.createHash('sha256').update(att.content).digest('hex'),
                hashMd5: crypto.createHash('md5').update(att.content).digest('hex'),
                disposition: att.contentDisposition,
                contentId: att.cid,
                isInline: att.contentDisposition === 'inline',
              })),
            };
            batch.push(record);
            if (batch.length >= 200) flush();
            successful++;
            items.push({ emlPath: path.relative(outputDir, emlPath), pstFolder, nid: ref, subject: record.subject, messageId: record.messageId || '', sha256: hashes.sha256, originalSha256: originalShaTag ? (p.get(originalShaTag) || '') : '', notes: notes.join('; ') });
          } catch (err) {
            errors.push({ folder: pstFolder, item: ref, error: err.message });
          }
          options.onProgress?.(successful, errors.length);
        }
      }
      flush();
    } finally {
      reader.close();
    }

    const sourceUnchanged = (await hashFile(filePath)) === sourceSha256;
    const csv = v => { const t = String(v ?? ''); return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const map = [['EML File', 'PST Folder', 'PST Item', 'Subject', 'Internet Message-ID', 'EML SHA-256', 'SHA-256 of original MIME (recorded in PST)', 'Not carried over'].join(','),
      ...items.map(i => [i.emlPath, i.pstFolder, i.nid, i.subject, i.messageId, i.sha256, i.originalSha256, i.notes].map(csv).join(','))].join('\r\n') + '\r\n';
    fs.writeFileSync(path.join(outputDir, 'pst_import_map.csv'), map, 'utf8');
    if (errors.length) {
      fs.writeFileSync(path.join(outputDir, 'pst_import_errors.txt'), errors.map(e => [e.folder, e.item || '', e.error].join('\t')).join('\r\n') + '\r\n', 'utf8');
    }

    return {
      source: filePath,
      format: 'pst',
      sourceSha256,
      sourceUnchanged,
      ...storeInfo,
      outputDir,
      totalParsed: successful + errors.filter(e => e.item).length,
      successful,
      failed: errors.filter(e => e.item).length,
      folderErrors: errors.filter(e => !e.item).length,
      errors: errors.slice(0, 50),
      messages: [],
    };
  }

  static _parseMbox(content) {
    const messages = [];
    const parts = content.split(/^From /gm);
    for (let i = 1; i < parts.length; i++) {
      const firstNewline = parts[i].indexOf('\n');
      const raw = parts[i].substring(firstNewline + 1).replace(/^>From /gm, 'From ');
      if (raw.trim()) messages.push({ raw });
    }
    return messages;
  }

  static _detectEncryption(parsed) {
    const ct = parsed.contentType?.value || '';
    return ct.includes('pkcs7-mime') || ct.includes('x-pkcs7-mime') || ct.includes('encrypted');
  }

  static _detectSignature(parsed) {
    const ct = parsed.contentType?.value || '';
    return ct.includes('pkcs7-signature') || ct.includes('x-pkcs7-signature') || ct.includes('signed');
  }

  static getSupportedFormats() {
    return {
      mbox: { extensions: ['.mbox', '.mbx'], description: 'Unix MBOX mailbox (Google Takeout, Thunderbird export)', method: 'importMbox' },
      eml: { extensions: ['.eml'], description: 'RFC 5322 email messages (individual files or directory)', method: 'importEmlDirectory' },
      pst: { extensions: ['.pst'], description: 'Outlook data files (Unicode and ANSI PST); items are rebuilt as EML and labelled as reconstructions', method: 'importPst' },
    };
  }
}
