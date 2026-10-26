import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';
import { exportMessagesToPst, itemMapCsv } from './pst/pst-export.js';

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
        description: 'Microsoft Outlook message format. Binary format based on OLE/COM structured storage (CFB). Contains message properties, body in RTF/HTML/plain, and embedded attachments.',
        forensicValue: 'HIGH',
        preserves: ['Outlook-specific properties', 'Categories/flags', 'Named MAPI properties', 'Attachments', 'RTF body'],
        limitations: ['Microsoft-proprietary format', 'Requires MAPI property knowledge to parse', 'May not preserve all MIME headers'],
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
        description: 'Unix mailbox format. Concatenates messages separated by "From " lines. Simple, widely supported, but has escaping issues (From-munging). Multiple variants exist (mboxrd, mboxcl, mboxcl2, mboxo).',
        forensicValue: 'MEDIUM',
        preserves: ['Message content', 'Headers', 'MIME structure'],
        limitations: ['From-line escaping modifies content', 'No standard for metadata', 'Single file can be very large', 'Variant differences'],
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
        description: 'PDF report with full message metadata, headers, body text, and forensic hashes for court-ready documentation.',
        forensicValue: 'MEDIUM',
        preserves: ['Message metadata', 'Body text', 'Hash values', 'Chain of custody reference'],
        limitations: ['Attachments listed but not embedded', 'Body text only (no HTML rendering)'],
        usedBy: ['Court submissions', 'Case documentation', 'Client reports'],
      },
      concordance: {
        name: 'Concordance DAT (Load File)',
        extension: '.dat',
        mimeType: 'text/plain',
        description: 'Concordance-compatible delimited load file for eDiscovery review platforms. Uses standard þ (thorn) delimiter and ð (eth) text qualifier. Includes OPT cross-reference file.',
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
    const provider = options.provider || 'Unknown';
    const preserveFolders = options.preserveFolders !== false;
    const folderCounters = {};

    switch (format) {
      case 'eml':
      case 'mime':
        for (const msg of messages) {
          try {
            const result = this.exportMessageBytes(msg);
            const folder = msg.folder || msg.folder_path || 'INBOX';
            const folderName = sanitizeFilename(folder.split('/').pop() || folder);
            folderCounters[folder] = (folderCounters[folder] || 0) + 1;
            const n = folderCounters[folder];
            const hash8 = (msg.hash_sha256 || msg.hashSha256 || 'unknown').substring(0, 8);
            result.filename = `${sanitizeFilename(provider)}_message_${n}_from_${folderName}_${hash8}${result.original ? '' : '_RECONSTRUCTED'}.${format}`;
            const subDir = preserveFolders ? path.join(outputDir, sanitizePath(folder)) : outputDir;
            fs.mkdirSync(subDir, { recursive: true });
            const filePath = path.join(subDir, result.filename);
            const relativePath = preserveFolders ? path.join(sanitizePath(folder), result.filename) : result.filename;
            fs.writeFileSync(filePath, result.content);
            if (!result.original) reconstructed.push({ file: relativePath, subject: msg.subject, reason: result.problem });
            files.push({ filename: result.filename, hash: result.hash, size: result.size, original: result.original, path: filePath, relativePath });
          } catch { emailsFailed++; }
        }
        break;

      case 'msg':
        for (const msg of messages) {
          try {
            const result = this.generateMsg(msg);
            const folder = msg.folder || msg.folder_path || 'INBOX';
            const folderName = sanitizeFilename(folder.split('/').pop() || folder);
            folderCounters[folder] = (folderCounters[folder] || 0) + 1;
            const n = folderCounters[folder];
            const hash8 = (msg.hash_sha256 || msg.hashSha256 || 'unknown').substring(0, 8);
            result.filename = `${sanitizeFilename(provider)}_message_${n}_from_${folderName}_${hash8}.msg`;
            const subDir = preserveFolders ? path.join(outputDir, sanitizePath(folder)) : outputDir;
            fs.mkdirSync(subDir, { recursive: true });
            const filePath = path.join(subDir, result.filename);
            const relativePath = preserveFolders ? path.join(sanitizePath(folder), result.filename) : result.filename;
            fs.writeFileSync(filePath, result.content);
            files.push({ ...result, path: filePath, relativePath });
          } catch { emailsFailed++; }
        }
        break;

      case 'mbox': {
        const filePath = path.join(outputDir, `collection_${new Date().toISOString().replace(/[:.]/g, '-')}.mbox`);
        const result = this.generateMbox(messages, filePath);
        reconstructed.push(...result.reconstructed);
        files.push({ filename: result.filename, hash: result.hash, size: result.size, messageCount: result.messageCount, path: filePath, relativePath: result.filename });
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
            groups = this._groupByThread(messages).map(t => ({ label: t.subject, messages: t.messages }));
            break;
          case 'email':
            groups = messages.map(m => ({ label: m.subject || '(no subject)', messages: [m] }));
            break;
          default:
            groups = [{ label: null, messages }];
        }
        for (const group of groups) {
          try {
            const result = this.generatePdf(group.messages, projectId, group.label);
            const filePath = path.join(outputDir, result.filename);
            fs.writeFileSync(filePath, result.content);
            files.push({ ...result, path: filePath, relativePath: result.filename });
          } catch { emailsFailed += group.messages.length; }
        }
        break;
      }

      case 'concordance': {
        const datResult = this.generateConcordanceDat(messages);
        const datPath = path.join(outputDir, datResult.filename);
        fs.writeFileSync(datPath, datResult.content, 'utf8');
        files.push({ ...datResult, path: datPath, relativePath: datResult.filename });

        const optResult = this.generateConcordanceOpt(messages, projectId);
        const optPath = path.join(outputDir, optResult.filename);
        fs.writeFileSync(optPath, optResult.content, 'utf8');
        files.push({ ...optResult, path: optPath, relativePath: optResult.filename });
        break;
      }

      case 'xml': {
        const xmlResult = this.generateXml(messages, projectId);
        const xmlPath = path.join(outputDir, xmlResult.filename);
        fs.writeFileSync(xmlPath, xmlResult.content, 'utf8');
        files.push({ ...xmlResult, path: xmlPath, relativePath: xmlResult.filename });
        break;
      }
    }

    const manifest = this.generateHashManifest(files, messages, { emailsFailed, attachmentsFailed, reconstructed });
    const manifestPath = path.join(outputDir, 'manifest.txt');
    fs.writeFileSync(manifestPath, manifest.text, 'utf8');

    const sessionManifest = this.generateSessionManifest(projectId, exportId, format, messages, files, options);
    const sessionManifestPath = path.join(outputDir, 'session_manifest.xml');
    fs.writeFileSync(sessionManifestPath, sessionManifest.content, 'utf8');

    const metadataCsv = this.generateMetadataCsv(messages);
    const metadataCsvPath = path.join(outputDir, 'metadata.csv');
    fs.writeFileSync(metadataCsvPath, metadataCsv.content, 'utf8');

    return { files, manifest, sessionManifest, metadataCsv, outputDir, reconstructed };
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
    const date = message.date || new Date().toISOString();
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
      `Date: ${new Date(date).toUTCString()}`,
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

  static generateMsg(message) {
    const from = message.from_address || message.fromAddress || '';
    const to = parseJsonField(message.to_addresses || message.toAddresses, []);
    const cc = parseJsonField(message.cc_addresses || message.ccAddresses, []);
    const subject = message.subject || '(no subject)';
    const bodyText = (message.body_text || message.bodyText || '').substring(0, 250000);
    const msgIdVal = message.message_id || message.messageId || '';
    const sha256 = message.hash_sha256 || message.hashSha256 || '';
    const toStr = Array.isArray(to) ? to.join('; ') : to;
    const ccStr = Array.isArray(cc) ? cc.join('; ') : cc;

    const subjectBuf = Buffer.from(subject + '\0', 'utf16le');
    const fromBuf = Buffer.from(from + '\0', 'utf16le');
    const toBuf = Buffer.from(toStr + '\0', 'utf16le');
    const bodyBuf = Buffer.from(bodyText + '\0', 'utf16le');
    const msgIdBuf = Buffer.from(msgIdVal + '\0', 'utf16le');
    const msgClassBuf = Buffer.from('IPM.Note\0', 'utf16le');
    const ccBuf = ccStr ? Buffer.from(ccStr + '\0', 'utf16le') : null;

    const varProps = [
      [0x001A, msgClassBuf], [0x0037, subjectBuf], [0x0C1A, fromBuf],
      [0x0E04, toBuf], [0x1000, bodyBuf], [0x1035, msgIdBuf],
    ];
    if (ccBuf) varProps.push([0x0E03, ccBuf]);

    const fixedCount = 2;
    const propsData = Buffer.alloc(32 + (fixedCount + varProps.length) * 16, 0);
    let po = 32;
    propsData.writeUInt16LE(0x0003, po); propsData.writeUInt16LE(0x0E07, po + 2);
    propsData.writeUInt32LE(6, po + 4); propsData.writeUInt32LE(1, po + 8);
    po += 16;
    if (message.date) {
      const ft = (BigInt(new Date(message.date).getTime()) + 11644473600000n) * 10000n;
      propsData.writeUInt16LE(0x0040, po); propsData.writeUInt16LE(0x0E06, po + 2);
      propsData.writeUInt32LE(6, po + 4); propsData.writeBigUInt64LE(ft, po + 8);
    }
    po += 16;
    for (const [propId, buf] of varProps) {
      propsData.writeUInt16LE(0x001F, po); propsData.writeUInt16LE(propId, po + 2);
      propsData.writeUInt32LE(6, po + 4); propsData.writeUInt32LE(buf.length, po + 8);
      po += 16;
    }

    const streams = [['__properties_version1.0', propsData]];
    for (const [propId, buf] of varProps) {
      streams.push([`__substg1.0_${propId.toString(16).toUpperCase().padStart(4, '0')}001F`, buf]);
    }

    const content = this._buildCfb(streams);
    return {
      content,
      filename: `${sanitizeFilename(subject)}_${sha256?.substring(0, 8) || 'unknown'}.msg`,
      hash: crypto.createHash('sha256').update(content).digest('hex'),
      size: content.length,
    };
  }

  static _buildCfb(streamEntries) {
    const S = 512, MS = 64, CUT = 4096;
    const END = 0xFFFFFFFE, FAT_M = 0xFFFFFFFD, FREE = 0xFFFFFFFF, NONE = 0xFFFFFFFF;

    const mini = [], regular = [];
    for (const [name, data] of streamEntries) {
      (data.length < CUT ? mini : regular).push({ name, data });
    }

    let mIdx = 0;
    const miniParts = [], miniStarts = new Map(), miniSizes = new Map();
    for (const { name, data } of mini) {
      miniStarts.set(name, mIdx);
      miniSizes.set(name, data.length);
      const cnt = Math.max(1, Math.ceil(data.length / MS));
      const pad = Buffer.alloc(cnt * MS, 0);
      data.copy(pad);
      miniParts.push(pad);
      mIdx += cnt;
    }
    const miniContainer = miniParts.length ? Buffer.concat(miniParts) : Buffer.alloc(0);
    const mcSecs = miniContainer.length ? Math.ceil(miniContainer.length / S) : 0;

    const mfEntries = mIdx;
    const mfBuf = mfEntries ? Buffer.alloc(Math.max(S, Math.ceil(mfEntries * 4 / S) * S), 0xFF) : null;
    if (mfBuf) {
      let mi = 0;
      for (const { data } of mini) {
        const cnt = Math.max(1, Math.ceil(data.length / MS));
        for (let s = 0; s < cnt; s++) { mfBuf.writeUInt32LE(s < cnt - 1 ? mi + 1 : END, mi * 4); mi++; }
      }
    }
    const mfSecs = mfBuf ? Math.ceil(mfBuf.length / S) : 0;

    const regSecs = regular.map(s => Math.max(1, Math.ceil(s.data.length / S)));
    const dirCount = 1 + streamEntries.length;
    const dirSecs = Math.max(1, Math.ceil(dirCount / 4));

    let si = 0;
    const dirStart = si; si += dirSecs;
    const mcStart = si; si += mcSecs;
    const mfStart = si; si += mfSecs;
    const regStarts = new Map();
    regular.forEach((s, i) => { regStarts.set(s.name, si); si += regSecs[i]; });
    const dataSecs = si;
    let fatSecs = Math.max(1, Math.ceil(dataSecs / 127));
    while (dataSecs + fatSecs > fatSecs * 128) fatSecs++;
    const fatStart = si; si += fatSecs;

    const fatBuf = Buffer.alloc(fatSecs * S, 0xFF);
    const fw = (idx, val) => { if (idx * 4 < fatBuf.length) fatBuf.writeUInt32LE(val, idx * 4); };
    for (let i = dirStart; i < dirStart + dirSecs; i++) fw(i, i < dirStart + dirSecs - 1 ? i + 1 : END);
    for (let i = mcStart; i < mcStart + mcSecs; i++) fw(i, i < mcStart + mcSecs - 1 ? i + 1 : END);
    for (let i = mfStart; i < mfStart + mfSecs; i++) fw(i, i < mfStart + mfSecs - 1 ? i + 1 : END);
    regular.forEach((s, ri) => { const st = regStarts.get(s.name); for (let i = st; i < st + regSecs[ri]; i++) fw(i, i < st + regSecs[ri] - 1 ? i + 1 : END); });
    for (let i = fatStart; i < fatStart + fatSecs; i++) fw(i, FAT_M);

    const dirBuf = Buffer.alloc(dirSecs * S, 0);
    for (let i = dirCount; i < dirSecs * 4; i++) {
      const o = i * 128;
      dirBuf.writeUInt32LE(NONE, o + 68); dirBuf.writeUInt32LE(NONE, o + 72);
      dirBuf.writeUInt32LE(NONE, o + 76); dirBuf.writeUInt32LE(END, o + 116);
    }
    const wDE = (idx, name, type, left, right, child, start, size) => {
      const o = idx * 128;
      const nb = Buffer.from(name + '\0', 'utf16le');
      nb.copy(dirBuf, o, 0, Math.min(nb.length, 64));
      dirBuf.writeUInt16LE(Math.min(nb.length, 64), o + 64);
      dirBuf[o + 66] = type; dirBuf[o + 67] = 1;
      dirBuf.writeUInt32LE(left, o + 68); dirBuf.writeUInt32LE(right, o + 72);
      dirBuf.writeUInt32LE(child, o + 76);
      dirBuf.writeUInt32LE(start, o + 116); dirBuf.writeUInt32LE(size, o + 120);
    };

    const bTree = (arr) => {
      if (!arr.length) return null;
      const m = arr.length >> 1;
      return { i: arr[m], l: bTree(arr.slice(0, m)), r: bTree(arr.slice(m + 1)) };
    };
    const tree = bTree(streamEntries.map((_, i) => i + 1));
    const writeNodes = (n) => {
      if (!n) return;
      const name = streamEntries[n.i - 1][0];
      const ls = n.l ? n.l.i : NONE, rs = n.r ? n.r.i : NONE;
      let start, size;
      if (miniStarts.has(name)) { start = miniStarts.get(name); size = miniSizes.get(name); }
      else { start = regStarts.get(name); size = regular.find(s => s.name === name).data.length; }
      wDE(n.i, name, 2, ls, rs, NONE, start, size);
      writeNodes(n.l); writeNodes(n.r);
    };
    wDE(0, 'Root Entry', 5, NONE, NONE, tree ? tree.i : NONE, mcSecs > 0 ? mcStart : END, miniContainer.length);
    writeNodes(tree);

    const hdr = Buffer.alloc(S, 0);
    Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]).copy(hdr);
    hdr.writeUInt16LE(0x003E, 24); hdr.writeUInt16LE(0x0003, 26);
    hdr.writeUInt16LE(0xFFFE, 28); hdr.writeUInt16LE(9, 30); hdr.writeUInt16LE(6, 32);
    hdr.writeUInt32LE(fatSecs, 44); hdr.writeUInt32LE(dirStart, 48);
    hdr.writeUInt32LE(CUT, 56);
    hdr.writeUInt32LE(mfSecs > 0 ? mfStart : END, 60); hdr.writeUInt32LE(mfSecs, 64);
    hdr.writeUInt32LE(END, 68); hdr.writeUInt32LE(0, 72);
    for (let i = 0; i < 109; i++) hdr.writeUInt32LE(i < fatSecs ? fatStart + i : FREE, 76 + i * 4);

    const pad = (b) => { const r = b.length % S; return r ? Buffer.concat([b, Buffer.alloc(S - r)]) : b; };
    const parts = [hdr, dirBuf];
    if (mcSecs) parts.push(pad(miniContainer));
    if (mfSecs) parts.push(mfBuf);
    for (const s of regular) parts.push(pad(s.data));
    parts.push(fatBuf);
    return Buffer.concat(parts);
  }

  // mboxrd: each original message (byte-for-byte, apart from the reversible ">From " quoting) after a
  // "From sender asctime-date" separator line.
  static generateMbox(messages, filePath) {
    const reconstructed = [];
    const filename = path.basename(filePath);
    const hash = crypto.createHash('sha256');
    let size = 0;
    const fd = fs.openSync(filePath, 'w');
    const write = (str) => {
      const buf = Buffer.from(str, 'latin1');
      fs.writeSync(fd, buf);
      hash.update(buf);
      size += buf.length;
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
        const exported = this.exportMessageBytes(msg);
        if (!exported.original) reconstructed.push({ file: filename, subject: msg.subject, reason: exported.problem });
        const sender = ((msg.from_address || msg.fromAddress || '').match(/[^\s<>"]+@[^\s<>"]+/) || ['MAILER-DAEMON'])[0];
        // latin1 maps every byte to one character and back, so 8-bit content survives unchanged.
        const raw = exported.content.toString('latin1').replace(/\r\n/g, '\n');
        const quoted = raw.replace(/^(>*From )/gm, '>$1');
        write(`From ${sender} ${asctime(new Date(msg.date))}\n`);
        write(quoted.endsWith('\n') ? quoted : `${quoted}\n`);
        write('\n');
      }
    } finally {
      fs.closeSync(fd);
    }

    return { filename, hash: hash.digest('hex'), size, messageCount: messages.length, reconstructed };
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

  static generatePdf(messages, projectId, threadLabel = null) {
    const now = new Date().toISOString();
    const pdfEsc = (str) => String(str ?? '').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

    const objects = [];
    let objNum = 0;
    const addObj = (content) => { objNum++; objects.push({ num: objNum, content }); return objNum; };

    const catalogNum = addObj('');
    const pagesNum = addObj('');

    const fontNum = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    const fontBoldNum = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
    const fontMonoNum = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>');

    const pageWidth = 612;
    const pageHeight = 792;
    const margin = 50;
    const lineHeight = 14;
    const maxY = pageHeight - margin;
    const contentWidth = pageWidth - 2 * margin;

    const pageContents = [];
    let currentLines = [];
    let curY = maxY;

    const flushPage = () => {
      if (currentLines.length === 0) return;
      const stream = currentLines.join('\n');
      const streamNum = addObj(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
      const pageNum = addObj(`<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Contents ${streamNum} 0 R /Resources << /Font << /F1 ${fontNum} 0 R /F2 ${fontBoldNum} 0 R /F3 ${fontMonoNum} 0 R >> >> >>`);
      pageContents.push(pageNum);
      currentLines = [];
      curY = maxY;
    };

    const addLine = (text, font = '/F1', size = 10) => {
      if (curY < margin + lineHeight) flushPage();
      currentLines.push(`BT ${font} ${size} Tf ${margin} ${curY} Td (${pdfEsc(text)}) Tj ET`);
      curY -= lineHeight;
    };

    const addGap = (px = 8) => { curY -= px; };

    const title = threadLabel ? `Thread: ${threadLabel.substring(0, 80)}` : 'SherlockMail Forensic Email Report';
    addLine(title, '/F2', 16);
    curY -= 6;
    addLine(`Project: ${projectId}  |  Generated: ${now}  |  Messages: ${messages.length}`, '/F1', 9);
    addLine('Tool: SherlockMail v0.9.0  |  Hash Algorithm: SHA-256', '/F1', 9);
    addGap(12);

    currentLines.push(`${margin} ${curY + 4} m ${pageWidth - margin} ${curY + 4} l S`);
    addGap(12);

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const from = msg.from_address || msg.fromAddress || '';
      const to = parseJsonField(msg.to_addresses || msg.toAddresses, []);
      const subject = msg.subject || '(no subject)';
      const date = msg.date ? new Date(msg.date).toLocaleString() : 'Unknown';
      const sha256 = msg.hash_sha256 || msg.hashSha256 || 'N/A';
      const folder = msg.folder || '';
      const body = (msg.body_text || msg.bodyText || '').substring(0, 2000);

      if (curY < margin + lineHeight * 8) flushPage();

      addLine(`Message #${i + 1}: ${subject.substring(0, 80)}`, '/F2', 11);
      addGap(4);
      addLine(`From: ${from}`, '/F1', 9);
      addLine(`To: ${(Array.isArray(to) ? to.join(', ') : to).substring(0, 100)}`, '/F1', 9);
      addLine(`Date: ${date}    Folder: ${folder}`, '/F1', 9);
      addLine(`SHA-256: ${sha256}`, '/F3', 7);
      addGap(4);

      if (body) {
        const bodyLines = body.split(/\r?\n/).slice(0, 15);
        for (const line of bodyLines) {
          const truncated = line.substring(0, 90);
          if (curY < margin + lineHeight) { flushPage(); addLine('(continued)', '/F1', 8); }
          addLine(truncated, '/F1', 8);
        }
        if (body.split(/\r?\n/).length > 15) addLine('...', '/F1', 8);
      }
      addGap(10);
      currentLines.push(`${margin} ${curY + 6} m ${pageWidth - margin} ${curY + 6} l 0.8 0.8 0.8 RG S 0 0 0 RG`);
      addGap(10);
    }

    flushPage();

    objects[0].content = `<< /Type /Catalog /Pages ${pagesNum} 0 R >>`;
    objects[1].content = `<< /Type /Pages /Kids [${pageContents.map(n => `${n} 0 R`).join(' ')}] /Count ${pageContents.length} >>`;

    let pdf = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
    const offsets = [];
    for (const obj of objects) {
      offsets.push(Buffer.byteLength(pdf));
      pdf += `${obj.num} 0 obj\n${obj.content}\nendobj\n`;
    }

    const xrefOffset = Buffer.byteLength(pdf);
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) {
      pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
    }
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogNum} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

    const content = Buffer.from(pdf, 'binary');

    return {
      content,
      filename: `${sanitizeFilename(threadLabel || 'report')}_${new Date().toISOString().replace(/[:.]/g, '-')}.pdf`,
      hash: crypto.createHash('sha256').update(content).digest('hex'),
      size: content.length,
      messageCount: messages.length,
    };
  }

  static generateConcordanceDat(messages) {
    const D = 'þ'; // þ (thorn) — Concordance field delimiter
    const Q = 'ð'; // ð (eth) — Concordance text qualifier

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
      const batesAttEnd = attCount > 0 ? `${batesPrefix}${String(idx + 1 + attCount).padStart(padLen, '0')}` : '';

      const from = msg.from_address || msg.fromAddress || '';
      const to = parseJsonField(msg.to_addresses || msg.toAddresses, []).join('; ');
      const cc = parseJsonField(msg.cc_addresses || msg.ccAddresses, []).join('; ');
      const bcc = parseJsonField(msg.bcc_addresses || msg.bccAddresses, []).join('; ');
      const subject = msg.subject || '';
      const d = msg.date ? new Date(msg.date) : null;
      const dateSent = d ? `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}` : '';
      const timeSent = d ? d.toTimeString().substring(0, 8) : '';
      const dateRcvd = msg.acquired_at ? new Date(msg.acquired_at).toLocaleDateString('en-US') : '';
      const timeRcvd = msg.acquired_at ? new Date(msg.acquired_at).toTimeString().substring(0, 8) : '';
      const folder = msg.folder || '';
      const hasAtt = msg.has_attachments || msg.hasAttachments ? 'TRUE' : 'FALSE';
      const size = msg.size || 0;
      const msgId = msg.message_id || msg.messageId || '';
      const convIdx = msg.in_reply_to || '';
      const parentId = msg.in_reply_to || '';
      const md5 = msg.hash_md5 || msg.hashMd5 || '';
      const sha256 = msg.hash_sha256 || msg.hashSha256 || '';
      const body = (msg.body_text || msg.bodyText || '').substring(0, 32000).replace(/[\r\n]+/g, ' ');

      const vals = [msg.id, batesBegin, batesEnd, batesBegin, batesAttEnd || batesEnd,
        msg.custodian || '', from, to, cc, bcc, subject, dateSent, timeSent,
        dateRcvd, timeRcvd, folder, hasAtt, attCount, size, msgId, convIdx, parentId,
        md5, sha256, body];
      return vals.map(v => `${Q}${String(v ?? '').replace(/ð/g, '')}${Q}`).join(D);
    });

    const content = [header, ...rows].join('\r\n') + '\r\n';
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
    const x = (str) => String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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
    <body encoding="plain"><![CDATA[${body}]]></body>
  </message>`;
    }).join('\n');

    const content = `<?xml version="1.0" encoding="UTF-8"?>
