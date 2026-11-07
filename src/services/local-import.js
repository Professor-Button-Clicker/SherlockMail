import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { simpleParser } from 'mailparser';
import { HashManager } from './hash-manager.js';
import { buildMessageRecord } from './collection-engine.js';
import { PstReader } from './pst/pst-reader.js';
import { buildMime } from './pst/pst-to-mime.js';
import { hashFile, readMbox, findSources } from './pst/pst-export.js';
import { protectionFlags } from './crypto-service.js';

const safeSegment = s => (s || '_').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '_').slice(0, 80);
const BATCH = 200;
const csvCell = (v) => { const t = String(v ?? ''); return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };

function sourceFiles(root) {
  const files = [];
  const walk = (p) => {
    if (fs.statSync(p).isDirectory()) for (const name of fs.readdirSync(p)) walk(path.join(p, name));
    else files.push(p);
  };
  walk(root);
  return files;
}

export class LocalImportService {

  // A folder of .eml files, or one .eml. Each message is copied byte for byte into the import folder and
  // the copy is checked against the source, so the case keeps its evidence and the source is only read.
  // mbox: each message of an .mbox is stored as its own EML, exactly as written apart from undoing the
  // reversible mboxrd ">From " quoting. Both record a map from each EML back to where it came from.
  static async importMail(sourcePath, projectId, options = {}) {
    const { outputDir, acquisitionId, format } = options;
    if (!outputDir) throw new Error('The import needs an output folder');
    const save = options.save || (() => {});
    const baseFolder = options.targetFolder || `Imported/${format === 'mbox' ? 'MBOX' : 'EML'}/${path.basename(sourcePath, path.extname(sourcePath))}`;
    fs.mkdirSync(outputDir, { recursive: true });

    const sources = format === 'mbox'
      ? [{ type: 'mbox', path: sourcePath, folder: [] }]
      : sourceFiles(sourcePath).filter(f => f.toLowerCase().endsWith('.eml')).map(f => ({ type: 'eml', path: f, folder: path.relative(fs.statSync(sourcePath).isDirectory() ? sourcePath : path.dirname(sourcePath), path.dirname(f)).split(path.sep).filter(Boolean) }));
    if (!sources.length) throw new Error('No .eml files found there');

    const sourceHashesBefore = new Map();
    for (const s of sources) sourceHashesBefore.set(s.path, await hashFile(s.path));

    const items = [];
    const errors = [];
    let batch = [];
    let n = 0;
    const flush = () => { if (batch.length) { save(batch); batch = []; } };
    const add = async (raw, source, folderParts, ref) => {
      const uid = ++n;
      const folder = [baseFolder, ...folderParts].filter(Boolean).join('/');
      const dir = path.join(outputDir, ...folderParts.map(safeSegment));
      fs.mkdirSync(dir, { recursive: true });
      const emlPath = path.join(dir, `${String(uid).padStart(6, '0')}.eml`);
      const record = await buildMessageRecord(raw, { uid, serviceId: ref, folder, folderPaths: [folder] });
      fs.writeFileSync(emlPath, raw, { flag: 'wx' });
      if (crypto.createHash('sha256').update(fs.readFileSync(emlPath)).digest('hex') !== record.hashSha256) {
        fs.unlinkSync(emlPath);
        throw new Error('The stored copy does not match the source bytes');
      }
      delete record.rawMime;
      for (const att of record.attachments || []) delete att.content;
      batch.push({ ...record, projectId, acquisitionId, emlPath, source: `${format}_import`, sourceFile: path.basename(source) });
      if (batch.length >= BATCH) flush();
      items.push({ emlPath: path.relative(outputDir, emlPath), source, ref, subject: record.subject, messageId: record.messageId || '', sha256: record.hashSha256, size: raw.length });
      options.onProgress?.(items.length, errors.length);
    };

    for (const s of sources) {
      try {
        if (s.type === 'eml') {
          await add(fs.readFileSync(s.path), s.path, s.folder, path.basename(s.path));
        } else {
          let index = 0;
          for await (const raw of readMbox(s.path, { unquote: options.unquoteMbox !== false })) {
            index++;
            try {
              await add(raw, s.path, s.folder, `message ${index}`);
            } catch (err) {
              errors.push({ source: s.path, item: `message ${index}`, error: err.message });
            }
          }
        }
      } catch (err) {
        errors.push({ source: s.path, item: path.basename(s.path), error: err.message });
      }
    }
    flush();

    const changed = [];
    for (const s of sources) if ((await hashFile(s.path)) !== sourceHashesBefore.get(s.path)) changed.push(s.path);

    const map = [['EML File', 'Source', 'Position', 'Subject', 'Internet Message-ID', 'SHA-256', 'Size'].join(','),
      ...items.map(i => [i.emlPath, i.source, i.ref, i.subject, i.messageId, i.sha256, i.size].map(csvCell).join(','))].join('\r\n') + '\r\n';
    fs.writeFileSync(path.join(outputDir, 'import_map.csv'), map, 'utf8');
    if (errors.length) {
      fs.writeFileSync(path.join(outputDir, 'import_errors.txt'), errors.map(e => [e.source, e.item, e.error].join('\t')).join('\r\n') + '\r\n', 'utf8');
    }

    return {
      source: sourcePath,
      format,
      sourceFiles: sources.length,
      sourceSha256: format === 'mbox' ? sourceHashesBefore.get(sourcePath) : null,
      sourceUnchanged: changed.length === 0,
      outputDir,
      totalParsed: items.length + errors.length,
      successful: items.length,
      failed: errors.length,
      errors: errors.slice(0, 50),
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
              acquisitionId: options.acquisitionId,
              uid: successful + 1,
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
              ...protectionFlags(eml),
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
            if (batch.length >= BATCH) flush();
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
    const map = [['EML File', 'PST Folder', 'PST Item', 'Subject', 'Internet Message-ID', 'EML SHA-256', 'SHA-256 of original MIME (recorded in PST)', 'Not carried over'].join(','),
      ...items.map(i => [i.emlPath, i.pstFolder, i.nid, i.subject, i.messageId, i.sha256, i.originalSha256, i.notes].map(csvCell).join(','))].join('\r\n') + '\r\n';
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
    };
  }

  static getSupportedFormats() {
    return {
      mbox: { extensions: ['.mbox', '.mbx'], description: 'Unix MBOX mailbox (Google Takeout, Thunderbird export). Each message is stored byte for byte as its own EML.' },
      eml: { extensions: ['.eml'], description: 'RFC 5322 email messages: one file, or a folder searched recursively. Each file is copied byte for byte.' },
      pst: { extensions: ['.pst', '.ost'], description: 'Outlook data files (Unicode and ANSI). A PST holds properties, not the original MIME, so items are rebuilt as EML and labelled as reconstructions.' },
    };
  }
}

export { findSources };
