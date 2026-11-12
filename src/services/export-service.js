import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';
import { exportMessagesToPst, itemMapCsv, itemMeta } from './pst/pst-export.js';
import { mimeToMsg } from './msg/msg-writer.js';
import { caseFields } from '../util/case-fields.js';
import { threadMessages } from './threading.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.SHERLOCKMAIL_DATA_DIR || path.join(__dirname, '..', '..', 'data');

export class ExportService {

  static getFormats() {
    return {
      eml: {
        name: 'EML (RFC 5322)',
        extension: '.eml',
        mimeType: 'message/rfc822',
        description: 'Standard email format. One file per message. Contains full headers, body, and MIME-encoded attachments. The gold standard for forensic preservation because it preserves the raw message exactly as received.',
        forensicValue: 'HIGH',
        preserves: ['Full headers', 'MIME structure', 'Attachments', 'Digital signatures', 'Encoding'],
        limitations: ['One file per message (many files for large collections)', 'No folder structure in filename'],
        usedBy: ['Most email clients', 'Forensic tools', 'eDiscovery platforms'],
      },
      msg: {
        name: 'MSG (Outlook)',
        extension: '.msg',
        mimeType: 'application/vnd.ms-outlook',
        description: 'Microsoft Outlook message (MS-OXMSG, Unicode). One file per message, converted from its original collected MIME: transport headers, plain and HTML bodies, sender and recipients, byte-identical attachments and attached emails as embedded messages. Each MSG carries the SHA-256 of its source message, and msg_item_map.csv ties every MSG to it.',
        forensicValue: 'HIGH',
        preserves: ['Transport headers', 'Plain and HTML bodies', 'Sender and recipients', 'Attachments (byte-identical)', 'Attached emails as embedded messages', 'Read/flag state where the source reports it', 'Gmail labels as categories'],
        limitations: ['The raw MIME itself is not inside the MSG (Outlook stores properties, not MIME); keep the EML export as the original evidence', 'S/MIME signatures cannot be re-verified from the MSG'],
        usedBy: ['Microsoft Outlook', 'Exchange', 'Forensic tools'],
      },
      pst: {
        name: 'PST (Personal Storage Table)',
        extension: '.pst',
        mimeType: 'application/vnd.ms-outlook-pst',
        description: 'Microsoft Outlook Personal Storage Table (Unicode). One container holding the collected folder hierarchy; each item is converted from its original collected MIME, keeping headers, bodies, recipients and byte-identical attachments. Split into parts at the chosen size. pst_item_map.csv ties every PST item to the SHA-256 of the message it came from.',
        forensicValue: 'HIGH',
        preserves: ['Folder hierarchy', 'Transport headers', 'Plain and HTML bodies', 'Recipients', 'Attachments (byte-identical)', 'Attached emails as items', 'Read/flag state where the source reports it', 'Gmail labels as categories'],
        limitations: ['The raw MIME itself is not inside the PST (Outlook stores properties, not MIME); keep the EML export as the original evidence', 'S/MIME signatures cannot be re-verified from the PST'],
        usedBy: ['Microsoft Outlook', 'Forensic tools', 'eDiscovery platforms'],
      },
      mbox: {
        name: 'MBOX (Unix Mailbox)',
        extension: '.mbox',
        mimeType: 'application/mbox',
        description: 'Unix mailbox (mboxrd). Every original message, byte for byte with its line endings untouched, after a "From " separator line; the only change inside a message is the reversible ">From " quoting mboxrd requires. mbox_item_map.csv gives each message\'s offset, size and SHA-256, and every message is read back from the written file and verified.',
        forensicValue: 'HIGH',
        preserves: ['Original message bytes (after reversible quoting)', 'Headers', 'MIME structure', 'Attachments'],
        limitations: ['Readers must undo the mboxrd ">From " quoting to get the exact original bytes (mbox_item_map.csv says which messages had quoted lines)', 'No standard for metadata', 'Single file can be very large'],
        usedBy: ['Thunderbird', 'Unix mail tools', 'Google Takeout'],
      },
      mime: {
        name: 'MIME (Raw)',
        extension: '.mime',
        mimeType: 'message/rfc822',
        description: 'Raw MIME content identical to EML but with .mime extension. Some tools differentiate between EML (may have added headers) and MIME (exact server response). Forensically equivalent to EML.',
        forensicValue: 'HIGH',
        preserves: ['Exact server response', 'Full MIME structure', 'All headers', 'Digital signatures'],
        limitations: ['Same as EML - one file per message'],
        usedBy: ['Forensic tools', 'Raw protocol captures'],
      },
      pdf: {
        name: 'PDF Report',
        extension: '.pdf',
        mimeType: 'application/pdf',
        description: 'PDF report with message metadata, routing headers, the full body text, attachment names and hashes. PDF\'s standard fonts cover Western European text; any other character prints as "?" and the report says how many were replaced. Keep the EML export as the original evidence.',
        forensicValue: 'MEDIUM',
        preserves: ['Message metadata', 'Body text', 'Hash values', 'Chain of custody reference'],
        limitations: ['Attachments listed but not embedded', 'Body text only (no HTML rendering)', 'Characters outside Western European text print as "?" (counted in the report)'],
        usedBy: ['Court submissions', 'Case documentation', 'Client reports'],
      },
      concordance: {
        name: 'Concordance DAT (Load File)',
        extension: '.dat',
        mimeType: 'text/plain',
        description: 'Concordance load file for eDiscovery review platforms, with the standard delimiters: DC4 (ASCII 20) between fields, thorn (ASCII 254) around values and the registered sign (ASCII 174) for line breaks inside a value. Includes an OPT cross-reference file.',
        forensicValue: 'HIGH',
        preserves: ['All metadata fields', 'Hash values', 'Folder paths', 'Date/time stamps'],
        limitations: ['Body text truncated to 32KB per field', 'Attachments referenced but not inline'],
        usedBy: ['Relativity', 'Concordance', 'Ringtail', 'Summation', 'IPRO'],
      },
      xml: {
        name: 'XML (Structured)',
        extension: '.xml',
        mimeType: 'application/xml',
        description: 'Structured XML export with full message metadata, headers, body content, and forensic hashes. Well-suited for programmatic ingestion, XSLT transformation, and integration with case management systems.',
        forensicValue: 'HIGH',
        preserves: ['Full metadata', 'Hash values', 'Folder structure', 'Body content', 'Attachment references'],
        limitations: ['Larger file size than delimited formats', 'Binary attachments not embedded (base64 would inflate size)'],
        usedBy: ['Case management systems', 'Custom forensic pipelines', 'XSLT workflows', 'Database imports'],
      },
    };
  }

