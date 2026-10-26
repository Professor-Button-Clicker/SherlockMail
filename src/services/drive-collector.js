import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { Readable, Transform } from 'stream';
import { v4 as uuidv4 } from 'uuid';
import { google } from 'googleapis';
import { getOAuth2Client, getAuthStatus as googleAuthStatus } from './google-oauth.js';
import { getAccessToken as msGetAccessToken, getAuthStatus as msAuthStatus } from './microsoft-oauth.js';
import { withRetry } from './collection-engine.js';
import { dayStart, nextDay } from './collection-query.js';

// The API roots can be pointed at a local stand-in for testing.
export const GRAPH = process.env.SHERLOCKMAIL_GRAPH_URL || 'https://graph.microsoft.com/v1.0';
const GOOGLE_API_ROOT = process.env.SHERLOCKMAIL_GOOGLE_API_URL || undefined;
const DOWNLOAD_WORKERS = 4;
export const REQUEST_TIMEOUT_MS = 300000;

// Google-native files have no bytes of their own; they are exported to the matching Office format.
export const GOOGLE_EXPORTS = {
  'application/vnd.google-apps.document': { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: '.docx' },
  'application/vnd.google-apps.spreadsheet': { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: '.xlsx' },
  'application/vnd.google-apps.presentation': { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: '.pptx' },
  'application/vnd.google-apps.drawing': { mime: 'application/pdf', ext: '.pdf' },
  'application/vnd.google-apps.script': { mime: 'application/vnd.google-apps.script+json', ext: '.json' },
};
export const GOOGLE_FOLDER = 'application/vnd.google-apps.folder';

export function driveProviderFor(protocol) {
  if (protocol === 'gmail_api') return 'google_drive';
  if (protocol === 'graph' || protocol === 'ews') return 'onedrive';
  return null;
}

export function driveAvailability(protocol) {
  const provider = driveProviderFor(protocol);
  if (!provider) {
    return { available: false, provider: null, reason: 'Drive/Cloud collection needs the Gmail API (Google Drive) or Microsoft Graph/EWS with Microsoft sign-in (OneDrive). Choose one of those collection profiles in Step 1.' };
  }
  const authorized = provider === 'google_drive' ? googleAuthStatus().authorized : msAuthStatus().authorized;
  if (!authorized) {
    return { available: false, provider, reason: provider === 'google_drive' ? 'Authorize with Google in Step 1 to collect Google Drive.' : 'Authorize with Microsoft in Step 1 to collect OneDrive.' };
  }
  return { available: true, provider };
}

// ── QuickXorHash (OneDrive) ──
// Each byte k is XORed into a 160-bit circular vector at bit offset (11 * k) mod 160, and the length is
// XORed into the last 8 bytes. Bytes that share k mod 160 land on the same offset, so they are folded
// into one accumulator first.
export class QuickXorHash {
  constructor() {
    this.acc = new Uint8Array(160);
    this.pos = 0;
    this.length = 0;
  }

  update(buf) {
    const acc = this.acc;
    let p = this.pos;
    for (let i = 0; i < buf.length; i++) {
      acc[p] ^= buf[i];
      p = p === 159 ? 0 : p + 1;
    }
    this.pos = p;
    this.length += buf.length;
    return this;
  }

  digest() {
    const vec = new Uint8Array(20);
    for (let r = 0; r < 160; r++) {
      const v = this.acc[r];
      if (!v) continue;
      const bit = (r * 11) % 160;
      const byte = bit >> 3;
      const shift = bit & 7;
      vec[byte] ^= (v << shift) & 0xff;
      if (shift) vec[(byte + 1) % 20] ^= v >> (8 - shift);
    }
    let len = BigInt(this.length);
    for (let i = 0; i < 8; i++) {
      vec[12 + i] ^= Number(len & 0xffn);
      len >>= 8n;
    }
    return Buffer.from(vec).toString('base64');
  }
}

