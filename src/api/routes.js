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
  saveFolders, getFolders, createAcquisition, saveMessage, saveMessagesBatch, getMessages, getMessageCount,
  saveSearchQuery, getSearchQueries, saveExportRecord, getExportRecords, updateExportRecord,
  getAuditLog, getFullAuditLog, getStats, addAuditEntry,
  getMessage, getAllProjectMessages, getProjectMessageKeys, updateAcquisition, getAcquisitions,
  saveAttachment, getAttachments, getProjectAttachments,
  saveDriveLink, getDriveLinks, setAttachmentLocalPath,
  saveTimestampRecord, getTimestampRecords,
  saveInlineSearch, getInlineSearches,
  saveQcResult, getQcResults,
  getDifferentialIds, saveDifferentialId, recoverInterruptedCollections, verifyAuditLogChain,
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
import { runCollection, supportsEngine, enumerateFolders } from '../services/collection-engine.js';
import { normalizeQuery, planQuery, describeQuery, describeKeys, matchesLocally } from '../services/collection-query.js';
import { driveAvailability, driveProviderFor, collectDrive, estimateDrive, writeDriveManifest, safeSegment } from '../services/drive-collector.js';
import { collectLinkedFiles, writeLinkedFilesManifest, LINKED_FOLDER_NAME } from '../services/linked-files.js';
import { simpleParser } from 'mailparser';
import {
  getAuthStatus, getAuthUrl, saveCredentials, loadCredentials,
  startCallbackServer, waitForAuth, stopCallbackServer, revokeTokens,
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
  stopCallbackServer as yahooStopCallbackServer, revokeTokens as yahooRevokeTokens,
} from '../services/yahoo-oauth.js';
import { EnterpriseAuthService } from '../services/enterprise-auth.js';
import { ExchangeAdvancedService } from '../services/exchange-advanced.js';
import { LocalImportService } from '../services/local-import.js';
import { CloudCollectionService } from '../services/cloud-collection.js';
import { CloudDownloadPipeline } from '../services/cloud-download-pipeline.js';
import { ContainerService } from '../services/container-service.js';
import { ReportService } from '../services/report-service.js';
import { AdvancedSearchService } from '../services/advanced-search.js';
import { AutomationService } from '../services/automation-service.js';
import { CryptoService } from '../services/crypto-service.js';
import { FileTypeDetector } from '../services/file-detection.js';
import { MetadataExportService } from '../services/metadata-export.js';
import { RetryPolicy, CircuitBreaker, RateLimiter, EmailValidator } from '../services/automation-service.js';
import {
  saveRfc3161Timestamp, getRfc3161Timestamps,
  saveFolderSnapshot, getFolderSnapshots,
  saveDriveItem, getDriveItems, updateDriveItem,
  saveCalendarEvent, getCalendarEvents,
  saveContact, getContacts,
  saveCloudDownload, getCloudDownloads, updateCloudDownload,
  savePreAcquisitionSearch, getPreAcquisitionSearches,
  indexMessage, searchIndex,
  saveSmtpSettings, getSmtpSettings,
  saveHealthEvent, getHealthEvents,
  saveAcquisitionTarget, getAcquisitionTargets, updateAcquisitionTarget,
  saveConnectivityTest, getConnectivityTests,
  saveProxySettings, getProxySettings, getDefaultProxy,
  saveServerProfile, getServerProfile, getAllServerProfiles,
  saveCertificate, getCertificates,
  saveCredential, getCredentials, getCredential, deleteCredential,
  saveCustomImapProfile, getCustomImapProfiles, getCustomImapProfile, deleteCustomImapProfile,
} from '../db/database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.SHERLOCKMAIL_DATA_DIR || path.join(__dirname, '..', '..', 'data');

const router = Router();

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

  let rawBuffer;
  if (msg.rawMime && Buffer.isBuffer(msg.rawMime)) {
    rawBuffer = msg.rawMime;
  } else if (msg.rawSource) {
    rawBuffer = Buffer.from(msg.rawSource, 'base64');
  } else {
    const headers = [
      `From: ${msg.fromAddress || ''}`,
      `To: ${(msg.toAddresses || []).join(', ')}`,
      `Subject: ${msg.subject || ''}`,
      `Date: ${msg.date || new Date().toISOString()}`,
      `Message-ID: ${msg.messageId || ''}`,
      `Content-Type: ${msg.contentType || 'text/plain'}`,
    ].join('\r\n');
    rawBuffer = Buffer.from(headers + '\r\n\r\n' + (msg.bodyText || ''));
  }

  fs.writeFileSync(filePath, rawBuffer);
  return { filePath, size: rawBuffer.length };
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
  stats.version = '0.9.0';
  stats.nodeVersion = process.versions.node;
  res.json(stats);
});

// ── Google OAuth ──
router.get('/oauth/google/status', (req, res) => {
  res.json(getAuthStatus());
});

router.post('/oauth/google/credentials', (req, res) => {
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
    const url = getAuthUrl();
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
    const url = msGetAuthUrl();
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
    let handler;
    let result;

    switch (protocol) {
      case 'imap':
        handler = new ImapHandler(config);
        result = await handler.connect();
        const folders = await handler.listFolders();
        await handler.disconnect();
        res.json({ ...result, folders, protocolLog: handler.getProtocolLog() });
        return;

      case 'pop3':
        handler = new Pop3Handler(config);
        result = await handler.connect();
        const msgList = await handler.listMessages();
        await handler.disconnect();
        res.json({ ...result, messages: msgList, protocolLog: handler.getProtocolLog() });
        return;

      case 'ews': {
        const ewsConfig = { ...config };
        if (!ewsConfig.password && msGetAuthStatus().authorized) {
          ewsConfig.authType = 'oauth2';
          ewsConfig.accessToken = await msGetAccessToken();
        }
        handler = new EwsHandler(ewsConfig);
        result = await handler.connect();
        const ewsFolders = await handler.listFolders();
        await handler.disconnect();
        res.json({ ...result, folders: ewsFolders, protocolLog: handler.getProtocolLog() });
        return;
      }

      case 'graph':
        handler = new GraphHandler(config);
        result = await handler.connect();
        const graphFolders = await handler.listFolders();
        await handler.disconnect();
        res.json({ ...result, folders: graphFolders, protocolLog: handler.getProtocolLog() });
        return;

      case 'gmail_api':
        handler = new GmailHandler(config);
        result = await handler.connect();
        const gmailFolders = await handler.listLabels();
        await handler.disconnect();
        res.json({ ...result, folders: gmailFolders, protocolLog: handler.getProtocolLog() });
        return;

      case 'zoho_api':
        handler = new ZohoHandler(config);
        result = await handler.connect();
        const zohoFolders = await handler.listFolders();
        await handler.disconnect();
        res.json({ ...result, folders: zohoFolders, protocolLog: handler.getProtocolLog() });
        return;

      case 'jmap':
        handler = new JmapHandler(config);
        result = await handler.connect();
        const jmapFolders = await handler.listFolders();
        await handler.disconnect();
        res.json({ ...result, folders: jmapFolders, protocolLog: handler.getProtocolLog() });
        return;

      default:
        res.status(400).json({ error: `Unknown protocol: ${protocol}` });
    }
  } catch (err) {
    let errorMsg = err.message;
    const host = (config?.host || '').toLowerCase();
    if (/auth|login|credential|command/i.test(errorMsg) && /aol|yahoo/.test(host)) {
      errorMsg += '. AOL/Yahoo requires an app-specific password — generate one in your account security settings and select "App-Specific Password" as auth method.';
    }
    res.status(500).json({ error: errorMsg, protocolLog: [] });
  }
});

