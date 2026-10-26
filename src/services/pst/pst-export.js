// Writes collected messages, or EML/MBOX files from disk, into Outlook PST files. Each message is
// converted from its original bytes; the PSTs are split at a size limit, and every item is listed with
// the SHA-256 of the message it came from so the PST can be tied back to the collection.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { PstWriter } from './pst-writer.js';
import { mimeToMessage } from './mime-to-mapi.js';

const DEFAULT_MAX_BYTES = 10 * 1024 ** 3;
const MBOX_CHUNK = 4 * 1024 * 1024;

export async function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

const parseList = (v) => {
  if (Array.isArray(v)) return v;
  try { const p = JSON.parse(v || '[]'); return Array.isArray(p) ? p : []; } catch { return []; }
};

// Read state is only known where the source reports it: IMAP \Seen and Gmail's UNREAD label.
function readState(msg, provider) {
  const flags = parseList(msg.flags).map(String);
  const labels = parseList(msg.labels).map(String);
  if (flags.some(f => f.startsWith('\\'))) return flags.includes('\\Seen') ? 'read' : 'unread';
  if (/gmail/i.test(provider || '') || flags.includes('UNREAD') || labels.includes('UNREAD')) {
    return flags.includes('UNREAD') || labels.includes('UNREAD') ? 'unread' : 'read';
  }
  return undefined;
}

const csvCell = v => {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Opens PST files on demand and moves to the next one when the size limit is reached.
class SplitPst {
  constructor({ outputDir, baseName, displayName, maxBytes }) {
    Object.assign(this, { outputDir, baseName, displayName, maxBytes: maxBytes || DEFAULT_MAX_BYTES });
    this.parts = [];
    this.writer = null;
  }

  current() {
    if (this.writer && this.writer.messageCount > 0 && this.writer.bytesWritten >= this.maxBytes) this._closeCurrent();
    if (!this.writer) {
      const n = this.parts.length + 1;
      const filename = `${this.baseName}_part${String(n).padStart(3, '0')}.pst`;
      this.writer = new PstWriter(path.join(this.outputDir, filename), { displayName: n > 1 ? `${this.displayName} (part ${n})` : this.displayName });
      this.parts.push({ filename, writer: this.writer });
    }
    return this.writer;
  }

  _closeCurrent() {
    const part = this.parts[this.parts.length - 1];
    Object.assign(part, this.writer.close());
    this.writer = null;
  }

  async finish() {
    if (!this.parts.length) this.current();       // an empty collection still yields a valid, empty PST
    if (this.writer) this._closeCurrent();
    if (this.parts.length === 1) {
      const single = `${this.baseName}.pst`;
      fs.renameSync(path.join(this.outputDir, this.parts[0].filename), path.join(this.outputDir, single));
      this.parts[0].filename = single;
    }
    const files = [];
    for (const p of this.parts) {
      const filePath = path.join(this.outputDir, p.filename);
      files.push({ filename: p.filename, path: filePath, relativePath: p.filename, size: fs.statSync(filePath).size, hash: await hashFile(filePath), messageCount: p.messageCount });
    }
    return files;
  }

  abort() {
    if (this.writer) this.writer.abort();
    this.writer = null;
  }
}

/**
 * Collected messages to PST. readMessage(msg) returns { content, original, problem } (the export
 * service's byte-for-byte reader, which labels anything it had to rebuild).
 */
export async function exportMessagesToPst(messages, { outputDir, baseName = 'collection', displayName = 'SherlockMail Export', rootFolderName = 'Collection', maxBytes, provider, readMessage, onProgress } = {}) {
  fs.mkdirSync(outputDir, { recursive: true });
  const pst = new SplitPst({ outputDir, baseName, displayName, maxBytes });
  const items = [];
  const failed = [];
  const reconstructed = [];
  try {
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const folderPath = String(msg.folder || msg.folder_path || 'INBOX');
      try {
        const bytes = readMessage(msg);
        const writer = pst.current();
        const { spec, subject, messageId } = await mimeToMessage(bytes.content, writer, {
          readState: readState(msg, provider),
          flagged: parseList(msg.flags).some(f => f === '\\Flagged' || f === 'STARRED'),
          labels: parseList(msg.labels).filter(l => typeof l === 'string' && !/^(UNREAD|STARRED|IMPORTANT|CATEGORY_|INBOX$|SENT$|DRAFT$|SPAM$|TRASH$)/.test(l)),
          sourceFolder: folderPath,
          acquiredAt: msg.acquired_at,
          internalDate: msg.internal_date,
        });
        const segments = [rootFolderName, ...folderPath.split('/').filter(Boolean)];
        writer.addMessage(writer.folder(segments), spec);
        const sha256 = crypto.createHash('sha256').update(bytes.content).digest('hex');
        if (!bytes.original) reconstructed.push({ file: pst.parts[pst.parts.length - 1].filename, subject: msg.subject, reason: bytes.problem });
        items.push({ part: pst.parts.length - 1, folder: segments.join('/'), subject, messageId, sha256, original: bytes.original, id: msg.id || '' });
      } catch (err) {
        failed.push({ id: msg.id, subject: msg.subject, folder: folderPath, error: err.message });
      }
      onProgress?.(i + 1, messages.length);
    }
    const files = await pst.finish();
    return { files, items: items.map(it => ({ ...it, file: files[it.part].filename })), failed, reconstructed };
  } catch (err) {
    pst.abort();
    throw err;
  }
}