function hasher(algos) {
  const hashes = {};
  for (const a of algos) hashes[a] = a === 'quickxor' ? new QuickXorHash() : crypto.createHash(a);
  let size = 0;
  const stream = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      for (const h of Object.values(hashes)) h.update(chunk);
      cb(null, chunk);
    },
  });
  return {
    stream,
    result() {
      const out = { size };
      for (const [a, h] of Object.entries(hashes)) out[a] = a === 'quickxor' ? h.digest() : h.digest('hex');
      return out;
    },
  };
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
export function safeSegment(name) {
  let s = String(name || 'unnamed').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim();
  if (!s) s = 'unnamed';
  if (RESERVED.test(s)) s = `_${s}`;
  if (s.length > 120) {
    const ext = path.extname(s).slice(0, 16);
    s = s.slice(0, 120 - ext.length) + ext;
  }
  return s;
}

export function uniquePath(used, dir, name, id) {
  let p = path.join(dir, name);
  if (used.has(p.toLowerCase())) {
    const ext = path.extname(name);
    p = path.join(dir, `${name.slice(0, name.length - ext.length)} [${String(id).slice(0, 10)}]${ext}`);
  }
  used.add(p.toLowerCase());
  return p;
}

function inDateRange(iso, query) {
  if (!query || (!query.dateFrom && !query.dateTo)) return true;
  const d = new Date(iso || NaN);
  if (isNaN(d.getTime())) return false;
  if (query.dateFrom && d < dayStart(query.dateFrom)) return false;
  if (query.dateTo && d >= dayStart(nextDay(query.dateTo))) return false;
  return true;
}

export function transient(err) {
  const status = err.status || err.response?.status || (typeof err.code === 'number' ? err.code : null);
  if (status && status !== 429 && status >= 400 && status < 500) err.permanent = true;
  const ra = parseFloat(err.response?.headers?.['retry-after'] ?? err.retryAfter);
  if (!isNaN(ra)) err.retryAfterMs = ra * 1000;
  return err;
}

// ── Google Drive ──

export function googleClient() {
  return google.drive({ version: 'v3', auth: getOAuth2Client(), timeout: REQUEST_TIMEOUT_MS, ...(GOOGLE_API_ROOT ? { rootUrl: GOOGLE_API_ROOT } : {}) });
}

