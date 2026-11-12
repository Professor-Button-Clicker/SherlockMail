import { Router } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);
import {
  createProject, getProjects, getProjectsSummary, getProject, deleteProject, updateProjectStatus, updateProject,
  saveFolders, replaceFolders, getFolderSummary, getFolders, createAcquisition, saveMessage, saveMessagesBatch, getMessages, getMessageCount,
  saveSearchQuery, getSearchQueries, saveExportRecord, getExportRecords, updateExportRecord,
  getAuditLog, getFullAuditLog, getStats, addAuditEntry,
  getMessage, getAllProjectMessages, getProjectMessageKeys, updateAcquisition, getAcquisitions,
  saveAttachment, getAttachments, getProjectAttachments,
  saveDriveLink, getDriveLinks, setAttachmentLocalPath,
  getTimestampRecords,
  saveInlineSearch, getInlineSearches,
  saveQcResult, getQcResults,
  recoverInterruptedCollections, verifyAuditLogChain,
} from '../db/database.js';
import { ImapHandler } from '../protocols/imap-handler.js';
import { Pop3Handler } from '../protocols/pop3-handler.js';
import { EwsHandler } from '../protocols/ews-handler.js';
import { GraphHandler } from '../protocols/graph-handler.js';
import { GmailHandler } from '../protocols/gmail-handler.js';
import { ZohoHandler } from '../protocols/zoho-handler.js';
import { JmapHandler } from '../protocols/jmap-handler.js';
import { ExportService } from '../services/export-service.js';
import { convertFilesToPst, itemMapCsv } from '../services/pst/pst-export.js';
import { InlineSearchEngine } from '../services/inline-search.js';
import { QualityControlService } from '../services/quality-control.js';
import { CloudAttachmentService } from '../services/cloud-attachment-service.js';
import { TimestampService } from '../services/timestamp-service.js';
import { runCollection, supportsEngine, enumerateFolders, COLLECTION_PROFILES } from '../services/collection-engine.js';
import { normalizeQuery, planQuery, describeQuery, describeKeys, matchesLocally } from '../services/collection-query.js';
import { driveAvailability, driveProviderFor, collectDrive, estimateDrive, writeDriveManifest, safeSegment } from '../services/drive-collector.js';
import { collectLinkedFiles, writeLinkedFilesManifest, LINKED_FOLDER_NAME } from '../services/linked-files.js';
import { simpleParser } from 'mailparser';
import {
  getAuthStatus, getAuthUrl, saveCredentials, loadCredentials,
  startCallbackServer, waitForAuth, stopCallbackServer, revokeTokens, getGoogleAccessToken,
} from '../services/google-oauth.js';
import {
  getAuthStatus as msGetAuthStatus, getAuthUrl as msGetAuthUrl,
  saveCredentials as msSaveCredentials, getAccessToken as msGetAccessToken,
  startCallbackServer as msStartCallbackServer, waitForAuth as msWaitForAuth,
  stopCallbackServer as msStopCallbackServer, revokeTokens as msRevokeTokens,
} from '../services/microsoft-oauth.js';
import {
  getAuthStatus as zohoGetAuthStatus, getAuthUrl as zohoGetAuthUrl,
  saveCredentials as zohoSaveCredentials,
  startCallbackServer as zohoStartCallbackServer, waitForAuth as zohoWaitForAuth,
  stopCallbackServer as zohoStopCallbackServer, revokeTokens as zohoRevokeTokens,
} from '../services/zoho-oauth.js';
import {
  getAuthStatus as fmGetAuthStatus, saveCredentials as fmSaveCredentials,
  revokeTokens as fmRevokeTokens,
} from '../services/fastmail-auth.js';
import { getProviders, detectProvider, getProvider, getRecommendedProtocol, getPreset, getCollectionProfiles, getCollectionProfile, getAllCollectionProfiles } from '../services/provider-profiles.js';
import { HashManager } from '../services/hash-manager.js';
import { Rfc3161TimestampService } from '../services/rfc3161-timestamp.js';
import { FolderSnapshotService } from '../services/folder-snapshot.js';
import {
  getAuthStatus as yahooGetAuthStatus, getAuthUrl as yahooGetAuthUrl,
  saveCredentials as yahooSaveCredentials,
  startCallbackServer as yahooStartCallbackServer, waitForAuth as yahooWaitForAuth,
  stopCallbackServer as yahooStopCallbackServer, revokeTokens as yahooRevokeTokens, getAccessToken as yahooGetAccessToken,
} from '../services/yahoo-oauth.js';
import { EnterpriseAuthService } from '../services/enterprise-auth.js';
import { ExchangeAdvancedService } from '../services/exchange-advanced.js';
import { LocalImportService } from '../services/local-import.js';
import { CloudCollectionService } from '../services/cloud-collection.js';
import { ContainerService } from '../services/container-service.js';
import { ReportService } from '../services/report-service.js';
import { computeDifferentialPlan } from '../services/advanced-search.js';
import { AutomationService } from '../services/automation-service.js';
import { checkOlderRecords } from '../services/record-corrections.js';
import { CryptoService } from '../services/crypto-service.js';
import { FileTypeDetector } from '../services/file-detection.js';
import { MetadataExportService } from '../services/metadata-export.js';
import { EmailValidator } from '../services/automation-service.js';
import { encryptSecret, decryptSecret } from '../util/local-secret.js';
import { applyProxy, describeProxy } from '../util/proxy.js';
import { caseFields } from '../util/case-fields.js';
import { threadMessages } from '../services/threading.js';
import {
  saveRfc3161Timestamp, getRfc3161Timestamps,
  saveFolderSnapshot, getFolderSnapshots,
  saveDriveItem, getDriveItems, updateDriveItem,
  saveCalendarEvent, getCalendarEvents,
  saveContact, getContacts,
  saveCloudDownload, getCloudDownloads, updateCloudDownload,
  savePreAcquisitionSearch, getPreAcquisitionSearches,
  indexMessage, searchIndex, clearSearchIndex,
  saveSmtpSettings, getSmtpSettings,
  saveHealthEvent, getHealthEvents,
  saveAcquisitionTarget, getAcquisitionTargets, updateAcquisitionTarget,
  saveConnectivityTest, getConnectivityTests,
  saveProxySettings, getProxySettings, getDefaultProxy,
  saveServerProfile, getServerProfile, getAllServerProfiles,
  saveCertificate, getCertificates,
  saveCredential, getCredentials, getCredential, deleteCredential,
  deleteSmtpSettings,
  saveCustomImapProfile, getCustomImapProfiles, getCustomImapProfile, deleteCustomImapProfile,
} from '../db/database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.SHERLOCKMAIL_DATA_DIR || path.join(__dirname, '..', '..', 'data');

const router = Router();

// A handler that throws or rejects must fail that one request, never the whole program: a collection for
// another project may be running in this process. Rejections go to the error handler at the end of this file.
for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
  const register = router[method].bind(router);
  router[method] = (route, ...handlers) => register(route, ...handlers.map(handler => (req, res, next) => {
    try {
      Promise.resolve(handler(req, res, next)).catch(next);
    } catch (err) {
      next(err);
    }
  }));
}

export const CLI_COMMANDS = {
  status: { description: 'List projects, or show one', options: ['[--project <id>]'] },
  collect: { description: 'Run a collection. Connection details come from a JSON file so no password is on the command line', options: ['--project <id>', '--connection <file.json>', '[--folders "INBOX,Sent"]', '[--output <dir>]'] },
  import: { description: 'Import an EML folder or file, an MBOX or a PST', options: ['--project <id>', '--path <file or folder>'] },
  search: { description: 'Search collected messages (same syntax as the app)', options: ['--project <id>', '--query <text>'] },
  qc: { description: 'Run quality control; exit code 1 if any check fails', options: ['--project <id>'] },
  verify: { description: 'Re-hash all evidence; exit code 1 if anything changed', options: ['--project <id>'] },
  export: { description: 'Export collected messages', options: ['--project <id>', '--format <eml|msg|pst|mbox|mime|pdf|concordance|xml>', '[--output <dir>]'] },
  timestamp: { description: 'Request a trusted RFC 3161 timestamp', options: ['--project <id>', '[--type collection|export]', '[--tsa <url>]'] },
};

const LOW_FREE_BYTES = 1024 * 1024 * 1024;
const CRITICAL_FREE_BYTES = 200 * 1024 * 1024;
const DISK_WATCH_MS = Number(process.env.SHERLOCKMAIL_DISK_WATCH_MS) || 30000;

// The saved default proxy applies from the moment the app starts.
try {
  const saved = getDefaultProxy();
  if (saved) applyProxy({ proxyType: saved.proxy_type, host: saved.host, port: saved.port, username: saved.username, password: decryptSecret(saved.password_encrypted) });
} catch (err) {
  console.error('Could not apply the saved proxy settings:', err.message);
}

try {
  const recovered = recoverInterruptedCollections();
  if (recovered.acquisitions || recovered.projects) {
    console.log(`Marked ${recovered.acquisitions} interrupted acquisition(s) and ${recovered.projects} project(s) as failed`);
  }
} catch (err) {
  console.error('Could not check for interrupted collections:', err.message);
}

// ── Collection Helpers ──

function sanitizeFolderName(folderPath) {
  return folderPath.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim() || 'INBOX';
}

const MIME_FOLDER_NAME = 'MIME (for Secondary Export Use)';

// A second collection into the same destination must never write into an earlier collection's evidence.
function unusedFolder(parent, name) {
  let candidate = path.join(parent, name);
  for (let n = 2; fs.existsSync(candidate) && fs.readdirSync(candidate).length > 0; n++) {
    candidate = path.join(parent, `${name} (${n})`);
  }
  return candidate;
}

const DIFFERENTIAL_FOLDER_NAME = 'Differential Acquisition';

const samePath = (a, b) => !!a && !!b && path.resolve(a).replace(/[\\/]+$/, '').toLowerCase() === path.resolve(b).replace(/[\\/]+$/, '').toLowerCase();

function dirHasFiles(dir) {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

// A location "already holds this project's collection" when an earlier acquisition of the same project
// wrote evidence there. Re-running into it becomes a differential acquisition in its own subfolder.
function priorCollectionAt(projectId, destinationDir) {
  const acquisitions = getAcquisitions(projectId);
  if (destinationDir) {
    const here = acquisitions.some(a => samePath(a.output_dir, destinationDir) || samePath(a.session_dir, destinationDir));
    return here && (dirHasFiles(path.join(destinationDir, MIME_FOLDER_NAME)) || dirHasFiles(path.join(destinationDir, 'Cloud Drive')));
  }
  const sessionsDir = path.resolve(DATA_DIR, 'projects', projectId, 'sessions').toLowerCase();
  return acquisitions.some(a => !a.output_dir && a.session_dir
    && path.resolve(a.session_dir).toLowerCase().startsWith(sessionsDir) && (a.acquired_messages || 0) > 0);
}

// With a destination chosen, the whole collection (raw MIME, logs, exports) lives there; otherwise it
// stays in the app's data folder.
function createSessionOutputDir(projectId, sessionName, destinationDir, { rerun = false } = {}) {
  let sessionDir, mimeDir, logsDir;
  if (destinationDir) {
    sessionDir = rerun ? unusedFolder(destinationDir, DIFFERENTIAL_FOLDER_NAME) : destinationDir;
    mimeDir = rerun ? path.join(sessionDir, MIME_FOLDER_NAME) : unusedFolder(destinationDir, MIME_FOLDER_NAME);
    logsDir = path.join(sessionDir, 'Logs');
  } else {
    const sessionsDir = path.join(DATA_DIR, 'projects', projectId, 'sessions');
    sessionDir = rerun ? unusedFolder(sessionsDir, `${DIFFERENTIAL_FOLDER_NAME} - ${sessionName}`) : path.join(sessionsDir, sessionName);
    mimeDir = path.join(sessionDir, 'MIME');
    logsDir = path.join(sessionDir, 'Logs');
  }
  fs.mkdirSync(mimeDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  return { sessionDir, mimeDir, logsDir, differentialFolder: rerun ? sessionDir : null };
}

const ATTACHMENT_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'application/pdf': '.pdf', 'text/calendar': '.ics', 'message/rfc822': '.eml', 'text/plain': '.txt', 'text/html': '.html' };

// Saves each attachment of a collected message as its own file, in a folder named after the message's
// EML and sitting beside it ("<eml name> attachments"). The EML is not touched. Each file is read back
// and hashed, and must match the hash recorded for that attachment when the message was parsed.
async function saveAttachmentFiles(msg, raw, log) {
  const atts = msg.attachments || [];
  if (!atts.length) return;
  if (atts.some(a => !Buffer.isBuffer(a.content)) && raw) {
    try {
      const parsed = await simpleParser(raw, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true, keepCidLinks: true });
      (parsed.attachments || []).forEach((p, i) => {
        if (atts[i] && !Buffer.isBuffer(atts[i].content)) Object.defineProperty(atts[i], 'content', { value: p.content, enumerable: false, configurable: true, writable: true });
      });
    } catch { /* recorded per attachment below */ }
  }
  const dir = `${msg.emlPath.replace(/\.eml$/i, '')} attachments`;
  const used = new Set();
  let made = false;
  for (const [i, att] of atts.entries()) {
    const entry = {
      emlPath: msg.emlPath, folder: msg.folder, subject: msg.subject, messageId: msg.messageId,
      filename: att.filename, contentType: att.contentType, disposition: att.disposition, contentId: att.contentId,
      size: att.size, recordedSha256: att.hashSha256, md5: att.hashMd5,
    };
    try {
      if (!Buffer.isBuffer(att.content)) throw new Error('the attachment could not be decoded from the message');
      if (!made) { await fs.promises.mkdir(dir, { recursive: true }); made = true; }
      const hasName = att.filename && att.filename !== 'unnamed';
      let name = safeSegment(hasName ? att.filename : `attachment-${i + 1}${ATTACHMENT_EXT[att.contentType] || '.bin'}`);
      for (let n = 2; used.has(name.toLowerCase()); n++) {
        const ext = path.extname(name);
        name = `${name.slice(0, name.length - ext.length).replace(/ \(\d+\)$/, '')} (${n})${ext}`;
      }
      used.add(name.toLowerCase());
      const file = path.join(dir, name);
      await fs.promises.writeFile(file, att.content, { flag: 'wx' });
      const written = crypto.createHash('sha256').update(await fs.promises.readFile(file)).digest('hex');
      att.localPath = file;
      log.push({ ...entry, savedAs: file, sha256: written, status: written === att.hashSha256 ? 'saved' : 'hash_mismatch' });
    } catch (err) {
      log.push({ ...entry, status: 'failed', error: err.message });
    } finally {
      delete att.content;
    }
  }
}

function writeAttachmentManifest(logsDir, ts, log) {
  if (!log?.length) return null;
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const hdr = 'Status,Folder,Subject,EmlFile,Attachment,SavedAs,ContentType,Disposition,ContentID,Size,MD5,SHA256,Error';
  const rows = log.map(e => [e.status, q(e.folder), q(e.subject), q(e.emlPath), q(e.filename), q(e.savedAs || ''), q(e.contentType),
    e.disposition || '', q(e.contentId || ''), e.size ?? '', e.md5 || '', e.sha256 || e.recordedSha256 || '', q(e.error || '')].join(','));
  const file = path.join(logsDir, `attachment_files_${ts}.csv`);
  fs.writeFileSync(file, [hdr, ...rows].join('\r\n') + '\r\n');
  return file;
}

function writeEmlFile(mimeDir, folderName, msg, folderMsgIndex, maxPerSubfolder = 5000) {
  const sanitized = sanitizeFolderName(folderName);
  let targetDir;
  if (maxPerSubfolder > 0 && folderMsgIndex >= maxPerSubfolder) {
    const subfolderIndex = Math.floor(folderMsgIndex / maxPerSubfolder) + 1;
    targetDir = path.join(mimeDir, sanitized, `Part_${subfolderIndex}`);
  } else {
    targetDir = path.join(mimeDir, sanitized);
  }
  fs.mkdirSync(targetDir, { recursive: true });

  const uid = msg.uid || 'unknown';
  const safeSubject = (msg.subject || 'no_subject').slice(0, 50).replace(/[<>:"/\\|?*\r\n]/g, '_');
  const filename = `${uid}_${safeSubject}.eml`;
  const filePath = path.join(targetDir, filename);

  // Evidence is only ever the bytes the server returned; a message without them is not written.
  let rawBuffer;
  if (msg.rawMime && Buffer.isBuffer(msg.rawMime)) {
    rawBuffer = msg.rawMime;
  } else if (msg.rawSource) {
    rawBuffer = Buffer.from(msg.rawSource, 'base64');
  } else {
    throw new Error('The server returned no raw message (MIME); nothing was saved for this item');
  }

  fs.writeFileSync(filePath, rawBuffer);
  verifyWrittenEml(filePath, msg.hashSha256);
  return { filePath, size: rawBuffer.length };
}

// The EML on disk must hold exactly the collected bytes. A file that does not is removed and the item
// fails, rather than leaving a copy that does not match its recorded hash.
function verifyWrittenEml(filePath, expectedSha256, onDisk = fs.readFileSync(filePath)) {
  const actual = crypto.createHash('sha256').update(onDisk).digest('hex');
  if (expectedSha256 && actual !== expectedSha256) {
    try { fs.unlinkSync(filePath); } catch {}
    throw new Error(`EML written to disk does not match the collected bytes (SHA-256 ${actual} vs ${expectedSha256}); the file was removed and the item not collected`);
  }
}

function emlTargetPath(mimeDir, folderName, msg, folderMsgIndex, maxPerSubfolder = 5000) {
  const sanitized = sanitizeFolderName(folderName);
  const targetDir = maxPerSubfolder > 0 && folderMsgIndex >= maxPerSubfolder
    ? path.join(mimeDir, sanitized, `Part_${Math.floor(folderMsgIndex / maxPerSubfolder) + 1}`)
    : path.join(mimeDir, sanitized);
  const safeSubject = (msg.subject || 'no_subject').slice(0, 50).replace(/[<>:"/\\|?*\r\n\t]/g, '_');
  return { targetDir, filePath: path.join(targetDir, `${msg.uid || 'unknown'}_${safeSubject}.eml`) };
}

// Checks the volume the evidence is written to (the nearest existing folder of the target).
// statfs works on every platform and on Windows builds that no longer ship wmic.
async function checkDiskSpace(targetPath, minFreeBytes = 500 * 1024 * 1024) {
  let probe = path.resolve(targetPath);
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const drive = path.parse(probe).root;
  try {
    const s = await fs.promises.statfs(probe);
    const freeBytes = Number(s.bavail) * Number(s.bsize);
    return { ok: freeBytes > minFreeBytes, freeBytes, drive, minFreeBytes };
  } catch (err) {
    return { ok: true, freeBytes: -1, drive, minFreeBytes, note: `Could not determine free space on ${drive}: ${err.message}` };
  }
}

// A folder SherlockMail writes to must be a full path: "E:Evidence" or "Evidence" would quietly resolve
// against SherlockMail's own working folder. Returns an error message, or null when the path is fine.
function notFullPathError(p, what = 'the destination') {
  if (p == null || (typeof p === 'string' && !p.trim())) return null;
  const s = String(p).trim();
  const full = process.platform === 'win32' ? /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(s) : path.isAbsolute(s);
  return full ? null : `Enter a full path for ${what} (for example D:\\Evidence\\Case-001 or \\\\server\\share\\Case-001), not "${s}".`;
}

function writeAcquisitionLogs(logsDir, sessionName, ad) {
  const ts = ad.ts || new Date().toISOString().replace(/[:.]/g, '-');
  const quote = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const drive = ad.drive?.stats;

  const acqLog = [
    `SherlockMail Acquisition Log`,
    `Session: ${sessionName}`,
    ...(ad.acquisitionId ? [`Acquisition ID: ${ad.acquisitionId}`] : []),
    `Started: ${ad.startedAt}`,
    `Completed: ${new Date().toISOString()}`,
    `Protocol: ${ad.protocol}`,
    `Target: ${ad.targetEmail}`,
    `Scope: ${ad.scope || 'email'}`,
    `Mode: ${ad.differential ? 'Differential (items already collected for this project are skipped)' : 'Full'}`,
    ...(ad.outputDir ? [`Output folder: ${ad.outputDir}`] : []),
    `Query: ${ad.queryDescription || 'None (all messages in the selected folders)'}`,
    ...(ad.stopNote ? [`Note: ${ad.stopNote}`] : []),
    ...(ad.queryNotes || []).map(n => `  ${n}`),
    ...(ad.queryUnsupported?.length ? [`  Not supported by this protocol and NOT applied: ${ad.queryUnsupported.join(', ')}`] : []),
    ``,
    `Results:`,
    `  Total messages found: ${ad.totalFound}`,
    ...(ad.duplicatesMerged ? [`  Label/folder duplicates merged: ${ad.duplicatesMerged} (each Gmail message collected once, with all its folders and labels recorded)`] : []),
    `  Downloaded: ${ad.acquired}`,
    `  Skipped (differential): ${ad.skipped}`,
    ...(ad.excluded ? [`  Excluded by query after download (logged, not kept): ${ad.excluded}`] : []),
    ...(ad.inlineMatches ? [`  In-line query matches: ${ad.inlineMatches.length} of ${ad.acquired}`] : []),
    ...(ad.recovered ? [`  Recovered on final retry pass: ${ad.recovered}`] : []),
    `  Failed: ${ad.failed}`,
    ...(ad.remaining ? [`  Not collected (collection stopped): ${ad.remaining}`] : []),
    `  Total bytes: ${ad.totalBytes}`,
    ``,
    `Folders:`,
    ...Object.entries(ad.folderStats || {}).map(([f, s]) =>
      `  ${f}: ${s.acquired} acquired, ${s.skipped} skipped${s.excluded ? `, ${s.excluded} excluded by query` : ''}, ${s.failed} failed`
    ),
    ...(drive ? [
      ``,
      `${ad.drive.label}:`,
      `  Files listed: ${drive.total}`,
      `  Downloaded: ${drive.downloaded} (${drive.verified} verified against the provider checksum, ${drive.mismatched} mismatched)`,
      `  Skipped: ${drive.skipped}`,
      `  Failed: ${drive.failed}`,
      `  Bytes: ${drive.bytes}`,
      ...(ad.drive.criteriaNotApplied?.length ? [`  Query criteria not applied to drive files: ${ad.drive.criteriaNotApplied.join(', ')}`] : []),
    ] : []),
    ...(ad.attachmentSummary ? [
      ``,
      `Attachment files (saved beside each EML; the EML is unchanged):`,
      `  Saved and verified: ${ad.attachmentSummary.saved}`,
      `  Saved with a hash mismatch: ${ad.attachmentSummary.mismatched}`,
      `  Not saved: ${ad.attachmentSummary.failed}`,
    ] : []),
    ...(ad.linkedStats || ad.linkedError ? [
      ``,
      `Linked cloud files:`,
      ...(ad.linkedError ? [`  Failed: ${ad.linkedError}`] : [
        `  Links found: ${ad.linkedStats.found}`,
        `  Downloaded: ${ad.linkedStats.downloaded} (${ad.linkedStats.verified} verified against the provider checksum, ${ad.linkedStats.mismatched} mismatched)`,
        `  Not downloaded (reason recorded per link): ${ad.linkedStats.notDownloaded}`,
        `  Failed: ${ad.linkedStats.failed}`,
        ...Object.entries(ad.linkedStats.accounts || {}).map(([k, v]) => `  Opened with ${k === 'google' ? 'Google' : 'Microsoft'} account: ${v}`),
      ]),
    ] : []),
    ``,
    `Completion: ${ad.completionType}`,
  ];
  fs.writeFileSync(path.join(logsDir, `acquisition_log_${ts}.txt`), acqLog.join('\n'));

  if (ad.excludedItems?.length) {
    const hdr = 'UID,MessageId,Folder,Subject,From,Date,Size,HashSHA256,FailedCriteria';
    const rows = ad.excludedItems.map(m => [m.uid, quote(m.messageId), quote(m.folder), quote(m.subject), quote(m.fromAddress),
      m.date || '', m.size || 0, m.hashSha256 || '', quote(m.failed.join('; '))].join(','));
    fs.writeFileSync(path.join(logsDir, `query_excluded_items_${ts}.csv`), [hdr, ...rows].join('\n'));
  }

  if (ad.inlineMatches?.length) {
    const hdr = 'UID,MessageId,Folder,Subject,From,Date,HashSHA256,EmlPath';
    const rows = ad.inlineMatches.map(m => [m.uid, quote(m.messageId), quote(m.folder), quote(m.subject), quote(m.fromAddress),
      m.date || '', m.hashSha256 || '', quote(m.emlPath)].join(','));
    fs.writeFileSync(path.join(logsDir, `query_matches_${ts}.csv`), [hdr, ...rows].join('\n'));
  }

  if (ad.errors.length > 0) {
    const errLog = [
      `SherlockMail Exception Log — Session: ${sessionName}`,
      `Generated: ${new Date().toISOString()}`,
      ``,
      ...ad.errors.map((e, i) =>
        `[${i + 1}] ${e.timestamp || ''} | ${e.folder || ''} | ${e.type || 'error'} | ${e.messageId || ''} | ${e.error}`
      ),
    ];
    fs.writeFileSync(path.join(logsDir, `exception_log_${ts}.txt`), errLog.join('\n'));
  }

  if (ad.downloadedItems.length > 0) {
    const hdr = 'UID,MessageId,Folder,AllFolders,Labels,Subject,From,Date,Size,HashSHA256,EmlPath';
    const rows = ad.downloadedItems.map(m =>
      [m.uid, quote(m.messageId), quote(m.folder), quote((m.folderPaths || [m.folder]).join('; ')), quote((m.gmailLabels || []).join('; ')),
       quote(m.subject), quote(m.fromAddress), m.date, m.size, m.hashSha256, quote(m.emlPath)].join(',')
    );
    fs.writeFileSync(path.join(logsDir, `downloaded_items_${ts}.csv`), [hdr, ...rows].join('\n'));
  }

  const remainingErrs = ad.errors.filter(e => e.type === 'message_fetch_error');
  if (remainingErrs.length > 0) {
    const hdr = 'UID,MessageId,Folder,Subject,Error,Timestamp';
    const rows = remainingErrs.map(e =>
      [e.uid ?? '', quote(e.messageId), quote(e.folder), quote(e.subject), quote(e.error), e.timestamp].join(',')
    );
    fs.writeFileSync(path.join(logsDir, `remaining_items_${ts}.csv`), [hdr, ...rows].join('\n'));
  }

  if (ad.differentialExclusions.length > 0) {
    const hdr = 'MessageId,HashSHA256,Folder,Reason';
    const rows = ad.differentialExclusions.map(e =>
      [quote(e.messageId), e.hashSha256 || '', quote(e.folder), 'already collected in an earlier acquisition'].join(',')
    );
    fs.writeFileSync(path.join(logsDir, `differential_excluded_${ts}.csv`), [hdr, ...rows].join('\n'));
  }

  return { logsDir, files: fs.readdirSync(logsDir) };
}

function determineCompletionType(acquired, failed, skipped, total, canceled = false) {
  if (canceled) return 'canceled';
  if (total === 0) return 'no_items_found';
  if (failed === 0) return 'completed_without_errors';
  if (acquired > 0 && failed > 0 && (acquired + skipped + failed >= total))
    return 'completed_with_errors_download_complete';
  if (failed > 0) return 'completed_with_errors_remaining_items';
  return 'completed_without_errors';
}

// ── Collection Progress Tracking ──
// A collection runs as a job inside the server, independent of the HTTP request that started it, so
// switching tabs, reloading the page or closing the browser never stops it; the UI re-attaches.
const collectionProgress = new Map();
const activeCollections = new Map();

const collectionStreams = new Map();

function progressSnapshot(p) {
  const { errors, ...rest } = p;
  return { ...rest, errorCount: errors?.length || 0, lastError: errors?.length ? errors[errors.length - 1] : null };
}

function publishCollectEvent(projectId, evt) {
  const clients = collectionStreams.get(projectId);
  if (!clients?.size) return;
  const frame = `data: ${JSON.stringify(evt)}\n\n`;
  for (const client of clients) client.write(frame);
}

export function getActiveCollections() {
  return [...activeCollections.values()].map(j => ({
    projectId: j.projectId,
    projectName: j.projectName,
    acquisitionId: j.acquisitionId,
    phase: j.progress.phase,
    acquired: j.progress.acquired,
    failed: j.progress.failed,
    skipped: j.progress.skipped,
    total: j.progress.total,
    drive: j.progress.drive ? { done: j.progress.drive.done, total: j.progress.drive.total } : null,
    startedAt: j.progress.startedAt,
    canceling: !!j.cancelReason,
  }));
}

// Stops every running collection and waits (up to timeoutMs) for each to write its logs and records.
export async function cancelAllCollections(reason = 'SherlockMail was closed', timeoutMs = 20000) {
  const jobs = [...activeCollections.values()];
  for (const j of jobs) {
    j.cancelReason = j.cancelReason || reason;
    j.controller.abort();
  }
  await Promise.race([
    Promise.allSettled(jobs.map(j => j.done)),
    new Promise(r => setTimeout(r, timeoutMs)),
  ]);
  return jobs.length;
}

router.get('/collections/active', (req, res) => {
  res.json(getActiveCollections());
});

router.get('/projects/:id/collect/progress', (req, res) => {
  const progress = collectionProgress.get(req.params.id);
  if (!progress) return res.json({ active: false });
  res.json(progressSnapshot(progress));
});

router.post('/projects/:id/collect/cancel', (req, res) => {
  const job = activeCollections.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'No collection is running for this project' });
  job.cancelReason = job.cancelReason || 'Stopped by the examiner';
  job.controller.abort();
  job.progress.statusDetail = 'Stopping: finishing items in progress and writing logs';
  publishCollectEvent(req.params.id, { type: 'progress', progress: progressSnapshot(job.progress) });
  res.json({ canceling: true });
});

// Server-sent events: one frame per collected item plus a progress snapshot every second.
router.get('/projects/:id/collect/events', (req, res) => {
  const id = req.params.id;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(': connected\n\n');
  if (!collectionStreams.has(id)) collectionStreams.set(id, new Set());
  collectionStreams.get(id).add(res);
  const current = collectionProgress.get(id);
  if (current) res.write(`data: ${JSON.stringify({ type: 'progress', progress: progressSnapshot(current) })}\n\n`);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(keepAlive);
    const clients = collectionStreams.get(id);
    clients?.delete(res);
    if (clients && !clients.size) collectionStreams.delete(id);
  });
});