export function itemMapCsv(items) {
  const rows = [['PST File', 'PST Folder', 'Subject', 'Internet Message-ID', 'Source SHA-256', 'Source', 'SherlockMail Message ID'].join(',')];
  for (const it of items) {
    rows.push([it.file, it.folder, it.subject, it.messageId, it.sha256, it.original ? 'original collected MIME' : 'RECONSTRUCTED', it.id].map(csvCell).join(','));
  }
  return rows.join('\r\n') + '\r\n';
}

// ── EML / MBOX sources ──

// Messages in an mbox file, one at a time. Separators are "From " lines at the start of the file or
// after a blank line; ">From " quoting (mboxrd) is reversed only when the caller asks for it.
export async function* readMbox(filePath, { unquote = true } = {}) {
  const fd = fs.openSync(filePath, 'r');
  const finish = (lines) => {
    let buf = Buffer.concat(lines);
    let end = buf.length;
    if (end && buf[end - 1] === 0x0A) end--;                // the blank line the mbox writer added
    if (end && buf[end - 1] === 0x0D) end--;
    buf = buf.subarray(0, end);
    return unquote ? Buffer.from(buf.toString('latin1').replace(/^>(>*From )/gm, '$1'), 'latin1') : buf;
  };
  try {
    const chunk = Buffer.alloc(MBOX_CHUNK);
    let pos = 0, partial = Buffer.alloc(0), current = null, prevBlank = true;
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, pos);
      pos += n;
      const data = n ? Buffer.concat([partial, chunk.subarray(0, n)]) : partial;
      let start = 0;
      for (;;) {
        let nl = data.indexOf(0x0A, start);
        if (nl === -1) { if (n) break; if (start >= data.length) break; nl = data.length - 1; }
        const line = data.subarray(start, nl + 1);
        start = nl + 1;
        if (prevBlank && line.length >= 5 && line.toString('latin1', 0, 5) === 'From ') {
          if (current) yield finish(current);
          current = [];
        } else if (current) {
          current.push(Buffer.from(line));
        } else if (line.toString('latin1').trim()) {
          throw new Error(`${path.basename(filePath)} is not an mbox file (no "From " separator at the start)`);
        }
        prevBlank = line.length <= 2 && line.toString('latin1').trim() === '';
      }
      partial = Buffer.from(data.subarray(start));
      if (!n) break;
    }
    if (current) yield finish(current);
  } finally {
    fs.closeSync(fd);
  }
}

const EML_EXT = new Set(['.eml', '.mime', '.msg822']);
const MBOX_EXT = new Set(['.mbox', '.mbx', '']);

function looksLikeMbox(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const head = Buffer.alloc(5);
    return fs.readSync(fd, head, 0, 5, 0) === 5 && head.toString('latin1') === 'From ';
  } finally { fs.closeSync(fd); }
}

// Every EML and MBOX file under the inputs, with the PST folder each one belongs in.
export function findSources(inputs) {
  const out = [];
  const visit = (p, folder) => {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(p).sort()) visit(path.join(p, name), [...folder, path.basename(p)]);
      return;
    }
    const ext = path.extname(p).toLowerCase();
    if (EML_EXT.has(ext)) out.push({ type: 'eml', path: p, folder });
    else if (MBOX_EXT.has(ext) && looksLikeMbox(p)) out.push({ type: 'mbox', path: p, folder: [...folder, path.basename(p, ext)] });
  };
  for (const input of inputs) {
    if (!fs.existsSync(input)) throw new Error(`Not found: ${input}`);
    const st = fs.statSync(input);
    if (st.isDirectory()) for (const name of fs.readdirSync(input).sort()) visit(path.join(input, name), [path.basename(input)]);
    else visit(input, []);
  }
  return out;
}

/** EML files and MBOX mailboxes from disk to PST. The source files are only read. */
export async function convertFilesToPst(inputs, { outputDir, baseName = 'converted', displayName = 'Converted Mail', maxBytes, unquoteMbox = true, onProgress } = {}) {
  const sources = findSources(inputs);
  if (!sources.length) throw new Error('No EML or MBOX files found in the selected location');
  fs.mkdirSync(outputDir, { recursive: true });
  const pst = new SplitPst({ outputDir, baseName, displayName, maxBytes });
  const items = [];
  const failed = [];
  const add = async (raw, folder, source) => {
    try {
      const writer = pst.current();
      const { spec, subject, messageId } = await mimeToMessage(raw, writer, { sourceFolder: source });
      writer.addMessage(writer.folder(folder.length ? folder : ['Imported']), spec);
      items.push({ part: pst.parts.length - 1, folder: folder.join('/'), subject, messageId, sha256: crypto.createHash('sha256').update(raw).digest('hex'), original: true, id: source });
    } catch (err) {
      failed.push({ source, error: err.message });
    }
  };
  try {
    let done = 0;
    for (const s of sources) {
      if (s.type === 'eml') {
        await add(fs.readFileSync(s.path), s.folder, s.path);
      } else {
        let n = 0;
        try {
          for await (const raw of readMbox(s.path, { unquote: unquoteMbox })) await add(raw, s.folder, `${s.path}#${++n}`);
        } catch (err) {
          failed.push({ source: s.path, error: err.message });
        }
      }
      onProgress?.(++done, sources.length);
    }
    const files = await pst.finish();
    return { files, items: items.map(it => ({ ...it, file: files[it.part].filename })), failed, sourceCount: sources.length };
  } catch (err) {
    pst.abort();
    throw err;
  }
}