<sherlockMailExport version="1.0" generated="${x(now)}" tool="SherlockMail v0.9.0">
  <project id="${x(projectId)}"/>
  <summary>
    <totalMessages>${messages.length}</totalMessages>
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
  <Tool>SherlockMail v0.9.0</Tool>
  <CaseInformation>
    <CaseName>${x(project.case_name || project.caseName || '')}</CaseName>
    <CaseId>${x(project.case_id || project.caseId || '')}</CaseId>
    <ExaminerName>${x(project.examiner_name || project.examinerName || '')}</ExaminerName>
    <Agency>${x(project.agency || '')}</Agency>
    <EvidenceId>${x(project.evidence_id || project.evidenceId || '')}</EvidenceId>
    <CustodianFullName>${x(project.custodian_name || project.custodianName || '')}</CustodianFullName>
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
    text += `Tool:            SherlockMail v0.9.0\n`;
    text += `Hash Algorithm:  SHA-256\n`;
    text += `File Count:      ${exportedFiles.length}\n`;
    text += `Total Size:      ${totalBytes} bytes\n`;
    text += `Emails:          ${emailCount}\n`;
    text += `Attachments:     ${attachmentCount}\n`;
    text += `Emails Failed:   ${emailsFailed}\n`;
    text += `Attach. Failed:  ${attachmentsFailed}\n`;
    const rebuilt = stats.reconstructed || [];
    text += `Reconstructed:   ${rebuilt.length}${rebuilt.length ? ' (NOT the original collected MIME; see below)' : ' (every message exported from its original collected bytes)'}\n`;
    if (rebuilt.length) {
      text += `\n${sep}\nRECONSTRUCTED MESSAGES\n${thin}\n`;
      for (const r of rebuilt) text += `${r.file} | ${r.subject || ''} | ${r.reason}\n`;
    }
    text += `\n${sep}\n`;
    text += `EXPORTED FILES\n`;
    text += `${thin}\n\n`;

    for (let i = 0; i < exportedFiles.length; i++) {
      const f = exportedFiles[i];
      const fname = f.filename || f.relativePath;
      const ext = (fname || '').split('.').pop();
      text += `[${i + 1}] ${fname}\n`;
      text += `    Format:  ${ext}\n`;
      text += `    Size:    ${f.size} bytes\n`;
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
      tool: 'SherlockMail v0.9.0',
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

  static verifyExport(exportDir) {
    const manifestPath = path.join(exportDir, 'manifest.txt');
    if (!fs.existsSync(manifestPath)) return { valid: false, error: 'Manifest not found' };

    const text = fs.readFileSync(manifestPath, 'utf8');
    const fileEntries = [];
    const entryPattern = /^\[(\d+)\]\s+(.+)\n\s+Format:\s+\S+\n\s+Size:\s+\d+ bytes\n\s+SHA-256:\s+([a-f0-9]+)/gm;
    let match;
    while ((match = entryPattern.exec(text)) !== null) {
      fileEntries.push({ filename: match[2], sha256: match[3] });
    }

    const results = [];
    for (const fileEntry of fileEntries) {
      const filePath = path.join(exportDir, fileEntry.filename);
      if (!fs.existsSync(filePath)) {
        results.push({ filename: fileEntry.filename, status: 'missing' });
        continue;
      }
      const content = fs.readFileSync(filePath);
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      results.push({
        filename: fileEntry.filename,
        expectedHash: fileEntry.sha256,
        computedHash: hash,
        status: hash === fileEntry.sha256 ? 'verified' : 'mismatch',
        size: content.length,
      });
    }

    return {
      valid: results.every(r => r.status === 'verified'),
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