  static ensureExportDir(projectId, exportId) {
    const dir = path.join(DATA_DIR, 'exports', projectId, exportId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  static async exportToFiles(projectId, exportId, format, messages, folders, customOutputDir, options = {}) {
    let outputDir;
    if (customOutputDir) {
      outputDir = path.join(customOutputDir, format);
      fs.mkdirSync(outputDir, { recursive: true });
    } else {
      outputDir = this.ensureExportDir(projectId, exportId);
    }
    const files = [];
    let emailsFailed = 0;
    let attachmentsFailed = 0;
    const reconstructed = [];
    const failed = [];
    const provider = options.provider || 'Unknown';
    const preserveFolders = options.preserveFolders !== false;
    const folderCounters = {};
    // Every message that could not be exported is listed with its reason; none is dropped silently.
    const fail = (msg, err) => {
      failed.push({ id: msg.id || '', folder: msg.folder || msg.folder_path || '', subject: msg.subject || '', sha256: msg.hash_sha256 || msg.hashSha256 || '', error: err?.message || String(err) });
      emailsFailed++;
    };
    const placeFile = (msg, ext, original) => {
      const folder = msg.folder || msg.folder_path || 'INBOX';
      const folderName = sanitizeFilename(folder.split('/').pop() || folder);
      folderCounters[folder] = (folderCounters[folder] || 0) + 1;
      const hash8 = (msg.hash_sha256 || msg.hashSha256 || 'unknown').substring(0, 8);
      const filename = `${sanitizeFilename(provider)}_message_${folderCounters[folder]}_from_${folderName}_${hash8}${original ? '' : '_RECONSTRUCTED'}.${ext}`;
      const subDir = preserveFolders ? path.join(outputDir, sanitizePath(folder)) : outputDir;
      fs.mkdirSync(subDir, { recursive: true });
      return { folder, filename, filePath: path.join(subDir, filename), relativePath: preserveFolders ? path.join(sanitizePath(folder), filename) : filename };
    };
    const addTextFile = (name, content) => {
      const filePath = path.join(outputDir, name);
      fs.writeFileSync(filePath, content, 'utf8');
      files.push({ filename: name, path: filePath, relativePath: name, size: Buffer.byteLength(content), hash: crypto.createHash('sha256').update(content).digest('hex') });
    };

    switch (format) {
      case 'eml':
      case 'mime':
        for (const msg of messages) {
          try {
            const result = this.exportMessageBytes(msg);
            const { filename, filePath, relativePath } = placeFile(msg, format, result.original);
            fs.writeFileSync(filePath, result.content);
            if (!result.original) reconstructed.push({ file: relativePath, subject: msg.subject, reason: result.problem });
            files.push({ filename, hash: result.hash, size: result.size, original: result.original, path: filePath, relativePath });
          } catch (err) { fail(msg, err); }
        }
        break;

      case 'msg': {
        // Converted from the original collected bytes, like PST items.
        const items = [];
        for (const msg of messages) {
          try {
            const bytes = this.exportMessageBytes(msg);
            const { folder, filename, filePath, relativePath } = placeFile(msg, 'msg', bytes.original);
            const { content, subject, messageId } = await mimeToMsg(bytes.content, itemMeta(msg, provider, folder));
            fs.writeFileSync(filePath, content);
            if (!bytes.original) reconstructed.push({ file: relativePath, subject: msg.subject, reason: bytes.problem });
            files.push({ filename, hash: crypto.createHash('sha256').update(content).digest('hex'), size: content.length, original: bytes.original, path: filePath, relativePath });
            items.push({ file: relativePath, folder, subject, messageId, sha256: crypto.createHash('sha256').update(bytes.content).digest('hex'), original: bytes.original, id: msg.id || '' });
          } catch (err) { fail(msg, err); }
        }
        const rows = [['MSG File', 'Source Folder', 'Subject', 'Internet Message-ID', 'Source SHA-256', 'Source', 'SherlockMail Message ID'].join(',')];
        for (const it of items) rows.push([it.file, it.folder, it.subject, it.messageId, it.sha256, it.original ? 'original collected MIME' : 'RECONSTRUCTED', it.id].map(csvCell).join(','));
        addTextFile('msg_item_map.csv', rows.join('\r\n') + '\r\n');
        break;
      }

      case 'mbox': {
        const filePath = path.join(outputDir, `collection_${new Date().toISOString().replace(/[:.]/g, '-')}.mbox`);
        const result = this.generateMbox(messages, filePath);
        reconstructed.push(...result.reconstructed);
        for (const f of result.failed) fail(f.msg, f.error);
        files.push({ filename: result.filename, hash: result.hash, size: result.size, messageCount: result.messageCount, path: filePath, relativePath: result.filename });
        addTextFile('mbox_item_map.csv', result.itemMap);
        if (result.verifyProblems.length) {
          for (const p of result.verifyProblems) failed.push({ id: p.id, folder: p.folder, subject: p.subject, sha256: p.sha256, error: p.error });
          emailsFailed += result.verifyProblems.length;
        }
        break;
      }

      case 'pst': {
        const project = options.project || {};
        const result = await exportMessagesToPst(messages, {
          outputDir,
          baseName: sanitizeFilename(project.name || 'collection'),
          displayName: `${project.name || 'SherlockMail'} (SherlockMail)`,
          rootFolderName: project.target_email || project.name || 'Collection',
          maxBytes: options.pstMaxGb ? options.pstMaxGb * 1024 ** 3 : undefined,
          provider,
          readMessage: msg => this.exportMessageBytes(msg),
          onProgress: options.onProgress,
        });
        files.push(...result.files);
        reconstructed.push(...result.reconstructed);
        for (const f of result.failed) failed.push({ id: f.id || '', folder: f.folder || '', subject: f.subject || '', sha256: '', error: f.error });
        emailsFailed += result.failed.length;
        const mapContent = itemMapCsv(result.items);
        const mapPath = path.join(outputDir, 'pst_item_map.csv');
        fs.writeFileSync(mapPath, mapContent, 'utf8');
        files.push({ filename: 'pst_item_map.csv', path: mapPath, relativePath: 'pst_item_map.csv', size: Buffer.byteLength(mapContent), hash: crypto.createHash('sha256').update(mapContent).digest('hex') });
        if (result.failed.length) {
          const failContent = result.failed.map(f => [f.id || '', f.folder || '', f.subject || '', f.error].join('\t')).join('\r\n') + '\r\n';
          const failPath = path.join(outputDir, 'pst_failed_items.txt');
          fs.writeFileSync(failPath, failContent, 'utf8');
          files.push({ filename: 'pst_failed_items.txt', path: failPath, relativePath: 'pst_failed_items.txt', size: Buffer.byteLength(failContent), hash: crypto.createHash('sha256').update(failContent).digest('hex') });
        }
        break;
      }

      case 'pdf': {
        const splitMode = options.pdfSplitMode || 'thread';
        let groups;
        switch (splitMode) {
          case 'all':
            groups = [{ label: null, messages }];
            break;
          case 'folder':
            groups = this._groupByFolder(messages);
            break;
          case 'thread':
            groups = threadMessages(messages).map(t => ({ label: t.messages[0].subject || '(no subject)', messages: t.messages }));
            break;
          case 'email':
            groups = messages.map(m => ({ label: m.subject || '(no subject)', messages: [m] }));
            break;
          default:
            groups = [{ label: null, messages }];
        }
        for (const group of groups) {
          try {
            const result = this.generatePdf(group.messages, projectId, group.label, options.attachmentsByMessage, options.project);
            // Thread and message subjects repeat; a later PDF must never overwrite an earlier one.
            const filePath = uniquePath(outputDir, result.filename);
            const { content, ...fileInfo } = result;
            fs.writeFileSync(filePath, content);
            files.push({ ...fileInfo, filename: path.basename(filePath), path: filePath, relativePath: path.basename(filePath) });
          } catch (err) { for (const m of group.messages) fail(m, err); }
        }
        break;
      }

      case 'concordance': {
        const datResult = this.generateConcordanceDat(messages, caseFields(options.project || {}).custodianName || '');
        const datPath = path.join(outputDir, datResult.filename);
        fs.writeFileSync(datPath, datResult.content, 'utf8');
        const { content: _dat, ...datInfo } = datResult;
        files.push({ ...datInfo, path: datPath, relativePath: datResult.filename });

        const optResult = this.generateConcordanceOpt(messages, projectId);
        const optPath = path.join(outputDir, optResult.filename);
        fs.writeFileSync(optPath, optResult.content, 'utf8');
        const { content: _opt, ...optInfo } = optResult;
        files.push({ ...optInfo, path: optPath, relativePath: optResult.filename });
        break;
      }

      case 'xml': {
        const xmlResult = this.generateXml(messages, projectId);
        const xmlPath = path.join(outputDir, xmlResult.filename);
        fs.writeFileSync(xmlPath, xmlResult.content, 'utf8');
        const { content: _xml, ...xmlInfo } = xmlResult;
        files.push({ ...xmlInfo, path: xmlPath, relativePath: xmlResult.filename });
        break;
      }
    }

    if (failed.length) {
      const rows = [['SherlockMail Message ID', 'Folder', 'Subject', 'Source SHA-256', 'Error'].join(',')];
      for (const f of failed) rows.push([f.id, f.folder, f.subject, f.sha256, f.error].map(csvCell).join(','));
      addTextFile('export_failed_items.csv', rows.join('\r\n') + '\r\n');
    }

    const metadataCsv = this.generateMetadataCsv(messages);
    addTextFile('metadata.csv', metadataCsv.content);

    const sessionManifest = this.generateSessionManifest(projectId, exportId, format, messages, files, options);
    addTextFile('session_manifest.xml', sessionManifest.content);

    // Every file, those two included, is read back from disk and hashed: what the manifest lists is what
    // was written, and verifying an export later covers all of it.
    const verificationFailures = await this.verifyWrittenFiles(files);

    const manifest = this.generateHashManifest(files, messages, { emailsFailed, attachmentsFailed, reconstructed, failed, verificationFailures });
    const manifestPath = path.join(outputDir, 'manifest.txt');
    fs.writeFileSync(manifestPath, manifest.text, 'utf8');

    return { files, manifest, sessionManifest, metadataCsv, outputDir, reconstructed, failed, verificationFailures };
  }

  // Re-reads each written file and computes MD5, SHA-1 and SHA-256 from the bytes on disk. A file whose
  // SHA-256 differs from what was produced in memory is reported, never silently accepted.
  static async verifyWrittenFiles(files) {
    const problems = [];
    for (const f of files) {
      const md5 = crypto.createHash('md5'), sha1 = crypto.createHash('sha1'), sha256 = crypto.createHash('sha256');
      let size = 0;
      try {
        for await (const chunk of fs.createReadStream(f.path)) {
          md5.update(chunk); sha1.update(chunk); sha256.update(chunk);
          size += chunk.length;
        }
      } catch (err) {
        f.verified = false;
        problems.push({ file: f.relativePath || f.filename, error: `could not be read back: ${err.message}` });
        continue;
      }
      const onDisk = sha256.digest('hex');
      f.md5 = md5.digest('hex');
      f.sha1 = sha1.digest('hex');
      f.verified = (!f.hash || f.hash === onDisk) && (f.size == null || f.size === size);
      if (!f.verified) problems.push({ file: f.relativePath || f.filename, error: `file on disk (SHA-256 ${onDisk}, ${size} bytes) differs from what was written (SHA-256 ${f.hash}, ${f.size} bytes)` });
      f.hash = onDisk;
      f.size = size;
    }
    return problems;
  }

  // The bytes collected from the server, provided the file still matches the hash recorded at collection.
  static readOriginal(message) {
    const filePath = message.eml_path || message.emlPath;
    const expected = message.hash_sha256 || message.hashSha256;
    if (!filePath || !fs.existsSync(filePath)) return { buf: null, problem: 'collected email file not found' };
    const buf = fs.readFileSync(filePath);
    const actual = crypto.createHash('sha256').update(buf).digest('hex');
    if (expected && actual !== expected) {
      return { buf: null, problem: `collected email file no longer matches its recorded SHA-256 (${actual.slice(0, 12)}... vs ${expected.slice(0, 12)}...)` };
    }
    return { buf };
  }

  // Exports are byte-for-byte copies of the collected message. Only when that file is missing or altered
  // is a message rebuilt from the database, and then it is labelled as reconstructed.
  static exportMessageBytes(message) {
    const original = this.readOriginal(message);
    if (original.buf) {
      return { content: original.buf, hash: crypto.createHash('sha256').update(original.buf).digest('hex'), size: original.buf.length, original: true };
    }
    const r = this.generateEml(message, { reconstructedReason: original.problem });
    const content = Buffer.from(r.content, 'utf8');
    return { content, hash: r.hash, size: content.length, original: false, problem: original.problem };
  }

  static generateEml(message, { reconstructedReason } = {}) {
    const from = message.from_address || message.fromAddress || '';
    const to = parseJsonField(message.to_addresses || message.toAddresses, []);
    const cc = parseJsonField(message.cc_addresses || message.ccAddresses, []);
    const subject = message.subject || '(no subject)';
    const date = message.date;
    const msgId = message.message_id || message.messageId || `<${uuidv4()}@sherlock-mail.local>`;
    const sha256 = message.hash_sha256 || message.hashSha256 || '';
    const bodyText = message.body_text || message.bodyText || '';
    const bodyHtml = message.body_html || message.bodyHtml || '';
    const contentType = message.content_type || message.contentType || 'text/plain; charset=utf-8';
    const acquired = message.acquired_at || new Date().toISOString();

    const headers = [
      `From: ${from}`,
      `To: ${Array.isArray(to) ? to.join(', ') : to}`,
      cc.length ? `Cc: ${Array.isArray(cc) ? cc.join(', ') : cc}` : null,
      `Subject: ${subject}`,
      date ? `Date: ${new Date(date).toUTCString()}` : null,
      `Message-ID: ${msgId}`,
      message.in_reply_to || message.inReplyTo ? `In-Reply-To: ${message.in_reply_to || message.inReplyTo}` : null,
      `MIME-Version: 1.0`,
    ].filter(Boolean);

    // A rebuilt message is not the evidence: it says so, and names the original's hash rather than
    // claiming to have it.
    const provenance = [
      `X-SherlockMail-Reconstructed: ${reconstructedReason || 'rebuilt from collected metadata; not the original MIME'}`,
      `X-SherlockMail-Original-SHA256: ${sha256}`,
      `X-SherlockMail-Acquired: ${acquired}`,
    ];

    let body;
    if (bodyHtml && bodyText) {
      const boundary = `----=_Part_${uuidv4().substring(0, 8)}`;
      headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
      headers.push(...provenance);
      body = [
        `--${boundary}`,
        `Content-Type: text/plain; charset=utf-8`,
        `Content-Transfer-Encoding: 7bit`,
        ``,
        bodyText,
        ``,
        `--${boundary}`,
        `Content-Type: text/html; charset=utf-8`,
        `Content-Transfer-Encoding: 7bit`,
        ``,
        bodyHtml,
        ``,
        `--${boundary}--`,
      ].join('\r\n');
    } else {
      // Only the text survives in the database, so a multipart original cannot keep its multipart type.
      const singleType = /^multipart\//i.test(contentType)
        ? (bodyText ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8')
        : contentType;
      headers.push(`Content-Type: ${singleType}`);
      headers.push(...provenance);
      body = bodyText || bodyHtml || '';
    }

    const eml = headers.join('\r\n') + '\r\n\r\n' + body + '\r\n';

    return {
      content: eml,
      filename: `${sanitizeFilename(subject)}_${sha256?.substring(0, 8) || 'unknown'}.eml`,
      hash: crypto.createHash('sha256').update(eml).digest('hex'),
      size: Buffer.byteLength(eml),
    };
  }

  // mboxrd: each original message after a "From sender asctime-date" separator line. The message bytes are
  // written exactly as collected, line endings included; the only change is the reversible ">From "
  // quoting (a line starting with zero or more ">" then "From " gets one more ">"), plus a final line
  // feed when a message does not end with one. The item map records where each message sits, and the
  // written file is read back to prove every message unquotes to its original SHA-256.
  static generateMbox(messages, filePath) {
    const reconstructed = [];
    const failed = [];
    const items = [];
    const filename = path.basename(filePath);
    const hash = crypto.createHash('sha256');
    let size = 0;
    const fd = fs.openSync(filePath, 'w');
    const write = (str) => {
      const buf = Buffer.from(str, 'latin1');
      fs.writeSync(fd, buf);
      hash.update(buf);
      size += buf.length;
      return buf.length;
    };
    const asctime = (d) => {
      const dt = isNaN(d.getTime()) ? new Date(0) : d;
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const p2 = n => String(n).padStart(2, '0');
      return `${days[dt.getUTCDay()]} ${months[dt.getUTCMonth()]} ${String(dt.getUTCDate()).padStart(2, ' ')} ${p2(dt.getUTCHours())}:${p2(dt.getUTCMinutes())}:${p2(dt.getUTCSeconds())} ${dt.getUTCFullYear()}`;
    };

    try {
      for (const msg of messages) {
        try {
          const exported = this.exportMessageBytes(msg);
          if (!exported.original) reconstructed.push({ file: filename, subject: msg.subject, reason: exported.problem });
          const sender = ((msg.from_address || msg.fromAddress || '').match(/[^\s<>"]+@[^\s<>"]+/) || ['MAILER-DAEMON'])[0];
          // latin1 maps every byte to one character and back, so 8-bit content survives unchanged.
          const raw = exported.content.toString('latin1');
          let quotedLines = 0;
          const quoted = raw.replace(/^(>*From )/gm, (m) => { quotedLines++; return `>${m}`; });
          const appendedNewline = !raw.endsWith('\n');
          const separatorOffset = size;
          write(`From ${sender} ${asctime(new Date(msg.date))}\n`);
          const messageOffset = size;
          const storedLength = write(appendedNewline ? `${quoted}\n` : quoted);
          write('\n');
          items.push({
            msg, separatorOffset, messageOffset, storedLength, originalSize: exported.content.length, quotedLines, appendedNewline,
            sha256: crypto.createHash('sha256').update(exported.content).digest('hex'), original: exported.original,
          });
        } catch (err) {
          failed.push({ msg, error: err });
        }
      }
    } finally {
      fs.closeSync(fd);
    }

    // Read the file back and undo the quoting: each message must match its original SHA-256 and size.
    const verifyProblems = [];
    const rfd = fs.openSync(filePath, 'r');
    for (const it of items) {
      const chunk = Buffer.alloc(it.storedLength);
      let got = 0;
      try {
        while (got < chunk.length) {
          const n = fs.readSync(rfd, chunk, got, chunk.length - got, it.messageOffset + got);
          if (!n) break;
          got += n;
        }
      } catch { /* a short read fails the check below */ }
      let restored = chunk.subarray(0, got).toString('latin1').replace(/^>(>*From )/gm, '$1');
      if (it.appendedNewline) restored = restored.slice(0, -1);
      const buf = Buffer.from(restored, 'latin1');
      it.verified = buf.length === it.originalSize && crypto.createHash('sha256').update(buf).digest('hex') === it.sha256;
      if (!it.verified) {
        verifyProblems.push({ id: it.msg.id || '', folder: it.msg.folder || '', subject: it.msg.subject || '', sha256: it.sha256, error: 'MBOX copy does not unquote to the original message bytes' });
      }
    }
    fs.closeSync(rfd);

    const rows = [['Message #', 'Separator Offset', 'Message Offset', 'Stored Length', 'Original Size', 'Source SHA-256', 'Quoted ">From " Lines', 'Line Feed Appended', 'Verified After Writing', 'Source', 'Folder', 'Subject', 'SherlockMail Message ID'].join(',')];
    items.forEach((it, i) => rows.push([
      i + 1, it.separatorOffset, it.messageOffset, it.storedLength, it.originalSize, it.sha256, it.quotedLines,
      it.appendedNewline ? 'yes' : 'no', it.verified ? 'yes' : 'NO', it.original ? 'original collected MIME' : 'RECONSTRUCTED',
      it.msg.folder || '', it.msg.subject || '', it.msg.id || '',
    ].map(csvCell).join(',')));

    return {
      filename, hash: hash.digest('hex'), size, messageCount: items.length, reconstructed, failed, verifyProblems,
      itemMap: rows.join('\r\n') + '\r\n',
    };
  }

  static _groupByFolder(messages) {
    const folders = new Map();
    for (const msg of messages) {
      const key = (msg.folder || msg.folderPath || 'INBOX').toLowerCase();
      const label = msg.folder || msg.folderPath || 'INBOX';
      if (!folders.has(key)) folders.set(key, { label, messages: [] });
      folders.get(key).messages.push(msg);
    }
    return [...folders.values()];
  }

  static _groupByThread(messages) {
    const normalize = (s) => (s || '').replace(/^(Re|Fwd|Fw)\s*:\s*/gi, '').trim().toLowerCase();
    const threads = new Map();
    for (const msg of messages) {
      const key = normalize(msg.subject) || 'no-subject';
      if (!threads.has(key)) threads.set(key, { subject: msg.subject || '(no subject)', messages: [] });
      threads.get(key).messages.push(msg);
    }
    return [...threads.values()];
  }

  // A plain PDF 1.4 with the standard fonts, whose WinAnsi encoding covers Western European text. Bodies are
  // wrapped, never cut; a character the fonts cannot show prints as "?" and the report counts them.
  static generatePdf(messages, projectId, threadLabel = null, attachmentsByMessage = null, project = null) {
    const now = new Date().toISOString();
    let replacedChars = 0;
    const WIN_ANSI_EXTRA = { 0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A, 0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C, 0x017E: 0x9E, 0x0178: 0x9F };
    const toWinAnsi = (str) => {
      let out = '';
      for (const ch of String(str ?? '')) {
        const cp = ch.codePointAt(0);
        if (cp === 0x09) out += '    ';
        else if (cp < 0x20 || cp === 0x7F) { replacedChars++; out += '?'; }
        else if (cp < 0x80 || (cp >= 0xA0 && cp <= 0xFF)) out += String.fromCharCode(cp);
        else if (WIN_ANSI_EXTRA[cp]) out += String.fromCharCode(WIN_ANSI_EXTRA[cp]);
        else { replacedChars++; out += '?'; }
      }
      return out;
    };
    const pdfEsc = (str) => str.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

    const objects = [];
    let objNum = 0;
    const addObj = (content) => { objNum++; objects.push({ num: objNum, content }); return objNum; };

    const catalogNum = addObj('');
    const pagesNum = addObj('');

    const encoding = '/Encoding /WinAnsiEncoding';
    const fontNum = addObj(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica ${encoding} >>`);
    const fontBoldNum = addObj(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold ${encoding} >>`);
    const fontMonoNum = addObj(`<< /Type /Font /Subtype /Type1 /BaseFont /Courier ${encoding} >>`);

    const pageWidth = 612;
    const pageHeight = 792;
    const margin = 50;
    const lineHeight = 12;
    const maxY = pageHeight - margin;
    const contentWidth = pageWidth - 2 * margin;

    const pageContents = [];
    let currentLines = [];
    let curY = maxY;

    const flushPage = () => {
      if (currentLines.length === 0) return;
      const stream = currentLines.join('\n');
      const streamNum = addObj(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
      const pageNum = addObj(`<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Contents ${streamNum} 0 R /Resources << /Font << /F1 ${fontNum} 0 R /F2 ${fontBoldNum} 0 R /F3 ${fontMonoNum} 0 R >> >> >>`);
      pageContents.push(pageNum);
      currentLines = [];
      curY = maxY;
    };

    // Average glyph widths are enough to wrap inside the margins: Helvetica about 0.5 em, Courier exactly 0.6.
    const wrap = (text, font, size) => {
      const perLine = Math.max(10, Math.floor(contentWidth / (size * (font === '/F3' ? 0.6 : font === '/F2' ? 0.56 : 0.5))));
      const lines = [];
      for (let rest = text; ;) {
        if (rest.length <= perLine) { lines.push(rest); break; }
        let cut = rest.lastIndexOf(' ', perLine);
        if (cut < perLine * 0.5) cut = perLine;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut).replace(/^ /, '');
      }
      return lines;
    };

    const addLine = (text, font = '/F1', size = 10) => {
      for (const line of wrap(toWinAnsi(text), font, size)) {
        if (curY < margin + lineHeight) flushPage();
        currentLines.push(`BT ${font} ${size} Tf ${margin} ${curY} Td (${pdfEsc(line)}) Tj ET`);
        curY -= Math.max(lineHeight, size + 2);
      }
    };

    const addGap = (px = 8) => { curY -= px; };
    const addRule = () => {
      if (curY < margin + lineHeight) flushPage();
      currentLines.push(`0.8 0.8 0.8 RG ${margin} ${curY + 6} m ${pageWidth - margin} ${curY + 6} l S 0 0 0 RG`);
    };

    addLine(threadLabel ? `Thread: ${threadLabel}` : 'SherlockMail Forensic Email Report', '/F2', 16);
    addGap(4);
    const caseLabel = project ? [project.name, project.case_id && `Case ID ${project.case_id}`, caseFields(project).evidenceId && `Evidence ID ${caseFields(project).evidenceId}`].filter(Boolean).join('  |  ') : `Project ${projectId}`;
    addLine(`Project: ${caseLabel}`, '/F1', 9);
    addLine(`Generated: ${now}  |  Messages: ${messages.length}`, '/F1', 9);
    addLine('Tool: SherlockMail v0.10.0  |  Hash Algorithm: SHA-256  |  Times in UTC', '/F1', 9);
    addGap(6);
    addRule();
    addGap(12);

    const headerValue = (headers, name) => {
      const v = headers?.[name];
      if (v == null) return null;
      const one = Array.isArray(v) ? v : [v];
      return one.map(h => (typeof h === 'object' ? (h.text || h.value || JSON.stringify(h)) : String(h)));
    };

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const from = msg.from_address || msg.fromAddress || '';
      const to = parseJsonField(msg.to_addresses || msg.toAddresses, []);
      const cc = parseJsonField(msg.cc_addresses || msg.ccAddresses, []);
      const subject = msg.subject || '(no subject)';
      const date = msg.date ? new Date(msg.date).toISOString() : 'No date in the message';
      const sha256 = msg.hash_sha256 || msg.hashSha256 || 'N/A';
      const body = msg.body_text || msg.bodyText || '';
      let headers = null;
      try { headers = JSON.parse(msg.headers_json || 'null'); } catch { /* the record's own fields still print */ }
      const atts = attachmentsByMessage?.get(msg.id) || [];

      if (curY < margin + lineHeight * 8) flushPage();

      addLine(`Message #${i + 1}: ${subject}`, '/F2', 11);
      addGap(4);
      addLine(`From: ${from}`, '/F1', 9);
      addLine(`To: ${(Array.isArray(to) ? to.join(', ') : to)}`, '/F1', 9);
      if (cc.length) addLine(`Cc: ${(Array.isArray(cc) ? cc.join(', ') : cc)}`, '/F1', 9);
      addLine(`Date: ${date}    Folder: ${msg.folder || ''}`, '/F1', 9);
      addLine(`Message-ID: ${msg.message_id || msg.messageId || '(none)'}`, '/F1', 9);
      for (const name of ['received', 'authentication-results', 'return-path', 'reply-to']) {
        for (const value of headerValue(headers, name) || []) addLine(`${name}: ${value}`, '/F3', 7);
      }
      addLine(`SHA-256: ${sha256}`, '/F3', 7);
      addGap(4);
      for (const att of atts) addLine(`Attachment: ${att.filename} (${att.size ?? '?'} bytes)  SHA-256 ${att.hash_sha256 || ''}`, '/F3', 7);
      if (atts.length) addGap(4);

      for (const line of body.split(/\r?\n/)) addLine(line, '/F1', 8);
      addGap(10);
      addRule();
      addGap(10);
    }

    if (replacedChars) {
      addLine(`Note: ${replacedChars} character(s) could not be shown in this PDF's fonts and print as "?". The original messages keep them.`, '/F2', 9);
    }

    flushPage();

    objects[0].content = `<< /Type /Catalog /Pages ${pagesNum} 0 R >>`;
    objects[1].content = `<< /Type /Pages /Kids [${pageContents.map(n => `${n} 0 R`).join(' ')}] /Count ${pageContents.length} >>`;

    // Every character here is a single byte (latin1), so string lengths are byte offsets.
    let pdf = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
    const offsets = [];
    for (const obj of objects) {
      offsets.push(pdf.length);
      pdf += `${obj.num} 0 obj\n${obj.content}\nendobj\n`;
    }

    const xrefOffset = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) {
      pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
    }
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogNum} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

    const content = Buffer.from(pdf, 'latin1');

    return {
      content,
      filename: `${sanitizeFilename(threadLabel || 'report')}_${new Date().toISOString().replace(/[:.]/g, '-')}.pdf`,
      hash: crypto.createHash('sha256').update(content).digest('hex'),
      size: content.length,
      messageCount: messages.length,
      replacedChars,
    };
  }