// ── Dashboard Stats ──
router.get('/stats', (req, res) => {
  const stats = getStats();
  stats.version = '0.10.0';
  stats.nodeVersion = process.versions.node;
  res.json(stats);
});

// ── Google OAuth ──
router.get('/oauth/google/status', (req, res) => {
  res.json(getAuthStatus());
});

// Saving sign-in settings replaces the ones in use, so anything that is not a usable set is refused.
const hasText = v => typeof v === 'string' && v.trim().length > 0;

router.post('/oauth/google/credentials', (req, res) => {
  const google = req.body?.installed || req.body?.web;
  if (!hasText(google?.client_id) || !hasText(google?.client_secret)) return res.status(400).json({ error: 'This is not a Google OAuth client file: it needs "installed" (or "web") with client_id and client_secret' });
  try {
    saveCredentials(req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/oauth/google/authorize', async (req, res) => {
  try {
    await startCallbackServer();
    const url = getAuthUrl(String(req.query.features || '').split(',').filter(Boolean));
    if (!url) return res.status(400).json({ error: 'OAuth credentials not configured. Upload client_secret JSON first.' });
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/oauth/google/wait', async (req, res) => {
  try {
    const result = await waitForAuth();
    stopCallbackServer();
    res.json(result);
  } catch (err) {
    stopCallbackServer();
    res.status(500).json({ error: err.message });
  }
});

router.post('/oauth/google/revoke', (req, res) => {
  revokeTokens();
  res.json({ success: true });
});

// ── Microsoft OAuth ──
router.get('/oauth/microsoft/status', (req, res) => {
  res.json(msGetAuthStatus());
});

router.post('/oauth/microsoft/credentials', (req, res) => {
  if (!hasText(req.body?.client_id)) return res.status(400).json({ error: 'A client (application) ID is required' });
  try {
    msSaveCredentials(req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/oauth/microsoft/authorize', async (req, res) => {
  try {
    await msStartCallbackServer();
    const url = msGetAuthUrl(String(req.query.features || '').split(',').filter(Boolean));
    if (!url) return res.status(400).json({ error: 'Microsoft credentials not configured. Enter Client ID and Secret first.' });
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/oauth/microsoft/wait', async (req, res) => {
  try {
    const result = await msWaitForAuth();
    msStopCallbackServer();
    res.json(result);
  } catch (err) {
    msStopCallbackServer();
    res.status(500).json({ error: err.message });
  }
});

router.post('/oauth/microsoft/revoke', (req, res) => {
  msRevokeTokens();
  res.json({ success: true });
});

// ── Zoho OAuth ──
router.get('/oauth/zoho/status', (req, res) => {
  res.json(zohoGetAuthStatus());
});

router.post('/oauth/zoho/credentials', (req, res) => {
  if (!hasText(req.body?.client_id) || !hasText(req.body?.client_secret)) return res.status(400).json({ error: 'A client ID and client secret are required' });
  try {
    zohoSaveCredentials(req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/oauth/zoho/authorize', async (req, res) => {
  try {
    await zohoStartCallbackServer();
    const url = zohoGetAuthUrl();
    if (!url) return res.status(400).json({ error: 'Zoho credentials not configured. Enter Client ID and Secret first.' });
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/oauth/zoho/wait', async (req, res) => {
  try {
    const result = await zohoWaitForAuth();
    zohoStopCallbackServer();
    res.json(result);
  } catch (err) {
    zohoStopCallbackServer();
    res.status(500).json({ error: err.message });
  }
});

router.post('/oauth/zoho/revoke', (req, res) => {
  zohoRevokeTokens();
  res.json({ success: true });
});

// ── Fastmail Auth ──
router.get('/oauth/fastmail/status', (req, res) => {
  res.json(fmGetAuthStatus());
});

router.post('/oauth/fastmail/credentials', (req, res) => {
  if (!hasText(req.body?.api_token)) return res.status(400).json({ error: 'An API token is required' });
  try {
    fmSaveCredentials(req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/oauth/fastmail/revoke', (req, res) => {
  fmRevokeTokens();
  res.json({ success: true });
});

// ── Provider Profiles ──
router.get('/providers', (req, res) => {
  res.json(getProviders());
});

router.get('/providers/detect', (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Email required' });
  const providerId = detectProvider(email);
  const provider = getProvider(providerId);
  const recommended = getRecommendedProtocol(providerId);
  res.json({ providerId, provider, recommended });
});

// ── Collection Profiles ──
router.get('/collection-profiles', (req, res) => {
  res.json(getAllCollectionProfiles());
});

router.get('/collection-profiles/:providerId', (req, res) => {
  const profiles = getCollectionProfiles(req.params.providerId);
  res.json(profiles);
});

// ── Projects ──
router.get('/projects', (req, res) => {
  res.json(getProjects());
});

router.get('/projects-summary', (req, res) => {
  res.json(getProjectsSummary());
});

router.get('/projects/:id', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json(project);
});

router.post('/projects', (req, res) => {
  try {
    const project = createProject(req.body);
    res.status(201).json(project);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/projects/:id', (req, res) => {
  try {
    const updated = updateProject(req.params.id, req.body, req.body.examiner);
    res.json(updated);
  } catch (err) {
    const status = err.message.includes('Cannot edit') ? 403 : 400;
    res.status(status).json({ error: err.message });
  }
});

router.delete('/projects/:id', (req, res) => {
  if (activeCollections.has(req.params.id)) return res.status(409).json({ error: 'Stop the running collection before deleting this project' });
  if (!getProject(req.params.id)) return res.status(404).json({ error: 'Project not found' });
  try {
    deleteProject(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Protocol Information ──
router.get('/protocols', (req, res) => {
  res.json({
    imap: {
      name: 'IMAP (Internet Message Access Protocol)',
      port: { secure: 993, plain: 143 },
      rfc: 'RFC 9051 (IMAP4rev2), RFC 3501 (IMAP4rev1)',
      description: 'Synchronizes email between client and server. Supports folders, flags, server-side search. Read-only mode preserves mailbox state. The primary protocol for forensic email collection.',
      presets: ImapHandler.getProviderPresets(),
      forensicNotes: [
        'IMAP EXAMINE command opens mailbox read-only (no flag changes)',
        'IMAP SEARCH runs queries server-side without downloading all messages',
        'UID-based tracking ensures each message is uniquely identified',
        'IMAP FETCH with BODY.PEEK[] downloads without setting \\Seen flag',
        'Protocol log captures every command/response for chain of custody',
      ],
    },
    pop3: {
      name: 'POP3 (Post Office Protocol v3)',
      port: { secure: 995, plain: 110 },
      rfc: 'RFC 1939',
      description: 'Downloads email from server. Simpler than IMAP but limited: no folders, no server-side search, no flags. Used as fallback when IMAP is unavailable.',
      presets: Pop3Handler.getProviderPresets(),
      forensicNotes: [
        'POP3 only accesses INBOX - no other folder support',
        'No server-side search capability',
        'RETR downloads the complete message',
        'TOP command can preview headers without full download',
        'Some servers delete messages after RETR (document this behavior)',
      ],
    },
    ews: {
      name: 'EWS (Exchange Web Services)',
      port: { secure: 443 },
      rfc: 'Microsoft proprietary SOAP API',
      description: 'SOAP-based API for Microsoft Exchange and Office 365. Provides rich access to mailboxes, calendars, contacts, and eDiscovery features. Uses Autodiscover for endpoint resolution.',
      capabilities: EwsHandler.getCapabilities(),
      forensicNotes: [
        'Autodiscover resolves the EWS endpoint from just email + credentials',
        'SearchMailboxes provides in-place eDiscovery search (KQL syntax)',
        'Recoverable Items folder contains soft-deleted and purged items',
        'In-Place Archive holds archival mail separate from primary mailbox',
        'MIME content export preserves the raw message for forensic integrity',
        'Being deprecated by Microsoft in favor of Graph API',
      ],
    },
    graph: {
      name: 'Microsoft Graph API',
      port: { secure: 443 },
      rfc: 'Microsoft REST API',
      description: 'Modern REST API replacing EWS for Microsoft 365. Supports mail, calendar, files, and more. Uses OAuth 2.0 and supports both delegated and app-only authentication.',
      capabilities: GraphHandler.getCapabilities(),
      forensicNotes: [
        'App-only auth enables batch mailbox access without user interaction',
        '$value endpoint returns raw MIME content for forensic preservation',
        'Modern attachments are OneDrive/SharePoint links (need separate download)',
        'Delta queries enable differential/incremental collection',
        'RBAC can limit app access to specific mailboxes or admin units',
      ],
    },
    gmail: {
      name: 'Gmail API',
      port: { secure: 443 },
      rfc: 'Google REST API',
      description: 'REST API for Gmail and Google Workspace. Uses labels instead of folders. Supports powerful search syntax identical to the Gmail search bar. OAuth 2.0 required.',
      capabilities: GmailHandler.getCapabilities(),
      forensicNotes: [
        'format=raw returns base64url-encoded MIME content',
        'Gmail uses labels, not folders (a message can have multiple labels)',
        'Service account with domain-wide delegation for enterprise access',
        'History API enables efficient incremental collection',
        'Trash and Spam are accessible for complete collection',
      ],
    },
    zoho: {
      name: 'Zoho Mail API',
      port: { secure: 443 },
      rfc: 'Zoho REST API',
      description: 'REST API for Zoho Mail and Zoho Workplace. Regional endpoints for US, EU, IN, AU, JP. OAuth 2.0 required.',
      capabilities: ZohoHandler.getCapabilities(),
      forensicNotes: [
        'Regional API endpoints must match account region',
        'Full message content retrieval with metadata',
        'Attachment download via separate endpoint',
        'Folder-based organization with search support',
        'OAuth tokens are short-lived (1 hour) with refresh',
      ],
    },
    jmap: {
      name: 'JMAP (Fastmail)',
      port: { secure: 443 },
      rfc: 'RFC 8621',
      description: 'JSON Meta Application Protocol — open standard for modern email access. Used by Fastmail. HTTP+JSON, batch method calls, efficient sync.',
      capabilities: JmapHandler.getCapabilities(),
      forensicNotes: [
        'Open standard (IETF RFC 8621) — not vendor-specific',
        'Batch method calls reduce round-trips',
        'State tokens enable efficient incremental sync',
        'Full message properties including headers',
        'API token authentication (no OAuth dance required)',
      ],
    },
  });
});

// ── Connection Testing ──
router.post('/connect/test', async (req, res) => {
  const { protocol, config } = req.body;

  try {
    const handler = await createHandler(protocol, config);
    const result = await handler.connect();
    if (protocol === 'pop3') {
      const msgList = await handler.listMessages();
      await handler.disconnect();
      res.json({ ...result, messages: msgList, protocolLog: handler.getProtocolLog() });
      return;
    }
    const folders = await listHandlerFolders(handler);
    await handler.disconnect();
    res.json({ ...result, folders, protocolLog: handler.getProtocolLog() });
  } catch (err) {
    let errorMsg = err.message || `The server refused the connection${err.status ? ` (HTTP ${err.status})` : ''}`;
    if (/^Unsupported protocol/.test(errorMsg)) return res.status(400).json({ error: errorMsg, protocolLog: [] });
    const host = (config?.host || '').toLowerCase();
    if (/auth|login|credential|command/i.test(errorMsg) && /aol|yahoo/.test(host)) {
      errorMsg += '. AOL/Yahoo requires an app-specific password — generate one in your account security settings and select "App-Specific Password" as auth method.';
    }
    res.status(500).json({ error: errorMsg, protocolLog: [] });
  }
});

// ── Folders ──
router.get('/projects/:id/folders', (req, res) => {
  res.json(getFolderSummary(req.params.id));
});

router.post('/projects/:id/folders', (req, res) => {
  if (!Array.isArray(req.body?.folders)) return res.status(400).json({ error: 'folders must be a list' });
  saveFolders(req.params.id, req.body.folders);
  res.json({ success: true });
});

// ── Collection / Acquisition ──

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

async function retryWithBackoff(fn, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === retries) throw err;
      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// In a differential run a message counts as already collected only when the same bytes are already held
// from the same folder. A different message that reuses a Message-ID, or a copy filed in another folder,
// is evidence in its own right and is collected.
const differentialKey = (hashSha256, folder) => `${hashSha256}
${folder || ''}`;

function processMessageItem(msg, projectId, acquisitionId, existingIds, differential, errors, opts = {}) {
  const { mimeDir, folderMsgCounters, differentialExclusions, downloadedItems } = opts;

  const isDuplicate = differential && existingIds.has(differentialKey(msg.hashSha256, msg.folder));
  if (isDuplicate) {
    if (differentialExclusions) {
      differentialExclusions.push({ messageId: msg.messageId, hashSha256: msg.hashSha256, folder: msg.folder });
    }
    return 'skipped';
  }

  try {
    msg.projectId = projectId;
    msg.acquisitionId = acquisitionId;

    if (mimeDir && folderMsgCounters) {
      const folderName = msg.folder || 'INBOX';
      if (folderMsgCounters[folderName] === undefined) folderMsgCounters[folderName] = 0;
      const { filePath } = writeEmlFile(mimeDir, folderName, msg, folderMsgCounters[folderName]);
      msg.emlPath = filePath;
      folderMsgCounters[folderName]++;
    }

    delete msg.rawSource;
    delete msg.rawMime;

    saveMessage(msg);
    if (msg.attachments) {
      for (const att of msg.attachments) {
        saveAttachment({ ...att, messageId: msg.id });
      }
    }
    if (downloadedItems) downloadedItems.push(msg);
    return 'acquired';
  } catch (err) {
    errors.push({
      messageId: msg.messageId || msg.id,
      subject: (msg.subject || '').slice(0, 100),
      folder: msg.folder,
      error: err.message,
      timestamp: new Date().toISOString(),
    });
    return 'failed';
  }
}

// Written as the collection runs (not only at the end), so a run that stalls or is killed
// still leaves a record of how far it got and what it was waiting on.
function createLiveLog(logsDir) {
  const file = path.join(logsDir, `collection_live_${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  let stream = null;
  try {
    stream = fs.createWriteStream(file, { flags: 'a' });
    stream.on('error', () => { stream = null; });
  } catch {
    stream = null;
  }
  return {
    file,
    write(line) { stream?.write(`${new Date().toISOString()}  ${line}\n`); },
    close() { stream?.end(); stream = null; },
  };
}

function describeTarget(protocol, config) {
  if (protocol === 'imap' || protocol === 'pop3') return `${config?.host}:${config?.port || (protocol === 'imap' ? 993 : 995)}`;
  if (protocol === 'gmail_api') return 'Gmail API (gmail.googleapis.com)';
  if (protocol === 'graph') return 'Microsoft Graph (graph.microsoft.com)';
  if (protocol === 'ews') return config?.ewsUrl || 'Exchange Web Services (autodiscover)';
  return protocol;
}

async function connectWithStatus(handler, progress, target, live, signal) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw new Error('Collection stopped before the connection was established');
    progress.statusDetail = `Connecting to ${target} (attempt ${attempt} of ${MAX_RETRIES})`;
    live.write(progress.statusDetail);
    try {
      await handler.connect();
      live.write(`Connected to ${target}`);
      progress.statusDetail = '';
      return;
    } catch (err) {
      progress.lastError = err.message;
      live.write(`Connection attempt ${attempt} failed: ${err.message}`);
      if (attempt === MAX_RETRIES) throw err;
      await new Promise(r => setTimeout(r, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)));
    }
  }
}

const DB_FLUSH_SIZE = 200;
const DB_FLUSH_INTERVAL_MS = 2000;

function createCollectionSink({
  projectId, acquisitionId, mimeDir, differential, existingIds, progress, errors, folderStats, downloadedItems,
  differentialExclusions, queryPlan, protocol, excludedItems, inlineMatches, onItem, attachmentLog,
}) {
  const folderCounters = {};
  const madeDirs = new Set();
  let pending = [];
  let lastFlush = Date.now();
  const statsFor = folder => folderStats[folder] || (folderStats[folder] = { acquired: 0, skipped: 0, excluded: 0, failed: 0 });
  const localKeys = queryPlan?.localKeys || [];
  const inlineKeys = queryPlan?.inlineKeys || [];

  function flush() {
    lastFlush = Date.now();
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    try {
      saveMessagesBatch(batch);
    } catch {
      for (const msg of batch) {
        try {
          saveMessagesBatch([msg]);
        } catch (err) {
          const idx = downloadedItems.findIndex(d => d.id === msg.id);
          if (idx >= 0) downloadedItems.splice(idx, 1);
          const stats = statsFor(msg.folder);
          stats.acquired--; stats.failed++;
          progress.acquired--; progress.failed++;
          errors.push({
            messageId: msg.messageId || msg.id, subject: (msg.subject || '').slice(0, 100), folder: msg.folder,
            error: err.message, timestamp: new Date().toISOString(), type: 'message_error',
          });
        }
      }
    }
  }

  async function add(msg, folder) {
    msg.projectId = projectId;
    msg.acquisitionId = acquisitionId;
    msg.folder = folder;
    const stats = statsFor(folder);

    if (differential && existingIds.has(differentialKey(msg.hashSha256, folder))) {
      differentialExclusions.push({ messageId: msg.messageId, hashSha256: msg.hashSha256, folder });
      stats.skipped++;
      progress.skipped++;
      onItem?.('skipped', msg, folder);
      return;
    }

    // In-place criteria the server could not apply: a non-matching message is recorded (with its hash)
    // in the exclusion log and not kept as evidence.
    if (localKeys.length) {
      const { match, failed } = matchesLocally(msg, queryPlan.query, localKeys, protocol);
      if (!match) {
        excludedItems.push({
          uid: msg.uid, messageId: msg.messageId, folder, subject: msg.subject, fromAddress: msg.fromAddress,
          date: msg.date, size: msg.size, hashSha256: msg.hashSha256, failed,
        });
        stats.skipped++;
        stats.excluded++;
        progress.skipped++;
        progress.excluded++;
        onItem?.('excluded', msg, folder);
        return;
      }
    }

    const index = folderCounters[folder] || 0;
    folderCounters[folder] = index + 1;
    const { targetDir, filePath } = emlTargetPath(mimeDir, folder, msg, index);
    if (!madeDirs.has(targetDir)) {
      await fs.promises.mkdir(targetDir, { recursive: true });
      madeDirs.add(targetDir);
    }
    await fs.promises.writeFile(filePath, msg.rawMime, { flag: 'wx' }).catch(async (err) => {
      if (err.code !== 'EEXIST') throw err;
      const alt = filePath.replace(/\.eml$/i, `_${String(msg.hashSha256 || msg.id).slice(0, 12)}.eml`);
      await fs.promises.writeFile(alt, msg.rawMime, { flag: 'wx' });
      msg.emlPath = alt;
    });
    msg.emlPath = msg.emlPath || filePath;
    verifyWrittenEml(msg.emlPath, msg.hashSha256, await fs.promises.readFile(msg.emlPath));
    if (attachmentLog) await saveAttachmentFiles(msg, msg.rawMime, attachmentLog);
    for (const att of msg.attachments || []) delete att.content;
    delete msg.rawMime;

    if (inlineKeys.length && matchesLocally(msg, queryPlan.query, inlineKeys, protocol).match) {
      inlineMatches.push({
        id: msg.id, uid: msg.uid, messageId: msg.messageId, folder, subject: msg.subject, fromAddress: msg.fromAddress,
        date: msg.date, hashSha256: msg.hashSha256, emlPath: msg.emlPath,
      });
    }

    pending.push(msg);
    downloadedItems.push({
      id: msg.id, uid: msg.uid, messageId: msg.messageId, folder, subject: msg.subject,
      fromAddress: msg.fromAddress, date: msg.date, size: msg.size, hashSha256: msg.hashSha256, emlPath: msg.emlPath,
      folderPaths: msg.folderPaths, gmailLabels: msg.gmailLabels,
    });
    stats.acquired++;
    progress.acquired++;
    onItem?.('acquired', msg, folder);
    if (pending.length >= DB_FLUSH_SIZE || Date.now() - lastFlush > DB_FLUSH_INTERVAL_MS) flush();
  }

  return { add, flush };
}

// One way to build a handler, whichever protocol and sign-in is used: a saved OAuth sign-in, a password,
// an app-only or imported Microsoft token, or Yahoo XOAUTH2 over IMAP.
async function createHandler(protocol, rawConfig, project) {
  const config = rawConfig ? { ...rawConfig } : {};
  config.email = config.email || project?.target_email;
  switch (protocol) {
    case 'imap':
      if (!config.host) throw new Error('IMAP host is required');
      if (config.authMethod === 'yahoo_oauth') {
        config.accessToken = await yahooGetAccessToken();
        config.username = config.username || yahooGetAuthStatus().email || config.email;
      }
      return new ImapHandler(config);
    case 'pop3':
      if (!config.host) throw new Error('POP3 host is required');
      return new Pop3Handler(config);
    case 'ews': {
      const session = config.enterpriseSessionId ? EnterpriseAuthService.getSession(config.enterpriseSessionId) : null;
      if (session) {
        const resource = session.ewsEndpoint;
        config.authType = 'oauth2';
        config.ewsUrl = config.ewsUrl || `${resource}/EWS/Exchange.asmx`;
        config.tokenProvider = () => session.tokenFor(resource);
        config.accessToken = await session.tokenFor(resource);
        // An app-only token reaches a mailbox only by impersonating it.
        if (session.authMethod !== 'imported') config.impersonate = config.targetUser || config.email;
      } else if (!config.password && msGetAuthStatus().authorized) {
        config.authType = 'oauth2';
        config.tokenProvider = msGetAccessToken;
        config.accessToken = await msGetAccessToken();
      }
      return new EwsHandler(config);
    }
    case 'graph': {
      const session = config.enterpriseSessionId ? EnterpriseAuthService.getSession(config.enterpriseSessionId) : null;
      if (session) {
        config.tokenProvider = () => session.tokenFor(session.graphEndpoint);
        config.graphBase = session.graphBase;
        if (session.authMethod !== 'imported') config.targetUser = config.targetUser || config.email;
      }
      return new GraphHandler({ authType: 'delegated', ...config });
    }
    case 'gmail_api':
      return new GmailHandler({ authType: 'oauth2', ...config });
    case 'zoho_api':
      return new ZohoHandler(config);
    case 'jmap':
      return new JmapHandler(config);
    default:
      throw new Error(`Unsupported protocol: ${protocol}`);
  }
}

// Gmail lists labels, POP3 has a single unnamed mailbox.
async function listHandlerFolders(handler) {
  if (handler.listFolders) return handler.listFolders();
  if (handler.listLabels) return handler.listLabels();
  return null;
}

const COLLECTION_SCOPES = new Set(['email', 'drive', 'both']);
const LEGACY_PROTOCOLS = new Set(['zoho_api', 'jmap']);

function parseCollectRequest(project, body) {
  const scope = COLLECTION_SCOPES.has(body.scope) ? body.scope : 'email';
  const config = body.config || null;
  const protocol = config?.protocol || project.provider_type;
  const destinationDir = typeof body.outputDir === 'string' && body.outputDir.trim() ? body.outputDir.trim() : null;
  const query = normalizeQuery(body.query);
  const queryPlan = planQuery(protocol, query);
  if (!query && body.searchQuery) queryPlan.server = body.searchQuery;
  return { scope, config, protocol, destinationDir, query, queryPlan, wantsEmail: scope !== 'drive', wantsDrive: scope !== 'email' };
}

function validateCollectTarget({ scope, protocol, wantsEmail, wantsDrive, destinationDir }) {
  const destinationError = notFullPathError(destinationDir, 'the destination folder');
  if (destinationError) return destinationError;
  if (wantsEmail && !supportsEngine(protocol) && !LEGACY_PROTOCOLS.has(protocol)) {
    return `Unsupported protocol: ${protocol || '(none)'}`;
  }
  if (wantsDrive) {
    const avail = driveAvailability(protocol);
    if (!avail.available) return `${scope === 'both' ? 'Email and Drive' : 'Drive/Cloud'} collection is not available: ${avail.reason}`;
  }
  return null;
}

// Starts a collection and returns at once (202). The job keeps running in the server whatever the UI
// does; progress, item and completion events stream over /collect/events and /collect/progress.
router.post('/projects/:id/collect', async (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const started = await startCollection(project, req.body || {});
  res.status(started.status).json(started.body);
});

async function startCollection(project, body) {
  const refuse = (status, payload) => ({ status, body: payload });
  if (activeCollections.has(project.id)) {
    return refuse(409, { error: 'A collection is already running for this project. Wait for it to finish or stop it first.', active: true });
  }

  let request;
  try {
    request = parseCollectRequest(project, body);
  } catch (err) {
    return refuse(400, { error: `Query: ${err.message}` });
  }
  const { scope, protocol, destinationDir, query, queryPlan } = request;
  const invalid = validateCollectTarget(request);
  if (invalid) return refuse(400, { error: invalid });

  // A missing drive root (e.g. an unplugged evidence drive) makes a recursive mkdirSync hang on Windows.
  if (destinationDir && !fs.existsSync(path.parse(path.resolve(destinationDir)).root)) {
    return refuse(400, { error: `Destination drive for ${destinationDir} is not available. Connect the drive or choose another destination.` });
  }
  const diskCheck = await checkDiskSpace(destinationDir || DATA_DIR);
  if (!diskCheck.ok) {
    return refuse(507, {
      error: `Insufficient disk space on ${diskCheck.drive}: ${Math.round(diskCheck.freeBytes / 1024 / 1024)} MB free, need at least ${Math.round(diskCheck.minFreeBytes / 1024 / 1024)} MB`,
      freeBytes: diskCheck.freeBytes,
    });
  }

  // Restarting into a location that already holds this project's collection is a differential
  // acquisition: only new items are collected, into their own "Differential Acquisition" folder.
  const rerun = priorCollectionAt(project.id, destinationDir);
  const differential = rerun || body.differential === true;
  const sessionName = `${(project.name || project.id).replace(/[<>:"/\\|?*]/g, '_')}_${new Date().toISOString().replace(/[:.]/g, '-')}`;
  let dirs;
  try {
    dirs = createSessionOutputDir(project.id, sessionName, destinationDir, { rerun });
  } catch (err) {
    return refuse(400, { error: `Cannot create the output folders in ${destinationDir || 'the SherlockMail data folder'}: ${err.message}` });
  }

  const selectedFolders = Array.isArray(body.folders) && body.folders.length ? body.folders : null;
  const queryDescription = describeQuery(query);
  const attachmentFiles = body.collectAttachmentFiles === true;
  const linkedFiles = body.collectLinkedFiles === true;
  const acquisitionId = createAcquisition(project.id, selectedFolders, {
    query, queryDescription, scope, outputDir: destinationDir, protocol, differential, examiner: project.examiner_name, attachmentFiles, linkedFiles,
  });
  updateProjectStatus(project.id, 'collecting');

  const progress = {
    active: true, phase: 'connecting', acquired: 0, failed: 0, skipped: 0, excluded: 0, total: 0,
    retrying: false, retryItem: '', currentFolder: '', errors: [], sessionDir: dirs.sessionDir,
    startedAt: Date.now(), elapsedMs: 0, estimateMs: null, scope, acquisitionId, differential,
    differentialFolder: dirs.differentialFolder, queryDescription, result: null,
  };
  collectionProgress.set(project.id, progress);

  const job = { projectId: project.id, projectName: project.name, acquisitionId, progress, controller: new AbortController(), cancelReason: null };
  activeCollections.set(project.id, job);
  job.done = runCollectionJob({
    ...request, project, job, dirs, sessionName, differential, selectedFolders, attachmentFiles, linkedFiles,
    limit: Math.max(0, parseInt(body.limit, 10) || 0),
    exportFormats: Array.isArray(body.exportFormats) ? [...new Set(body.exportFormats.filter(f => typeof f === 'string'))] : [],
    pdfSplitMode: typeof body.pdfSplitMode === 'string' ? body.pdfSplitMode : undefined,
    pstMaxGb: pstSizeGb(body.pstMaxGb),
  }).catch(err => {
    // Finalizing itself failed (e.g. the database became unavailable): still release the UI and record it.
    console.error(`Collection job for ${project.id} could not be finalized:`, err);
    progress.active = false;
    progress.phase = 'error';
    progress.lastError = err.message;
    progress.result = { acquisitionId, status: 'failed', completionType: 'fatal_error', error: `Collection could not be finalized: ${err.message}`, sessionDir: dirs.sessionDir };
    try { updateAcquisition(acquisitionId, { status: 'failed', completionType: 'fatal_error' }); } catch {}
    try { updateProjectStatus(project.id, 'failed'); } catch {}
    publishCollectEvent(project.id, { type: 'failed', result: progress.result });
  }).finally(() => activeCollections.delete(project.id));

  return {
    status: 202,
    job,
    body: {
      started: true, acquisitionId, scope, differential, rerun,
      sessionDir: dirs.sessionDir, differentialFolder: dirs.differentialFolder,
      query: { description: queryDescription, notes: queryPlan.notes, unsupported: queryPlan.unsupported.map(k => describeKeys([k])) },
    },
  };
}

async function runCollectionJob(ctx) {
  const { project, job, config, protocol, queryPlan, query, differential, limit, sessionName, destinationDir, scope, wantsEmail, wantsDrive } = ctx;
  const { sessionDir, mimeDir, logsDir, differentialFolder } = ctx.dirs;
  const { progress, acquisitionId } = job;
  const signal = job.controller.signal;
  const startedAt = new Date(progress.startedAt).toISOString();
  const ts = startedAt.replace(/[:.]/g, '-');
  const targetFolders = ctx.selectedFolders || ['INBOX'];
  const errors = [];
  const folderStats = {};
  const downloadedItems = [];
  const differentialExclusions = [];
  const excludedItems = [];
  const inlineMatches = [];
  let handler = null;
  let driveResult = null;
  let linkedResult = null;
  const attachmentLog = [];
  let fatalError = null;
  const live = createLiveLog(logsDir);
  progress.liveLogFile = live.file;
  const publish = () => publishCollectEvent(project.id, { type: 'progress', progress: progressSnapshot(progress) });
  const pushProgressError = (text) => {
    progress.errors.push(text);
    if (progress.errors.length > 100) progress.errors.shift();
  };
  const unsupportedLabels = queryPlan.unsupported.map(k => describeKeys([k]));
  let preSnapshot = null;
  let snapshotComparison = null;

  // The server's own folder list and counts, read live. Taken before the first message and after the last,
  // so anything that changed in the mailbox during the collection is on record.
  const takeSnapshot = async (activeHandler, type) => {
    try {
      const folders = await listHandlerFolders(activeHandler);
      if (!folders) return null;
      const snapshot = FolderSnapshotService.captureSnapshot(project.id, folders, acquisitionId, type);
      saveFolderSnapshot(snapshot);
      if (type === 'pre_acquisition') replaceFolders(project.id, folders);
      live.write(`Folder snapshot (${type}): ${snapshot.totalFolders} folders, ${snapshot.totalMessages} messages, SHA-256 ${snapshot.hashSha256}`);
      return snapshot;
    } catch (err) {
      live.write(`Folder snapshot (${type}) could not be taken: ${err.message}`);
      return null;
    }
  };
  const compareWithPreSnapshot = async (activeHandler) => {
    if (!preSnapshot) return;
    const post = await takeSnapshot(activeHandler, 'post_acquisition');
    if (!post) return;
    snapshotComparison = FolderSnapshotService.compareSnapshots(preSnapshot, post);
    snapshotComparison.changed = !!(snapshotComparison.foldersAdded.length || snapshotComparison.foldersRemoved.length || snapshotComparison.foldersChanged.length);
    if (snapshotComparison.changed) {
      live.write(`The mailbox changed during the collection: ${snapshotComparison.foldersChanged.map(f => `${f.path} ${f.delta > 0 ? '+' : ''}${f.delta}`).join(', ') || 'folders added or removed'}`);
    }
  };

  // Evidence must not be cut short by a full disk without the examiner being told why.
  let lowDiskWarned = false;
  const diskWatch = setInterval(async () => {
    const disk = await checkDiskSpace(sessionDir, CRITICAL_FREE_BYTES);
    if (disk.freeBytes < 0) return;
    if (!disk.ok) {
      saveHealthEvent({ projectId: project.id, acquisitionId, eventType: 'disk_space', severity: 'critical', message: `Stopped: only ${formatBytesServer(disk.freeBytes)} free on ${disk.drive}`, details: disk });
      live.write(`Stopping: only ${formatBytesServer(disk.freeBytes)} free on ${disk.drive}`);
      job.cancelReason = job.cancelReason || `Stopped because ${disk.drive} is nearly full (${formatBytesServer(disk.freeBytes)} free)`;
      job.controller.abort();
      clearInterval(diskWatch);
    } else if (disk.freeBytes < LOW_FREE_BYTES && !lowDiskWarned) {
      lowDiskWarned = true;
      saveHealthEvent({ projectId: project.id, acquisitionId, eventType: 'disk_space', severity: 'warning', message: `Low disk space: ${formatBytesServer(disk.freeBytes)} free on ${disk.drive}`, details: disk });
      live.write(`Low disk space: ${formatBytesServer(disk.freeBytes)} free on ${disk.drive}`);
    }
  }, DISK_WATCH_MS);
  diskWatch.unref?.();

  const baseLog = () => ({
    ts, acquisitionId, startedAt, protocol, targetEmail: project.target_email, scope, differential,
    outputDir: sessionDir, queryDescription: describeQuery(query), queryNotes: queryPlan.notes,
    queryUnsupported: unsupportedLabels, folderStats, errors, downloadedItems, differentialExclusions,
    excludedItems, excluded: progress.excluded, inlineMatches: queryPlan.inlineKeys.length ? inlineMatches : null,
    recovered: progress.recoveredOnRetry || 0, duplicatesMerged: progress.duplicatesMerged || 0, drive: driveResult,
  });

  try {
    live.write(`Collection started: project "${project.name}", acquisition ${acquisitionId}, protocol ${protocol}, scope ${scope}${differential ? ', differential' : ''}`);
    live.write(`Output: ${sessionDir}${differentialFolder ? ' (differential acquisition folder)' : ''}; logs ${logsDir}`);
    live.write(`Query: ${describeQuery(query)}`);
    if (wantsEmail) live.write(`Attachments: ${ctx.attachmentFiles ? 'also saved as separate hashed files beside each EML' : 'kept inside each original EML only'}; linked cloud files: ${ctx.linkedFiles ? 'downloaded after the mail' : 'not downloaded'}`);
    for (const note of queryPlan.notes) live.write(`  ${note}`);
    if (unsupportedLabels.length) live.write(`  Not supported by ${protocol} and NOT applied: ${unsupportedLabels.join(', ')}`);

    const existingIds = new Set();
    if (differential) {
      for (const m of getProjectMessageKeys(project.id)) {
        if (m.hash_sha256) existingIds.add(differentialKey(m.hash_sha256, m.folder));
      }
      live.write(`Differential: ${existingIds.size} message(s) from earlier acquisitions of this project will be skipped where the same bytes are found in the same folder`);
    }

    if (wantsEmail && supportsEngine(protocol)) {
      const target = describeTarget(protocol, config);
      live.write(`Email: ${targetFolders.length} folder(s) from ${target}: ${targetFolders.join(', ')}`);
      handler = await createHandler(protocol, config, project);
      progress.phase = 'connecting';
      await connectWithStatus(handler, progress, target, live, signal);
      preSnapshot = await takeSnapshot(handler, 'pre_acquisition');

      let lastLogged = '';
      let lastHeartbeat = 0;
      const logTick = () => {
        const done = progress.acquired + progress.failed + progress.skipped;
        const state = `${progress.phase} | ${progress.statusDetail || progress.currentFolder || ''}`;
        if (state !== lastLogged) { live.write(`Phase: ${state}`); lastLogged = state; }
        if (Date.now() - lastHeartbeat >= 15000) {
          lastHeartbeat = Date.now();
          live.write(`Progress: ${done}/${progress.total} (acquired ${progress.acquired}, failed ${progress.failed}, skipped ${progress.skipped}${progress.deferred ? `, ${progress.deferred} set aside for a final retry` : ''}), ${progress.itemsPerSec || 0} items/s, ETA ${progress.estimateMs != null ? Math.round(progress.estimateMs / 1000) + 's' : 'n/a'}`);
        }
      };
      const itemEvent = (status, folder, fields) => publishCollectEvent(project.id, {
        type: 'item', status, folder, ...fields,
        acquired: progress.acquired, failed: progress.failed, skipped: progress.skipped,
        total: progress.total, bytesDone: progress.bytesDone,
      });
      const sink = createCollectionSink({
        projectId: project.id, acquisitionId, mimeDir, differential, existingIds, progress, errors, folderStats,
        downloadedItems, differentialExclusions, queryPlan, protocol, excludedItems, inlineMatches,
        attachmentLog: ctx.attachmentFiles ? attachmentLog : null,
        onItem: (status, msg, folder) => itemEvent(status, folder, { uid: msg.uid, subject: msg.subject, from: msg.fromAddress, size: msg.size }),
      });

      try {
        const run = await runCollection({
          protocol,
          primary: handler,
          folders: protocol === 'pop3' ? ['INBOX'] : targetFolders,
          limit,
          searchCriteria: queryPlan.server,
          progress,
          signal,
          overrides: { workers: parseInt(config?.connections, 10) || 0 },
          onRecord: sink.add,
          onFailure: ({ folder, ref, error, stage }) => {
            const stats = folderStats[folder] || (folderStats[folder] = { acquired: 0, skipped: 0, excluded: 0, failed: 0 });
            stats.failed++;
            progress.failed++;
            errors.push({
              folder, uid: ref?.uid, messageId: ref?.serviceId || null, error: error.message,
              timestamp: new Date().toISOString(), type: stage === 'fetch' ? 'message_fetch_error' : 'message_error',
            });
            pushProgressError(`${folder} #${ref?.uid ?? '?'}: ${error.message}`);
            progress.lastError = `${folder} #${ref?.uid ?? '?'}: ${error.message}`;
            live.write(`Item failed (${stage}): ${folder} #${ref?.uid ?? '?'}: ${error.message}`);
            itemEvent('failed', folder, { uid: ref?.uid, error: error.message });
          },
          onFolderError: (folder, err) => {
            errors.push({ folder, error: err.message, timestamp: new Date().toISOString(), type: 'folder_error' });
            pushProgressError(`${folder}: ${err.message}`);
            progress.lastError = `${folder}: ${err.message}`;
            live.write(`Folder failed: ${folder}: ${err.message}`);
          },
          onThrottle: ({ message, detail }) => {
            live.write(`${detail} (server: ${message})`);
            publish();
          },
          onDeferred: ({ folder, ref, error }) => {
            live.write(`Item set aside for a final retry: ${folder} #${ref?.uid ?? '?'}: ${error.message}`);
          },
          onRetryRound: ({ round, of, count }) => {
            live.write(`Final retries, round ${round} of ${of}: ${count} item(s) still to collect`);
            publish();
          },
          onTick: () => {
            logTick();
            publish();
          },
        });
        if (run.retryRounds) live.write(`Final retries recovered ${run.recovered} item(s) in ${run.retryRounds} round(s)`);
      } finally {
        sink.flush();
      }
      live.write(`Email download finished: ${progress.acquired} acquired, ${progress.failed} failed, ${progress.skipped} skipped (${progress.excluded} excluded by query), ${progress.duplicatesMerged || 0} label copies merged`);
      if (!signal.aborted) await compareWithPreSnapshot(handler);
      await handler.disconnect().catch(() => {});
    } else if (wantsEmail) {
      handler = await createHandler(protocol, config, project);
      progress.phase = 'connecting';
      await retryWithBackoff(() => handler.connect());
      preSnapshot = await takeSnapshot(handler, 'pre_acquisition');
      progress.phase = 'collecting';
      const folderMsgCounters = {};
      for (const folder of targetFolders) {
        if (signal.aborted) break;
        const stats = folderStats[folder] = { acquired: 0, skipped: 0, excluded: 0, failed: 0 };
        progress.currentFolder = folder;
        try {
          const messages = await retryWithBackoff(() => handler.fetchMessages(folder, { limit }));
          progress.total += messages.length;
          const fromJson = messages.filter(m => m.rawFromJson).length;
          if (fromJson) live.write(`Note: ${fromJson} message(s) in ${folder} arrived from the server as JSON text; 8-bit content that was not UTF-8 cannot be byte-identical to the server's copy`);
          for (const msg of messages) {
            if (signal.aborted) break;
            msg.folder = msg.folder || folder;
            // The raw message could not be downloaded: a failure, never a record rebuilt from metadata.
            if (msg.fetchError) {
              stats.failed++;
              progress.failed++;
              errors.push({ folder, uid: msg.uid, messageId: msg.serviceId || null, error: msg.fetchError, timestamp: new Date().toISOString(), type: 'message_fetch_error' });
              live.write(`Item failed (fetch): ${folder} #${msg.uid}: ${msg.fetchError}`);
              continue;
            }
            if (queryPlan.localKeys.length) {
              const { match, failed } = matchesLocally(msg, query, queryPlan.localKeys, protocol);
              if (!match) {
                excludedItems.push({ uid: msg.uid, messageId: msg.messageId, folder, subject: msg.subject, fromAddress: msg.fromAddress, date: msg.date, size: msg.size, hashSha256: msg.hashSha256, failed });
                stats.skipped++; stats.excluded++; progress.skipped++; progress.excluded++;
                continue;
              }
            }
            const result = processMessageItem(msg, project.id, acquisitionId, existingIds, differential, errors, {
              mimeDir, folderMsgCounters, differentialExclusions, downloadedItems,
            });
            if (result === 'skipped') { stats.skipped++; progress.skipped++; }
            else if (result === 'failed') { stats.failed++; progress.failed++; }
            else {
              stats.acquired++;
              progress.acquired++;
              if (ctx.attachmentFiles && msg.emlPath && msg.attachments?.length) {
                await saveAttachmentFiles(msg, fs.readFileSync(msg.emlPath), attachmentLog);
                for (const att of msg.attachments) if (att.localPath) setAttachmentLocalPath(att.id, att.localPath);
              }
              if (queryPlan.inlineKeys.length && matchesLocally(msg, query, queryPlan.inlineKeys, protocol).match) {
                inlineMatches.push({ id: msg.id, uid: msg.uid, messageId: msg.messageId, folder, subject: msg.subject, fromAddress: msg.fromAddress, date: msg.date, hashSha256: msg.hashSha256, emlPath: msg.emlPath });
              }
            }
            progress.elapsedMs = Date.now() - progress.startedAt;
            const done = progress.acquired + progress.failed + progress.skipped;
            if (done > 0 && progress.total > 0) progress.estimateMs = Math.round((progress.elapsedMs / done) * (progress.total - done));
          }
        } catch (folderErr) {
          errors.push({ folder, error: folderErr.message, timestamp: new Date().toISOString(), type: 'folder_error' });
          pushProgressError(`${folder}: ${folderErr.message}`);
          live.write(`Folder failed: ${folder}: ${folderErr.message}`);
        }
        publish();
      }
      if (!signal.aborted) await compareWithPreSnapshot(handler);
      await handler.disconnect().catch(() => {});
    }

    if (ctx.linkedFiles && wantsEmail && !signal.aborted) {
      progress.phase = 'linked-files';
      progress.statusDetail = 'Looking for cloud links in the collected messages';
      publish();
      const linkedTick = setInterval(publish, 1000);
      try {
        const collected = getAllProjectMessages(project.id).filter(m => m.acquisition_id === acquisitionId);
        linkedResult = await collectLinkedFiles({
          messages: collected, outDir: sessionDir, signal, progress, log: line => live.write(line),
          onRecord: r => {
            for (const m of r.messages) {
              saveDriveLink({
                id: crypto.randomUUID(), projectId: project.id, messageId: m.id, provider: r.provider, url: r.url, fileId: r.fileId,
                status: r.status, downloadedAt: r.downloadedAt, localPath: r.localPath, size: r.size, sha256: r.sha256,
              });
            }
            saveCloudDownload({
              id: r.id, projectId: project.id, provider: r.provider, remoteUrl: r.url, fileName: r.name, fileSize: r.size, mimeType: r.mimeType,
              stage: r.status, localPath: r.localPath, hashMd5: r.md5, hashSha1: r.sha1, hashSha256: r.sha256,
              error: r.status === 'downloaded' ? null : r.reason, startedAt: r.downloadedAt, completedAt: r.downloadedAt,
            });
            publishCollectEvent(project.id, {
              type: 'drive-item', status: r.status === 'not_downloaded' ? 'skipped' : r.status, folder: 'Linked file', subject: r.name || r.url, size: r.size,
              error: r.status === 'downloaded' ? null : r.reason,
            });
          },
        });
      } catch (err) {
        // A problem with linked files never undoes the mail that was collected; it is recorded instead.
        linkedResult = { error: err.message, records: [], stats: null };
        errors.push({ error: `Linked cloud files: ${err.message}`, timestamp: new Date().toISOString(), type: 'linked_files_error' });
        live.write(`Linked cloud files failed: ${err.message}`);
      } finally {
        clearInterval(linkedTick);
        progress.statusDetail = '';
      }
    }

    if (wantsDrive && !signal.aborted) {
      progress.phase = 'drive';
      progress.statusDetail = 'Listing drive files';
      publish();
      const existing = differential
        ? new Map(getDriveItems(project.id).filter(d => ['downloaded', 'hash_mismatch'].includes(d.status)).map(d => [d.remote_id, d.modified_time]))
        : null;
      const driveTick = setInterval(publish, 1000);
      try {
        driveResult = await collectDrive({
          protocol, projectId: project.id, acquisitionId, outDir: path.join(sessionDir, 'Cloud Drive'), query, progress, signal,
          existing, log: line => live.write(line), saveItem: saveDriveItem,
          onItem: r => publishCollectEvent(project.id, {
            type: 'drive-item', status: r.status, folder: driveResultLabel(protocol), subject: r.path, size: r.size,
            error: r.metadata?.error || (r.status === 'hash_mismatch' ? r.metadata?.verification?.detail : null),
          }),
        });
      } finally {
        clearInterval(driveTick);
        progress.statusDetail = '';
      }
    }

  } catch (err) {
    fatalError = err;
    await handler?.disconnect().catch(() => {});
  }
  clearInterval(diskWatch);
  try {
    const result = await finalizeCollection({ canceled: signal.aborted, fatal: fatalError });
    await notifyByEmail(project, result.status === 'completed' ? 'acquisition_complete' : 'acquisition_error', {
      status: result.status, completionType: result.completionType, messages: result.messageCount, failed: result.failedCount, error: result.error,
    }, line => live.write(line));
    return result;
  } finally {
    live.close();
  }

  async function finalizeCollection({ canceled: stopRequested, fatal }) {
    const acquired = downloadedItems.length;
    const drive = driveResult?.stats;
    const done = acquired + progress.skipped + progress.failed;
    const emailLeft = Math.max(0, progress.total - done);
    const driveLeft = drive ? Math.max(0, drive.total - drive.done) : 0;
    // A stop that arrives after everything was downloaded (while logs or exports are written) did not
    // cut anything short, so the collection still counts as complete.
    const cutShort = emailLeft > 0 || driveLeft > 0 || !!progress.foldersNotListed?.length || (wantsDrive && !driveResult);
    const canceled = stopRequested && (cutShort || !!fatal);
    const remaining = canceled ? emailLeft + driveLeft : 0;
    if (canceled && progress.foldersNotListed?.length) live.write(`Folders not listed before the stop: ${progress.foldersNotListed.join(', ')}`);
    const totalFound = Math.max(progress.total, done);
    const totalBytes = downloadedItems.reduce((sum, m) => sum + (m.size || 0), 0) + (drive?.bytes || 0);
    const acquiredAll = acquired + (drive?.downloaded || 0);
    const failedAll = progress.failed + (drive?.failed || 0);
    const skippedAll = progress.skipped + (drive?.skipped || 0);
    const differentialSkipped = progress.skipped - progress.excluded;

    let completionType = fatal ? (canceled ? 'canceled' : 'fatal_error')
      : determineCompletionType(acquiredAll, failedAll, skippedAll, totalFound + (drive?.total || 0), canceled);
    // A downloaded file (the account's drive, a linked file, or a saved attachment) that does not match its
    // expected checksum is a verification warning on the whole collection.
    const verificationWarnings = (drive?.mismatched || 0) + (linkedResult?.stats?.mismatched || 0) + attachmentLog.filter(e => e.status !== 'saved').length;
    if (!fatal && !canceled && verificationWarnings && completionType === 'completed_without_errors') completionType = 'completed_with_verification_warnings';
    // A folder that could not be read means items were never listed; the collection is not complete.
    const folderFailures = errors.filter(e => e.type === 'folder_error').length;
    if (!fatal && !canceled && folderFailures && !completionType.startsWith('completed_with_errors')) completionType = 'completed_with_errors_remaining_items';
    const status = canceled ? 'canceled'
      : fatal ? 'failed'
      : (failedAll > 0 || folderFailures > 0) && acquiredAll === 0 ? 'failed'
      : completionType.startsWith('completed_with_errors') ? 'completed_with_errors'
      : 'completed';
    const projectStatus = status === 'canceled' ? 'canceled' : status === 'failed' ? 'failed' : 'completed';

    if (fatal) {
      live.write(`Collection ${canceled ? 'stopped' : 'failed'}: ${fatal.message}`);
      errors.push({ error: fatal.message, timestamp: new Date().toISOString(), type: 'fatal' });
      pushProgressError(fatal.message);
      progress.lastError = fatal.message;
    } else if (canceled) {
      live.write(`Collection stopped: ${job.cancelReason || 'canceled'}; ${remaining} item(s) not collected`);
    } else if (stopRequested) {
      live.write(`Stop requested (${job.cancelReason || 'stopped'}), but every item had already been collected`);
    }

    progress.phase = 'finalizing';
    publish();

    let logResult = { logsDir, files: [] };
    let attachmentManifest = null;
    let linkedManifest = null;
    const attachmentSummary = ctx.attachmentFiles ? {
      saved: attachmentLog.filter(e => e.status === 'saved').length,
      mismatched: attachmentLog.filter(e => e.status === 'hash_mismatch').length,
      failed: attachmentLog.filter(e => e.status === 'failed').length,
    } : null;
    const linkedStats = linkedResult?.stats || null;
    const notDownloaded = (linkedResult?.records || []).filter(r => !['downloaded', 'hash_mismatch'].includes(r.status));
    for (const e of attachmentLog.filter(x => x.status !== 'saved')) {
      errors.push({ folder: e.folder, messageId: e.messageId, error: `Attachment "${e.filename}" ${e.status === 'failed' ? `not saved: ${e.error}` : 'saved, but its hash does not match the one recorded from the message'}`, timestamp: new Date().toISOString(), type: 'attachment_file_error' });
    }
    try {
      logResult = writeAcquisitionLogs(logsDir, sessionName, {
        attachmentSummary, linkedStats, linkedError: linkedResult?.error || null,
        ...baseLog(),
        totalFound, acquired, skipped: differentialSkipped, failed: progress.failed, remaining, totalBytes, completionType,
        excluded: progress.excluded, recovered: progress.recoveredOnRetry || 0, drive: driveResult,
        stopNote: stopRequested && !canceled ? `Stop requested (${job.cancelReason || 'stopped'}) after every item had already been collected; nothing was left out.` : null,
      });
      const manifest = writeDriveManifest(logsDir, ts, driveResult);
      attachmentManifest = writeAttachmentManifest(logsDir, ts, attachmentLog);
      linkedManifest = writeLinkedFilesManifest(logsDir, ts, linkedResult);
      if (manifest || attachmentManifest || linkedManifest) logResult.files = fs.readdirSync(logsDir);
    } catch (logErr) {
      live.write(`Could not write acquisition logs: ${logErr.message}`);
      errors.push({ error: `Log writing failed: ${logErr.message}`, timestamp: new Date().toISOString(), type: 'log_error' });
    }

    updateAcquisition(acquisitionId, {
      status, completionType, sessionDir,
      totalMessages: totalFound, acquiredMessages: acquired, failedMessages: progress.failed,
      skippedMessages: progress.skipped, totalBytes,
      protocolLog: handler?.getProtocolLog?.() || [],
      errorLog: errors.length > 0 ? errors : null,
    });
    updateProjectStatus(project.id, projectStatus);

    if (queryPlan.inlineKeys.length) {
      saveInlineSearch(project.id, `[collection ${acquisitionId}] ${describeQuery(query)}`, inlineMatches.length, Date.now() - progress.startedAt);
    }

    const summary = `${acquired} messages via ${String(protocol).toUpperCase()}`
      + (drive ? `, ${drive.downloaded} drive files` : '')
      + (differential ? ` (differential: ${differentialSkipped} skipped)` : '')
      + (progress.excluded ? ` (${progress.excluded} excluded by query)` : '')
      + (failedAll ? ` (${failedAll} failed)` : '')
      + (remaining ? ` (${remaining} not collected)` : '');
    addAuditEntry(project.id,
      fatal && !canceled ? 'ACQUISITION_FAILED' : canceled ? 'ACQUISITION_CANCELED' : 'ACQUISITION_COMPLETED',
      `${fatal && !canceled ? `Failed: ${fatal.message}. ` : canceled ? `Stopped (${job.cancelReason || 'canceled'}). ` : ''}Acquired ${summary} — ${completionType}`, {
        acquisitionId, messageCount: acquired, skippedCount: differentialSkipped, excludedCount: progress.excluded, failedCount: progress.failed,
        remaining, differential: !!differential, totalBytes, folders: targetFolders, folderStats, protocol, scope,
        query: describeQuery(query), completionType, sessionDir, logsDir: logResult.logsDir, logFiles: logResult.files,
        drive: drive ? { provider: driveResult.provider, ...drive } : null, errors: errors.slice(0, 50),
      }, project.examiner_name, acquisitionId);

    if (attachmentSummary) {
      addAuditEntry(project.id, 'ATTACHMENT_FILES_SAVED', `Attachment files saved beside the collected EMLs: ${attachmentSummary.saved} saved${attachmentSummary.mismatched ? `, ${attachmentSummary.mismatched} with a hash mismatch` : ''}${attachmentSummary.failed ? `, ${attachmentSummary.failed} not saved` : ''}`, {
        acquisitionId, ...attachmentSummary, manifest: attachmentManifest,
      }, project.examiner_name, acquisitionId);
    }
    if (linkedResult) {
      addAuditEntry(project.id, 'CLOUD_ATTACHMENTS_DOWNLOADED', linkedResult.error
        ? `Linked cloud files could not be processed: ${linkedResult.error}`
        : `Linked cloud files: ${linkedStats.found} found, ${linkedStats.downloaded} downloaded (${linkedStats.verified} verified), ${linkedStats.notDownloaded} not downloaded, ${linkedStats.failed} failed`, {
        acquisitionId, stats: linkedStats, error: linkedResult.error || null, manifest: linkedManifest,
        files: (linkedResult.records || []).filter(r => r.localPath).map(r => ({ url: r.url, localPath: r.localPath, sha256: r.sha256, verification: r.verification })),
      }, project.examiner_name, acquisitionId);
    }

    if (snapshotComparison) {
      fs.writeFileSync(path.join(logResult.logsDir, `folder_snapshots_${ts}.json`), JSON.stringify(snapshotComparison, null, 2));
      addAuditEntry(project.id, 'FOLDER_SNAPSHOT', `Folder snapshots before and after the collection: ${snapshotComparison.changed ? `the mailbox changed (${snapshotComparison.messageDelta >= 0 ? '+' : ''}${snapshotComparison.messageDelta} messages)` : 'no change'}`, {
        acquisitionId, ...snapshotComparison,
      }, project.examiner_name, acquisitionId);
    }

    // A trusted timestamp over the list of collected hashes, from an outside authority. When none can be
    // reached that is recorded as such; nothing stands in for it.
    let timestamp = null;
    if (acquired > 0 && !canceled) {
      progress.statusDetail = 'Requesting a trusted timestamp';
      publish();
      const record = await TimestampService.timestampCollection(project.id, downloadedItems, logResult.logsDir, ts);
      saveRfc3161Timestamp(record);
      timestamp = Rfc3161TimestampService.summarize(record);
      live.write(record.status === 'verified'
        ? `Trusted timestamp from ${record.tsaName}: ${record.genTime} (token ${record.tokenFile})`
        : `No trusted timestamp: ${record.error}`);
      addAuditEntry(project.id, record.status === 'verified' ? 'RFC3161_COLLECTION_TIMESTAMP' : 'RFC3161_TIMESTAMP_FAILED',
        record.status === 'verified' ? `Collection timestamped by ${record.tsaName} at ${record.genTime}` : `Collection could not be timestamped: ${record.error}`,
        { acquisitionId, targetHash: record.targetHash, targetFile: record.targetFile, tsa: record.tsaUrl, status: record.status, genTime: record.genTime || null, serialNumber: record.serialNumber || null, error: record.error || null, attempts: record.attempts },
        project.examiner_name, acquisitionId);
      progress.statusDetail = '';
    }

    // The formats chosen in the Workflow step are exported here, by the server, so they are produced even
    // if nobody is watching when the collection ends. Each covers this acquisition's messages only.
    const exports = [];
    const exportFormats = [];
    for (const f of ctx.exportFormats || []) exportFormats.push(f);
    if (!fatal && !canceled && acquired > 0 && exportFormats.length) {
      progress.phase = 'exporting';
      publish();
      const messages = getAllProjectMessages(project.id).filter(m => m.acquisition_id === acquisitionId);
      for (const format of exportFormats) {
        progress.statusDetail = `Exporting ${format.toUpperCase()}`;
        publish();
        try {
          const r = await performExport(project, {
            format, outputDir: destinationDir ? sessionDir : undefined, pdfSplitMode: ctx.pdfSplitMode, pstMaxGb: ctx.pstMaxGb, messages,
            onProgress: format === 'pst' ? (done, total) => { progress.statusDetail = `Exporting PST: ${done} of ${total}`; publish(); } : undefined,
            label: `Automatic export after acquisition ${acquisitionId}`,
          });
          exports.push({ format, success: true, files: r.files.length, totalBytes: r.totalBytes, outputDir: r.outputDir, reconstructed: r.reconstructedCount, failed: r.failedCount, verificationFailures: r.verificationFailures.length });
          live.write(`Exported ${format.toUpperCase()}: ${r.files.length} file(s) to ${r.outputDir}`);
          for (const f of r.failed) live.write(`  Not exported to ${format.toUpperCase()}: ${f.folder} | ${f.subject} | ${f.error}`);
          for (const v of r.verificationFailures) live.write(`  ${format.toUpperCase()} file failed read-back verification: ${v.file}: ${v.error}`);
        } catch (exportErr) {
          exports.push({ format, success: false, error: exportErr.message });
          live.write(`Export ${format.toUpperCase()} failed: ${exportErr.message}`);
        }
      }
      progress.statusDetail = '';
    }

    const result = {
      exports,
      acquisitionId, status, completionType,
      error: fatal && !canceled ? fatal.message : null,
      canceled, cancelReason: canceled ? job.cancelReason : null,
      messageCount: acquired, duplicatesMerged: progress.duplicatesMerged || 0, skippedCount: differentialSkipped,
      excludedCount: progress.excluded, failedCount: progress.failed, remainingCount: remaining,
      recoveredOnRetry: progress.recoveredOnRetry || 0,
      differential: !!differential, differentialFolder, scope, totalBytes, folderStats,
      sessionDir, destinationDir, mimeOutputDir: wantsEmail ? mimeDir : null, logsDir: logResult.logsDir, logFiles: logResult.files,
      errors: errors.slice(0, 50), timestamp,
      folderSnapshot: snapshotComparison ? { changed: snapshotComparison.changed, messageDelta: snapshotComparison.messageDelta, foldersChanged: snapshotComparison.foldersChanged } : null,
      query: query ? {
        type: query.type, description: describeQuery(query), notes: queryPlan.notes, unsupported: unsupportedLabels,
        inlineMatchCount: queryPlan.inlineKeys.length ? inlineMatches.length : null,
      } : null,
      drive: driveResult ? { provider: driveResult.provider, label: driveResult.label, root: driveResult.root, stats: driveResult.stats, criteriaNotApplied: driveResult.criteriaNotApplied } : null,
      attachmentFiles: attachmentSummary ? { ...attachmentSummary, manifest: attachmentManifest } : null,
      linkedFiles: linkedResult ? {
        error: linkedResult.error || null, stats: linkedStats, folder: linkedStats?.downloaded ? path.join(sessionDir, LINKED_FOLDER_NAME) : null, manifest: linkedManifest,
        notDownloaded: notDownloaded.slice(0, 50).map(r => ({ provider: r.providerLabel, url: r.url, name: r.name || null, reason: r.reason, messages: r.messages.length })),
      } : null,
    };
    progress.result = result;
    progress.active = false;
    progress.phase = status === 'canceled' ? 'canceled' : fatal ? 'error' : 'complete';
    progress.estimateMs = 0;
    publish();
    publishCollectEvent(project.id, { type: fatal && !canceled ? 'failed' : 'complete', result });
    live.write(`Collection finished: ${completionType}`);
    return result;
  }
}

// Sends the completion e-mail the examiner set up. A failed notification is logged, never fatal.
async function notifyByEmail(project, type, details, log = () => {}) {
  let settings;
  try {
    settings = getSmtpSettings(project.id);
  } catch (err) {
    log(`Notification settings could not be read: ${err.message}`);
    return;
  }
  if (!settings) return;
  const wanted = type === 'export_complete' ? settings.notify_on_export : type === 'acquisition_error' ? settings.notify_on_error : settings.notify_on_complete;
  if (!wanted) return;
  const result = await AutomationService.sendNotification({
    host: settings.host, port: settings.port, secure: !!settings.secure, username: settings.username,
    password: decryptSecret(settings.password_encrypted), fromAddress: settings.from_address, toAddresses: settings.to_addresses,
  }, { type, projectName: project.name, details });
  log(result.success ? `Notification e-mail sent to ${result.recipients} recipient(s)` : `Notification e-mail failed: ${result.error}`);
  addAuditEntry(project.id, result.success ? 'NOTIFICATION_SENT' : 'NOTIFICATION_FAILED', result.success ? `Notification (${type}) sent to ${result.recipients} recipient(s)` : `Notification (${type}) failed: ${result.error}`, { type, error: result.error || null }, project.examiner_name);
}

function driveResultLabel(protocol) {
  return driveProviderFor(protocol) === 'google_drive' ? 'Google Drive' : 'OneDrive';
}

// Counts what a collection with these settings would include, without downloading anything: the same
// enumeration and Gmail label de-duplication the collection uses, with the query applied server-side.
router.post('/projects/:id/collect/estimate', async (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (activeCollections.has(project.id)) return res.status(409).json({ error: 'A collection is running for this project' });

  let request;
  try {
    request = parseCollectRequest(project, req.body || {});
  } catch (err) {
    return res.status(400).json({ error: `Query: ${err.message}` });
  }
  const { scope, protocol, config, destinationDir, query, queryPlan } = request;
  const invalid = validateCollectTarget(request);
  if (invalid) return res.status(400).json({ error: invalid });

  const controller = new AbortController();
  res.on('close', () => { if (!res.writableFinished) controller.abort(); });
  const rerun = priorCollectionAt(project.id, destinationDir);
  const out = {
    protocol, scope, rerun,
    previouslyCollected: getProjectMessageKeys(project.id).length,
    differentialFolder: rerun ? (destinationDir ? path.join(destinationDir, DIFFERENTIAL_FOLDER_NAME) : DIFFERENTIAL_FOLDER_NAME) : null,
    query: {
      type: query?.type || null, description: describeQuery(query), notes: queryPlan.notes,
      unsupported: queryPlan.unsupported.map(k => describeKeys([k])), checkedAfterDownload: queryPlan.localKeys.length > 0,
    },
  };

  let handler = null;
  try {
    if (request.wantsEmail) {
      if (supportsEngine(protocol)) {
        handler = await createHandler(protocol, config, project);
        await handler.connect();
        const folders = protocol === 'pop3' ? ['INBOX'] : (Array.isArray(req.body.folders) && req.body.folders.length ? req.body.folders : ['INBOX']);
        const { listings, rawTotal, duplicatesMerged, folderErrors } = await enumerateFolders({
          primary: handler, folders, searchCriteria: queryPlan.server, signal: controller.signal,
        });
        const refs = listings.flatMap(l => l.refs);
        const sized = refs.filter(r => r.size > 0);
        let totalBytes = sized.reduce((s, r) => s + r.size, 0);
        let sizeBasis = !refs.length || sized.length === refs.length ? 'exact' : sized.length ? 'partial' : 'unknown';
        if (sizeBasis === 'partial') {
          totalBytes = Math.round((totalBytes / sized.length) * refs.length);
          sizeBasis = `estimated from ${sized.length.toLocaleString()} of ${refs.length.toLocaleString()} reported sizes`;
        } else if (sizeBasis === 'unknown' && handler.sampleSizes) {
          const sample = await handler.sampleSizes(refs, 100);
          if (sample.sampled) {
            totalBytes = Math.round(sample.averageBytes * refs.length);
            sizeBasis = `estimated from a random sample of ${sample.sampled} messages`;
          }
        }
        out.email = {
          items: refs.length, itemsBeforeDedup: rawTotal, duplicatesMerged, totalBytes: sizeBasis === 'unknown' ? null : totalBytes, sizeBasis,
          folders: listings.map(l => ({ folder: l.folder, items: l.refs.length, bytes: l.refs.reduce((s, r) => s + (r.size || 0), 0) })),
          folderErrors: folderErrors.map(f => ({ folder: f.folder, error: f.error.message })),
        };
      } else {
        out.email = { items: null, note: `${protocol} cannot list messages without downloading them, so only the folder totals are available.` };
      }
    }
    if (request.wantsDrive) {
      try {
        out.drive = await estimateDrive({ protocol, query, signal: controller.signal });
      } catch (err) {
        out.drive = { error: err.message };
      }
    }
    if (!res.headersSent) res.json(out);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  } finally {
    await handler?.disconnect?.().catch(() => {});
  }
});

// ── Acquisitions ──
router.get('/projects/:id/acquisitions', (req, res) => {
  res.json(getAcquisitions(req.params.id));
});

// ── Messages ──
router.get('/projects/:id/messages', (req, res) => {
  const { folder, limit, offset, search } = req.query;
  const messages = getMessages(req.params.id, {
    folder,
    limit: parseInt(limit) || 50,
    offset: parseInt(offset) || 0,
    search,
  });
  const total = getMessageCount(req.params.id, { folder, search });
  res.json({ messages, total });
});

router.get('/projects/:id/messages/:msgId', (req, res) => {
  const msg = getMessage(req.params.msgId);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  const attachments = getAttachments(req.params.msgId);
  res.json({ ...msg, attachments });
});

// ── Inline Search ──
router.post('/projects/:id/inline-search', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { query } = req.body;
  const messages = getAllProjectMessages(project.id);
  const attachmentsByMessage = new Map();
  for (const a of getProjectAttachments(project.id)) {
    if (!attachmentsByMessage.has(a.message_id)) attachmentsByMessage.set(a.message_id, []);
    attachmentsByMessage.get(a.message_id).push(a.filename);
  }
  let result;
  try {
    result = InlineSearchEngine.search(messages, query, { attachmentsByMessage });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  saveInlineSearch(project.id, query, result.stats.matched, result.stats.elapsed);
  addAuditEntry(project.id, 'INLINE_SEARCH', `Inline search: "${query}" — ${result.stats.matched} of ${result.stats.total} matched`, {
    query,
    matched: result.stats.matched,
    total: result.stats.total,
    elapsed: result.stats.elapsed,
  }, project.examiner_name);

  res.json({
    results: result.results.map(m => ({
      id: m.id,
      subject: m.subject,
      from_address: m.from_address,
      to_addresses: m.to_addresses,
      date: m.date,
      folder: m.folder,
      size: m.size,
      hash_sha256: m.hash_sha256,
      has_attachments: m.has_attachments,
      is_encrypted: m.is_encrypted,
      is_signed: m.is_signed,
    })),
    stats: result.stats,
    parsed: result.parsed,
  });
});

router.get('/inline-search/syntax', (req, res) => {
  res.json(InlineSearchEngine.getSyntaxHelp());
});

router.get('/projects/:id/inline-searches', (req, res) => {
  res.json(getInlineSearches(req.params.id));
});

// ── Server-side Search Queries ──
router.get('/projects/:id/searches', (req, res) => {
  res.json(getSearchQueries(req.params.id));
});

router.post('/projects/:id/search', async (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { criteria = {}, queryType, config } = req.body;

  const dbResults = getMessages(project.id, {
    search: criteria.keyword || criteria.from || criteria.subject,
    folder: criteria.folder,
  });

  // Searching collected evidence must not log in to the custodian's mailbox. The live server is only asked
  // when the request says so and carries the connection to use.
  let serverResult = { resultCount: null, query: '', protocolLog: [] };
  if (config) {
    const protocol = config.protocol || project.provider_type;
    let handler = null;
    try {
      handler = await createHandler(protocol, config, project);
      await handler.connect();
      serverResult = protocol === 'imap'
        ? await handler.serverSearch(criteria.folder || 'INBOX', criteria).then(r => ({ query: JSON.stringify(criteria), resultCount: r.count, uids: r.uids }))
        : await handler.searchMessages(criteria);
      serverResult.protocolLog = handler.getProtocolLog();
    } catch (err) {
      serverResult.error = err.message;
    } finally {
      await handler?.disconnect?.().catch(() => {});
    }
  }

  const queryId = saveSearchQuery(project.id, queryType || 'keyword', serverResult.query || JSON.stringify(criteria), criteria);
  addAuditEntry(project.id, 'SEARCH_EXECUTED', `Search: ${serverResult.query || JSON.stringify(criteria)}`, {
    queryId, criteria,
    serverResults: serverResult.resultCount,
    localResults: dbResults.length,
  }, project.examiner_name);

  res.json({
    ...serverResult,
    queryId,
    localResults: dbResults.map(m => ({
      id: m.id,
      subject: m.subject,
      from_address: m.from_address,
      date: m.date,
      folder: m.folder,
      hash_sha256: m.hash_sha256,
      has_attachments: m.has_attachments,
      size: m.size,
      is_signed: m.is_signed,
      is_encrypted: m.is_encrypted,
    })),
    localResultCount: dbResults.length,
  });
});

// ── Records from before 0.10.0: corrected only when the examiner asks ──
router.post('/projects/:id/older-records/check', async (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (activeCollections.has(project.id)) return res.status(409).json({ error: 'Wait for the running collection to finish' });
  try {
    res.json(await checkOlderRecords(project));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Quality Control ──
router.post('/projects/:id/qc', async (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  if (activeCollections.has(project.id)) return res.status(409).json({ error: 'Wait for the running collection to finish before running QC' });

  try {
    // With an acquisition ID, QC covers that one collection (what the wizard just collected); otherwise the whole project.
    const acquisitionId = typeof req.body?.acquisitionId === 'string' ? req.body.acquisitionId : null;
    let messages = getAllProjectMessages(project.id);
    let acquisitions = getAcquisitions(project.id);
    let driveItems = getDriveItems(project.id);
    if (acquisitionId) {
      acquisitions = acquisitions.filter(a => a.id === acquisitionId);
      if (!acquisitions.length) return res.status(404).json({ error: 'Acquisition not found for this project' });
      messages = messages.filter(m => m.acquisition_id === acquisitionId);
      driveItems = driveItems.filter(d => { try { return JSON.parse(d.metadata_json || '{}').acquisitionId === acquisitionId; } catch { return false; } });
    }
    const messageIds = new Set(messages.map(m => m.id));
    const folders = getFolders(project.id);
    const exports = getExportRecords(project.id);
    const attachments = getProjectAttachments(project.id).filter(a => messageIds.has(a.message_id));
    const driveLinks = getDriveLinks(project.id);
    const scope = req.body?.scope === 'collection' ? 'collection' : 'full';

    const auditChain = verifyAuditChain(getAuditLog(project.id));
    const results = await QualityControlService.runChecks(project, messages, acquisitions, folders, exports, { attachments, driveLinks, driveItems, scope, acquisitionId, auditChain });
    saveQcResult(project.id, results);

    addAuditEntry(project.id, 'QC_COMPLETED', `Quality control (${scope}${acquisitionId ? `, acquisition ${acquisitionId}` : ''}): ${results.summary.passed} passed, ${results.summary.warnings} warnings, ${results.summary.failed} failed`, {
      scope,
      acquisitionId,
      summary: results.summary,
      overallStatus: results.overallStatus,
    }, project.examiner_name, acquisitionId || undefined);

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/projects/:id/qc', (req, res) => {
  res.json(getQcResults(req.params.id));
});

// ── Cloud Attachment Detection ──
router.post('/projects/:id/cloud-scan', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const messages = getAllProjectMessages(project.id);
  const result = CloudAttachmentService.scanMessages(messages);

  const known = new Set(getDriveLinks(project.id).map(l => `${l.message_id}|${l.url}`));
  for (const link of result.links) {
    if (!known.has(`${link.messageId}|${link.url}`)) saveDriveLink({ ...link, projectId: project.id });
  }

  addAuditEntry(project.id, 'CLOUD_SCAN', `Cloud attachment scan: ${result.totalLinks} links found from ${result.totalProviders} provider(s)`, {
    totalLinks: result.totalLinks,
    byProvider: result.byProvider,
  }, project.examiner_name);

  res.json(result);
});

router.get('/projects/:id/cloud-links', (req, res) => {
  res.json(getDriveLinks(req.params.id));
});

router.get('/cloud/providers', (req, res) => {
  res.json(CloudAttachmentService.getProviderInfo());
});

// ── RFC 3161 Timestamps ──
router.post('/projects/:id/timestamp', async (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { type, tsaUrl } = req.body || {};
  try {
    let record;
    if (type === 'export') {
      const latest = getExportRecords(project.id)[0];
      if (!latest) return res.status(400).json({ error: 'No exports to timestamp' });
      if (!latest.output_dir || !fs.existsSync(path.join(latest.output_dir, 'manifest.txt'))) return res.status(400).json({ error: 'The latest export\'s manifest was not found' });
      record = await TimestampService.timestampExport(project.id, latest.output_dir, { tsaUrl });
    } else {
      const messages = getAllProjectMessages(project.id);
      if (!messages.length) return res.status(400).json({ error: 'No messages to timestamp. Collect messages first.' });
      record = await TimestampService.timestampCollection(project.id, messages, path.join(DATA_DIR, 'projects', project.id, 'timestamps'), new Date().toISOString().replace(/[:.]/g, '-'), { tsaUrl });
    }
    saveRfc3161Timestamp(record);
    addAuditEntry(project.id, record.status === 'verified' ? 'RFC3161_TIMESTAMP' : 'RFC3161_TIMESTAMP_FAILED',
      record.status === 'verified' ? `Trusted timestamp (${type || 'collection'}) from ${record.tsaName} at ${record.genTime}` : `Trusted timestamp (${type || 'collection'}) failed: ${record.error}`,
      { type: type || 'collection', targetHash: record.targetHash, targetFile: record.targetFile, tsa: record.tsaUrl, status: record.status, genTime: record.genTime || null, serialNumber: record.serialNumber || null, error: record.error || null, attempts: record.attempts },
      project.examiner_name);
    res.json({ ...Rfc3161TimestampService.summarize(record), type: type || 'collection', targetFile: record.targetFile, tokenFile: record.tokenFile || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Trusted tokens, each re-verified against its target, plus how many old self-made records exist.
router.get('/projects/:id/timestamps', async (req, res) => {
  const rows = getRfc3161Timestamps(req.params.id);
  const results = [];
  for (const row of rows) {
    const summary = Rfc3161TimestampService.summarize(row);
    if (row.timestamp_token) {
      const v = await Rfc3161TimestampService.verifyTimestamp(row.timestamp_token, row.target_hash, { tsaUrl: row.tsa_url });
      summary.verifiedNow = v.valid;
      summary.chainTrusted = v.chainTrusted;
      summary.trustedRoot = v.trustedRoot || null;
      summary.errors = v.errors;
    }
    results.push(summary);
  }
  res.json({ timestamps: results, legacyInternalRecords: getTimestampRecords(req.params.id).length });
});

router.get('/timestamp/info', (req, res) => {
  res.json(TimestampService.getInfo());
});

// ── Analytics: Timeline ──
router.get('/projects/:id/analytics/timeline', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const messages = getAllProjectMessages(project.id);
  const buckets = {};
  const hourBuckets = new Array(24).fill(0);
  const dayOfWeekBuckets = new Array(7).fill(0);

  for (const msg of messages) {
    if (!msg.date) continue;
    const d = new Date(msg.date);
    if (isNaN(d.getTime())) continue;

    const dateKey = d.toISOString().substring(0, 10);
    if (!buckets[dateKey]) buckets[dateKey] = { date: dateKey, count: 0, sent: 0, received: 0, totalSize: 0 };
    buckets[dateKey].count++;
    buckets[dateKey].totalSize += msg.size || 0;

    const targetEmail = (project.target_email || '').toLowerCase();
    if (targetEmail && (msg.from_address || '').toLowerCase().includes(targetEmail)) buckets[dateKey].sent++;
    else buckets[dateKey].received++;

    hourBuckets[d.getUTCHours()]++;
    dayOfWeekBuckets[d.getUTCDay()]++;
  }

  const timeline = Object.values(buckets).sort((a, b) => a.date.localeCompare(b.date));

  res.json({
    timeline,
    hourDistribution: hourBuckets,
    dayOfWeekDistribution: dayOfWeekBuckets,
    timeZone: 'UTC',
    totalMessages: messages.length,
    undatedMessages: messages.filter(m => !m.date || isNaN(new Date(m.date).getTime())).length,
    dateRange: timeline.length > 0
      ? { from: timeline[0].date, to: timeline[timeline.length - 1].date }
      : null,
  });
});

// ── Analytics: Relationships ──
router.get('/projects/:id/analytics/relationships', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const messages = getAllProjectMessages(project.id);
  const pairMap = {};
  const contactMap = {};

  const addressOf = (v) => {
    const text = String(v || '').toLowerCase().trim();
    return text.match(/<([^<>\s]+@[^<>\s]+)>/)?.[1] || text.match(/[^\s<>"',;]+@[^\s<>"',;]+/)?.[0] || text;
  };
  for (const msg of messages) {
    const from = addressOf(msg.from_address);
    if (!from) continue;

    if (!contactMap[from]) contactMap[from] = { address: from, sent: 0, received: 0, totalMessages: 0 };
    contactMap[from].sent++;
    contactMap[from].totalMessages++;

    let toAddrs = msg.to_addresses || '[]';
    if (typeof toAddrs === 'string') {
      try { toAddrs = JSON.parse(toAddrs); } catch { toAddrs = [toAddrs]; }
    }
    const ccAddrs = msg.cc_addresses ? (typeof msg.cc_addresses === 'string' ? (() => { try { return JSON.parse(msg.cc_addresses); } catch { return [msg.cc_addresses]; } })() : msg.cc_addresses) : [];

    const allRecipients = [...(Array.isArray(toAddrs) ? toAddrs : [toAddrs]), ...(Array.isArray(ccAddrs) ? ccAddrs : [])];

    for (const to of allRecipients) {
      const toAddr = addressOf(to);
      if (!toAddr) continue;

      if (!contactMap[toAddr]) contactMap[toAddr] = { address: toAddr, sent: 0, received: 0, totalMessages: 0 };
      contactMap[toAddr].received++;
      contactMap[toAddr].totalMessages++;

      const key = [from, toAddr].sort().join('|||');
      if (!pairMap[key]) pairMap[key] = { source: from, target: toAddr, count: 0, subjects: [] };
      pairMap[key].count++;
      if (pairMap[key].subjects.length < 5 && msg.subject) {
        pairMap[key].subjects.push(msg.subject);
      }
    }
  }

  const pairs = Object.values(pairMap).sort((a, b) => b.count - a.count);
  const contacts = Object.values(contactMap).sort((a, b) => b.totalMessages - a.totalMessages);

  res.json({
    pairs: pairs.slice(0, 100),
    contacts: contacts.slice(0, 50),
    totalPairs: pairs.length,
    totalContacts: contacts.length,
  });
});

// ── Analytics: Email Threading ──
router.get('/projects/:id/analytics/threading', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const messages = getAllProjectMessages(project.id);
  const threads = threadMessages(messages).filter(g => g.threadedBy !== 'single').map(({ messages: sorted, threadedBy }) => {
    const dated = sorted.filter(m => m.date);
    return {
      rootMessageId: sorted[0].message_id,
      rootSubject: sorted[0].subject,
      rootFrom: sorted[0].from_address,
      rootDate: sorted[0].date,
      messageCount: sorted.length,
      participants: [...new Set(sorted.map(m => m.from_address).filter(Boolean))],
      dateRange: { from: dated[0]?.date || null, to: dated[dated.length - 1]?.date || null },
      threadedBy,
      messages: sorted.map(m => ({ id: m.id, subject: m.subject, from: m.from_address, date: m.date, inReplyTo: m.in_reply_to, messageId: m.message_id })),
    };
  });
  threads.sort((a, b) => b.messageCount - a.messageCount);
  const threadedMessages = threads.reduce((n, t) => n + t.messageCount, 0);

  res.json({
    totalMessages: messages.length,
    threadedMessages,
    singleMessages: messages.length - threadedMessages,
    threadCount: threads.length,
    threads: threads.slice(0, 100),
  });
});

// ── Analytics: Deduplication ──
router.get('/projects/:id/analytics/dedup', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const messages = getAllProjectMessages(project.id);
  const hashGroups = {};
  const contentGroups = {};

  for (const msg of messages) {
    if (msg.hash_sha256) {
      if (!hashGroups[msg.hash_sha256]) hashGroups[msg.hash_sha256] = [];
      hashGroups[msg.hash_sha256].push(msg);
    }

    const contentKey = crypto.createHash('sha256').update(
      [msg.from_address || '', msg.to_addresses || '', msg.subject || '', (msg.date || '').substring(0, 19), (msg.body_text || '').substring(0, 500)].join('|')
    ).digest('hex');
    if (!contentGroups[contentKey]) contentGroups[contentKey] = [];
    contentGroups[contentKey].push(msg);
  }

  const exactDupes = Object.entries(hashGroups)
    .filter(([, group]) => group.length > 1)
    .map(([hash, group]) => ({
      hash,
      count: group.length,
      subject: group[0].subject,
      from: group[0].from_address,
      date: group[0].date,
      folders: [...new Set(group.map(m => m.folder).filter(Boolean))],
      ids: group.map(m => m.id),
    }))
    .sort((a, b) => b.count - a.count);

  const nearDupes = Object.entries(contentGroups)
    .filter(([, group]) => group.length > 1)
    .filter(([, group]) => {
      const hashes = new Set(group.map(m => m.hash_sha256).filter(Boolean));
      return hashes.size > 1 || !group[0].hash_sha256;
    })
    .map(([hash, group]) => ({
      contentHash: hash,
      count: group.length,
      subject: group[0].subject,
      from: group[0].from_address,
      date: group[0].date,
      ids: group.map(m => m.id),
    }))
    .sort((a, b) => b.count - a.count);

  const totalExactDupeMessages = exactDupes.reduce((sum, d) => sum + d.count - 1, 0);
  const totalNearDupeMessages = nearDupes.reduce((sum, d) => sum + d.count - 1, 0);
  const uniqueMessages = messages.length - totalExactDupeMessages;
  const dedupSavingsPct = messages.length > 0 ? ((totalExactDupeMessages / messages.length) * 100).toFixed(1) : '0.0';

  res.json({
    totalMessages: messages.length,
    uniqueMessages,
    exactDuplicates: totalExactDupeMessages,
    nearDuplicates: totalNearDupeMessages,
    dedupSavingsPercent: dedupSavingsPct,
    exactGroups: exactDupes.slice(0, 50),
    nearGroups: nearDupes.slice(0, 50),
    hashAlgorithm: 'SHA-256',
  });
});

// ── Analytics: Header Analysis ──
router.get('/projects/:id/messages/:msgId/headers', (req, res) => {
  const msg = getMessage(req.params.msgId);
  if (!msg || msg.project_id !== req.params.id) return res.status(404).json({ error: 'Message not found' });

  let headers = {};
  try { headers = typeof msg.headers_json === 'string' ? JSON.parse(msg.headers_json) : (msg.headers_json || {}); } catch {}

  const receivedHeaders = [];
  const rawReceived = headers.received || headers.Received || [];
  const receivedList = Array.isArray(rawReceived) ? rawReceived : [rawReceived];

  for (const hop of receivedList) {
    if (!hop) continue;
    const fromMatch = hop.match(/from\s+(\S+)/i);
    const byMatch = hop.match(/by\s+(\S+)/i);
    const dateMatch = hop.match(/;\s*(.+)$/);
    const ipMatch = hop.match(/\[(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\]/);

    receivedHeaders.push({
      raw: hop,
      from: fromMatch?.[1] || null,
      by: byMatch?.[1] || null,
      ip: ipMatch?.[1] || null,
      date: dateMatch?.[1]?.trim() || null,
    });
  }

  const authResults = headers['authentication-results'] || headers['Authentication-Results'] || '';
  const authList = Array.isArray(authResults) ? authResults : [authResults];
  const authentication = { spf: 'none', dkim: 'none', dmarc: 'none', raw: authList.filter(Boolean) };

  for (const ar of authList) {
    if (!ar) continue;
    const spfMatch = ar.match(/spf=(\w+)/i);
    const dkimMatch = ar.match(/dkim=(\w+)/i);
    const dmarcMatch = ar.match(/dmarc=(\w+)/i);
    if (spfMatch) authentication.spf = spfMatch[1].toLowerCase();
    if (dkimMatch) authentication.dkim = dkimMatch[1].toLowerCase();
    if (dmarcMatch) authentication.dmarc = dmarcMatch[1].toLowerCase();
  }

  const headerAddress = (value) => {
    const v = Array.isArray(value) ? value[0] : value;
    if (!v) return '';
    if (typeof v === 'object') return (v.value?.[0]?.address || v.text || '').toLowerCase();
    return (String(v).match(/[^\s<>"',;]+@[^\s<>"',;]+/)?.[0] || String(v)).toLowerCase();
  };
  const domainOf = address => address.includes('@') ? address.split('@').pop() : '';
  const headerText = (value) => {
    const v = Array.isArray(value) ? value[0] : value;
    if (!v) return '';
    return typeof v === 'object' ? (v.text || v.value?.[0]?.address || '') : String(v);
  };

  const rawDkimSig = headers['dkim-signature'] || headers['DKIM-Signature'] || '';
  const dkimSig = Array.isArray(rawDkimSig) ? rawDkimSig[0] || '' : rawDkimSig;
  const dkimDomain = typeof dkimSig === 'object'
    ? (dkimSig.params?.d || null)
    : (dkimSig ? (String(dkimSig).match(/\bd=([^;\s]+)/)?.[1] || null) : null);

  const returnPath = headerText(headers['return-path'] || headers['Return-Path']);
  const replyTo = headerText(headers['reply-to'] || headers['Reply-To']);
  const fromAddress = headerAddress(headers.from || headers.From || msg.from_address);
  const replyAddress = headerAddress(headers['reply-to'] || headers['Reply-To']);
  const returnAddress = headerAddress(headers['return-path'] || headers['Return-Path']);

  const redFlags = [];
  if (returnAddress && domainOf(fromAddress) && domainOf(returnAddress) !== domainOf(fromAddress)) {
    redFlags.push({ type: 'RETURN_PATH_MISMATCH', description: `Return-Path domain ${domainOf(returnAddress)} does not match From domain ${domainOf(fromAddress)}`, severity: 'warning' });
  }
  if (replyAddress && fromAddress && replyAddress !== fromAddress) {
    redFlags.push({ type: 'REPLY_TO_DIFFERS', description: `Reply-To ${replyAddress} differs from From ${fromAddress}`, severity: 'info' });
  }
  if (authentication.spf === 'fail' || authentication.spf === 'softfail') {
    redFlags.push({ type: 'SPF_FAIL', description: `SPF result ${authentication.spf}: sender not authorized`, severity: 'critical' });
  }
  if (authentication.dkim === 'fail') {
    redFlags.push({ type: 'DKIM_FAIL', description: 'DKIM signature verification failed: message may be altered', severity: 'critical' });
  }
  if (authentication.dmarc === 'fail') {
    redFlags.push({ type: 'DMARC_FAIL', description: 'DMARC policy check failed', severity: 'critical' });
  }
  if (dkimDomain && domainOf(fromAddress) && !domainOf(fromAddress).endsWith(dkimDomain.toLowerCase())) {
    redFlags.push({ type: 'DKIM_DOMAIN_MISMATCH', description: `DKIM signed by ${dkimDomain} but From shows ${domainOf(fromAddress)}`, severity: 'warning' });
  }

  const hopCount = receivedHeaders.length;
  if (hopCount > 8) {
    redFlags.push({ type: 'EXCESSIVE_HOPS', description: `Message traversed ${hopCount} servers — unusually high`, severity: 'info' });
  }

  res.json({
    messageId: msg.message_id,
    subject: msg.subject,
    from: msg.from_address,
    date: msg.date,
    receivedHops: receivedHeaders,
    authentication,
    dkimDomain,
    returnPath,
    replyTo,
    redFlags,
    xHeaders: Object.entries(headers).filter(([k]) => k.toLowerCase().startsWith('x-')).map(([k, v]) => ({ name: k, value: v })),
    rawHeaderCount: Object.keys(headers).length,
  });
});

// ── Chain of Custody Report ──
router.get('/projects/:id/chain-of-custody', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const auditLog = getAuditLog(req.params.id);
  const messages = getAllProjectMessages(project.id);
  const acquisitions = getAcquisitions(project.id);
  const exports = getExportRecords(project.id);
  const chainVerification = verifyAuditChain(auditLog);

  const { evidenceId, custodianName } = caseFields(project);

  const brokenEntries = new Set(chainVerification.breaks.map(b => b.entryId));
  const custodyEvents = auditLog.map(entry => ({
    timestamp: entry.timestamp,
    event: entry.event_type,
    description: entry.description,
    handler: entry.examiner || project.examiner_name || 'System',
    hashChain: entry.hash,
    verified: !brokenEntries.has(entry.id),
  }));
  const trustedTimestamps = getRfc3161Timestamps(req.params.id);

  const report = {
    reportGenerated: new Date().toISOString(),
    reportVersion: '1.0',
    toolInfo: {
      name: 'SherlockMail',
      version: '0.10.0',
      description: 'Forensic email collection tool',
    },
    caseInfo: {
      projectName: project.name,
      projectId: project.id,
      caseId: project.case_id,
      caseName: project.case_name,
      evidenceId,
      custodian: custodianName,
      examiner: project.examiner_name,
      targetEmail: project.target_email,
      provider: project.provider_type,
      legalAuthority: project.legal_authority,
      legalScope: project.legal_scope,
      projectCreated: project.created_at,
    },
    evidenceSummary: {
      totalMessages: messages.length,
      totalAttachments: messages.reduce((sum, m) => sum + (m.attachment_count || 0), 0),
      totalSize: messages.reduce((sum, m) => sum + (m.size || 0), 0),
      dateRange: messages.length > 0 ? {
        earliest: messages.reduce((min, m) => m.date && m.date < min ? m.date : min, messages[0]?.date || ''),
        latest: messages.reduce((max, m) => m.date && m.date > max ? m.date : max, messages[0]?.date || ''),
      } : null,
      hashAlgorithms: ['MD5', 'SHA-256', 'SHA-512'],
      messagesWithHash: messages.filter(m => m.hash_sha256).length,
    },
    acquisitionHistory: acquisitions.map(a => ({
      id: a.id,
      status: a.status,
      started: a.started_at,
      completed: a.completed_at,
      totalMessages: a.total_messages,
      acquiredMessages: a.acquired_messages,
      failedMessages: a.failed_messages,
      totalBytes: a.total_bytes,
    })),
    custodyChain: custodyEvents,
    auditIntegrity: {
      totalEntries: auditLog.length,
      chainValid: chainVerification.valid,
      breaks: chainVerification.breaks,
      hashAlgorithm: 'SHA-256',
      standard: 'NIST SP 800-86 compliant hash chain',
    },
    exportHistory: exports.map(e => ({
      id: e.id,
      format: e.format,
      started: e.started_at,
      completed: e.completed_at,
      messageCount: e.message_count,
      totalBytes: e.total_bytes,
      hash: e.hash_sha256,
    })),
    timestampRecords: trustedTimestamps.filter(t => t.status === 'verified').length,
    trustedTimestamps: trustedTimestamps.map(t => Rfc3161TimestampService.summarize(t)),
    legacyInternalRecords: getTimestampRecords(project.id).length,
    standards: {
      collection: 'ISO/IEC 27037:2012 — Identification, collection, acquisition, preservation',
      hashing: 'NIST FIPS 180-4 (SHA-256/SHA-512)',
      auditTrail: 'NIST SP 800-86 — Guide to Integrating Forensic Techniques',
      bestPractices: 'SWGDE 18-F-002-2.0 (2025) — Best Practices for Digital Evidence Collection',
      cloudEvidence: 'SWGDE 23-F-004-1.1 — Digital Evidence from Cloud Service Providers',
      principles: 'ACPO Good Practice Guide v5 (2012) — Four Principles for Digital Evidence',
      timestamping: 'RFC 3161 tokens from an external Timestamp Authority, verified on receipt',
      admissibility: 'FRE 901(b)(9) — Process or System Producing Accurate Result',
      authentication: 'FRE 902(14) — Certified Data from Electronic Process',
      eDiscovery: 'EDRM Collection Standards — Repeatable processes with documented risks',
    },
    certification: {
      statement: `I certify that the evidence described in this report was collected, preserved, and maintained in accordance with forensic best practices. The chain of custody was maintained throughout the process, and the integrity of the evidence can be verified using the hash values and audit trail documented herein.`,
      examiner: project.examiner_name,
      date: new Date().toISOString(),
    },
  };

  addAuditEntry(req.params.id, 'CUSTODY_REPORT_GENERATED', 'Chain of custody report generated', {
    messageCount: messages.length, auditEntries: auditLog.length, chainValid: chainVerification.valid,
  }, project.examiner_name);

  res.json(report);
});

// ── Export ──
router.get('/export/formats', (req, res) => {
  res.json(ExportService.getFormats());
});

const EXPORT_FORMATS = new Set(Object.keys(ExportService.getFormats()).filter(f => ExportService.getFormats()[f].available !== false));

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// Shared by the Export tab and the automatic export at the end of a collection.
// PST parts are split at this size (GB); Outlook's own default ceiling for a Unicode PST is 50 GB.
function pstSizeGb(value) {
  const gb = parseFloat(value);
  return Number.isFinite(gb) && gb > 0 ? Math.min(gb, 100) : 10;
}

async function performExport(project, { format, outputDir: customOutputDir, pdfSplitMode, pstMaxGb, preserveFolders, messages: only, label, onProgress }) {
  const exportPathError = notFullPathError(customOutputDir, 'the export folder');
  if (exportPathError) throw new Error(exportPathError);
  if (!EXPORT_FORMATS.has(format)) throw httpError(400, `Unknown export format: ${format}`);
  const messages = only || getAllProjectMessages(project.id);
  if (messages.length === 0) throw httpError(400, 'No messages to export. Collect messages first.');

  const folders = getFolders(project.id);
  const exportId = crypto.randomUUID();
  const acquisitions = getAcquisitions(project.id);
  const options = { provider: project.provider_type || 'Unknown', preserveFolders, project, acquisition: acquisitions[0] || {} };
  if (pdfSplitMode) options.pdfSplitMode = pdfSplitMode;
  if (format === 'pst') { options.pstMaxGb = pstSizeGb(pstMaxGb); options.onProgress = onProgress; }
  if (format === 'pdf') {
    options.attachmentsByMessage = new Map();
    for (const a of getProjectAttachments(project.id)) {
      if (!options.attachmentsByMessage.has(a.message_id)) options.attachmentsByMessage.set(a.message_id, []);
      options.attachmentsByMessage.get(a.message_id).push(a);
    }
  }
  const { files, manifest, outputDir, reconstructed, failed = [], verificationFailures = [] } = await ExportService.exportToFiles(project.id, exportId, format, messages, folders, customOutputDir, options);
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);

  saveExportRecord(project.id, format, outputDir, messages.length - failed.length, totalBytes, manifest.manifestHash);
  updateProjectStatus(project.id, 'exported');

  const stamp = await TimestampService.timestampExport(project.id, outputDir);
  saveRfc3161Timestamp(stamp);
  const timestamp = Rfc3161TimestampService.summarize(stamp);
  addAuditEntry(project.id, stamp.status === 'verified' ? 'RFC3161_TIMESTAMP' : 'RFC3161_TIMESTAMP_FAILED',
    stamp.status === 'verified' ? `Export manifest timestamped by ${stamp.tsaName} at ${stamp.genTime}` : `Export manifest could not be timestamped: ${stamp.error}`,
    { exportId, format, targetHash: stamp.targetHash, targetFile: stamp.targetFile, tsa: stamp.tsaUrl, status: stamp.status, genTime: stamp.genTime || null, serialNumber: stamp.serialNumber || null, error: stamp.error || null, attempts: stamp.attempts },
    project.examiner_name);

  addAuditEntry(project.id, 'EXPORT_COMPLETED', `${label ? `${label}: ` : ''}Exported ${messages.length - failed.length} of ${messages.length} messages to ${format.toUpperCase()}${reconstructed?.length ? ` (${reconstructed.length} reconstructed: original file missing or altered)` : ''}${failed.length ? `; ${failed.length} not exported (see export_failed_items.csv)` : ''}${verificationFailures.length ? `; ${verificationFailures.length} file(s) FAILED read-back verification` : ''}`, {
    exportId, format, outputDir, messageCount: messages.length, totalBytes,
    manifestHash: manifest.manifestHash,
    reconstructed: reconstructed || [],
    failed, verificationFailures,
    fileHashes: files.map(f => ({ filename: f.relativePath || f.filename, md5: f.md5, sha1: f.sha1, sha256: f.hash })),
    timestamp: stamp.genTime || null,
  }, project.examiner_name);
  await notifyByEmail(project, 'export_complete', { format, messages: messages.length - failed.length, failed: failed.length, outputDir });

  return {
    exportId,
    format,
    files: files.map(f => ({
      filename: f.relativePath || f.filename,
      size: f.size,
      hash: f.hash,
      // Exports to a chosen folder live there; only those in the data folder can be fetched by link.
      downloadUrl: customOutputDir ? null : `/api/projects/${project.id}/exports/${exportId}/files/${encodeURIComponent(f.relativePath || f.filename)}`,
    })),
    manifest,
    messageCount: messages.length,
    totalBytes,
    outputDir,
    reconstructedCount: reconstructed?.length || 0,
    failedCount: failed.length,
    failed: failed.slice(0, 100),
    verificationFailures,
    timestamp,
  };
}

router.post('/projects/:id/export', async (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (activeCollections.has(project.id)) return res.status(409).json({ error: 'Wait for the running collection to finish before exporting' });
  try {
    res.json(await performExport(project, {
      format: req.body.format, outputDir: req.body.outputDir, pdfSplitMode: req.body.pdfSplitMode, pstMaxGb: req.body.pstMaxGb, preserveFolders: req.body.preserveFolders,
    }));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get('/projects/:id/exports', (req, res) => {
  res.json(getExportRecords(req.params.id));
});

// ── File Download ──
router.get('/projects/:id/exports/:exportId/files/:filename', (req, res) => {
  const exportDir = path.resolve(DATA_DIR, 'exports', req.params.id, req.params.exportId);
  const filePath = path.resolve(exportDir, req.params.filename);
  if (!filePath.startsWith(exportDir + path.sep)) return res.status(400).json({ error: 'Invalid file name' });
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return res.status(404).json({ error: 'File not found' });
  res.download(filePath);
});

router.get('/projects/:id/exports/:exportId/download-all', (req, res) => {
  const dir = path.join(DATA_DIR, 'exports', req.params.id, req.params.exportId);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Export not found' });

  const walk = (rel) => fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap(e => {
    const name = path.join(rel, e.name);
    return e.isDirectory() ? walk(name) : [name];
  });
  const files = walk('').map(f => ({
    filename: f,
    size: fs.statSync(path.join(dir, f)).size,
    downloadUrl: `/api/projects/${req.params.id}/exports/${req.params.exportId}/files/${encodeURIComponent(f)}`,
  }));

  res.json({ exportId: req.params.exportId, files });
});

// ── Audit Log ──
router.get('/projects/:id/audit', (req, res) => {
  res.json(getAuditLog(req.params.id));
});

router.get('/audit', (req, res) => {
  res.json(getFullAuditLog());
});

// ── Evidence Integrity Verification ──
function sha256OfFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath).on('error', reject).on('data', c => hash.update(c)).on('end', () => resolve(hash.digest('hex')));
  });
}

// Re-hashes each collected file and compares it with the SHA-256 recorded at collection.
router.get('/projects/:id/verify', async (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const messages = getAllProjectMessages(req.params.id);
  const auditLog = getAuditLog(req.params.id);
  const exports = getExportRecords(req.params.id);
  const timestamps = getRfc3161Timestamps(req.params.id).filter(t => t.status === 'verified');

  const messageVerification = [];
  for (let i = 0; i < messages.length; i += 16) {
    messageVerification.push(...await Promise.all(messages.slice(i, i + 16).map(async (m) => {
      const recorded = m.hash_sha256 || '';
      const row = { id: m.id, subject: m.subject || '(no subject)', from: m.from_address, date: m.date, file: m.eml_path || null, recordedHash: recorded, currentHash: null };
      if (!recorded) return { ...row, status: 'no_hash' };
      if (!m.eml_path) return { ...row, status: 'no_file' };
      try {
        row.currentHash = await sha256OfFile(m.eml_path);
        return { ...row, status: row.currentHash === recorded ? 'verified' : 'modified' };
      } catch (err) {
        return { ...row, status: err.code === 'ENOENT' ? 'missing' : 'unreadable', error: err.message };
      }
    })));
  }
  const countStatus = s => messageVerification.filter(m => m.status === s).length;

  const chainVerification = verifyAuditChain(auditLog);

  const exportVerification = [];
  for (const exp of exports) {
    if (exp.output_dir && fs.existsSync(exp.output_dir)) {
      const result = await ExportService.verifyExport(exp.output_dir);
      exportVerification.push({ exportId: exp.id, format: exp.format, ...result });
    } else {
      exportVerification.push({ exportId: exp.id, format: exp.format, valid: false, error: 'Export directory not found' });
    }
  }

  const verification = {
    timestamp: new Date().toISOString(),
    toolVersion: '0.10.0',
    projectId: req.params.id,
    projectName: project.name,
    examiner: project.examiner_name,
    messageCount: messages.length,
    hashVerification: {
      algorithm: 'SHA-256',
      method: 'Each collected file re-read and re-hashed, compared with the hash recorded at collection',
      total: messages.length,
      preserved: countStatus('verified'),
      verified: countStatus('verified'),
      modified: countStatus('modified'),
      missing: countStatus('missing') + countStatus('unreadable'),
      noFile: countStatus('no_file'),
      noHash: countStatus('no_hash'),
      details: messageVerification,
    },
    auditLogIntegrity: {
      totalEntries: auditLog.length,
      chainVerified: chainVerification,
    },
    exportIntegrity: exportVerification,
    timestampRecords: timestamps.length,
    standards: {
      hashAlgorithm: 'SHA-256 (NIST FIPS 180-4)',
      auditStandard: 'NIST SP 800-86',
      evidenceHandling: 'ISO/IEC 27037:2012',
      bestPractices: 'SWGDE 18-F-002-2.0 (2025)',
      principles: 'ACPO Good Practice Guide v5 (2012)',
      legalStandard: 'FRE 901(b)(9) / FRE 902(14)',
      timestampStandard: 'RFC 3161 tokens from an external Timestamp Authority',
    },
  };

  addAuditEntry(req.params.id, 'INTEGRITY_VERIFIED', `Evidence integrity verification: ${countStatus('verified')} of ${messages.length} files verified, ${countStatus('modified')} modified, ${countStatus('missing') + countStatus('unreadable')} missing; audit chain ${chainVerification.valid ? 'intact' : 'BROKEN'}`, {
    messageCount: messages.length,
    verified: countStatus('verified'),
    modified: countStatus('modified'),
    missing: countStatus('missing') + countStatus('unreadable'),
    chainValid: chainVerification.valid,
    exportsVerified: exportVerification.filter(e => e.valid).length,
    timestamps: timestamps.length,
  }, project.examiner_name);

  res.json(verification);
});

// ══════════════════════════════════════════════════════════════
// ── CATEGORY 1: Forensic Integrity (Features 1-3) ──
// ══════════════════════════════════════════════════════════════

// Feature 1: RFC 3161 Trusted Timestamping
router.get('/rfc3161/tsas', (req, res) => {
  res.json(Rfc3161TimestampService.getAvailableTSAs());
});

router.post('/projects/:id/rfc3161/timestamp', async (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const { targetType, targetHash, tsaUrl, hashAlgorithm } = req.body;
    if (!targetHash || !tsaUrl) return res.status(400).json({ error: 'targetHash and tsaUrl required' });
    const result = await Rfc3161TimestampService.requestTimestamp(targetHash, tsaUrl, { hashAlgorithm });
    result.projectId = req.params.id;
    result.targetType = targetType || 'manual';
    saveRfc3161Timestamp(result);
    addAuditEntry(req.params.id, result.status === 'verified' ? 'RFC3161_TIMESTAMP' : 'RFC3161_TIMESTAMP_FAILED', result.status === 'verified' ? `RFC 3161 timestamp from ${result.tsaName} at ${result.genTime}` : `RFC 3161 timestamp from ${result.tsaName} failed: ${result.error}`, { tsaUrl, targetType, targetHash, status: result.status, genTime: result.genTime || null, serialNumber: result.serialNumber || null, error: result.error || null }, project.examiner_name);
    res.json({ ...Rfc3161TimestampService.summarize(result), timestampToken: result.timestampToken || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/projects/:id/rfc3161/timestamps', (req, res) => {
  res.json(getRfc3161Timestamps(req.params.id));
});

router.get('/rfc3161/info', (req, res) => {
  res.json(Rfc3161TimestampService.getInfo());
});

// Feature 2: Multi-Algorithm Hashing
router.post('/hash/compute', (req, res) => {
  try {
    const { data, algorithms } = req.body;
    if (!data) return res.status(400).json({ error: 'data required' });
    const result = algorithms ? HashManager.computeSelected(data, algorithms) : HashManager.computeAll(data);
    res.json(result);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/hash/verify', (req, res) => {
  try {
    const { data, expectedHashes } = req.body;
    if (!data || !expectedHashes) return res.status(400).json({ error: 'data and expectedHashes required' });
    res.json(HashManager.verify(data, expectedHashes));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.get('/hash/algorithms', (req, res) => {
  res.json(HashManager.getAlgorithmInfo());
});

// Feature 3: Folder Snapshots
router.post('/projects/:id/snapshots', async (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const { snapshotType, acquisitionId, config } = req.body || {};
  if (!config) return res.status(400).json({ error: 'A snapshot reads the mailbox live: send the connection to use. Collections take their own snapshots before and after automatically.' });
  let handler = null;
  try {
    handler = await createHandler(config.protocol || project.provider_type, config, project);
    await handler.connect();
    const folders = await listHandlerFolders(handler);
    if (!folders) return res.status(400).json({ error: 'POP3 has no folders to take a snapshot of' });
    const snapshot = FolderSnapshotService.captureSnapshot(req.params.id, folders, acquisitionId, snapshotType || 'manual');
    saveFolderSnapshot(snapshot);
    addAuditEntry(req.params.id, 'FOLDER_SNAPSHOT', `Folder snapshot captured (${snapshot.totalFolders} folders, ${snapshot.totalMessages} messages)`, { snapshotType: snapshotType || 'manual', totalFolders: snapshot.totalFolders, hash: snapshot.hashSha256 }, project.examiner_name);
    res.json(snapshot);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await handler?.disconnect?.().catch(() => {});
  }
});

router.get('/projects/:id/snapshots', (req, res) => {
  res.json(getFolderSnapshots(req.params.id));
});

router.post('/projects/:id/snapshots/compare', (req, res) => {
  try {
    const snapshots = getFolderSnapshots(req.params.id);
    const { firstId, secondId } = req.body || {};
    // Newest first in the list: by default, the latest snapshot against the one before it.
    const post = secondId ? snapshots.find(x => x.id === secondId) : snapshots[0];
    const pre = firstId ? snapshots.find(x => x.id === firstId) : snapshots[1];
    if (!pre || !post) return res.status(400).json({ error: 'Need 2 snapshots to compare' });
    res.json(FolderSnapshotService.compareSnapshots(pre, post));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════
// ── CATEGORY 2: Protocol & Provider Coverage (Features 4-9) ──
// ══════════════════════════════════════════════════════════════

// Feature 4: Yahoo OAuth
router.get('/oauth/yahoo/status', (req, res) => { res.json(yahooGetAuthStatus()); });
router.post('/oauth/yahoo/credentials', (req, res) => {
  if (!hasText(req.body?.clientId || req.body?.client_id) || !hasText(req.body?.clientSecret || req.body?.client_secret)) return res.status(400).json({ error: 'A client ID and client secret are required' });
  try { yahooSaveCredentials(req.body); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
router.get('/oauth/yahoo/authorize', async (req, res) => {
  try {
    await yahooStartCallbackServer();
    const url = yahooGetAuthUrl();
    if (!url) return res.status(400).json({ error: 'Yahoo OAuth credentials not configured' });
    res.json({ url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.get('/oauth/yahoo/wait', async (req, res) => {
  try { const result = await yahooWaitForAuth(); yahooStopCallbackServer(); res.json(result); }
  catch (err) { yahooStopCallbackServer(); res.status(500).json({ error: err.message }); }
});
router.post('/oauth/yahoo/revoke', (req, res) => { res.json(yahooRevokeTokens()); });

// Feature 5: Enterprise App-Only Auth + Feature 9: Azure Sovereign Clouds
router.get('/enterprise/azure-environments', (req, res) => {
  res.json(EnterpriseAuthService.getAzureEnvironments());
});

router.post('/enterprise/authenticate', async (req, res) => {
  try {
    const { method } = req.body;
    const result = method === 'certificate' ? await EnterpriseAuthService.authenticateWithCertificate(req.body) : await EnterpriseAuthService.authenticateAppOnly(req.body);
    res.json(result);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Feature 8: Remote Token Import
router.post('/enterprise/import-token', (req, res) => {
  try {
    res.json(EnterpriseAuthService.importToken(req.body.tokenData || req.body));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Feature 6: Exchange Advanced Features. Each opens its own read-only EWS session with the connection sent.
async function withEws(req, res, work) {
  const project = req.params.id ? getProject(req.params.id) : null;
  if (req.params.id && !project) return res.status(404).json({ error: 'Project not found' });
  const config = req.body?.config;
  if (!config) return res.status(400).json({ error: 'Send the Exchange connection to use (config)' });
  let handler = null;
  try {
    handler = await createHandler('ews', config, project);
    await handler.connect();
    const email = config.targetUser || config.email || project?.target_email;
    const result = await work(handler, email);
    if (project) addAuditEntry(project.id, 'EXCHANGE_INSPECTED', `Exchange ${req.path.split('/').pop()} read`, { email, error: result.error || null }, project.examiner_name);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await handler?.disconnect?.().catch(() => {});
  }
}

router.post('/projects/:id/exchange/recoverable-items', (req, res) => withEws(req, res, (h, email) => ExchangeAdvancedService.getRecoverableItems(h, email, req.body)));
router.post('/projects/:id/exchange/public-folders', (req, res) => withEws(req, res, h => ExchangeAdvancedService.getPublicFolders(h)));
router.post('/projects/:id/exchange/archive', (req, res) => withEws(req, res, (h, email) => ExchangeAdvancedService.getArchiveMailbox(h, email)));
router.post('/projects/:id/exchange/inbox-rules', (req, res) => withEws(req, res, (h, email) => ExchangeAdvancedService.getInboxRules(h, email)));
router.post('/exchange/detect-version', (req, res) => withEws(req, res, h => ExchangeAdvancedService.detectExchangeVersion(h)));

// Feature 7: Local File Import (MBOX/PST/EML)
router.post('/projects/:id/import', async (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (activeCollections.has(project.id)) return res.status(409).json({ error: 'Wait for the running collection to finish before importing' });
  const { filePath, format, targetFolder, unquoteMbox } = req.body || {};
  if (!filePath) return res.status(400).json({ error: 'Choose the file or folder to import' });
  if (!fs.existsSync(filePath)) return res.status(400).json({ error: `Not found: ${filePath}` });

  const isDirectory = fs.statSync(filePath).isDirectory();
  const ext = (format || (isDirectory ? 'eml' : path.extname(filePath).slice(1))).toLowerCase();
  const kind = { mbox: 'mbox', mbx: 'mbox', pst: 'pst', ost: 'pst', eml: 'eml' }[ext];
  if (!kind) return res.status(400).json({ error: `Unsupported format: ${ext || 'unknown'}. Supported: mbox, pst, eml` });

  const importId = `${kind}_${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const outputDir = path.join(DATA_DIR, 'imports', project.id, importId);
  const acquisitionId = createAcquisition(project.id, [filePath], { scope: 'import', protocol: 'import', outputDir, examiner: project.examiner_name });
  const options = { targetFolder: targetFolder || undefined, outputDir, acquisitionId, format: kind, unquoteMbox, save: batch => saveMessagesBatch(batch) };
  try {
    const result = kind === 'pst' ? await LocalImportService.importPst(filePath, project.id, options) : await LocalImportService.importMail(filePath, project.id, options);
    const collected = getAllProjectMessages(project.id).filter(m => m.acquisition_id === acquisitionId);
    const totalBytes = collected.reduce((sum, m) => sum + (m.size || 0), 0);
    const status = !result.successful && (result.failed || result.folderErrors) ? 'failed' : (result.failed || result.folderErrors) ? 'completed_with_errors' : 'completed';
    const completionType = status === 'completed' ? 'completed_without_errors' : status === 'failed' ? 'fatal_error' : 'completed_with_errors_remaining_items';
    updateAcquisition(acquisitionId, {
      status, completionType, sessionDir: outputDir, totalMessages: result.totalParsed, acquiredMessages: result.successful,
      failedMessages: result.failed, skippedMessages: 0, totalBytes, errorLog: result.errors?.length ? result.errors : null,
    });
    updateProjectStatus(project.id, status === 'failed' ? 'failed' : 'completed');
    addAuditEntry(project.id, kind === 'pst' ? 'PST_IMPORTED' : 'LOCAL_IMPORT', `Imported ${result.successful} messages from ${path.basename(filePath)}${result.failed ? ` (${result.failed} could not be read)` : ''}${kind === 'pst' ? '; rebuilt as EML from PST properties' : ''}`, {
      source: filePath, format: kind, sourceSha256: result.sourceSha256 || null, sourceUnchanged: result.sourceUnchanged, outputDir, acquisitionId,
      pstFormat: result.pstFormat, displayName: result.displayName, passwordProtected: result.passwordProtected,
      successful: result.successful, failed: result.failed, folderErrors: result.folderErrors, errors: result.errors,
    }, project.examiner_name, acquisitionId);
    res.json({ ...result, acquisitionId, status });
  } catch (err) {
    updateAcquisition(acquisitionId, { status: 'failed', completionType: 'fatal_error', errorLog: [{ error: err.message }] });
    addAuditEntry(project.id, 'IMPORT_FAILED', `Import of ${path.basename(filePath)} failed: ${err.message}`, { source: filePath, format: kind, acquisitionId }, project.examiner_name, acquisitionId);
    res.status(500).json({ error: err.message });
  }
});

router.get('/import/formats', (req, res) => {
  res.json(LocalImportService.getSupportedFormats());
});

// ══════════════════════════════════════════════════════════════
// ── CATEGORY 3: Cloud & Drive Collection (Features 10-15) ──
// ══════════════════════════════════════════════════════════════

// The saved sign-in is used unless a token is sent; "accessToken" in a URL would end up in logs.
const googleToken = req => req.body?.accessToken || getGoogleAccessToken();
const microsoftToken = req => {
  if (req.body?.enterpriseSessionId) {
    const session = EnterpriseAuthService.getSession(req.body.enterpriseSessionId);
    return session.tokenFor(session.graphEndpoint);
  }
  return req.body?.accessToken || msGetAccessToken();
};

// Listings are read-only and saved to the project, with the raw response in a hashed file where it is evidence.
function projectOr404(req, res) {
  const project = getProject(req.params.id);
  if (!project) res.status(404).json({ error: 'Project not found' });
  return project;
}

function saveRawListing(project, kind, raw) {
  const dir = path.join(DATA_DIR, 'projects', project.id, 'cloud');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${kind}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const text = JSON.stringify(raw, null, 2);
  fs.writeFileSync(file, text);
  return { file, sha256: crypto.createHash('sha256').update(text).digest('hex') };
}

const cloudRoute = (work) => async (req, res) => {
  const project = projectOr404(req, res);
  if (!project) return;
  try {
    res.json(await work(project, req));
  } catch (err) {
    res.status(err.status === 401 || err.status === 403 ? 403 : 500).json({ error: err.status === 403 ? `${err.message}. This sign-in may need the extra permission for this data: sign in again with it.` : err.message });
  }
};

function saveListedDriveItems(project, items) {
  const known = new Map(getDriveItems(project.id).map(d => [d.remote_id, d]));
  for (const item of items) {
    if (known.has(item.remoteId)) continue; // a collected file's record is not overwritten by a later listing
    item.projectId = project.id;
    saveDriveItem(item);
  }
}

// Feature 10: Google Drive Collection
router.post('/projects/:id/drive/google/items', cloudRoute(async (project, req) => {
  const result = await CloudCollectionService.listGoogleDriveItems(await googleToken(req), req.body || {});
  saveListedDriveItems(project, result.items);
  return result;
}));
router.post('/projects/:id/drive/google/shared-drives', cloudRoute(async (project, req) => CloudCollectionService.listGoogleSharedDrives(await googleToken(req))));
router.post('/projects/:id/drive/google/revisions/:fileId', cloudRoute(async (project, req) => CloudCollectionService.getGoogleDriveRevisions(await googleToken(req), req.params.fileId)));

// Feature 11: OneDrive Collection
router.post('/projects/:id/drive/onedrive/items', cloudRoute(async (project, req) => {
  const result = await CloudCollectionService.listOneDriveItems(await microsoftToken(req), req.body || {});
  saveListedDriveItems(project, result.items);
  return result;
}));
router.post('/projects/:id/drive/onedrive/revisions/:itemId', cloudRoute(async (project, req) => CloudCollectionService.getOneDriveRevisions(await microsoftToken(req), req.params.itemId, req.body?.userId)));

// Feature 12: SharePoint Collection
router.post('/projects/:id/drive/sharepoint/sites', cloudRoute(async (project, req) => CloudCollectionService.listSharePointSites(await microsoftToken(req), req.body?.search)));
router.post('/projects/:id/drive/sharepoint/documents/:siteId', cloudRoute(async (project, req) => CloudCollectionService.listSharePointDocuments(await microsoftToken(req), req.params.siteId, req.body || {})));

// Feature 13: Google Calendar Collection
router.post('/projects/:id/calendar/events', cloudRoute(async (project, req) => {
  const result = await CloudCollectionService.listGoogleCalendarEvents(await googleToken(req), req.body || {});
  const stored = saveRawListing(project, 'google_calendar', result.raw);
  for (const evt of result.events) { evt.projectId = project.id; saveCalendarEvent(evt); }
  addAuditEntry(project.id, 'CALENDAR_COLLECTED', `Collected ${result.events.length} calendar events`, { file: stored.file, sha256: stored.sha256, count: result.events.length }, project.examiner_name);
  return { events: result.events, file: stored.file, sha256: stored.sha256 };
}));

router.get('/projects/:id/calendar', (req, res) => {
  res.json(getCalendarEvents(req.params.id));
});

// Feature 14: Contact Collection
router.post('/projects/:id/contacts/google', cloudRoute(async (project, req) => {
  const result = await CloudCollectionService.listGoogleContacts(await googleToken(req));
  const stored = saveRawListing(project, 'google_contacts', result.raw);
  for (const c of result.contacts) { c.projectId = project.id; saveContact(c); }
  addAuditEntry(project.id, 'CONTACTS_COLLECTED', `Collected ${result.contacts.length} Google contacts`, { file: stored.file, sha256: stored.sha256, count: result.contacts.length }, project.examiner_name);
  return { contacts: result.contacts, file: stored.file, sha256: stored.sha256 };
}));

router.post('/projects/:id/contacts/microsoft', cloudRoute(async (project, req) => {
  const result = await CloudCollectionService.listMicrosoftContacts(await microsoftToken(req), req.body || {});
  const stored = saveRawListing(project, 'microsoft_contacts', result.raw);
  for (const c of result.contacts) { c.projectId = project.id; saveContact(c); }
  addAuditEntry(project.id, 'CONTACTS_COLLECTED', `Collected ${result.contacts.length} Microsoft contacts`, { file: stored.file, sha256: stored.sha256, count: result.contacts.length }, project.examiner_name);
  return { contacts: result.contacts, file: stored.file, sha256: stored.sha256 };
}));

router.get('/projects/:id/contacts', (req, res) => {
  res.json(getContacts(req.params.id));
});

// Feature 15: Cloud Attachment Download Pipeline. The same verified downloader a collection uses, over
// every message of the project; every link not downloaded is listed with the reason.
router.post('/projects/:id/cloud-attachments/download', async (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (activeCollections.has(project.id)) return res.status(409).json({ error: 'Wait for the running collection to finish' });
  const outDir = path.join(DATA_DIR, 'projects', project.id, 'linked_files', new Date().toISOString().replace(/[:.]/g, '-'));
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const log = [];
    const known = new Map();
    const result = await collectLinkedFiles({
      messages: getAllProjectMessages(project.id), outDir, progress: {}, log: line => log.push(line),
      onRecord: r => {
        for (const m of r.messages) {
          const key = `${m.id}|${r.url}`;
          if (known.has(key)) continue;
          known.set(key, true);
          saveDriveLink({ id: crypto.randomUUID(), projectId: project.id, messageId: m.id, provider: r.provider, url: r.url, fileId: r.fileId, status: r.status, downloadedAt: r.downloadedAt, localPath: r.localPath, size: r.size, sha256: r.sha256 });
        }
        saveCloudDownload({
          id: r.id, projectId: project.id, provider: r.provider, remoteUrl: r.url, fileName: r.name, fileSize: r.size, mimeType: r.mimeType,
          stage: r.status, localPath: r.localPath, hashMd5: r.md5, hashSha1: r.sha1, hashSha256: r.sha256,
          error: r.status === 'downloaded' ? null : r.reason, startedAt: r.downloadedAt, completedAt: r.downloadedAt,
        });
      },
    });
    const manifest = writeLinkedFilesManifest(outDir, new Date().toISOString().replace(/[:.]/g, '-'), result);
    addAuditEntry(project.id, 'CLOUD_ATTACHMENTS_DOWNLOADED', `Linked cloud files: ${result.stats.found} found, ${result.stats.downloaded} downloaded (${result.stats.verified} verified), ${result.stats.notDownloaded} not downloaded, ${result.stats.failed} failed`, { stats: result.stats, manifest }, project.examiner_name);
    res.json({
      stats: result.stats, outputDir: outDir, manifest,
      notDownloaded: result.records.filter(r => !['downloaded', 'hash_mismatch'].includes(r.status)).slice(0, 100).map(r => ({ provider: r.providerLabel, url: r.url, name: r.name || null, reason: r.reason })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/projects/:id/cloud-downloads', (req, res) => {
  res.json(getCloudDownloads(req.params.id));
});

// Drive items listing
router.get('/projects/:id/drive-items', (req, res) => {
  res.json(getDriveItems(req.params.id, req.query.provider));
});

// ══════════════════════════════════════════════════════════════
// ── CATEGORY 4: Export & Containerization (Features 16-20) ──
// ══════════════════════════════════════════════════════════════

// Feature 16: VHDX Container Export
router.post('/projects/:id/export/vhdx', async (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (activeCollections.has(project.id)) return res.status(409).json({ error: 'Wait for the running collection to finish before packaging' });
  try {
    // By default the latest export; any folder can be chosen.
    const sourceDir = req.body?.sourceDir || getExportRecords(project.id)[0]?.output_dir;
    if (!sourceDir) return res.status(400).json({ error: 'Nothing to package: run an export first, or choose a folder' });
    if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) return res.status(400).json({ error: `Folder not found: ${sourceDir}` });
    const name = `${(project.name || 'evidence').replace(/[^\w.-]+/g, '_')}_${new Date().toISOString().replace(/[:.]/g, '-')}.vhdx`;
    const vhdxPathError = notFullPathError(req.body?.outputPath, 'the image file') || notFullPathError(req.body?.outputDir, 'the image folder');
    if (vhdxPathError) return res.status(400).json({ error: vhdxPathError });
    const outputPath = req.body?.outputPath || path.join(req.body?.outputDir || path.join(DATA_DIR, 'containers', project.id), name);
    const result = await ContainerService.createVhdxContainer(sourceDir, outputPath, { label: project.case_id || project.name });
    addAuditEntry(project.id, 'VHDX_CREATED', `VHDX container created from ${sourceDir} (${result.fileCount} files, ${result.size} bytes)`, { sourceDir, outputPath, hashes: result.hashes, contentsManifest: result.contentsManifest }, project.examiner_name);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Feature 17: PST Writer. The project's messages as PST (the same export as format "pst").
router.post('/projects/:id/export/pst-create', async (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (activeCollections.has(project.id)) return res.status(409).json({ error: 'Wait for the running collection to finish before exporting' });
  try {
    res.json(await performExport(project, { format: 'pst', outputDir: req.body.outputDir, pstMaxGb: req.body.pstMaxGb }));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// EML files and MBOX mailboxes on disk converted to PST. The sources are only read; the PSTs, an item
// map and a hash manifest go to the output folder. Recorded in a project's audit log when one is given.
router.post('/convert/pst', async (req, res) => {
  const inputs = [].concat(req.body.inputs || req.body.input || []).filter(p => typeof p === 'string' && p.trim()).map(p => path.resolve(p.trim()));
  if (!inputs.length) return res.status(400).json({ error: 'Choose a folder or file of EML/MBOX messages to convert' });
  const convertPathError = notFullPathError(req.body.outputDir, 'the output folder');
  if (convertPathError) return res.status(400).json({ error: convertPathError });
  const outputDir = req.body.outputDir ? path.resolve(req.body.outputDir) : path.join(DATA_DIR, 'conversions', `pst_${new Date().toISOString().replace(/[:.]/g, '-')}`);
  for (const input of inputs) {
    const rel = path.relative(input, outputDir);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return res.status(400).json({ error: 'The output folder cannot be inside the source folder' });
  }
  const project = req.body.projectId ? getProject(req.body.projectId) : null;
  try {
    const result = await convertFilesToPst(inputs, {
      outputDir, baseName: (req.body.name || 'converted').replace(/[^\w.-]+/g, '_').slice(0, 60),
      displayName: req.body.name || 'Converted Mail', maxBytes: pstSizeGb(req.body.pstMaxGb) * 1024 ** 3, unquoteMbox: req.body.unquoteMbox !== false,
    });
    const map = itemMapCsv(result.items);
    fs.writeFileSync(path.join(outputDir, 'pst_item_map.csv'), map, 'utf8');
    const files = [...result.files, { filename: 'pst_item_map.csv', size: Buffer.byteLength(map), hash: crypto.createHash('sha256').update(map).digest('hex') }];
    if (result.failed.length) {
      const failText = result.failed.map(f => `${f.source}\t${f.error}`).join('\r\n') + '\r\n';
      fs.writeFileSync(path.join(outputDir, 'pst_failed_items.txt'), failText, 'utf8');
      files.push({ filename: 'pst_failed_items.txt', size: Buffer.byteLength(failText), hash: crypto.createHash('sha256').update(failText).digest('hex') });
    }
    const manifest = ExportService.generateHashManifest(files, [], { emailsFailed: result.failed.length });
    fs.writeFileSync(path.join(outputDir, 'manifest.txt'), manifest.text, 'utf8');
    if (project) {
      addAuditEntry(project.id, 'PST_CONVERTED', `Converted ${result.items.length} messages from ${inputs.length} location(s) to ${result.files.length} PST file(s)${result.failed.length ? ` (${result.failed.length} failed)` : ''}`, {
        inputs, outputDir, messageCount: result.items.length, failed: result.failed.slice(0, 50), files: files.map(f => ({ filename: f.filename, sha256: f.hash, size: f.size })), manifestHash: manifest.manifestHash,
      }, project.examiner_name);
    }
    res.json({
      outputDir, messageCount: result.items.length, sourceCount: result.sourceCount, failedCount: result.failed.length, failed: result.failed.slice(0, 50),
      files: files.map(f => ({ filename: f.filename, size: f.size, hash: f.hash, messageCount: f.messageCount })), manifestHash: manifest.manifestHash,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Feature 18: History Report
router.get('/projects/:id/reports/history', (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const auditLog = getAuditLog(req.params.id);
    const acquisitions = getAcquisitions(req.params.id);
    const exports = getExportRecords(req.params.id);
    const report = ReportService.generateHistoryReport(project, auditLog, acquisitions, exports);
    if (req.query.save === 'true') {
      const outDir = path.join(DATA_DIR, 'reports', req.params.id);
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, report.filename), report.content);
      report.savedTo = path.join(outDir, report.filename);
    }
    addAuditEntry(project.id, 'HISTORY_REPORT', 'History report generated', { hash: report.hash, entries: auditLog.length }, project.examiner_name);
    res.json(report);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Feature 19: Revision Report
router.get('/projects/:id/reports/revisions', async (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const driveItems = getDriveItems(req.params.id).filter(d => d.item_type !== 'folder');
    // Read from the provider now, using the saved sign-in; a file that cannot be read is listed with the reason.
    const revisions = [];
    const notAvailable = [];
    let googleAccess = null;
    let msAccess = null;
    for (const item of driveItems) {
      try {
        let rows;
        if (item.provider === 'google_drive') {
          googleAccess = googleAccess || await getGoogleAccessToken();
          rows = await CloudCollectionService.getGoogleDriveRevisions(googleAccess, item.remote_id);
        } else {
          msAccess = msAccess || await msGetAccessToken();
          rows = await CloudCollectionService.getOneDriveRevisions(msAccess, item.remote_id);
        }
        for (const r of rows) revisions.push({ ...r, driveItemId: item.id });
      } catch (err) {
        notAvailable.push({ name: item.path || item.name, error: err.message });
      }
    }
    const report = ReportService.generateRevisionReport(project, driveItems, revisions, { notAvailable });
    if (req.query.save === 'true') {
      const outDir = path.join(DATA_DIR, 'reports', req.params.id);
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, report.filename), report.content);
      report.savedTo = path.join(outDir, report.filename);
    }
    addAuditEntry(project.id, 'REVISION_REPORT', `Revision report: ${revisions.length} revisions of ${driveItems.length} files${notAvailable.length ? `, ${notAvailable.length} not readable` : ''}`, { hash: report.hash, notAvailable: notAvailable.length }, project.examiner_name);
    res.json({ ...report, notAvailable });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Feature 20: Log Compression
router.post('/projects/:id/logs/compress', (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    // Logs sit with each collection (<session or destination>\\Logs), wherever that was.
    const sources = req.body?.logsDir
      ? [{ dir: req.body.logsDir, prefix: '' }]
      : getAcquisitions(project.id).filter(a => a.session_dir).map(a => ({ dir: path.join(a.session_dir, 'Logs'), prefix: `acquisition_${a.id.slice(0, 8)}` }));
    const outputPath = req.body?.outputPath || path.join(DATA_DIR, 'reports', project.id, `logs_${new Date().toISOString().replace(/[:.]/g, '-')}.zip`);
    const result = ReportService.compressLogs(project.id, sources, outputPath);
    if (result.compressed) addAuditEntry(project.id, 'LOGS_COMPRESSED', `${result.fileCount} log files compressed`, { outputPath, hash: result.hash }, project.examiner_name);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════
// ── CATEGORY 5: Search & Filtering (Features 21-23) ──
// ══════════════════════════════════════════════════════════════

// Feature 21: Pre-Acquisition Server-Side Search
// Asks the server how many items a query matches, without downloading anything: the same query and
// enumeration a collection uses, for protocols that can list; the provider's own search for the rest.
router.post('/projects/:id/search/pre-acquisition', async (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const { config, folders, query } = req.body || {};
  if (!config) return res.status(400).json({ error: 'Send the connection to search with (config)' });
  const protocol = config.protocol || project.provider_type;
  let handler = null;
  const saveAndAudit = (result) => {
    savePreAcquisitionSearch(result);
    addAuditEntry(project.id, 'PRE_ACQUISITION_SEARCH', result.error ? `Pre-acquisition search failed: ${result.error}` : `Pre-acquisition search: ${result.resultCount} matches`, { query, resultCount: result.resultCount, error: result.error || null }, project.examiner_name);
  };
  try {
    const normalized = normalizeQuery(query);
    const plan = planQuery(protocol, normalized);
    handler = await createHandler(protocol, config, project);
    await handler.connect();
    const result = { id: crypto.randomUUID(), projectId: project.id, criteria: query, protocol, uids: [], resultCount: 0, queryDescription: describeQuery(normalized), notes: plan.notes, unsupported: plan.unsupported.map(k => describeKeys([k])), checkedAfterDownload: plan.localKeys.length > 0 };
    if (supportsEngine(protocol)) {
      const targets = protocol === 'pop3' ? ['INBOX'] : (Array.isArray(folders) && folders.length ? folders : ['INBOX']);
      const { listings, folderErrors, duplicatesMerged } = await enumerateFolders({ primary: handler, folders: targets, searchCriteria: plan.server });
      result.resultCount = listings.reduce((sum, l) => sum + l.refs.length, 0);
      result.uids = listings.flatMap(l => l.refs.map(r => r.serviceId || r.uid));
      result.folders = listings.map(l => ({ folder: l.folder, items: l.refs.length }));
      result.duplicatesMerged = duplicatesMerged;
      if (folderErrors.length) {
        result.folderErrors = folderErrors.map(f => ({ folder: f.folder, error: f.error.message }));
        result.error = `${folderErrors.length} folder(s) could not be searched: ${folderErrors[0].folder}: ${folderErrors[0].error.message}`;
      }
    } else {
      const found = await handler.searchMessages({ keyword: normalized?.keywords?.join(' '), from: normalized?.from?.[0], subject: normalized?.subject?.[0], since: normalized?.dateFrom, before: normalized?.dateTo });
      result.resultCount = found.resultCount;
    }
    result.protocolLog = handler.getProtocolLog();
    saveAndAudit(result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await handler?.disconnect?.().catch(() => {});
  }
});

router.get('/projects/:id/search/pre-acquisition', (req, res) => {
  res.json(getPreAcquisitionSearches(req.params.id));
});

// Feature 22: Full-Text Index Search
router.post('/projects/:id/search/index', (req, res) => {
  try {
    const messages = getAllProjectMessages(req.params.id);
    let indexed = 0;
    clearSearchIndex(req.params.id);
    for (const msg of messages) {
      indexMessage(req.params.id, msg.id, {
        subject: msg.subject,
        body: msg.body_text,
        from: msg.from_address,
        to: msg.to_addresses,
        cc: msg.cc_addresses,
        folder: msg.folder,
      });
      indexed++;
    }
    res.json({ indexed, projectId: req.params.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/projects/:id/search/fulltext', (req, res) => {
  try {
    const { query, fields } = req.query;
    if (!query) return res.status(400).json({ error: 'query parameter required' });
    const fieldList = fields ? fields.split(',') : null;
    const messageIds = searchIndex(req.params.id, query, fieldList);
    const messages = messageIds.map(id => getMessage(id)).filter(Boolean);
    res.json({ query, resultCount: messages.length, messages });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Feature 23: Differential/Incremental Acquisition
router.get('/projects/:id/differential/plan', (req, res) => {
  try {
    const messages = getAllProjectMessages(req.params.id);
    const folders = getFolders(req.params.id);
    res.json(computeDifferentialPlan(messages, folders));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// What a differential collection would skip: the identifiers of everything already collected.
router.get('/projects/:id/differential/ids', (req, res) => {
  res.json(getProjectMessageKeys(req.params.id));
});

// ══════════════════════════════════════════════════════════════
// ── CATEGORY 6: Automation & Operations (Features 24-31) ──
// ══════════════════════════════════════════════════════════════

// Feature 24: SMTP Notifications
router.post('/notifications/smtp/settings', (req, res) => {
  try {
    const b = req.body || {};
    if (!b.host) return res.status(400).json({ error: 'SMTP host is required' });
    const to = Array.isArray(b.toAddresses) ? b.toAddresses : String(b.toAddresses || '').split(/[,;\s]+/).filter(Boolean);
    if (!to.length || !b.fromAddress) return res.status(400).json({ error: 'From and To addresses are required' });
    deleteSmtpSettings(b.projectId || null);
    const settings = {
      id: b.id || crypto.randomUUID(), projectId: b.projectId || null, host: b.host, port: Number(b.port) || 587, secure: !!b.secure, username: b.username || null,
      passwordEncrypted: encryptSecret(b.password), fromAddress: b.fromAddress, toAddresses: to,
      notifyOnComplete: b.notifyOnComplete !== false, notifyOnError: b.notifyOnError !== false, notifyOnExport: !!b.notifyOnExport,
    };
    saveSmtpSettings(settings);
    res.json({ success: true, id: settings.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/notifications/smtp/settings/:projectId', (req, res) => {
  const settings = getSmtpSettings(req.params.projectId);
  if (settings) { delete settings.password_encrypted; }
  res.json(settings || { configured: false });
});

router.post('/notifications/smtp/test', async (req, res) => {
  try {
    const b = req.body || {};
    const to = Array.isArray(b.toAddresses) ? b.toAddresses : String(b.toAddresses || '').split(/[,;\s]+/).filter(Boolean);
    const result = await AutomationService.sendNotification({ ...b, toAddresses: to }, {
      type: 'test',
      projectName: 'Test Notification',
      details: { message: 'This is a test notification from SherlockMail' },
    });
    res.status(result.success ? 200 : 502).json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Feature 25: CLI Commands Info
router.get('/cli/commands', (req, res) => {
  res.json(CLI_COMMANDS);
});

// Feature 26: Health Monitoring
router.get('/health', (req, res) => {
  res.json(AutomationService.checkHealth());
});

router.get('/health/disk', async (req, res) => {
  const targetPath = req.query.path || DATA_DIR;
  res.json(await AutomationService.checkDiskSpace(targetPath));
});

router.get('/projects/:id/health/events', (req, res) => {
  res.json(getHealthEvents(req.params.id));
});

// Feature 27: Acquisition Insights
router.get('/projects/:id/insights', (req, res) => {
  try {
    const messages = getAllProjectMessages(req.params.id);
    const acquisitions = getAcquisitions(req.params.id);
    const folders = getFolders(req.params.id);
    res.json(AutomationService.generateInsights(messages, acquisitions, folders));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Feature 28: Multi-Target Acquisition
// Creates one project per mailbox and, when "start" is set, collects them one after another. Passwords in a
// target's config stay in memory for the run; the saved record has none.
router.post('/acquisitions/batch', async (req, res) => {
  try {
    const { targets, start } = req.body;
    if (!targets || !targets.length) return res.status(400).json({ error: 'targets array required' });
    const batch = AutomationService.createBatch(targets);
    const runs = [];
    batch.targets.forEach((target, i) => {
      const project = createProject({
        name: `Batch ${batch.batchId.slice(0, 8)} ${target.targetEmail}`,
        targetEmail: target.targetEmail,
        providerType: target.providerType,
        caseName: req.body.caseName,
        caseId: req.body.caseId,
        examinerName: req.body.examinerName,
      });
      target.projectId = project.id;
      const { password, accessToken, ...safeConfig } = target.config || {};
      saveAcquisitionTarget({ ...target, config: safeConfig });
      runs.push({ target, project, request: targets[i] });
    });
    if (start) runBatch(runs);
    res.json({ ...batch, started: !!start, targets: batch.targets.map(({ config, ...t }) => t) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

async function runBatch(runs) {
  for (const { target, project, request } of runs) {
    updateAcquisitionTarget(target.id, { status: 'running', startedAt: new Date().toISOString() });
    try {
      const started = await startCollection(project, {
        config: { protocol: target.providerType, email: target.targetEmail, ...(request.config || {}) },
        folders: request.folders, outputDir: request.outputDir, query: request.query, scope: request.scope,
      });
      if (started.status !== 202) throw new Error(started.body.error);
      updateAcquisitionTarget(target.id, { acquisitionId: started.body.acquisitionId });
      await started.job.done;
      const result = collectionProgress.get(project.id)?.result;
      updateAcquisitionTarget(target.id, {
        status: result?.status === 'completed' ? 'completed' : result?.status === 'completed_with_errors' ? 'completed_with_errors' : 'failed',
        completedAt: new Date().toISOString(), error: result?.error || null,
      });
    } catch (err) {
      updateAcquisitionTarget(target.id, { status: 'failed', completedAt: new Date().toISOString(), error: err.message });
    }
  }
}

router.get('/acquisitions/batch/:batchId', (req, res) => {
  res.json(getAcquisitionTargets(req.params.batchId));
});

// Feature 29: Connectivity Testing
router.post('/connectivity/test', async (req, res) => {
  try {
    const { host, port, protocol } = req.body;
    if (!host) return res.status(400).json({ error: 'host required' });
    const result = await AutomationService.testConnectivity(host, port || 993, protocol || null, req.body);
    if (req.body.projectId) { result.projectId = req.body.projectId; saveConnectivityTest(result); }
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/projects/:id/connectivity/tests', (req, res) => {
  res.json(getConnectivityTests(req.params.id));
});

// Feature 30: Proxy Support
// The default proxy takes effect at once for every new connection, and again each time the app starts.
router.post('/proxy/settings', (req, res) => {
  try {
    const b = req.body || {};
    const proxyType = b.proxyType || 'none';
    const proxy = { id: crypto.randomUUID(), name: b.name || `${proxyType} ${b.host || ''}`.trim(), proxyType, host: b.host || null, port: Number(b.port) || null, username: b.username || null, passwordEncrypted: encryptSecret(b.password), isDefault: b.isDefault !== false };
    if (proxy.isDefault) {
      applyProxy({ proxyType, host: proxy.host, port: proxy.port, username: proxy.username, password: b.password });
      for (const old of getProxySettings().filter(p => p.is_default)) saveProxySettings({ id: old.id, name: old.name, proxyType: old.proxy_type, host: old.host, port: old.port, username: old.username, passwordEncrypted: old.password_encrypted, isDefault: false });
    }
    saveProxySettings(proxy);
    res.json({ success: true, id: proxy.id, active: describeProxy() });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.get('/proxy/settings', (req, res) => {
  const proxies = getProxySettings();
  for (const p of proxies) delete p.password_encrypted;
  res.json(proxies);
});

router.get('/proxy/default', (req, res) => {
  const proxy = getDefaultProxy();
  if (proxy) delete proxy.password_encrypted;
  res.json(proxy || { configured: false });
});

// Feature 31: Server Profile Auto-Detection
router.post('/server-profiles/detect', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });
    const profile = await AutomationService.detectServerProfile(email);
    saveServerProfile(profile);
    res.json(profile);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/server-profiles', (req, res) => {
  res.json(getAllServerProfiles());
});

router.get('/server-profiles/:domain', (req, res) => {
  const profile = getServerProfile(req.params.domain);
  res.json(profile || { found: false, domain: req.params.domain });
});

// ══════════════════════════════════════════════════════════════
// ── CATEGORY 7: Security & Cryptography (Features 32-35) ──
// ══════════════════════════════════════════════════════════════

// Feature 32: S/MIME Decryption
function evidenceBytes(req) {
  if (req.body?.messageId) {
    const msg = getMessage(req.body.messageId);
    if (!msg || msg.project_id !== req.params.id) throw Object.assign(new Error('Message not found'), { status: 404 });
    if (!msg.eml_path || !fs.existsSync(msg.eml_path)) throw Object.assign(new Error('The collected file for this message is missing'), { status: 404 });
    return { raw: fs.readFileSync(msg.eml_path), msg };
  }
  if (req.body?.content) return { raw: Buffer.from(req.body.content, 'base64'), msg: null };
  throw Object.assign(new Error('Send messageId or content (base64)'), { status: 400 });
}

function storedCertificates(projectId) {
  return getCertificates(projectId).map(c => {
    let material = {};
    try { material = JSON.parse(c.pem_data || '{}'); } catch { /* not a stored pair */ }
    return { id: c.id, subject: c.subject, certType: c.cert_type, certificatePem: material.certificatePem, privateKeyPem: decryptSecret(material.privateKey), passphrase: decryptSecret(material.passphrase) };
  });
}

// Feature 32: S/MIME Decryption. The evidence file is not touched; the decrypted message is saved as a
// derived copy, its hash recorded in the audit log.
router.post('/projects/:id/crypto/decrypt', async (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const { raw, msg } = evidenceBytes(req);
    const inline = req.body.privateKeyPem ? [{ certificatePem: req.body.certificatePem, privateKeyPem: req.body.privateKeyPem, passphrase: req.body.passphrase, subject: 'key supplied for this request' }] : [];
    const stored = storedCertificates(project.id).filter(c => c.privateKeyPem && (!req.body.certificateId || c.id === req.body.certificateId));
    const result = CryptoService.decryptMessage(raw, [...inline, ...stored]);
    const { decryptedContent, ...response } = result;
    if (result.decrypted) {
      const dir = path.join(DATA_DIR, 'projects', project.id, 'decrypted');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${msg?.id || result.id}_decrypted.eml`);
      fs.writeFileSync(file, decryptedContent);
      response.outputPath = file;
      response.sha256 = crypto.createHash('sha256').update(decryptedContent).digest('hex');
      const parsed = await simpleParser(decryptedContent, { skipImageLinks: true }).catch(() => null);
      response.preview = { subject: parsed?.subject || msg?.subject || null, text: parsed?.text || decryptedContent.toString('utf8') };
      addAuditEntry(project.id, 'MESSAGE_DECRYPTED', `Decrypted a copy of "${msg?.subject || 'message'}" with ${result.certificateUsed?.subject || 'a supplied key'}`, { messageId: msg?.id || null, sourceSha256: crypto.createHash('sha256').update(raw).digest('hex'), outputPath: file, sha256: response.sha256, algorithm: result.encryptionAlgorithm }, project.examiner_name);
    }
    res.json(response);
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// Feature 33: Digital Signature Verification
router.post('/projects/:id/crypto/verify-signature', async (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const { raw, msg } = evidenceBytes(req);
    const extraCaPems = storedCertificates(project.id).filter(c => c.certType === 'ca' && c.certificatePem).map(c => c.certificatePem);
    const result = CryptoService.verifySignature(raw, { extraCaPems });
    if (msg && result.signed) addAuditEntry(project.id, 'SIGNATURE_CHECKED', `Signature of "${msg.subject}": ${result.signatureValid === true ? 'valid' : result.signatureValid === false ? 'NOT valid' : 'not verified'}${result.signatureValid === true && !result.chainTrusted ? ' (signer not chained to a trusted root)' : ''}`, { messageId: msg.id, signatureValid: result.signatureValid, chainTrusted: result.chainTrusted, signer: result.signerInfo?.subject || null }, project.examiner_name);
    res.json(result);
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// Certificate management. The private key, when given, is stored encrypted.
router.post('/certificates', (req, res) => {
  try {
    const { certificatePem, privateKeyPem, passphrase, certType, projectId } = req.body || {};
    if (!certificatePem) return res.status(400).json({ error: 'certificatePem is required' });
    const x509 = new crypto.X509Certificate(certificatePem);
    if (privateKeyPem) {
      const key = crypto.createPrivateKey(passphrase ? { key: privateKeyPem, passphrase } : privateKeyPem);
      if (!x509.checkPrivateKey(key)) return res.status(400).json({ error: 'This private key does not belong to this certificate' });
    }
    const cert = {
      id: crypto.randomUUID(), projectId: projectId || null, subject: x509.subject.replace(/\n/g, ', '), issuer: x509.issuer.replace(/\n/g, ', '), serialNumber: x509.serialNumber,
      thumbprintSha256: x509.fingerprint256, notBefore: new Date(x509.validFrom).toISOString(), notAfter: new Date(x509.validTo).toISOString(),
      keyUsage: (x509.keyUsage || []).join(','), emailAddress: x509.subjectAltName?.match(/email:([^,\s]+)/)?.[1] || null,
      certType: certType || (privateKeyPem ? 'smime_encrypt' : 'ca'),
      pemData: JSON.stringify({ certificatePem, privateKey: encryptSecret(privateKeyPem), passphrase: encryptSecret(passphrase) }),
    };
    saveCertificate(cert);
    if (projectId) addAuditEntry(projectId, 'CERTIFICATE_IMPORTED', `Certificate imported: ${cert.subject}`, { certType: cert.certType, thumbprint: cert.thumbprintSha256, hasPrivateKey: !!privateKeyPem });
    res.json({ success: true, id: cert.id, subject: cert.subject, thumbprint: cert.thumbprintSha256, hasPrivateKey: !!privateKeyPem });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.get('/certificates', (req, res) => {
  const certs = getCertificates(req.query.projectId);
  for (const c of certs) { delete c.pem_data; delete c.pfx_path; }
  res.json(certs);
});

// Feature 34: Credential Manager
router.post('/credentials', (req, res) => {
  try {
    const { label, credentialType, targetHost, username, password, masterKey } = req.body;
    if (!label || !credentialType || !password || !masterKey) return res.status(400).json({ error: 'label, credentialType, password, masterKey required' });
    const encrypted = CryptoService.encryptCredential(password, masterKey);
    const cred = { id: crypto.randomUUID(), label, credentialType, targetHost, username, ...encrypted, metadata: { ...(req.body.metadata || {}), salt: encrypted.salt } };
    saveCredential(cred);
    res.json({ success: true, id: cred.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/credentials', (req, res) => {
  res.json(getCredentials());
});

router.post('/credentials/:id/decrypt', (req, res) => {
  try {
    const cred = getCredential(req.params.id);
    if (!cred) return res.status(404).json({ error: 'Credential not found' });
    const { masterKey } = req.body;
    if (!masterKey) return res.status(400).json({ error: 'masterKey required' });
    let salt = null;
    try { salt = JSON.parse(cred.metadata_json || '{}').salt || null; } catch { /* entries from before salting have none */ }
    const decrypted = CryptoService.decryptCredential(cred.encrypted_data, cred.iv, cred.auth_tag, masterKey, salt);
    res.json({ id: cred.id, label: cred.label, decrypted });
  } catch (err) { res.status(400).json({ error: 'Decryption failed — wrong master key?' }); }
});

router.delete('/credentials/:id', (req, res) => {
  deleteCredential(req.params.id);
  res.json({ success: true });
});

// Feature 35: Custom IMAP Profiles
router.post('/imap-profiles', (req, res) => {
  try {
    const profile = { id: crypto.randomUUID(), ...req.body };
    saveCustomImapProfile(profile);
    res.json({ success: true, id: profile.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/imap-profiles', (req, res) => {
  res.json(getCustomImapProfiles());
});

router.get('/imap-profiles/:id', (req, res) => {
  const profile = getCustomImapProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  res.json(profile);
});

router.delete('/imap-profiles/:id', (req, res) => {
  deleteCustomImapProfile(req.params.id);
  res.json({ success: true });
});

router.post('/imap-profiles/:id/export', (req, res) => {
  try {
    const profile = getCustomImapProfile(req.params.id);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    res.json(CryptoService.exportProfile(profile));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/imap-profiles/import', (req, res) => {
  try {
    const { xmlContent } = req.body;
    if (!xmlContent) return res.status(400).json({ error: 'xmlContent required' });
    const profile = CryptoService.importProfile(xmlContent);
    saveCustomImapProfile(profile);
    res.json({ success: true, profile });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════
// ── ADVANCED FEATURES: File Detection, Metadata Export,      ──
// ── Retry/Rate-Limit, Email Validation, AutoDiscover,        ──
// ── Hash File Ops, Timestamp Verification                    ──
// ══════════════════════════════════════════════════════════════

// ── File Type Detection ──
router.post('/detect/file', (req, res) => {
  try {
    const { filePath } = req.body;
    if (!filePath) return res.status(400).json({ error: 'filePath required' });
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return res.status(404).json({ error: `File not found: ${filePath}` });
    res.json(FileTypeDetector.detect(filePath));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/detect/buffer', (req, res) => {
  try {
    const { data, filename } = req.body;
    if (!data) return res.status(400).json({ error: 'data (base64) required' });
    const buf = Buffer.from(data, 'base64');
    res.json(FileTypeDetector.detectBuffer(buf, filename));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/detect/classify', (req, res) => {
  try {
    const { filename, data } = req.body;
    if (!filename) return res.status(400).json({ error: 'filename required' });
    const buf = data ? Buffer.from(data, 'base64') : null;
    res.json(FileTypeDetector.classifyAttachment(filename, buf));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Metadata Export ──
router.get('/metadata-export/types', (req, res) => {
  res.json(MetadataExportService.getAvailableExportTypes());
});

function metadataRows(projectId, type) {
  switch (type) {
    case 'email': return getAllProjectMessages(projectId);
    case 'attachment': return getProjectAttachments(projectId);
    case 'calendar': return getCalendarEvents(projectId);
    case 'contact': return getContacts(projectId);
    case 'drive': return getDriveItems(projectId);
    case 'document': return getDriveItems(projectId).filter(d => d.item_type !== 'folder');
    case 'audit': return getAuditLog(projectId);
    case 'timestamp': return getRfc3161Timestamps(projectId);
    case 'snapshot': return getFolderSnapshots(projectId);
    case 'hash': return [
      ...getAllProjectMessages(projectId).map(m => ({ ...m, type: 'email' })),
      ...getProjectAttachments(projectId).map(a => ({ ...a, type: 'attachment' })),
      ...getDriveItems(projectId).filter(d => d.hash_sha256).map(d => ({ ...d, type: 'drive' })),
    ];
    default: throw httpError(400, `Unknown type: ${type}`);
  }
}

router.post('/projects/:id/metadata-export', (req, res) => {
  try {
    const { type, format } = req.body;
    if (!type) return res.status(400).json({ error: 'type required (email, attachment, calendar, contact, document, drive, audit, hash, timestamp, snapshot)' });
    const csv = MetadataExportService.exportToString(metadataRows(req.params.id, type), type, format || 'csv');
    const ext = (format === 'tsv') ? 'tsv' : 'csv';
    res.setHeader('Content-Type', format === 'tsv' ? 'text/tab-separated-values' : 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${type}_export.${ext}"`);
    res.send(csv);
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

router.post('/projects/:id/metadata-export/file', (req, res) => {
  try {
    const { type, format, outputPath } = req.body;
    if (!type || !outputPath) return res.status(400).json({ error: 'type and outputPath required' });
    const outputPathError = notFullPathError(outputPath, 'the metadata file');
    if (outputPathError) return res.status(400).json({ error: outputPathError });
    const result = MetadataExportService.exportToFile(metadataRows(req.params.id, type), type, outputPath, format || 'csv');
    res.json(result);
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

router.get('/metadata-export/columns/:type', (req, res) => {
  const columns = MetadataExportService.getColumns(req.params.type);
  if (!columns) return res.status(404).json({ error: 'Unknown type' });
  res.json({ type: req.params.type, columns });
});

// ── File Hashing (new endpoints for upgraded hash-manager) ──
router.post('/hash/file', (req, res) => {
  try {
    const { filePath, algorithms } = req.body;
    if (!filePath) return res.status(400).json({ error: 'filePath required' });
    res.json(HashManager.computeFileSync(filePath, algorithms));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/hash/file/streaming', async (req, res) => {
  try {
    const { filePath, algorithms } = req.body;
    if (!filePath) return res.status(400).json({ error: 'filePath required' });
    const result = await HashManager.computeFileStreaming(filePath, algorithms);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/hash/verify-file', (req, res) => {
  try {
    const { filePath, expectedHashes } = req.body;
    if (!filePath || !expectedHashes) return res.status(400).json({ error: 'filePath and expectedHashes required' });
    res.json(HashManager.verifyFile(filePath, expectedHashes));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/hash/directory-manifest', (req, res) => {
  try {
    const { dirPath, algorithms } = req.body;
    if (!dirPath) return res.status(400).json({ error: 'dirPath required' });
    res.json(HashManager.computeDirectoryManifest(dirPath, algorithms));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/hash/mime', (req, res) => {
  try {
    const { messageId, mimeData, emlData } = req.body;
    if (!messageId || !mimeData) return res.status(400).json({ error: 'messageId and mimeData required' });
    const mime = Buffer.from(mimeData, 'base64');
    const eml = emlData ? Buffer.from(emlData, 'base64') : null;
    res.json(HashManager.createMimeHashResult(messageId, mime, eml));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/hash/drive', (req, res) => {
  try {
    const { itemId, fileData, metadata } = req.body;
    if (!itemId || !fileData) return res.status(400).json({ error: 'itemId and fileData required' });
    res.json(HashManager.createDriveHashResult(itemId, Buffer.from(fileData, 'base64'), metadata));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/hash/attachment', (req, res) => {
  try {
    const { attachmentId, data, parentMessageId } = req.body;
    if (!attachmentId || !data) return res.status(400).json({ error: 'attachmentId and data required' });
    res.json(HashManager.createAttachmentHashResult(attachmentId, Buffer.from(data, 'base64'), parentMessageId));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── RFC 3161 Timestamp Verification (new endpoints) ──
router.post('/projects/:id/rfc3161/verify', async (req, res) => {
  try {
    const { timestampToken, originalHash, tsaUrl } = req.body;
    if (!timestampToken) return res.status(400).json({ error: 'timestampToken (base64) required' });
    const result = await Rfc3161TimestampService.verifyTimestamp(timestampToken, originalHash, { tsaUrl });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/projects/:id/rfc3161/verify-chain', async (req, res) => {
  try {
    const timestamps = getRfc3161Timestamps(req.params.id);
    if (!timestamps.length) return res.json({ totalTimestamps: 0, allValid: true, chronologicalOrder: true, results: [] });
    const result = await Rfc3161TimestampService.verifyTimestampChain(timestamps);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Email Validation ──
router.post('/validate/email', (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });
    res.json(EmailValidator.validate(email));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/validate/email/mx', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });
    res.json(await EmailValidator.validateMx(email));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Exchange AutoDiscover ──
router.post('/exchange/autodiscover', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });
    res.json(await AutomationService.exchangeAutoDiscover(email, password));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Session/Output Naming ──
router.post('/session/name', (req, res) => {
  try {
    const { projectName, targetEmail, counter } = req.body;
    res.json({ sessionName: AutomationService.createSessionName(projectName, targetEmail, { counter }) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/session/output-folder', (req, res) => {
  try {
    const { baseDir, projectName, targetEmail, counter } = req.body;
    if (!baseDir) return res.status(400).json({ error: 'baseDir required' });
    const baseDirError = notFullPathError(baseDir, 'the output folder');
    if (baseDirError) return res.status(400).json({ error: baseDirError });
    res.json(AutomationService.createOutputFolder(baseDir, projectName, targetEmail, { counter }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Retry Policy & Rate Limiter Status ──
router.get('/resilience/info', (req, res) => {
  res.json({
    profiles: COLLECTION_PROFILES,
    retries: 'Each item: up to 4 attempts with exponential backoff, then final rounds at the end of the run (up to 50), one try per round.',
    quota: 'A provider quota refusal pauses all workers for the provider\'s Retry-After or 60 s and halves the request rate; items fail only after 15 minutes of refusals.',
    connections: 'Extra IMAP sessions are waited for up to 20 s; a server that refuses them does not stop the collection.',
  });
});

// ══════════════════════════════════════════════════════════════

function verifyAuditChain(auditLog) {
  return verifyAuditLogChain(auditLog);
}

// --- Transfer (Robocopy + 7-Zip) ---

function find7zPath() {
  const candidates = [
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
  ];
  const __dirname2 = path.dirname(fileURLToPath(import.meta.url));
  const vendorPath = path.resolve(__dirname2, '../../node_modules/electron-winstaller/vendor/7z-x64.exe');
  candidates.push(vendorPath);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const TRANSFER_EXEC_OPTIONS = { timeout: 0, maxBuffer: 64 * 1024 * 1024, windowsHide: true };

async function listFiles(root, rel = '') {
  const out = [];
  for (const entry of await fs.promises.readdir(path.join(root, rel), { withFileTypes: true })) {
    const r = path.join(rel, entry.name);
    if (entry.isDirectory()) out.push(...await listFiles(root, r));
    else if (entry.isFile()) out.push(r);
  }
  return out;
}

// Every source file is re-hashed and compared with its copy; the result is written beside the copy.
async function verifyCopiedTree(source, destination, ts) {
  const files = await listFiles(source);
  const rows = [];
  let verified = 0, mismatched = 0, missing = 0, totalBytes = 0;
  for (let i = 0; i < files.length; i += 8) {
    await Promise.all(files.slice(i, i + 8).map(async (rel) => {
      const src = path.join(source, rel);
      const dst = path.join(destination, rel);
      const size = (await fs.promises.stat(src)).size;
      totalBytes += size;
      const srcHash = await sha256OfFile(src);
      let dstHash = '';
      let status;
      try {
        dstHash = await sha256OfFile(dst);
        status = dstHash === srcHash ? 'verified' : 'MISMATCH';
      } catch {
        status = 'MISSING';
      }
      if (status === 'verified') verified++;
      else if (status === 'MISMATCH') mismatched++;
      else missing++;
      rows.push([`"${rel.replace(/"/g, '""')}"`, size, srcHash, dstHash, status].join(','));
    }));
  }
  const reportPath = path.join(destination, `transfer_verification_${ts}.csv`);
  fs.writeFileSync(reportPath, ['RelativePath,Size,SourceSHA256,DestinationSHA256,Status', ...rows.sort()].join('\n'));
  return { files: files.length, verified, mismatched, missing, totalBytes, reportPath };
}

function unusedFile(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let n = 2; fs.existsSync(candidate); n++) candidate = path.join(dir, `${base} (${n})${ext}`);
  return candidate;
}

router.post('/projects/:id/transfer', async (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (activeCollections.has(project.id)) return res.status(409).json({ error: 'Wait for the running collection to finish before transferring it' });

  const { source, destination, mode, zipPassword } = req.body;
  if (!source || !destination) return res.status(400).json({ error: 'Source and destination are required' });
  const pathError = notFullPathError(destination, 'the transfer destination');
  if (pathError) return res.status(400).json({ error: pathError });

  if (!fs.existsSync(source)) return res.status(400).json({ error: 'Source directory does not exist' });
  const norm = p => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase() + path.sep;
  if (norm(destination).startsWith(norm(source))) {
    return res.status(400).json({ error: 'Choose a transfer destination outside the folder being transferred; copying a folder into itself would never finish.' });
  }
  if (!fs.existsSync(path.parse(path.resolve(destination)).root)) {
    return res.status(400).json({ error: `Destination drive for ${destination} is not available. Connect the drive or choose another destination.` });
  }

  const log = [];
  const ts = new Date().toISOString().replace(/[:.]/g, '-');

  try {
    fs.mkdirSync(destination, { recursive: true });

    if (mode === 'zipped') {
      const sevenZip = find7zPath();
      if (!sevenZip) return res.status(500).json({ error: '7-Zip not found. Install 7-Zip or ensure it is in Program Files.' });

      // Never add to an existing archive: 7-Zip would merge this collection into it.
      const archivePath = unusedFile(destination, `${project.name || project.id}_collection.7z`.replace(/[<>:"/\\|?*]/g, '_'));
      const pass = zipPassword ? [`-p${zipPassword}`, '-mhe=on'] : [];
      log.push(`7-Zip: ${sevenZip}`);
      log.push(`Creating archive: ${archivePath}${zipPassword ? ' (AES-256, encrypted file names)' : ''}`);
      const created = await execFileAsync(sevenZip, ['a', '-t7z', '-mx=5', '-r', '-bd', ...pass, archivePath, path.join(source, '*')], TRANSFER_EXEC_OPTIONS);
      if (created.stdout) log.push(created.stdout.trim());

      log.push('Testing archive integrity (7z t)');
      const tested = await execFileAsync(sevenZip, ['t', '-bd', ...(zipPassword ? [`-p${zipPassword}`] : []), archivePath], TRANSFER_EXEC_OPTIONS);
      if (tested.stdout) log.push(tested.stdout.trim());

      const stat = fs.statSync(archivePath);
      const archiveSha256 = await sha256OfFile(archivePath);
      fs.writeFileSync(`${archivePath}.sha256`, `${archiveSha256}  ${path.basename(archivePath)}\n`);
      log.push(`Archive SHA-256: ${archiveSha256}`);
      addAuditEntry(project.id, 'TRANSFER_COMPLETED', `Zipped transfer to ${destination} (${formatBytesServer(stat.size)}), archive tested OK`, { source, destination, archivePath, archiveSha256, encrypted: !!zipPassword, size: stat.size }, project.examiner_name);

      res.json({ archivePath, archiveSha256, totalBytes: stat.size, encrypted: !!zipPassword, tested: true, log });
    } else {
      if (process.platform === 'win32') {
        log.push(`Robocopy: ${source} -> ${destination}`);
        const args = [source, destination, '/E', '/COPY:DAT', '/DCOPY:DAT', '/R:2', '/W:1', '/NP', '/NFL', '/NDL'];
        let exitCode = 0;
        try {
          const { stdout } = await execFileAsync('robocopy', args, TRANSFER_EXEC_OPTIONS);
          if (stdout) log.push(stdout.trim());
        } catch (robocopyErr) {
          // Robocopy exits 1-7 for "copied / extra files / mismatches" and 8+ for failures. A killed process
          // has no numeric code, which must never count as success.
          if (robocopyErr.stdout) log.push(robocopyErr.stdout.trim());
          if (typeof robocopyErr.code !== 'number') throw new Error(`Robocopy did not finish: ${robocopyErr.signal || robocopyErr.message}`);
          exitCode = robocopyErr.code;
          if (exitCode >= 8) throw new Error(`Robocopy reported failures (exit code ${exitCode}); some files were not copied`);
        }
        log.push(`Robocopy exit code: ${exitCode}`);
      } else {
        log.push(`Copying ${source} -> ${destination}`);
        await fs.promises.cp(source, destination, { recursive: true, preserveTimestamps: true, force: false, errorOnExist: false });
      }

      log.push('Verifying every copied file by SHA-256');
      const v = await verifyCopiedTree(source, destination, ts);
      log.push(`Verified ${v.verified} of ${v.files} file(s); ${v.mismatched} mismatched, ${v.missing} missing. Report: ${v.reportPath}`);
      const ok = v.mismatched === 0 && v.missing === 0;
      addAuditEntry(project.id, ok ? 'TRANSFER_COMPLETED' : 'TRANSFER_VERIFICATION_FAILED',
        `${ok ? 'Transfer verified' : 'Transfer verification FAILED'}: ${v.verified}/${v.files} files (${formatBytesServer(v.totalBytes)}) to ${destination}`,
        { source, destination, ...v }, project.examiner_name);

      if (!ok) return res.status(500).json({ error: `Transfer verification failed: ${v.mismatched} file(s) differ and ${v.missing} are missing at the destination. See ${v.reportPath}`, verification: v, log });
      res.json({ filesCopied: v.files, totalBytes: v.totalBytes, verification: v, log });
    }
  } catch (err) {
    addAuditEntry(project.id, 'TRANSFER_FAILED', err.message, { source, destination, mode }, project.examiner_name);
    res.status(500).json({ error: err.message, log });
  }
});

function formatBytesServer(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// An address that is not part of the API is an error, not the app's page.
router.use((req, res) => {
  res.status(404).json({ error: `No such API route: ${req.method} ${req.path}` });
});

// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  console.error(`[api] ${req.method} ${req.path} failed:`, err);
  if (res.headersSent) return res.end();
  res.status(err.status || err.statusCode || 500).json({ error: err.message || 'Internal error' });
});

export default router;
