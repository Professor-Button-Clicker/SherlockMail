// Files linked from collected mail (Google Drive / Docs, OneDrive, SharePoint) downloaded with the
// signed-in Google or Microsoft account. Every link found is recorded: downloaded files are hashed while
// written and checked against the provider's checksum, and every link that is not downloaded says why.
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { v4 as uuidv4 } from 'uuid';
import { CloudAttachmentService } from './cloud-attachment-service.js';
import { getAuthStatus as googleAuthStatus } from './google-oauth.js';
import { getAccessToken as msGetAccessToken, getAuthStatus as msAuthStatus } from './microsoft-oauth.js';
import {
  GRAPH, REQUEST_TIMEOUT_MS, GOOGLE_EXPORTS, GOOGLE_FOLDER, googleClient, downloadGoogle, graphJson,
  writeVerified, verify, safeSegment, uniquePath, transient,
} from './drive-collector.js';
import { withRetry } from './collection-engine.js';

export const LINKED_FOLDER_NAME = 'Linked Cloud Files';
const WORKERS = 3;
const LABELS = { google_drive: 'Google Drive', google_docs: 'Google Drive', onedrive: 'OneDrive', sharepoint: 'SharePoint', dropbox: 'Dropbox', box: 'Box' };

const decodeEntities = s => s.replace(/&amp;/gi, '&').replace(/&#x2F;/gi, '/').replace(/&#47;/g, '/').replace(/&quot;/gi, '"');
// A link's last character is often sentence punctuation or a closing bracket, not part of the URL.
const trimUrl = u => u.replace(/[.,;:!?'")\]}>]+$/, '');

/**
 * The cloud links in a set of messages, one entry per linked file, each listing the messages that link
 * to it. messages: rows with id, subject, folder, body_text/body_html (or bodyText/bodyHtml).
 */
export function findCloudLinks(messages) {
  const byKey = new Map();
  for (const m of messages) {
    const text = decodeEntities(`${m.body_text || m.bodyText || ''} ${m.body_html || m.bodyHtml || ''}`);
    for (const link of CloudAttachmentService.detectLinks(text)) {
      const url = trimUrl(link.url);
      const google = link.provider === 'google_drive' || link.provider === 'google_docs';
      const key = google && link.fileId ? `google:${link.fileId}` : `${link.provider}:${url.toLowerCase()}`;
      let entry = byKey.get(key);
      if (!entry) {
        entry = { id: uuidv4(), key, provider: link.provider, providerLabel: LABELS[link.provider] || link.providerLabel, url, fileId: link.fileId || null, isFolderLink: /\/drive\/folders\//.test(url), messages: [] };
        byKey.set(key, entry);
      }
      if (!entry.messages.some(x => x.id === m.id)) {
        entry.messages.push({ id: m.id, subject: m.subject || '', folder: m.folder || '', messageId: m.message_id || m.messageId || '', emlPath: m.eml_path || m.emlPath || '' });
      }
    }
  }
  return [...byKey.values()];
}

const statusOf = err => Number(err?.status ?? err?.response?.status ?? err?.code) || null;

// ── Google ──

async function googleAccount(drive, signal) {
  try {
    const r = await drive.about.get({ fields: 'user(emailAddress)' }, { signal });
    return r.data.user?.emailAddress || 'the signed-in Google account';
  } catch {
    return 'the signed-in Google account';
  }
}

async function fetchGoogle(ctx, link, signal) {
  const { drive, account, root, used } = ctx;
  let meta;
  try {
    meta = (await withRetry(() => drive.files.get({
      fileId: link.fileId, supportsAllDrives: true,
      fields: 'id,name,mimeType,size,md5Checksum,sha256Checksum,createdTime,modifiedTime,owners(emailAddress),webViewLink,trashed',
    }, { signal }).catch(err => { throw transient(err); }), { attempts: 3 })).data;
  } catch (err) {
    const status = statusOf(err);
    if (status === 404) return { status: 'not_downloaded', reason: `Not found, or not shared with ${account}` };
    if (status === 403) return { status: 'not_downloaded', reason: `${account} is not allowed to open this file` };
    if (status === 401) return { status: 'not_downloaded', reason: 'The Google sign-in has expired; sign in again in Collect step 1' };
    return { status: 'failed', reason: `Google Drive could not be reached: ${err.message}` };
  }
  const info = { name: meta.name, mimeType: meta.mimeType, owner: meta.owners?.[0]?.emailAddress || null, modifiedTime: meta.modifiedTime, remoteId: meta.id, account };
  if (meta.mimeType === GOOGLE_FOLDER) {
    return { ...info, status: 'not_downloaded', reason: 'Folder link: linked folders are not downloaded (collect the Drive / Cloud scope for the account that owns it)' };
  }
  const native = meta.mimeType.startsWith('application/vnd.google-apps.');
  const exp = native ? GOOGLE_EXPORTS[meta.mimeType] || null : null;
  if (native && !exp) {
    return { ...info, status: 'not_downloaded', reason: `Google ${meta.mimeType.replace('application/vnd.google-apps.', '')} files cannot be downloaded or exported` };
  }
  const item = { remoteId: meta.id, export: exp, mimeType: meta.mimeType, serverHashes: { md5: meta.md5Checksum || null, sha256: meta.sha256Checksum || null } };
  const name = safeSegment(exp && !meta.name.toLowerCase().endsWith(exp.ext) ? `${meta.name}${exp.ext}` : meta.name);
  const target = uniquePath(used, path.join(root, 'Google Drive'), name, meta.id);
  const hashes = await withRetry(() => downloadGoogle(drive, item, target, signal).catch(err => { throw transient(err); }), { attempts: 4 });
  return { ...info, ...finished(item, hashes, target), exportedAs: exp?.mime || null };
}

// ── OneDrive / SharePoint, through the Graph sharing-link API ──

const shareId = url => `u!${Buffer.from(url, 'utf8').toString('base64').replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-')}`;

async function microsoftAccount(signal) {
  try {
    const me = await graphJson('/me?$select=userPrincipalName,mail', signal);
    return me.mail || me.userPrincipalName || 'the signed-in Microsoft account';
  } catch {
    return 'the signed-in Microsoft account';
  }
}

async function fetchMicrosoft(ctx, link, signal) {
  const { account, root, used } = ctx;
  const sid = shareId(link.url);
  const redeem = { Prefer: 'redeemSharingLinkIfNecessary' };
  let meta;
  try {
    meta = await withRetry(() => graphJson(`/shares/${sid}/driveItem?$select=id,name,size,file,folder,package,parentReference,lastModifiedDateTime,createdBy,webUrl`, signal, redeem), { attempts: 3 });
  } catch (err) {
    const status = statusOf(err);
    if (status === 404) return { status: 'not_downloaded', reason: 'The link no longer works, or the file was deleted' };
    if (status === 403) return { status: 'not_downloaded', reason: `${account} is not allowed to open this link (if it was shared with this account, sign in again in Collect step 1 to grant access to shared files)` };
    if (status === 401) return { status: 'not_downloaded', reason: 'The Microsoft sign-in has expired; sign in again in Collect step 1' };
    return { status: 'failed', reason: `Microsoft Graph could not be reached: ${err.message}` };
  }
  const info = { name: meta.name, mimeType: meta.file?.mimeType || null, owner: meta.createdBy?.user?.email || meta.createdBy?.user?.displayName || null, modifiedTime: meta.lastModifiedDateTime, remoteId: meta.id, account };
  if (meta.folder || meta.package) {
    return { ...info, status: 'not_downloaded', reason: 'Folder link: linked folders are not downloaded (collect the Drive / Cloud scope for the account that owns it)' };
  }
  const item = {
    remoteId: meta.id, mimeType: info.mimeType,
    serverHashes: { sha256: meta.file?.hashes?.sha256Hash?.toLowerCase() || null, sha1: meta.file?.hashes?.sha1Hash?.toLowerCase() || null, quickxor: meta.file?.hashes?.quickXorHash || null },
  };
  const target = uniquePath(used, path.join(root, link.provider === 'sharepoint' ? 'SharePoint' : 'OneDrive'), safeSegment(meta.name), meta.id);
  const hashes = await withRetry(async () => {
    const token = await msGetAccessToken();
    const res = await fetch(`${GRAPH}/shares/${sid}/driveItem/content`, {
      headers: { Authorization: `Bearer ${token}`, ...redeem },
      redirect: 'follow',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok || !res.body) {
      const err = new Error(`Download failed (${res.status})`);
      err.status = res.status;
      err.retryAfter = res.headers.get('retry-after');
      throw transient(err);
    }
    return writeVerified(Readable.fromWeb(res.body), target, ['md5', 'sha1', 'sha256', 'quickxor']);
  }, { attempts: 4 });
  return { ...info, ...finished(item, hashes, target) };
}

function finished(item, hashes, target) {
  const v = verify(item, hashes);
  return {
    status: v.status === 'hash_mismatch' ? 'hash_mismatch' : 'downloaded',
    verification: v.status, reason: v.detail,
    localPath: target, size: hashes.size, md5: hashes.md5, sha1: hashes.sha1 || null, sha256: hashes.sha256,
    downloadedAt: new Date().toISOString(),
  };
}

/**
 * Finds the cloud links in `messages` and downloads what the signed-in accounts can open into
 * <outDir>/Linked Cloud Files. Returns { records, stats, root }.
 */
export async function collectLinkedFiles({ messages, outDir, signal, log, progress, onRecord }) {
  const links = findCloudLinks(messages);
  const root = path.join(outDir, LINKED_FOLDER_NAME);
  const stats = { found: links.length, done: 0, downloaded: 0, verified: 0, mismatched: 0, notDownloaded: 0, failed: 0, bytes: 0, accounts: {} };
  if (progress) progress.linkedFiles = stats;
  if (!links.length) {
    log?.('Linked cloud files: no Google Drive, OneDrive, SharePoint, Dropbox or Box links in the collected messages');
    return { records: [], stats, root };
  }
  log?.(`Linked cloud files: ${links.length} linked file(s) found in ${new Set(links.flatMap(l => l.messages.map(m => m.id))).size} message(s)`);

  const used = new Set();
  const wantsGoogle = links.some(l => l.provider === 'google_drive' || l.provider === 'google_docs');
  const wantsMicrosoft = links.some(l => l.provider === 'onedrive' || l.provider === 'sharepoint');
  const google = wantsGoogle && googleAuthStatus().authorized ? { drive: googleClient(), root, used } : null;
  if (google) google.account = await googleAccount(google.drive, signal);
  const microsoft = wantsMicrosoft && msAuthStatus().authorized ? { root, used } : null;
  if (microsoft) microsoft.account = await microsoftAccount(signal);
  if (google) stats.accounts.google = google.account;
  if (microsoft) stats.accounts.microsoft = microsoft.account;

  const records = [];
  const queue = links.slice();
  const work = async () => {
    for (let link = queue.shift(); link; link = queue.shift()) {
      if (signal?.aborted) return;
      let outcome;
      try {
        if (link.provider === 'google_drive' || link.provider === 'google_docs') {
          outcome = !link.fileId ? { status: 'not_downloaded', reason: 'The link does not name a Google Drive file' }
            : google ? await fetchGoogle(google, link, signal)
            : { status: 'not_downloaded', reason: 'Not signed in to Google in SherlockMail (sign in with Google in Collect step 1)' };
        } else if (link.provider === 'onedrive' || link.provider === 'sharepoint') {
          outcome = microsoft ? await fetchMicrosoft(microsoft, link, signal)
            : { status: 'not_downloaded', reason: 'Not signed in to Microsoft in SherlockMail (sign in with Microsoft in Collect step 1)' };
        } else {
          outcome = { status: 'not_downloaded', reason: `SherlockMail has no ${link.providerLabel} sign-in; preserve this file through ${link.providerLabel} (an export by the account owner or administrator)` };
        }
      } catch (err) {
        if (signal?.aborted) return;
        outcome = { status: 'failed', reason: err.message };
      }
      const record = { ...link, ...outcome };
      stats.done++;
      if (record.status === 'downloaded' || record.status === 'hash_mismatch') {
        stats.downloaded++;
        stats.bytes += record.size || 0;
        if (record.verification === 'verified') stats.verified++;
        if (record.status === 'hash_mismatch') { stats.mismatched++; log?.(`Linked cloud files: HASH MISMATCH ${record.name}: ${record.reason}`); }
      } else if (record.status === 'failed') {
        stats.failed++;
        log?.(`Linked cloud files: failed ${record.url}: ${record.reason}`);
      } else {
        stats.notDownloaded++;
      }
      if (progress) progress.statusDetail = `Downloading linked cloud files: ${stats.done} of ${stats.found}`;
      records.push(record);
      onRecord?.(record);
    }
  };
  await Promise.all(Array.from({ length: Math.min(WORKERS, links.length) }, work));
  for (const l of queue) records.push({ ...l, status: 'not_downloaded', reason: 'Collection stopped before this link was reached' });
  log?.(`Linked cloud files: ${stats.downloaded} downloaded (${stats.verified} verified against the provider's checksum, ${stats.mismatched} mismatched), ${stats.notDownloaded} not downloaded, ${stats.failed} failed`);
  return { records, stats, root };
}

export function writeLinkedFilesManifest(logsDir, ts, result) {
  if (!result?.records?.length) return null;
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const hdr = 'Provider,Status,Verification,Reason,Link,FileName,SavedAs,Size,MD5,SHA256,Owner,Modified,OpenedWith,LinkedFromMessages,MessageSubjects,MessageFiles';
  const rows = result.records.map(r => [
    r.providerLabel, r.status, r.verification || '', q(r.reason || ''), q(r.url), q(r.name || ''), q(r.localPath || ''),
    r.size || '', r.md5 || '', r.sha256 || '', q(r.owner || ''), r.modifiedTime || '', q(r.account || ''),
    r.messages.length, q(r.messages.map(m => m.subject).join(' | ')), q(r.messages.map(m => m.emlPath).join(' | ')),
  ].join(','));
  const file = path.join(logsDir, `linked_cloud_files_${ts}.csv`);
  fs.writeFileSync(file, [hdr, ...rows].join('\r\n') + '\r\n');
  return file;
}