async function listGoogle(drive, query, signal, log) {
  const clauses = ["'me' in owners"];
  const serverApplied = [];
  if (query?.type === 'in-place') {
    if (query.dateFrom) clauses.push(`modifiedTime >= '${dayStart(query.dateFrom).toISOString()}'`);
    if (query.dateTo) clauses.push(`modifiedTime < '${dayStart(nextDay(query.dateTo)).toISOString()}'`);
    if (query.dateFrom || query.dateTo) serverApplied.push('dateRange');
    if (query.keywords?.length) {
      clauses.push(`(${query.keywords.map(k => `fullText contains '${k.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`).join(' or ')})`);
      serverApplied.push('keywords');
    }
  }
  const q = clauses.join(' and ');
  const folders = new Map();
  const files = [];
  let pageToken;
  do {
    if (signal?.aborted) break;
    const res = await withRetry(async () => {
      try {
        return await drive.files.list({
          q, pageSize: 1000, pageToken, spaces: 'drive', supportsAllDrives: true, includeItemsFromAllDrives: false,
          fields: 'nextPageToken, files(id,name,mimeType,size,md5Checksum,sha256Checksum,createdTime,modifiedTime,owners(emailAddress),parents,webViewLink,shared,trashed)',
        }, { signal });
      } catch (err) { throw transient(err); }
    });
    for (const f of res.data.files || []) {
      if (f.mimeType === GOOGLE_FOLDER) folders.set(f.id, f);
      else files.push(f);
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  // Folders are listed so file paths can be rebuilt; a date or keyword filter may leave some out, so
  // fetch any parent that is missing.
  for (const f of files) {
    for (let pid = f.parents?.[0]; pid && !folders.has(pid) && !folders.has(`missing:${pid}`); ) {
      try {
        const r = await drive.files.get({ fileId: pid, fields: 'id,name,mimeType,parents', supportsAllDrives: true }, { signal });
        if (r.data.mimeType !== GOOGLE_FOLDER || !r.data.parents) { folders.set(`missing:${pid}`, true); break; }
        folders.set(pid, r.data);
        pid = r.data.parents?.[0];
      } catch {
        folders.set(`missing:${pid}`, true);
        break;
      }
    }
  }
  log?.(`Google Drive: listed ${files.length} file(s) owned by the account (query: ${q})`);
  const pathOf = (id, depth = 0) => {
    const f = folders.get(id);
    if (!f || f === true || depth > 64) return [];
    return [...pathOf(f.parents?.[0], depth + 1), safeSegment(f.name)];
  };
  return {
    serverApplied,
    items: files.map(f => {
      const exp = GOOGLE_EXPORTS[f.mimeType];
      const native = f.mimeType.startsWith('application/vnd.google-apps.');
      return {
        remoteId: f.id,
        name: f.name,
        mimeType: f.mimeType,
        size: parseInt(f.size || '0', 10) || 0,
        createdTime: f.createdTime,
        modifiedTime: f.modifiedTime,
        owner: f.owners?.[0]?.emailAddress || null,
        shared: !!f.shared,
        trashed: !!f.trashed,
        webUrl: f.webViewLink,
        parentId: f.parents?.[0] || null,
        folderPath: [...(f.trashed ? ['_Trash'] : []), ...pathOf(f.parents?.[0])],
        export: native ? exp || null : null,
        downloadable: !native || !!exp,
        serverHashes: { md5: f.md5Checksum || null, sha256: f.sha256Checksum || null },
      };
    }),
  };
}

export async function downloadGoogle(drive, item, target, signal) {
  const algos = ['md5', 'sha256'];
  const res = item.export
    ? await drive.files.export({ fileId: item.remoteId, mimeType: item.export.mime }, { responseType: 'stream', signal })
    : await drive.files.get({ fileId: item.remoteId, alt: 'media', acknowledgeAbuse: true, supportsAllDrives: true }, { responseType: 'stream', signal });
  return writeVerified(res.data, target, algos);
}

// ── OneDrive ──

export async function graphJson(url, signal, headers = {}) {
  const token = await msGetAccessToken();
  const res = await fetch(url.startsWith('http') ? url : `${GRAPH}${url}`, {
    headers: { Authorization: `Bearer ${token}`, ...headers },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error?.message || `Graph API error (${res.status})`);
    err.status = res.status;
    err.retryAfter = res.headers.get('retry-after');
    throw transient(err);
  }
  return res.json();
}

async function listOneDrive(query, signal, log) {
  const all = [];
  let url = '/me/drive/root/delta?$select=id,name,size,file,folder,package,parentReference,createdDateTime,lastModifiedDateTime,deleted,webUrl,root,remoteItem,createdBy';
  while (url) {
    if (signal?.aborted) break;
    const data = await withRetry(() => graphJson(url, signal));
    all.push(...(data.value || []));
    url = data['@odata.nextLink'] || null;
  }
  const byId = new Map(all.map(i => [i.id, i]));
  const pathOf = (id, depth = 0) => {
    const i = byId.get(id);
    if (!i || i.root || depth > 64) return [];
    return [...pathOf(i.parentReference?.id, depth + 1), safeSegment(i.name)];
  };
  const files = all.filter(i => i.file && !i.deleted && !i.remoteItem);
  log?.(`OneDrive: listed ${files.length} file(s) in the account's drive`);
  return {
    serverApplied: [],
    items: files
      .filter(i => query?.type !== 'in-place' || inDateRange(i.lastModifiedDateTime, query))
      .map(i => ({
        remoteId: i.id,
        name: i.name,
        mimeType: i.file?.mimeType || null,
        size: i.size || 0,
        createdTime: i.createdDateTime,
        modifiedTime: i.lastModifiedDateTime,
        owner: i.createdBy?.user?.email || i.createdBy?.user?.displayName || null,
        shared: false,
        trashed: false,
        webUrl: i.webUrl,
        parentId: i.parentReference?.id || null,
        folderPath: pathOf(i.parentReference?.id),
        export: null,
        downloadable: true,
        serverHashes: {
          sha256: i.file?.hashes?.sha256Hash?.toLowerCase() || null,
          sha1: i.file?.hashes?.sha1Hash?.toLowerCase() || null,
          quickxor: i.file?.hashes?.quickXorHash || null,
        },
      })),
  };
}

async function downloadOneDrive(item, target, signal) {
  const token = await msGetAccessToken();
  const res = await fetch(`${GRAPH}/me/drive/items/${encodeURIComponent(item.remoteId)}/content`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'follow',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok || !res.body) {
    const err = new Error(`OneDrive download failed (${res.status})`);
    err.status = res.status;
    err.retryAfter = res.headers.get('retry-after');
    throw transient(err);
  }
  return writeVerified(Readable.fromWeb(res.body), target, ['md5', 'sha1', 'sha256', 'quickxor']);
}

// Written to a .part file and renamed only once complete, so an interrupted download never looks finished.
export async function writeVerified(source, target, algos) {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const part = `${target}.part`;
  const h = hasher(algos);
  try {
    await pipeline(source, h.stream, fs.createWriteStream(part));
    await fs.promises.rename(part, target);
  } catch (err) {
    await fs.promises.rm(part, { force: true }).catch(() => {});
    throw err;
  }
  return h.result();
}

export function verify(item, hashes) {
  const s = item.serverHashes || {};
  const checks = [
    ['sha256', s.sha256, hashes.sha256],
    ['sha1', s.sha1, hashes.sha1],
    ['md5', s.md5, hashes.md5],
    ['quickXorHash', s.quickxor, hashes.quickxor],
  ].filter(([, server]) => server);
  if (item.export) return { status: 'exported', detail: 'Google-native file exported; Google publishes no checksum for exports' };
  if (!checks.length) return { status: 'unverified', detail: 'Provider published no checksum for this file' };
  const bad = checks.filter(([, server, local]) => String(server).toLowerCase() !== String(local).toLowerCase());
  if (bad.length) {
    return { status: 'hash_mismatch', detail: `Downloaded content does not match the provider's ${bad.map(b => b[0]).join(', ')}${item.mimeType?.includes('officedocument') ? ' (SharePoint/OneDrive for Business can rewrite Office files on download)' : ''}` };
  }
  return { status: 'verified', detail: `Matches provider ${checks.map(c => c[0]).join(', ')}` };
}

/**
 * Lists the account's drive files (respecting an in-place date/keyword query where the provider allows)
 * without downloading. Used by the pre-collection estimate.
 */
export async function estimateDrive({ protocol, query, signal }) {
  const avail = driveAvailability(protocol);
  if (!avail.available) throw new Error(avail.reason);
  const { items } = avail.provider === 'google_drive'
    ? await listGoogle(googleClient(), query, signal)
    : await listOneDrive(query, signal);
  const downloadable = items.filter(i => i.downloadable);
  return {
    provider: avail.provider,
    files: items.length,
    downloadable: downloadable.length,
    notDownloadable: items.length - downloadable.length,
    totalBytes: downloadable.reduce((s, i) => s + (i.size || 0), 0),
    exportCount: downloadable.filter(i => i.export).length,
  };
}

/**
 * Collects the account's drive into <outDir>/<provider>. Every file is hashed while written and checked
 * against the provider's checksum; nothing is overwritten.
 */
export async function collectDrive({ protocol, projectId, acquisitionId, outDir, query, progress, signal, log, onItem, saveItem, existing }) {
  const avail = driveAvailability(protocol);
  if (!avail.available) throw new Error(avail.reason);
  const provider = avail.provider;
  const label = provider === 'google_drive' ? 'Google Drive' : 'OneDrive';
  const root = path.join(outDir, label);
  const drive = provider === 'google_drive' ? googleClient() : null;

  const stats = { provider, phase: 'listing', total: 0, done: 0, downloaded: 0, failed: 0, skipped: 0, verified: 0, mismatched: 0, bytes: 0, totalBytes: 0 };
  progress.drive = stats;
  const { items } = provider === 'google_drive'
    ? await listGoogle(drive, query, signal, log)
    : await listOneDrive(query, signal, log);

  // Files are filtered by modified date (both providers) and full text (Google only); mail-only criteria
  // do not apply to files.
  const notApplied = [];
  if (query?.type === 'in-place') {
    for (const k of ['from', 'to', 'subject', 'hasAttachments', 'unreadOnly']) {
      if (Array.isArray(query[k]) ? query[k].length : query[k]) notApplied.push(k);
    }
    if (provider === 'onedrive' && query.keywords?.length) notApplied.push('keywords');
  } else if (query?.type === 'in-line') {
    notApplied.push('in-line query (drive files are collected in full)');
  }
  if (notApplied.length) log?.(`${label}: query criteria not applied to drive files: ${notApplied.join(', ')}`);

  stats.total = items.length;
  stats.totalBytes = items.filter(i => i.downloadable).reduce((s, i) => s + i.size, 0);
  stats.phase = 'downloading';
  const used = new Set();
  const records = [];
  const queue = items.slice();

  const work = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      if (signal?.aborted) return;
      const record = {
        id: uuidv4(), projectId, provider, itemType: 'file', name: item.name, mimeType: item.mimeType, size: item.size,
        remoteId: item.remoteId, parentId: item.parentId, path: [...item.folderPath, item.name].join('/'),
        webUrl: item.webUrl, createdTime: item.createdTime, modifiedTime: item.modifiedTime, owner: item.owner,
        shared: item.shared, status: 'listed',
        metadata: { acquisitionId, trashed: item.trashed, serverHashes: item.serverHashes, exportedAs: item.export?.mime || null },
      };
      if (existing && existing.has(item.remoteId) && existing.get(item.remoteId) === item.modifiedTime) {
        record.status = 'skipped_differential';
        record.metadata.detail = 'Unchanged since an earlier acquisition of this project';
        stats.skipped++;
      } else if (!item.downloadable) {
        record.status = 'not_downloadable';
        record.metadata.detail = `Google ${item.mimeType.replace('application/vnd.google-apps.', '')} files cannot be downloaded or exported; metadata recorded`;
        stats.skipped++;
      } else {
        const fileName = safeSegment(item.export && !item.name.toLowerCase().endsWith(item.export.ext) ? `${item.name}${item.export.ext}` : item.name);
        const dir = path.join(root, ...item.folderPath);
        const target = uniquePath(used, dir, fileName, item.remoteId);
        try {
          const hashes = await withRetry(() => (provider === 'google_drive'
            ? downloadGoogle(drive, item, target, signal)
            : downloadOneDrive(item, target, signal)).catch(err => { throw transient(err); }), { attempts: 4 });
          const v = verify(item, hashes);
          record.localPath = target;
          record.hashMd5 = hashes.md5;
          record.hashSha256 = hashes.sha256;
          record.size = hashes.size;
          record.downloadedAt = new Date().toISOString();
          record.status = v.status === 'hash_mismatch' ? 'hash_mismatch' : 'downloaded';
          record.metadata.verification = v;
          if (hashes.quickxor) record.metadata.quickXorHash = hashes.quickxor;
          if (hashes.sha1) record.metadata.sha1 = hashes.sha1;
          stats.downloaded++;
          stats.bytes += hashes.size;
          if (v.status === 'verified') stats.verified++;
          if (v.status === 'hash_mismatch') { stats.mismatched++; log?.(`${label}: HASH MISMATCH ${record.path}: ${v.detail}`); }
        } catch (err) {
          if (signal?.aborted) return;
          record.status = 'failed';
          record.metadata.error = err.message;
          stats.failed++;
          log?.(`${label}: failed ${record.path}: ${err.message}`);
        }
      }
      stats.done++;
      saveItem?.(record);
      records.push(record);
      onItem?.(record);
    }
  };
  await Promise.all(Array.from({ length: DOWNLOAD_WORKERS }, work));
  stats.phase = signal?.aborted ? 'canceled' : 'complete';
  log?.(`${label}: ${stats.downloaded} downloaded (${stats.verified} verified against provider checksum, ${stats.mismatched} mismatched), ${stats.failed} failed, ${stats.skipped} not downloadable`);
  return { provider, label, root, stats, records, criteriaNotApplied: notApplied };
}

export function writeDriveManifest(logsDir, ts, result) {
  if (!result?.records?.length) return null;
  const quote = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const hdr = 'Provider,Status,Verification,Path,LocalPath,Size,MD5,SHA256,Modified,Created,Owner,RemoteId,Detail';
  const rows = result.records.map(r => [
    r.provider, r.status, r.metadata?.verification?.status || '', quote(r.path), quote(r.localPath || ''), r.size || 0,
    r.hashMd5 || '', r.hashSha256 || '', r.modifiedTime || '', r.createdTime || '', quote(r.owner || ''), r.remoteId,
    quote(r.metadata?.verification?.detail || r.metadata?.error || r.metadata?.detail || ''),
  ].join(','));
  const file = path.join(logsDir, `drive_items_${ts}.csv`);
  fs.writeFileSync(file, [hdr, ...rows].join('\n'));
  return file;
}