  static generateConcordanceDat(messages, custodian = '') {
    // Concordance's default delimiters: DC4 (ASCII 20) between fields, thorn (ASCII 254) around each value.
    const D = '\u0014';
    const Q = '\u00fe';
    const NEWLINE = '\u00ae'; // (registered sign, ASCII 174) stands for a line break inside a value

    const fields = [
      'DOCID', 'BATES_BEGIN', 'BATES_END', 'BATES_ATTACH_BEGIN', 'BATES_ATTACH_END',
      'CUSTODIAN', 'FROM', 'TO', 'CC', 'BCC', 'SUBJECT', 'DATESENT', 'TIMESENT',
      'DATERCVD', 'TIMERCVD', 'FOLDER', 'HASATTACHMENTS', 'ATTACHCOUNT',
      'MESSAGESIZE', 'MESSAGEID', 'CONVERSATIONINDEX', 'PARENTID',
      'HASHMD5', 'HASHSHA256', 'BODYTEXT',
    ];

    const header = fields.map(f => `${Q}${f}${Q}`).join(D);
    const batesPrefix = 'SM-';
    const padLen = 7;

    const rows = messages.map((msg, idx) => {
      const batesNum = String(idx + 1).padStart(padLen, '0');
      const batesBegin = `${batesPrefix}${batesNum}`;
      const batesEnd = batesBegin;
      const attCount = msg.attachment_count || msg.attachmentCount || 0;

      const from = msg.from_address || msg.fromAddress || '';
      const to = parseJsonField(msg.to_addresses || msg.toAddresses, []).join('; ');
      const cc = parseJsonField(msg.cc_addresses || msg.ccAddresses, []).join('; ');
      const bcc = parseJsonField(msg.bcc_addresses || msg.bccAddresses, []).join('; ');
      const subject = msg.subject || '';
      const d = msg.date ? new Date(msg.date) : null;
      const dateSent = d ? `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}` : '';
      const timeSent = d ? d.toISOString().substring(11, 19) : '';
      // The server's received time; the time SherlockMail collected a message is not its received date.
      const rcvd = msg.internal_date ? new Date(msg.internal_date) : null;
      const dateRcvd = rcvd ? `${rcvd.getUTCMonth() + 1}/${rcvd.getUTCDate()}/${rcvd.getUTCFullYear()}` : '';
      const timeRcvd = rcvd ? rcvd.toISOString().substring(11, 19) : '';
      const folder = msg.folder || '';
      const hasAtt = msg.has_attachments || msg.hasAttachments ? 'TRUE' : 'FALSE';
      const size = msg.size || 0;
      const msgId = msg.message_id || msg.messageId || '';
      const convIdx = msg.in_reply_to || '';
      const parentId = msg.in_reply_to || '';
      const md5 = msg.hash_md5 || msg.hashMd5 || '';
      const sha256 = msg.hash_sha256 || msg.hashSha256 || '';
      const body = (msg.body_text || msg.bodyText || '').substring(0, 32000).replace(/\r?\n/g, NEWLINE);

      // Attachments stay inside their message, so a family's range is the message's own number.
      const vals = [msg.id, batesBegin, batesEnd, batesBegin, batesEnd,
        msg.custodian || custodian, from, to, cc, bcc, subject, dateSent, timeSent,
        dateRcvd, timeRcvd, folder, hasAtt, attCount, size, msgId, convIdx, parentId,
        md5, sha256, body];
      return vals.map(v => `${Q}${String(v ?? '').replace(/[\u0014\u00fe]/g, ' ').replace(/[\r\n]+/g, NEWLINE)}${Q}`).join(D);
    });

    const content = `\ufeff${[header, ...rows].join('\r\n')}\r\n`;
    return {
      content,
      filename: `loadfile_${new Date().toISOString().replace(/[:.]/g, '-')}.dat`,
      hash: crypto.createHash('sha256').update(content).digest('hex'),
      size: Buffer.byteLength(content),
      messageCount: messages.length,
    };
  }