// ── Folders ──
router.get('/projects/:id/folders', (req, res) => {
  res.json(getFolders(req.params.id));
});

router.post('/projects/:id/folders', (req, res) => {
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

function processMessageItem(msg, projectId, acquisitionId, existingIds, differential, errors, opts = {}) {
  const { mimeDir, folderMsgCounters, differentialExclusions, downloadedItems } = opts;

  const isDuplicate = differential && (existingIds.has(msg.messageId) || existingIds.has(msg.hashSha256));
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

    if (differential && (existingIds.has(msg.messageId) || existingIds.has(msg.hashSha256))) {
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

async function createEngineHandler(protocol, config, project) {
  switch (protocol) {
    case 'imap':
      if (!config?.host) throw new Error('IMAP host is required');
      return new ImapHandler(config);
    case 'pop3':
      if (!config?.host) throw new Error('POP3 host is required');
      return new Pop3Handler(config);
    case 'ews': {
      const ewsConfig = { ...(config || {}) };
      ewsConfig.email = ewsConfig.email || project.target_email;
      if (!ewsConfig.password && msGetAuthStatus().authorized) {
        ewsConfig.authType = 'oauth2';
        ewsConfig.tokenProvider = msGetAccessToken;
        ewsConfig.accessToken = await msGetAccessToken();
      }
      return new EwsHandler(ewsConfig);
    }
    case 'graph':
      return new GraphHandler(config || { email: project.target_email, authType: 'delegated' });
    case 'gmail_api':
      return new GmailHandler(config || { email: project.target_email, authType: 'oauth2' });
    default:
      throw new Error(`Unsupported protocol: ${protocol}`);
  }
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

function validateCollectTarget({ scope, protocol, wantsEmail, wantsDrive }) {
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
  if (activeCollections.has(project.id)) {
    return res.status(409).json({ error: 'A collection is already running for this project. Wait for it to finish or stop it first.', active: true });
  }

  let request;
  try {
    request = parseCollectRequest(project, req.body || {});
  } catch (err) {
    return res.status(400).json({ error: `Query: ${err.message}` });
  }
  const { scope, protocol, destinationDir, query, queryPlan } = request;
  const invalid = validateCollectTarget(request);
  if (invalid) return res.status(400).json({ error: invalid });

  // A missing drive root (e.g. an unplugged evidence drive) makes a recursive mkdirSync hang on Windows.
  if (destinationDir && !fs.existsSync(path.parse(path.resolve(destinationDir)).root)) {
    return res.status(400).json({ error: `Destination drive for ${destinationDir} is not available. Connect the drive or choose another destination.` });
  }
  const diskCheck = await checkDiskSpace(destinationDir || DATA_DIR);
  if (!diskCheck.ok) {
    return res.status(507).json({
      error: `Insufficient disk space on ${diskCheck.drive}: ${Math.round(diskCheck.freeBytes / 1024 / 1024)} MB free, need at least ${Math.round(diskCheck.minFreeBytes / 1024 / 1024)} MB`,
      freeBytes: diskCheck.freeBytes,
    });
  }

  // Restarting into a location that already holds this project's collection is a differential
  // acquisition: only new items are collected, into their own "Differential Acquisition" folder.
  const rerun = priorCollectionAt(project.id, destinationDir);
  const differential = rerun || req.body.differential === true;
  const sessionName = `${(project.name || project.id).replace(/[<>:"/\\|?*]/g, '_')}_${new Date().toISOString().replace(/[:.]/g, '-')}`;
  let dirs;
  try {
    dirs = createSessionOutputDir(project.id, sessionName, destinationDir, { rerun });
  } catch (err) {
    return res.status(400).json({ error: `Cannot create the output folders in ${destinationDir || 'the SherlockMail data folder'}: ${err.message}` });
  }

  const selectedFolders = Array.isArray(req.body.folders) && req.body.folders.length ? req.body.folders : null;
  const queryDescription = describeQuery(query);
  const attachmentFiles = req.body.collectAttachmentFiles === true;
  const linkedFiles = req.body.collectLinkedFiles === true;
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
    limit: Math.max(0, parseInt(req.body.limit, 10) || 0),
    exportFormats: Array.isArray(req.body.exportFormats) ? [...new Set(req.body.exportFormats.filter(f => typeof f === 'string'))] : [],
    pdfSplitMode: typeof req.body.pdfSplitMode === 'string' ? req.body.pdfSplitMode : undefined,
    pstMaxGb: pstSizeGb(req.body.pstMaxGb),
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

  res.status(202).json({
    started: true, acquisitionId, scope, differential, rerun,
    sessionDir: dirs.sessionDir, differentialFolder: dirs.differentialFolder,
    query: { description: queryDescription, notes: queryPlan.notes, unsupported: queryPlan.unsupported.map(k => describeKeys([k])) },
  });
});

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
        if (m.message_id) existingIds.add(m.message_id);
        if (m.hash_sha256) existingIds.add(m.hash_sha256);
      }
      live.write(`Differential: ${existingIds.size} identifiers from earlier acquisitions of this project will be skipped`);
    }

    if (wantsEmail && supportsEngine(protocol)) {
      const target = describeTarget(protocol, config);
      live.write(`Email: ${targetFolders.length} folder(s) from ${target}: ${targetFolders.join(', ')}`);
      handler = await createEngineHandler(protocol, config, project);
      progress.phase = 'connecting';
      await connectWithStatus(handler, progress, target, live, signal);

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
          onTick: () => {
            logTick();
            publish();
          },
        });
        if (run.recovered) live.write(`Final retry pass recovered ${run.recovered} item(s)`);
      } finally {
        sink.flush();
      }
      live.write(`Email download finished: ${progress.acquired} acquired, ${progress.failed} failed, ${progress.skipped} skipped (${progress.excluded} excluded by query), ${progress.duplicatesMerged || 0} label copies merged`);
      await handler.disconnect().catch(() => {});
    } else if (wantsEmail) {
      const factories = {
        zoho_api: () => new ZohoHandler(config || { email: project.target_email }),
        jmap: () => new JmapHandler(config || { email: project.target_email }),
      };
      handler = factories[protocol]();
      progress.phase = 'connecting';
      await retryWithBackoff(() => handler.connect());
      progress.phase = 'collecting';
      const folderMsgCounters = {};
      for (const folder of targetFolders) {
        if (signal.aborted) break;
        const stats = folderStats[folder] = { acquired: 0, skipped: 0, excluded: 0, failed: 0 };
        progress.currentFolder = folder;
        try {
          const messages = await retryWithBackoff(() => handler.fetchMessages(folder, { limit }));
          progress.total += messages.length;
          for (const msg of messages) {
            if (signal.aborted) break;
            msg.folder = msg.folder || folder;
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
  try {
    return await finalizeCollection({ canceled: signal.aborted, fatal: fatalError });
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
    const status = canceled ? 'canceled'
      : fatal ? 'failed'
      : failedAll > 0 && acquiredAll === 0 ? 'failed'
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

    let timestamp = null;
    if (acquired > 0) {
      const tsResult = TimestampService.timestampCollection(project.id, downloadedItems);
      saveTimestampRecord(project.id, 'collection', tsResult.collectionDigest, tsResult.timestamp);
      timestamp = tsResult.timestamp.genTime;
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
          exports.push({ format, success: true, files: r.files.length, totalBytes: r.totalBytes, outputDir: r.outputDir, reconstructed: r.reconstructedCount });
          live.write(`Exported ${format.toUpperCase()}: ${r.files.length} file(s) to ${r.outputDir}`);
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
        handler = await createEngineHandler(protocol, config, project);
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
  const total = getMessageCount(req.params.id);
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
  const result = InlineSearchEngine.search(messages, query);

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

  const { criteria, queryType } = req.body;

  const dbResults = getMessages(project.id, {
    search: criteria.keyword || criteria.from || criteria.subject,
    folder: criteria.folder,
  });

  let serverResult = { resultCount: 0, query: '', protocolLog: [] };

  try {
    switch (project.provider_type) {
      case 'imap': {
        const config = JSON.parse(project.config || '{}');
        if (config.host) {
          const handler = new ImapHandler(config);
          await handler.connect();
          const searchResult = await handler.serverSearch(criteria.folder || 'INBOX', criteria);
          serverResult = {
            query: JSON.stringify(criteria),
            resultCount: searchResult.count,
            uids: searchResult.uids,
            protocolLog: handler.getProtocolLog(),
          };
          await handler.disconnect();
        } else {
          serverResult.query = JSON.stringify(criteria);
          serverResult.note = 'IMAP SEARCH requires active connection with host configured';
        }
        break;
      }
      case 'ews': {
        const ewsConfig = { email: project.target_email };
        if (msGetAuthStatus().authorized) {
          ewsConfig.authType = 'oauth2';
          ewsConfig.accessToken = await msGetAccessToken();
        }
        const handler = new EwsHandler(ewsConfig);
        await handler.connect();
        serverResult = await handler.searchMailboxes(criteria);
        serverResult.protocolLog = handler.getProtocolLog();
        await handler.disconnect();
        break;
      }
      case 'graph': {
        const handler = new GraphHandler({ email: project.target_email, authType: 'delegated' });
        await handler.connect();
        serverResult = await handler.searchMessages(criteria);
        serverResult.protocolLog = handler.getProtocolLog();
        await handler.disconnect();
        break;
      }
      case 'gmail_api': {
        const handler = new GmailHandler({ email: project.target_email, authType: 'oauth2' });
        await handler.connect();
        serverResult = await handler.searchMessages(criteria);
        serverResult.protocolLog = handler.getProtocolLog();
        await handler.disconnect();
        break;
      }
      case 'zoho_api': {
        const handler = new ZohoHandler({ email: project.target_email });
        await handler.connect();
        serverResult = await handler.searchMessages(criteria);
        serverResult.protocolLog = handler.getProtocolLog();
        await handler.disconnect();
        break;
      }
      case 'jmap': {
        const handler = new JmapHandler({ email: project.target_email });
        await handler.connect();
        serverResult = await handler.searchMessages(criteria);
        serverResult.protocolLog = handler.getProtocolLog();
        await handler.disconnect();
        break;
      }
    }
  } catch (err) {
    serverResult.error = err.message;
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
    })),
    localResultCount: dbResults.length,
  });
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

    const results = await QualityControlService.runChecks(project, messages, acquisitions, folders, exports, { attachments, driveLinks, driveItems, scope, acquisitionId });
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

  for (const link of result.links) {
    saveDriveLink({ ...link, projectId: project.id });
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
router.post('/projects/:id/timestamp', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { type } = req.body;
  const messages = getAllProjectMessages(project.id);

  let tsResult;
  if (type === 'export') {
    const exports = getExportRecords(project.id);
    const latest = exports[0];
    if (!latest) return res.status(400).json({ error: 'No exports to timestamp' });
    tsResult = TimestampService.timestampExport(project.id, latest.id, {
      manifestHash: latest.hash_sha256,
      fileCount: latest.message_count,
    });
  } else {
    tsResult = TimestampService.timestampCollection(project.id, messages);
  }

  saveTimestampRecord(project.id, tsResult.type, tsResult.collectionDigest || tsResult.manifestHash, tsResult.timestamp);

  addAuditEntry(project.id, 'TIMESTAMP_CREATED', `RFC 3161 timestamp created: ${tsResult.type}`, {
    type: tsResult.type,
    genTime: tsResult.timestamp.genTime,
    serialNumber: tsResult.timestamp.serialNumber,
  }, project.examiner_name);

  res.json(tsResult);
});

router.get('/projects/:id/timestamps', (req, res) => {
  res.json(getTimestampRecords(req.params.id));
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

    const fromAddr = (msg.from_address || '').toLowerCase();
    const targetEmail = (project.target_email || '').toLowerCase();
    if (fromAddr.includes(targetEmail)) buckets[dateKey].sent++;
    else buckets[dateKey].received++;

    hourBuckets[d.getHours()]++;
    dayOfWeekBuckets[d.getDay()]++;
  }

  const timeline = Object.values(buckets).sort((a, b) => a.date.localeCompare(b.date));

  res.json({
    timeline,
    hourDistribution: hourBuckets,
    dayOfWeekDistribution: dayOfWeekBuckets,
    totalMessages: messages.length,
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

  for (const msg of messages) {
    const from = (msg.from_address || '').toLowerCase().trim();
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
      const toAddr = (to || '').toLowerCase().trim();
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
  const byMsgId = {};
  const threads = [];
  const orphans = [];

  for (const msg of messages) {
    if (msg.message_id) byMsgId[msg.message_id] = msg;
  }

  const assigned = new Set();

  function buildThread(root) {
    const thread = [root];
    assigned.add(root.id);
    const children = messages.filter(m =>
      !assigned.has(m.id) && (
        (m.in_reply_to && m.in_reply_to === root.message_id) ||
        (m.headers_json && (() => {
          try {
            const h = typeof m.headers_json === 'string' ? JSON.parse(m.headers_json) : m.headers_json;
            const refs = h.references || h.References || '';
            return refs.includes(root.message_id);
          } catch { return false; }
        })())
      )
    );
    for (const child of children) {
      thread.push(...buildThread(child));
    }
    return thread;
  }

  for (const msg of messages) {
    if (assigned.has(msg.id)) continue;
    const isReply = msg.in_reply_to && byMsgId[msg.in_reply_to];
    if (isReply) continue;

    const thread = buildThread(msg);
    if (thread.length > 1) {
      threads.push({
        rootMessageId: msg.message_id,
        rootSubject: msg.subject,
        rootFrom: msg.from_address,
        rootDate: msg.date,
        messageCount: thread.length,
        participants: [...new Set(thread.map(m => m.from_address).filter(Boolean))],
        dateRange: {
          from: thread.reduce((min, m) => m.date && m.date < min ? m.date : min, thread[0]?.date || ''),
          to: thread.reduce((max, m) => m.date && m.date > max ? m.date : max, thread[0]?.date || ''),
        },
        messages: thread.map(m => ({
          id: m.id, subject: m.subject, from: m.from_address, date: m.date,
          inReplyTo: m.in_reply_to, messageId: m.message_id
        })),
      });
    }
  }

  for (const msg of messages) {
    if (!assigned.has(msg.id)) orphans.push(msg.id);
  }

  const subjectGroups = {};
  for (const id of orphans) {
    const msg = messages.find(m => m.id === id);
    if (!msg) continue;
    const normSubj = (msg.subject || '').replace(/^(Re|Fwd|Fw)\s*:\s*/gi, '').trim().toLowerCase();
    if (!normSubj) continue;
    if (!subjectGroups[normSubj]) subjectGroups[normSubj] = [];
    subjectGroups[normSubj].push(msg);
  }

  for (const [, group] of Object.entries(subjectGroups)) {
    if (group.length > 1) {
      group.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
      threads.push({
        rootMessageId: group[0].message_id,
        rootSubject: group[0].subject,
        rootFrom: group[0].from_address,
        rootDate: group[0].date,
        messageCount: group.length,
        participants: [...new Set(group.map(m => m.from_address).filter(Boolean))],
        dateRange: {
          from: group[0].date,
          to: group[group.length - 1].date,
        },
        threadedBy: 'subject',
        messages: group.map(m => ({
          id: m.id, subject: m.subject, from: m.from_address, date: m.date,
          inReplyTo: m.in_reply_to, messageId: m.message_id
        })),
      });
      group.forEach(m => assigned.add(m.id));
    }
  }

  threads.sort((a, b) => b.messageCount - a.messageCount);

  res.json({
    totalMessages: messages.length,
    threadedMessages: assigned.size,
    singleMessages: messages.length - assigned.size,
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

  const rawDkimSig = headers['dkim-signature'] || headers['DKIM-Signature'] || '';
  const dkimSig = Array.isArray(rawDkimSig) ? rawDkimSig[0] || '' : rawDkimSig;
  const dkimDomain = dkimSig ? (String(dkimSig).match(/d=([^;\s]+)/)?.[1] || null) : null;

  const rawReturnPath = headers['return-path'] || headers['Return-Path'] || '';
  const returnPath = Array.isArray(rawReturnPath) ? rawReturnPath[0] || '' : String(rawReturnPath);
  const rawReplyTo = headers['reply-to'] || headers['Reply-To'] || '';
  const replyTo = Array.isArray(rawReplyTo) ? rawReplyTo[0] || '' : String(rawReplyTo);
  const rawFrom = headers.from || headers.From || msg.from_address || '';
  const fromHeader = Array.isArray(rawFrom) ? rawFrom[0] || '' : String(rawFrom);

  const redFlags = [];
  if (returnPath && fromHeader && !returnPath.toLowerCase().includes(fromHeader.toLowerCase().replace(/.*</, '').replace(/>.*/, '').split('@')[1] || '__none__')) {
    redFlags.push({ type: 'RETURN_PATH_MISMATCH', description: 'Return-Path domain does not match From domain', severity: 'warning' });
  }
  if (replyTo && fromHeader && replyTo.toLowerCase() !== fromHeader.toLowerCase()) {
    redFlags.push({ type: 'REPLY_TO_DIFFERS', description: 'Reply-To differs from From address', severity: 'info' });
  }
  if (authentication.spf === 'fail' || authentication.spf === 'softfail') {
    redFlags.push({ type: 'SPF_FAIL', description: `SPF check ${authentication.spf}ed — sender not authorized`, severity: 'critical' });
  }
  if (authentication.dkim === 'fail') {
    redFlags.push({ type: 'DKIM_FAIL', description: 'DKIM signature verification failed — message may be altered', severity: 'critical' });
  }
  if (authentication.dmarc === 'fail') {
    redFlags.push({ type: 'DMARC_FAIL', description: 'DMARC policy check failed', severity: 'critical' });
  }
  if (dkimDomain && fromHeader && !fromHeader.toLowerCase().includes(dkimDomain.toLowerCase())) {
    redFlags.push({ type: 'DKIM_DOMAIN_MISMATCH', description: `DKIM signed by ${dkimDomain} but From shows different domain`, severity: 'warning' });
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
  const timestamps = getTimestampRecords(project.id);
  const chainVerification = verifyAuditChain(auditLog);

  let config = {};
  try { config = JSON.parse(project.config || '{}'); } catch {}

  const custodyEvents = auditLog.map(entry => ({
    timestamp: entry.timestamp,
    event: entry.event_type,
    description: entry.description,
    handler: entry.examiner || project.examiner_name || 'System',
    hashChain: entry.hash,
    verified: true,
  }));

  const report = {
    reportGenerated: new Date().toISOString(),
    reportVersion: '1.0',
    toolInfo: {
      name: 'SherlockMail',
      version: '0.9.0',
      description: 'Forensic email collection tool',
    },
    caseInfo: {
      projectName: project.name,
      projectId: project.id,
      caseId: project.case_id,
      caseName: project.case_name,
      evidenceId: config.evidenceId || project.agency,
      custodian: config.custodianName || null,
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
    timestampRecords: timestamps.length,
    standards: {
      collection: 'ISO/IEC 27037:2012 — Identification, collection, acquisition, preservation',
      hashing: 'NIST FIPS 180-4 (SHA-256/SHA-512)',
      auditTrail: 'NIST SP 800-86 — Guide to Integrating Forensic Techniques',
      bestPractices: 'SWGDE 18-F-002-2.0 (2025) — Best Practices for Digital Evidence Collection',
      cloudEvidence: 'SWGDE 23-F-004-1.1 — Digital Evidence from Cloud Service Providers',
      principles: 'ACPO Good Practice Guide v5 (2012) — Four Principles for Digital Evidence',
      timestamping: 'RFC 3161 Trusted Timestamping (structure; use production TSA for legal binding)',
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
  if (!EXPORT_FORMATS.has(format)) throw httpError(400, `Unknown export format: ${format}`);
  const messages = only || getAllProjectMessages(project.id);
  if (messages.length === 0) throw httpError(400, 'No messages to export. Collect messages first.');

  const folders = getFolders(project.id);
  const exportId = crypto.randomUUID();
  const acquisitions = getAcquisitions(project.id);
  const options = { provider: project.provider_type || 'Unknown', preserveFolders, project, acquisition: acquisitions[0] || {} };
  if (pdfSplitMode) options.pdfSplitMode = pdfSplitMode;
  if (format === 'pst') { options.pstMaxGb = pstSizeGb(pstMaxGb); options.onProgress = onProgress; }
  const { files, manifest, outputDir, reconstructed } = await ExportService.exportToFiles(project.id, exportId, format, messages, folders, customOutputDir, options);
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);

  saveExportRecord(project.id, format, outputDir, messages.length, totalBytes, manifest.manifestHash);
  updateProjectStatus(project.id, 'exported');

  const tsResult = TimestampService.timestampExport(project.id, exportId, manifest);
  saveTimestampRecord(project.id, 'export', manifest.manifestHash, tsResult.timestamp);

  addAuditEntry(project.id, 'EXPORT_COMPLETED', `${label ? `${label}: ` : ''}Exported ${messages.length} messages to ${format.toUpperCase()}${reconstructed?.length ? ` (${reconstructed.length} reconstructed: original file missing or altered)` : ''}`, {
    exportId, format, outputDir, messageCount: messages.length, totalBytes,
    manifestHash: manifest.manifestHash,
    reconstructed: reconstructed || [],
    fileHashes: files.map(f => ({ filename: f.filename, sha256: f.hash })),
    timestamp: tsResult.timestamp.genTime,
  }, project.examiner_name);

  return {
    exportId,
    format,
    files: files.map(f => ({
      filename: f.filename || f.relativePath,
      size: f.size,
      hash: f.hash,
      downloadUrl: `/api/projects/${project.id}/exports/${exportId}/files/${encodeURIComponent(f.filename || f.relativePath)}`,
    })),
    manifest,
    messageCount: messages.length,
    totalBytes,
    outputDir,
    reconstructedCount: reconstructed?.length || 0,
    timestamp: tsResult.timestamp,
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
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.download(filePath);
});

router.get('/projects/:id/exports/:exportId/download-all', (req, res) => {
  const dir = path.join(DATA_DIR, 'exports', req.params.id, req.params.exportId);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Export not found' });

  const files = fs.readdirSync(dir).map(f => ({
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
  const timestamps = getTimestampRecords(req.params.id);

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
      const result = ExportService.verifyExport(exp.output_dir);
      exportVerification.push({ exportId: exp.id, format: exp.format, ...result });
    } else {
      exportVerification.push({ exportId: exp.id, format: exp.format, valid: false, error: 'Export directory not found' });
    }
  }

  const verification = {
    timestamp: new Date().toISOString(),
    toolVersion: '0.9.0',
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
      timestampStandard: 'RFC 3161 (structure; use production TSA for legal binding)',
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
    const { targetType, targetHash, tsaUrl } = req.body;
    if (!targetHash || !tsaUrl) return res.status(400).json({ error: 'targetHash and tsaUrl required' });
    const result = await Rfc3161TimestampService.requestTimestamp(targetHash, tsaUrl, req.body);
    result.projectId = req.params.id;
    result.targetType = targetType || 'manual';
    saveRfc3161Timestamp(result);
    addAuditEntry(req.params.id, 'RFC3161_TIMESTAMP', `RFC 3161 timestamp requested from ${result.tsaName}`, { tsaUrl, targetType, status: result.status }, project.examiner_name);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/projects/:id/rfc3161/timestamp-collection', async (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const messages = getAllProjectMessages(req.params.id);
    const { tsaUrl } = req.body;
    if (!tsaUrl) return res.status(400).json({ error: 'tsaUrl required' });
    const result = await Rfc3161TimestampService.timestampCollection(req.params.id, messages, tsaUrl, req.body);
    saveRfc3161Timestamp(result);
    addAuditEntry(req.params.id, 'RFC3161_COLLECTION_TIMESTAMP', `Collection timestamped via RFC 3161 (${messages.length} messages)`, { tsaUrl, messageCount: messages.length, status: result.status }, project.examiner_name);
    res.json(result);
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
router.post('/projects/:id/snapshots', (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const folders = getFolders(req.params.id);
    const { snapshotType, acquisitionId } = req.body;
    const snapshot = FolderSnapshotService.captureSnapshot(req.params.id, folders, acquisitionId, snapshotType || 'manual');
    saveFolderSnapshot(snapshot);
    addAuditEntry(req.params.id, 'FOLDER_SNAPSHOT', `Folder snapshot captured (${snapshot.totalFolders} folders, ${snapshot.totalMessages} messages)`, { snapshotType: snapshotType || 'manual', totalFolders: snapshot.totalFolders }, project.examiner_name);
    res.json(snapshot);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/projects/:id/snapshots', (req, res) => {
  res.json(getFolderSnapshots(req.params.id));
});

router.post('/projects/:id/snapshots/compare', (req, res) => {
  try {
    const snapshots = getFolderSnapshots(req.params.id);
    if (snapshots.length < 2) return res.status(400).json({ error: 'Need at least 2 snapshots to compare' });
    const pre = snapshots[snapshots.length - 1];
    const post = snapshots[0];
    res.json(FolderSnapshotService.compareSnapshots(pre, post));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════
// ── CATEGORY 2: Protocol & Provider Coverage (Features 4-9) ──
// ══════════════════════════════════════════════════════════════

// Feature 4: Yahoo OAuth
router.get('/oauth/yahoo/status', (req, res) => { res.json(yahooGetAuthStatus()); });
router.post('/oauth/yahoo/credentials', (req, res) => {
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
    let result;
    if (method === 'certificate') result = await EnterpriseAuthService.authenticateWithCertificate(req.body);
    else result = await EnterpriseAuthService.authenticateAppOnly(req.body);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Feature 8: Remote Token Import
router.post('/enterprise/import-token', async (req, res) => {
  try {
    const result = await EnterpriseAuthService.importToken(req.body.tokenData || req.body);
    res.json(result);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Feature 6: Exchange Advanced Features
router.get('/projects/:id/exchange/recoverable-items', async (req, res) => {
  try {
    const result = await ExchangeAdvancedService.getRecoverableItems(null, req.query.email, req.query);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/projects/:id/exchange/public-folders', async (req, res) => {
  try { res.json(await ExchangeAdvancedService.getPublicFolders(null, req.query)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/projects/:id/exchange/archive', async (req, res) => {
  try { res.json(await ExchangeAdvancedService.getArchiveMailbox(null, req.query.email, req.query)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/projects/:id/exchange/inbox-rules', async (req, res) => {
  try { res.json(await ExchangeAdvancedService.getInboxRules(null, req.query.email)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/exchange/detect-version', async (req, res) => {
  try { res.json(await ExchangeAdvancedService.detectExchangeVersion(req.query.host)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Feature 7: Local File Import (MBOX/PST/EML)
router.post('/projects/:id/import', async (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const { filePath, format, targetFolder } = req.body;
    if (!filePath) return res.status(400).json({ error: 'filePath required' });
    if (!fs.existsSync(filePath)) return res.status(400).json({ error: 'File not found' });

    let result;
    const ext = (format || path.extname(filePath).slice(1)).toLowerCase();
    if (ext === 'mbox' || ext === 'mbx') {
      result = await LocalImportService.importMbox(filePath, req.params.id, { targetFolder });
    } else if (ext === 'pst') {
      if (activeCollections.has(project.id)) return res.status(409).json({ error: 'Wait for the running collection to finish before importing' });
      const importId = `pst_${new Date().toISOString().replace(/[:.]/g, '-')}`;
      result = await LocalImportService.importPst(filePath, req.params.id, {
        targetFolder, outputDir: path.join(DATA_DIR, 'imports', req.params.id, importId), save: batch => saveMessagesBatch(batch),
      });
      addAuditEntry(req.params.id, 'PST_IMPORTED', `Imported ${result.successful} items from ${path.basename(filePath)}${result.failed ? ` (${result.failed} could not be read)` : ''}; rebuilt as EML from PST properties`, {
        source: filePath, sourceSha256: result.sourceSha256, sourceUnchanged: result.sourceUnchanged, outputDir: result.outputDir, pstFormat: result.pstFormat, displayName: result.displayName, passwordProtected: result.passwordProtected,
        successful: result.successful, failed: result.failed, folderErrors: result.folderErrors, errors: result.errors,
      }, project.examiner_name);
      return res.json(result);
    } else if (ext === 'eml' || fs.statSync(filePath).isDirectory()) {
      result = await LocalImportService.importEmlDirectory(filePath, req.params.id, { targetFolder });
    } else {
      return res.status(400).json({ error: `Unsupported format: ${ext}. Supported: mbox, pst, eml` });
    }

    for (const msg of result.messages.filter(m => !m.error)) {
      saveMessage(msg);
      if (msg.attachments) for (const att of msg.attachments) saveAttachment({ ...att, messageId: msg.id });
    }

    addAuditEntry(req.params.id, 'LOCAL_IMPORT', `Imported ${result.successful} messages from ${ext.toUpperCase()} file`, { source: filePath, format: ext, total: result.totalParsed || result.totalFiles, successful: result.successful, failed: result.failed }, project.examiner_name);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/import/formats', (req, res) => {
  res.json(LocalImportService.getSupportedFormats());
});

// ══════════════════════════════════════════════════════════════
// ── CATEGORY 3: Cloud & Drive Collection (Features 10-15) ──
// ══════════════════════════════════════════════════════════════

// Feature 10: Google Drive Collection
router.get('/projects/:id/drive/google/items', async (req, res) => {
  try {
    const result = await CloudCollectionService.listGoogleDriveItems(req.query.accessToken, req.query);
    for (const item of result.items) { item.projectId = req.params.id; saveDriveItem(item); }
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/projects/:id/drive/google/shared-drives', async (req, res) => {
  try { res.json(await CloudCollectionService.listGoogleSharedDrives(req.query.accessToken)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/projects/:id/drive/google/revisions/:fileId', async (req, res) => {
  try { res.json(await CloudCollectionService.getGoogleDriveRevisions(req.query.accessToken, req.params.fileId)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Feature 11: OneDrive Collection
router.get('/projects/:id/drive/onedrive/items', async (req, res) => {
  try {
    const result = await CloudCollectionService.listOneDriveItems(req.query.accessToken, req.query);
    for (const item of result.items) { item.projectId = req.params.id; saveDriveItem(item); }
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/projects/:id/drive/onedrive/revisions/:itemId', async (req, res) => {
  try { res.json(await CloudCollectionService.getOneDriveRevisions(req.query.accessToken, req.params.itemId, req.query.userId)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Feature 12: SharePoint Collection
router.get('/projects/:id/drive/sharepoint/sites', async (req, res) => {
  try { res.json(await CloudCollectionService.listSharePointSites(req.query.accessToken, req.query.search)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/projects/:id/drive/sharepoint/documents/:siteId', async (req, res) => {
  try { res.json(await CloudCollectionService.listSharePointDocuments(req.query.accessToken, req.params.siteId, req.query)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Feature 13: Google Calendar Collection
router.get('/projects/:id/calendar/events', async (req, res) => {
  try {
    const result = await CloudCollectionService.listGoogleCalendarEvents(req.query.accessToken, req.query);
    for (const evt of result.events) { evt.projectId = req.params.id; saveCalendarEvent(evt); }
    addAuditEntry(req.params.id, 'CALENDAR_COLLECTED', `Collected ${result.events.length} calendar events`);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/projects/:id/calendar', (req, res) => {
  res.json(getCalendarEvents(req.params.id));
});

// Feature 14: Contact Collection
router.get('/projects/:id/contacts/google', async (req, res) => {
  try {
    const result = await CloudCollectionService.listGoogleContacts(req.query.accessToken, req.query);
    for (const c of result.contacts) { c.projectId = req.params.id; saveContact(c); }
    addAuditEntry(req.params.id, 'CONTACTS_COLLECTED', `Collected ${result.contacts.length} Google contacts`);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/projects/:id/contacts/microsoft', async (req, res) => {
  try {
    const result = await CloudCollectionService.listMicrosoftContacts(req.query.accessToken, req.query);
    for (const c of result.contacts) { c.projectId = req.params.id; saveContact(c); }
    addAuditEntry(req.params.id, 'CONTACTS_COLLECTED', `Collected ${result.contacts.length} Microsoft contacts`);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/projects/:id/contacts', (req, res) => {
  res.json(getContacts(req.params.id));
});

// Feature 15: Cloud Attachment Download Pipeline
router.post('/projects/:id/cloud-attachments/download', async (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const links = getDriveLinks(req.params.id);
    if (links.length === 0) return res.json({ totalLinks: 0, downloaded: 0, message: 'No cloud links to download' });
    const outputDir = path.join(DATA_DIR, 'projects', req.params.id);
    const result = await CloudDownloadPipeline.processLinks(req.params.id, links, req.body.accessTokens || {}, outputDir);
    for (const dl of result.results) saveCloudDownload(dl);
    addAuditEntry(req.params.id, 'CLOUD_ATTACHMENTS_DOWNLOADED', `Downloaded ${result.downloaded} of ${result.totalLinks} cloud attachments`, { downloaded: result.downloaded, failed: result.failed, totalBytes: result.totalBytes }, project.examiner_name);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
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
router.post('/projects/:id/export/vhdx', (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const exportDir = req.body.exportDir || path.join(DATA_DIR, 'exports', req.params.id);
    if (!fs.existsSync(exportDir)) return res.status(400).json({ error: 'Export directory not found — run an export first' });
    const outputPath = req.body.outputPath || path.join(DATA_DIR, 'exports', req.params.id, `evidence_${Date.now()}.vhdx`);
    const result = ContainerService.createVhdxContainer(exportDir, outputPath, { label: project.name });
    addAuditEntry(req.params.id, 'VHDX_CREATED', `VHDX container created (${result.fileCount} files, ${result.size} bytes)`, { outputPath, hashes: result.hashes }, project.examiner_name);
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
    }
    res.json(report);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Feature 19: Revision Report
router.get('/projects/:id/reports/revisions', (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const driveItems = getDriveItems(req.params.id);
    const report = ReportService.generateRevisionReport(project, driveItems, []);
    res.json(report);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Feature 20: Log Compression
router.post('/projects/:id/logs/compress', async (req, res) => {
  try {
    const logsDir = req.body.logsDir || path.join(DATA_DIR, 'logs', req.params.id);
    const outputPath = req.body.outputPath || path.join(DATA_DIR, 'exports', req.params.id, `logs_${Date.now()}.zip`);
    const result = await ReportService.compressLogs(req.params.id, logsDir, outputPath);
    if (result.compressed) {
      addAuditEntry(req.params.id, 'LOGS_COMPRESSED', `${result.fileCount} log files compressed`, { outputPath, hash: result.hash });
    }
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════
// ── CATEGORY 5: Search & Filtering (Features 21-23) ──
// ══════════════════════════════════════════════════════════════

// Feature 21: Pre-Acquisition Server-Side Search
router.post('/projects/:id/search/pre-acquisition', async (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const result = await AdvancedSearchService.preAcquisitionSearch({ client: null }, req.body.criteria || req.body);
    result.projectId = req.params.id;
    savePreAcquisitionSearch(result);
    addAuditEntry(req.params.id, 'PRE_ACQUISITION_SEARCH', `Pre-acquisition search: ${result.resultCount} matches`, { criteria: req.body.criteria || req.body, resultCount: result.resultCount });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/projects/:id/search/pre-acquisition', (req, res) => {
  res.json(getPreAcquisitionSearches(req.params.id));
});

// Feature 22: Full-Text Index Search
router.post('/projects/:id/search/index', (req, res) => {
  try {
    const messages = getAllProjectMessages(req.params.id);
    let indexed = 0;
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
    const plan = AdvancedSearchService.computeDifferentialPlan(messages, folders);
    res.json(plan);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/projects/:id/differential/ids', (req, res) => {
  res.json(getDifferentialIds(req.params.id));
});

// ══════════════════════════════════════════════════════════════
// ── CATEGORY 6: Automation & Operations (Features 24-31) ──
// ══════════════════════════════════════════════════════════════

// Feature 24: SMTP Notifications
router.post('/notifications/smtp/settings', (req, res) => {
  try {
    const settings = { id: req.body.id || crypto.randomUUID(), ...req.body };
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
    const result = await AutomationService.sendNotification(req.body, {
      type: 'test',
      projectName: 'Test Notification',
      details: { message: 'This is a test notification from SherlockMail' },
    });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Feature 25: CLI Commands Info
router.get('/cli/commands', (req, res) => {
  res.json(AutomationService.getCliCommands());
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
router.post('/acquisitions/batch', (req, res) => {
  try {
    const { targets } = req.body;
    if (!targets || !targets.length) return res.status(400).json({ error: 'targets array required' });
    const batch = AutomationService.createBatch(targets);
    for (const target of batch.targets) {
      const project = createProject({
        name: `Batch — ${target.targetEmail}`,
        targetEmail: target.targetEmail,
        providerType: target.providerType,
        caseName: req.body.caseName,
        caseId: req.body.caseId,
        examinerName: req.body.examinerName,
      });
      target.projectId = project.id;
      saveAcquisitionTarget(target);
    }
    res.json(batch);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/acquisitions/batch/:batchId', (req, res) => {
  res.json(getAcquisitionTargets(req.params.batchId));
});

// Feature 29: Connectivity Testing
router.post('/connectivity/test', async (req, res) => {
  try {
    const { host, port, protocol } = req.body;
    if (!host) return res.status(400).json({ error: 'host required' });
    const result = await AutomationService.testConnectivity(host, port || 993, protocol || 'imaps', req.body);
    if (req.body.projectId) { result.projectId = req.body.projectId; saveConnectivityTest(result); }
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/projects/:id/connectivity/tests', (req, res) => {
  res.json(getConnectivityTests(req.params.id));
});

// Feature 30: Proxy Support
router.post('/proxy/settings', (req, res) => {
  try {
    const proxy = { id: crypto.randomUUID(), ...req.body };
    saveProxySettings(proxy);
    res.json({ success: true, id: proxy.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
router.post('/projects/:id/crypto/decrypt', async (req, res) => {
  try {
    const certs = getCertificates(req.params.id);
    const result = await CryptoService.decryptMessage(req.body.content, certs);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Feature 33: Digital Signature Verification
router.post('/projects/:id/crypto/verify-signature', async (req, res) => {
  try {
    const result = await CryptoService.verifySignature(req.body.content, req.body.options);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Certificate management
router.post('/certificates', (req, res) => {
  try {
    const cert = { id: crypto.randomUUID(), ...req.body };
    saveCertificate(cert);
    addAuditEntry(req.body.projectId, 'CERTIFICATE_IMPORTED', `Certificate imported: ${cert.subject || cert.email_address || 'unknown'}`, { certType: cert.certType, thumbprint: cert.thumbprintSha256 });
    res.json({ success: true, id: cert.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
    const cred = { id: crypto.randomUUID(), label, credentialType, targetHost, username, ...encrypted, metadata: req.body.metadata || {} };
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
    const decrypted = CryptoService.decryptCredential(cred.encrypted_data, cred.iv, cred.auth_tag, masterKey);
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

router.post('/projects/:id/metadata-export', (req, res) => {
  try {
    const { type, format } = req.body;
    if (!type) return res.status(400).json({ error: 'type required (email, attachment, calendar, contact, document, drive, audit, hash, timestamp, snapshot)' });

    let data;
    switch (type) {
      case 'email': data = getAllProjectMessages(req.params.id); break;
      case 'attachment': data = getProjectAttachments(req.params.id); break;
      case 'calendar': data = getCalendarEvents(req.params.id); break;
      case 'contact': data = getContacts(req.params.id); break;
      case 'drive': data = getDriveItems(req.params.id); break;
      case 'audit': data = getFullAuditLog(req.params.id); break;
      case 'timestamp': data = getRfc3161Timestamps(req.params.id); break;
      case 'snapshot': data = getFolderSnapshots(req.params.id); break;
      default: data = [];
    }

    const csv = MetadataExportService.exportToString(data, type, format || 'csv');
    const ext = (format === 'tsv') ? 'tsv' : 'csv';
    res.setHeader('Content-Type', format === 'tsv' ? 'text/tab-separated-values' : 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${type}_export.${ext}"`);
    res.send(csv);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/projects/:id/metadata-export/file', (req, res) => {
  try {
    const { type, format, outputPath } = req.body;
    if (!type || !outputPath) return res.status(400).json({ error: 'type and outputPath required' });

    let data;
    switch (type) {
      case 'email': data = getAllProjectMessages(req.params.id); break;
      case 'attachment': data = getProjectAttachments(req.params.id); break;
      case 'calendar': data = getCalendarEvents(req.params.id); break;
      case 'contact': data = getContacts(req.params.id); break;
      case 'drive': data = getDriveItems(req.params.id); break;
      case 'audit': data = getFullAuditLog(req.params.id); break;
      case 'timestamp': data = getRfc3161Timestamps(req.params.id); break;
      case 'snapshot': data = getFolderSnapshots(req.params.id); break;
      default: data = [];
    }

    const result = MetadataExportService.exportToFile(data, type, outputPath, format || 'csv');
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
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
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });
    res.json(await AutomationService.exchangeAutoDiscover(email));
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
    res.json(AutomationService.createOutputFolder(baseDir, projectName, targetEmail, { counter }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Retry Policy & Rate Limiter Status ──
router.get('/resilience/info', (req, res) => {
  res.json({
    retryPolicy: { description: 'Exponential backoff with jitter', maxRetries: 3, retryableErrors: ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'EAI_AGAIN'], retryableStatusCodes: [408, 429, 500, 502, 503, 504] },
    circuitBreaker: { description: 'Trips after consecutive failures, auto-resets', states: ['closed', 'open', 'half-open'], failureThreshold: 5, resetTimeoutMs: 60000 },
    rateLimiter: { description: 'Token-bucket rate limiting', defaultMaxRequests: 30, defaultWindowMs: 60000 },
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

export default router;