  static generateConcordanceOpt(messages, projectId) {
    const lines = messages.map((msg, i) => {
      const docId = msg.id || `DOC_${i + 1}`;
      const volume = projectId.substring(0, 8);
      const imgPath = '';
      return `${docId},${volume},${imgPath},Y,,,${i + 1}`;
    });

    const content = lines.join('\r\n') + '\r\n';
    return {
      content,
      filename: `loadfile_${new Date().toISOString().replace(/[:.]/g, '-')}.opt`,
      hash: crypto.createHash('sha256').update(content).digest('hex'),
      size: Buffer.byteLength(content),
    };
  }

  static generateXml(messages, projectId) {
    const now = new Date().toISOString();
    // XML 1.0 cannot carry most control characters even when escaped; they are replaced and counted.
    let replacedChars = 0;
    const legal = (str) => String(str ?? '').replace(/[^\t\n\r\x20-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, () => { replacedChars++; return '\uFFFD'; });
    const x = (str) => legal(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const cdata = (str) => `<![CDATA[${legal(str).replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;

    const msgElements = messages.map((msg, idx) => {
      const from = msg.from_address || msg.fromAddress || '';
      const to = parseJsonField(msg.to_addresses || msg.toAddresses, []);
      const cc = parseJsonField(msg.cc_addresses || msg.ccAddresses, []);
      const bcc = parseJsonField(msg.bcc_addresses || msg.bccAddresses, []);
      const body = msg.body_text || msg.bodyText || '';

      return `  <message seq="${idx + 1}" id="${x(msg.id)}">
    <subject>${x(msg.subject || '')}</subject>
    <from>${x(from)}</from>
    <to>${to.map(a => `<address>${x(a)}</address>`).join('')}</to>
    <cc>${cc.map(a => `<address>${x(a)}</address>`).join('')}</cc>
    <bcc>${bcc.map(a => `<address>${x(a)}</address>`).join('')}</bcc>
    <date>${x(msg.date || '')}</date>
    <folder>${x(msg.folder || '')}</folder>
    <size>${msg.size || 0}</size>
    <messageId>${x(msg.message_id || msg.messageId || '')}</messageId>
    <inReplyTo>${x(msg.in_reply_to || msg.inReplyTo || '')}</inReplyTo>
    <contentType>${x(msg.content_type || msg.contentType || 'text/plain')}</contentType>
    <hashes>
      <md5>${x(msg.hash_md5 || msg.hashMd5 || '')}</md5>
      <sha256>${x(msg.hash_sha256 || msg.hashSha256 || '')}</sha256>
      <sha512>${x(msg.hash_sha512 || msg.hashSha512 || '')}</sha512>
    </hashes>
    <flags>${x(msg.flags || '[]')}</flags>
    <hasAttachments>${msg.has_attachments || msg.hasAttachments ? 'true' : 'false'}</hasAttachments>
    <attachmentCount>${msg.attachment_count || msg.attachmentCount || 0}</attachmentCount>
    <acquiredAt>${x(msg.acquired_at || '')}</acquiredAt>
    <body encoding="plain">${cdata(body)}</body>
  </message>`;
    }).join('\n');

    const content = `<?xml version="1.0" encoding="UTF-8"?>
<sherlockMailExport version="1.0" generated="${x(now)}" tool="SherlockMail v0.10.0">
  <project id="${x(projectId)}"/>
  <summary>
    <totalMessages>${messages.length}</totalMessages>
    <charactersNotRepresentable>${replacedChars}</charactersNotRepresentable>
    <hashAlgorithm>SHA-256</hashAlgorithm>
    <exportDate>${x(now)}</exportDate>
  </summary>
  <messages count="${messages.length}">
${msgElements}
  </messages>
</sherlockMailExport>
`;

    return {
      content,
      filename: `export_${new Date().toISOString().replace(/[:.]/g, '-')}.xml`,
      hash: crypto.createHash('sha256').update(content).digest('hex'),
      size: Buffer.byteLength(content),
      messageCount: messages.length,
    };
  }

  static generateSessionManifest(projectId, exportId, format, messages, exportedFiles, options = {}) {
    const x = escHtml;
    const now = new Date().toISOString();
    const project = options.project || {};
    const acquisition = options.acquisition || {};
    const totalBytes = exportedFiles.reduce((sum, f) => sum + (f.size || 0), 0);
    const folders = [...new Set(messages.map(m => m.folder || m.folder_path || 'INBOX'))];
    const attachmentCount = messages.reduce((sum, m) => sum + (m.attachment_count || m.attachmentCount || 0), 0);

    const fileEntries = exportedFiles.map((f, i) => {
      const fname = f.relativePath || f.filename;
      return `    <File seq="${i + 1}">
      <Name>${x(fname)}</Name>
      <Size>${f.size || 0}</Size>
      <SHA256>${x(f.hash || '')}</SHA256>
    </File>`;
    }).join('\n');

    const content = `<?xml version="1.0" encoding="UTF-8"?>
<SessionManifest xmlns="urn:sherlockmail:manifest:1.0" version="1.0">
  <GeneratedAt>${x(now)}</GeneratedAt>
  <Tool>SherlockMail v0.10.0</Tool>
  <CaseInformation>
    <CaseName>${x(project.case_name || project.caseName || '')}</CaseName>
    <CaseId>${x(project.case_id || project.caseId || '')}</CaseId>
    <ExaminerName>${x(project.examiner_name || project.examinerName || '')}</ExaminerName>
    <Agency>${x(project.agency || '')}</Agency>
    <EvidenceId>${x(caseFields(project).evidenceId || project.evidenceId || '')}</EvidenceId>
    <CustodianFullName>${x(caseFields(project).custodianName || project.custodianName || '')}</CustodianFullName>
    <EvidenceDescription>${x(project.evidence_description || project.evidenceDescription || '')}</EvidenceDescription>
    <ClientName>${x(project.client_name || project.clientName || '')}</ClientName>
    <ClientMatterNo>${x(project.client_matter_no || project.clientMatterNo || '')}</ClientMatterNo>
  </CaseInformation>
  <CollectionParameters>
    <TargetEmail>${x(project.target_email || project.targetEmail || '')}</TargetEmail>
    <ProviderType>${x(project.provider_type || project.providerType || '')}</ProviderType>
    <Protocol>${x(options.protocol || project.provider_type || project.providerType || '')}</Protocol>
    <FoldersCollected>${folders.length}</FoldersCollected>
    <Folders>
${folders.map(f => `      <Folder>${x(f)}</Folder>`).join('\n')}
    </Folders>
  </CollectionParameters>
  <SessionStatistics>
    <StartedAt>${x(acquisition.started_at || acquisition.startedAt || '')}</StartedAt>
    <CompletedAt>${x(acquisition.completed_at || acquisition.completedAt || now)}</CompletedAt>
    <TotalMessages>${messages.length}</TotalMessages>
    <TotalAttachments>${attachmentCount}</TotalAttachments>
    <TotalSize>${totalBytes}</TotalSize>
    <ExportFormat>${x(format)}</ExportFormat>
    <ExportId>${x(exportId || '')}</ExportId>
    <FileCount>${exportedFiles.length}</FileCount>
  </SessionStatistics>
  <ExportedFiles>
${fileEntries}
  </ExportedFiles>
  <Integrity>
    <HashAlgorithm>SHA-256</HashAlgorithm>
    <ManifestHash>${crypto.createHash('sha256').update(fileEntries).digest('hex')}</ManifestHash>
  </Integrity>
</SessionManifest>
`;

    return {
      content,
      filename: 'session_manifest.xml',
      hash: crypto.createHash('sha256').update(content).digest('hex'),
      size: Buffer.byteLength(content),
    };
  }

  static generateMetadataCsv(messages) {
    const csvEscape = (val) => {
      const s = String(val ?? '');
      if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    };
    const joinField = (val) => {
      const arr = parseJsonField(val, []);
      return Array.isArray(arr) ? arr.join('; ') : String(arr);
    };

    const columns = [
      'Subject', 'From', 'To', 'CC', 'BCC', 'DateSent', 'DateReceived',
      'Folder', 'Size', 'MessageID', 'InReplyTo', 'HasAttachments',
      'AttachmentCount', 'ContentType', 'SHA256', 'MD5', 'AcquiredAt',
    ];

    const rows = [columns.join(',')];
    for (const msg of messages) {
      const row = [
        csvEscape(msg.subject || ''),
        csvEscape(msg.from_address || msg.fromAddress || ''),
        csvEscape(joinField(msg.to_addresses || msg.toAddresses)),
        csvEscape(joinField(msg.cc_addresses || msg.ccAddresses)),
        csvEscape(joinField(msg.bcc_addresses || msg.bccAddresses)),
        csvEscape(msg.date || ''),
        csvEscape(msg.acquired_at || ''),
        csvEscape(msg.folder || msg.folder_path || ''),
        msg.size || 0,
        csvEscape(msg.message_id || msg.messageId || ''),
        csvEscape(msg.in_reply_to || msg.inReplyTo || ''),
        (msg.has_attachments || msg.hasAttachments) ? 'TRUE' : 'FALSE',
        msg.attachment_count || msg.attachmentCount || 0,
        csvEscape(msg.content_type || msg.contentType || ''),
        csvEscape(msg.hash_sha256 || msg.hashSha256 || ''),
        csvEscape(msg.hash_md5 || msg.hashMd5 || ''),
        csvEscape(msg.acquired_at || ''),
      ];
      rows.push(row.join(','));
    }

    const content = rows.join('\r\n') + '\r\n';
    return {
      content,
      filename: 'metadata.csv',
      hash: crypto.createHash('sha256').update(content).digest('hex'),
      size: Buffer.byteLength(content),
      rowCount: messages.length,
    };
  }

  static generateHashManifest(exportedFiles, messages = [], stats = {}) {
    const generated = new Date().toISOString();
    const totalBytes = exportedFiles.reduce((sum, f) => sum + f.size, 0);
    const emailCount = messages.length;
    const attachmentCount = messages.reduce((sum, m) => sum + (m.attachment_count || m.attachmentCount || 0), 0);
    const emailsFailed = stats.emailsFailed || 0;
    const attachmentsFailed = stats.attachmentsFailed || 0;
    const sep = '='.repeat(64);
    const thin = '-'.repeat(64);

    let text = `${sep}\n`;
    text += `SHERLOCKMAIL FORENSIC EXPORT MANIFEST\n`;
    text += `${sep}\n`;
    text += `Generated:       ${generated}\n`;
    text += `Tool:            SherlockMail v0.10.0\n`;
    text += `Hash Algorithms: MD5, SHA-1, SHA-256 (each file re-read from disk after writing)\n`;
    text += `File Count:      ${exportedFiles.length}\n`;
    text += `Total Size:      ${totalBytes} bytes\n`;
    text += `Emails:          ${emailCount}\n`;
    text += `Attachments:     ${attachmentCount}\n`;
    text += `Emails Failed:   ${emailsFailed}\n`;
    text += `Attach. Failed:  ${attachmentsFailed}\n`;
    const rebuilt = stats.reconstructed || [];
    text += `Reconstructed:   ${rebuilt.length}${rebuilt.length ? ' (NOT the original collected MIME; see below)' : ' (every message exported from its original collected bytes)'}\n`;
    const verifyProblems = stats.verificationFailures || [];
    text += `Verified:        ${verifyProblems.length ? `NO: ${verifyProblems.length} file(s) on disk differ from what was written (see below)` : 'every file read back from disk matches what was written'}\n`;
    if (rebuilt.length) {
      text += `\n${sep}\nRECONSTRUCTED MESSAGES\n${thin}\n`;
      for (const r of rebuilt) text += `${r.file} | ${r.subject || ''} | ${r.reason}\n`;
    }
    const failedItems = stats.failed || [];
    if (failedItems.length) {
      text += `\n${sep}\nMESSAGES NOT EXPORTED (also in export_failed_items.csv)\n${thin}\n`;
      for (const f of failedItems) text += `${f.folder} | ${f.subject} | ${f.sha256 || ''} | ${f.error}\n`;
    }
    if (verifyProblems.length) {
      text += `\n${sep}\nVERIFICATION FAILURES\n${thin}\n`;
      for (const p of verifyProblems) text += `${p.file} | ${p.error}\n`;
    }
    text += `\n${sep}\n`;
    text += `EXPORTED FILES\n`;
    text += `${thin}\n\n`;

    for (let i = 0; i < exportedFiles.length; i++) {
      const f = exportedFiles[i];
      // The path relative to the export folder, so the manifest can be checked file by file.
      const fname = (f.relativePath || f.filename || '').replace(/\\/g, '/');
      const ext = fname.split('.').pop();
      text += `[${i + 1}] ${fname}\n`;
      text += `    Format:  ${ext}\n`;
      text += `    Size:    ${f.size} bytes\n`;
      if (f.md5) text += `    MD5:     ${f.md5}\n`;
      if (f.sha1) text += `    SHA-1:   ${f.sha1}\n`;
      text += `    SHA-256: ${f.hash}\n\n`;
    }

    const preHash = crypto.createHash('sha256').update(text).digest('hex');
    text += `${sep}\n`;
    text += `MANIFEST INTEGRITY\n`;
    text += `${thin}\n`;
    text += `Manifest SHA-256: ${preHash}\n`;
    text += `${sep}\n`;

    return {
      generated,
      tool: 'SherlockMail v0.10.0',
      algorithm: 'SHA-256',
      fileCount: exportedFiles.length,
      totalBytes,
      emailCount,
      attachmentCount,
      emailsFailed,
      attachmentsFailed,
      manifestHash: preHash,
      text,
    };
  }

  static async verifyExport(exportDir) {
    const manifestPath = path.join(exportDir, 'manifest.txt');
    if (!fs.existsSync(manifestPath)) return { valid: false, error: 'Manifest not found' };

    const text = fs.readFileSync(manifestPath, 'utf8');
    const fileEntries = [];
    const entryPattern = /^\[(\d+)\]\s+(.+)\n\s+Format:\s+\S+\n\s+Size:\s+\d+ bytes\n(?:\s+MD5:\s+[a-f0-9]+\n)?(?:\s+SHA-1:\s+[a-f0-9]+\n)?\s+SHA-256:\s+([a-f0-9]+)/gm;
    let match;
    while ((match = entryPattern.exec(text)) !== null) {
      fileEntries.push({ filename: match[2].trim(), sha256: match[3] });
    }

    const results = [];
    for (const fileEntry of fileEntries) {
      const filePath = path.resolve(exportDir, fileEntry.filename);
      if (!filePath.startsWith(path.resolve(exportDir) + path.sep)) {
        results.push({ filename: fileEntry.filename, status: 'outside the export folder' });
        continue;
      }
      if (!fs.existsSync(filePath)) {
        results.push({ filename: fileEntry.filename, status: 'missing' });
        continue;
      }
      const sha = crypto.createHash('sha256');
      let size = 0;
      // A PST part can be far larger than a Buffer can hold.
      for await (const chunk of fs.createReadStream(filePath)) { sha.update(chunk); size += chunk.length; }
      const hash = sha.digest('hex');
      results.push({
        filename: fileEntry.filename,
        expectedHash: fileEntry.sha256,
        computedHash: hash,
        status: hash === fileEntry.sha256 ? 'verified' : 'mismatch',
        size,
      });
    }

    return {
      valid: results.length > 0 && results.every(r => r.status === 'verified'),
      error: results.length ? undefined : 'The manifest lists no files',
      totalFiles: results.length,
      verified: results.filter(r => r.status === 'verified').length,
      failed: results.filter(r => r.status !== 'verified').length,
      details: results,
    };
  }

  static listExportFiles(projectId) {
    const exportsDir = path.join(DATA_DIR, 'exports', projectId);
    if (!fs.existsSync(exportsDir)) return [];

    const exports = [];
    for (const exportId of fs.readdirSync(exportsDir)) {
      const dir = path.join(exportsDir, exportId);
      if (!fs.statSync(dir).isDirectory()) continue;

      const files = fs.readdirSync(dir).map(f => ({
        filename: f,
        size: fs.statSync(path.join(dir, f)).size,
        path: path.join(dir, f),
      }));

      exports.push({ exportId, files, directory: dir });
    }
    return exports;
  }
}

function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let n = 2; fs.existsSync(candidate); n++) candidate = path.join(dir, `${base} (${n})${ext}`);
  return candidate;
}

function csvCell(value) {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function sanitizeFilename(name) {
  return (name || 'untitled')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .substring(0, 60);
}

function sanitizePath(folderPath) {
  return (folderPath || 'INBOX')
    .split('/')
    .map(seg => seg.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/\s+/g, '_'))
    .join(path.sep);
}

function escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function parseJsonField(value, fallback) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return [value]; }
  }
  return fallback;
}
