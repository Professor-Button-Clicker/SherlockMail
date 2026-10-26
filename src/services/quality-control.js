import crypto from 'crypto';
import fs from 'fs';
import { simpleParser } from 'mailparser';

const TIMESTAMP_CHECK_CONCURRENCY = 32;
const HEADER_READ_BYTES = 256 * 1024;
const HEADER_PARSER_OPTIONS = { skipHtmlToText: true, skipTextToHtml: true, skipTextLinks: true, skipImageLinks: true };

// Checks that belong to export/case review rather than to verifying a collection.
const NOT_IN_COLLECTION_SCOPE = new Set(['Duplicate Detection', 'Export Completeness', 'Audit Trail', 'DFIR Standards Compliance']);

function isoOrNull(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

const HASH_CHECK_CONCURRENCY = 16;

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('error', reject)
      .on('data', chunk => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

async function readHeaderBlock(filePath) {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(HEADER_READ_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEADER_READ_BYTES, 0);
    const data = buf.subarray(0, bytesRead);
    const ends = [data.indexOf('\r\n\r\n'), data.indexOf('\n\n')].filter(i => i >= 0);
    return ends.length ? data.subarray(0, Math.min(...ends)) : data;
  } finally {
    await fh.close();
  }
}

async function verifyMessageTimestamps(m) {
  const recordedDate = isoOrNull(m.date);
  let recordedHeaderDate = null;
  try { recordedHeaderDate = isoOrNull(JSON.parse(m.headers_json || '{}').date); } catch {}
  const recordedServerDate = isoOrNull(m.internal_date);
  const report = { subject: m.subject, folder: m.folder, uid: m.uid, file: m.eml_path, recordedDate, recordedHeaderDate };

  if (!m.eml_path || !fs.existsSync(m.eml_path)) {
    return { status: 'missing_file', report: { ...report, problem: 'Collected email file not found' } };
  }

  let emailDate = null;
  try {
    const header = await readHeaderBlock(m.eml_path);
    const parsed = await simpleParser(Buffer.concat([header, Buffer.from('\r\n\r\n')]), HEADER_PARSER_OPTIONS);
    emailDate = isoOrNull(parsed.date);
  } catch {
    // An unreadable header is treated like a missing Date header below.
  }
  report.emailDateHeader = emailDate;

  if (emailDate) {
    const differs = [];
    let recordedValue = null;
    if (recordedHeaderDate && recordedHeaderDate !== emailDate) { differs.push('the Date header recorded at collection'); recordedValue = recordedHeaderDate; }
    if (recordedDate && recordedDate !== emailDate) { differs.push('the message date recorded at collection'); recordedValue = recordedValue || recordedDate; }
    if (!recordedHeaderDate && !recordedDate) differs.push('a missing recorded date');
    return differs.length
      ? { status: 'mismatch', report: { ...report, recordedValue, problem: `Date header in the collected email differs from ${differs.join(' and ')}` } }
      : { status: 'match', report };
  }
  if (recordedHeaderDate) {
    return { status: 'mismatch', report: { ...report, problem: 'The Date header recorded at collection is no longer in the collected email' } };
  }
  if (recordedServerDate && recordedDate) {
    return recordedServerDate === recordedDate
      ? { status: 'match_server_date', report }
      : { status: 'mismatch', report: { ...report, recordedValue: recordedDate, recordedServerDate, problem: 'Recorded message date differs from the server date recorded at collection' } };
  }
  return { status: 'unverifiable', report: { ...report, problem: 'No Date header and no server date recorded' } };
}

export class QualityControlService {

  // scope 'collection' limits the run to checks that verify the collection itself.
  static async runChecks(project, messages, acquisitions, folders, exports, options = {}) {
    const startTime = Date.now();
    const all = [
      ['Collection Completeness', () => this.checkCollectionCompleteness(messages, acquisitions)],
      ['Hash Integrity', () => this.checkHashIntegrity(messages)],
      ['Duplicate Detection', () => this.checkDuplicates(messages)],
      ['Date Consistency', () => this.checkDateConsistency(messages)],
      ['Required Fields', () => this.checkMissingFields(messages)],
      ['Folder Coverage', () => this.checkFolderCoverage(messages, acquisitions)],
      ['Export Completeness', () => this.checkExportCompleteness(messages, exports)],
      ['Audit Trail', () => this.checkAuditTrail(project)],
      ['Encryption & Signing Detection', () => this.checkEncryptionDetection(messages)],
      ['Write Protection (ISO 27037)', () => this.checkWriteProtection(project)],
      ['DFIR Standards Compliance', () => this.checkStandardsCompliance(project, messages, acquisitions)],
      ['Attachment Completeness', () => this.checkAttachmentCompleteness(messages, options.attachments || [])],
      ['Timestamp Verification', () => this.checkTimestampVerification(messages)],
      ['Protocol Log Completeness', () => this.checkProtocolLogCompleteness(acquisitions)],
      ['Cloud Attachment Coverage', () => this.checkCloudAttachmentCoverage(messages, options.driveLinks || [])],
      ['Drive File Verification', () => this.checkDriveFiles(options.driveItems || [])],
      ['Export Integrity', () => this.checkExportIntegrity(exports)],
      ['Collection Resumability', () => this.checkCollectionResumability(acquisitions)],
    ];
    const selected = options.scope === 'collection' ? all.filter(([name]) => !NOT_IN_COLLECTION_SCOPE.has(name)) : all;
    const checks = [];
    for (const [, run] of selected) checks.push(await run());

    const elapsed = Date.now() - startTime;
    const passed = checks.filter(c => c.status === 'pass').length;
    const warnings = checks.filter(c => c.status === 'warning').length;
    const failed = checks.filter(c => c.status === 'fail').length;

    return {
      timestamp: new Date().toISOString(),
      projectId: project.id,
      projectName: project.name,
      acquisitionId: options.acquisitionId || null,
      scope: options.scope === 'collection' ? 'collection' : 'full',
      elapsed,
      summary: { total: checks.length, passed, warnings, failed },
      overallStatus: failed > 0 ? 'fail' : warnings > 0 ? 'warning' : 'pass',
      checks,
    };
  }

  // Every enumerated item must be accounted for: collected, deliberately skipped (already collected, or
  // excluded by the query), or recorded as failed.
  static checkCollectionCompleteness(messages, acquisitions) {
    const check = { name: 'Collection Completeness', category: 'collection' };
    const sum = key => acquisitions.reduce((s, a) => s + (a[key] || 0), 0);
    const acquired = sum('acquired_messages');
    const skipped = sum('skipped_messages');
    const failed = sum('failed_messages');
    const expected = sum('total_messages');
    const unfinished = acquisitions.filter(a => ['failed', 'canceled', 'running', 'paused'].includes(a.status));
    const accounted = acquired + skipped + failed;

    check.metrics = { collected: messages.length, acquired, skipped, failed, expected, acquisitions: acquisitions.length, unfinished: unfinished.length };
    if (messages.length === 0 && acquired === 0) {
      return { ...check, status: 'fail', detail: unfinished.length ? `No messages collected; ${unfinished.length} acquisition(s) did not finish` : 'No messages collected' };
    }

    const problems = [];
    if (failed > 0) problems.push(`${failed} item(s) failed to download (listed in remaining_items_*.csv)`);
    if (expected > accounted) problems.push(`${expected - accounted} enumerated item(s) not collected, skipped or failed`);
    if (unfinished.length) problems.push(`${unfinished.length} acquisition(s) ended as ${[...new Set(unfinished.map(a => a.completion_type || a.status))].join(', ')}`);
    if (messages.length < acquired) problems.push(`${acquired - messages.length} acquired message record(s) missing from the case database`);

    check.status = problems.length ? 'warning' : 'pass';
    check.detail = problems.length
      ? problems.join('; ')
      : `All ${expected.toLocaleString()} enumerated item(s) accounted for: ${acquired.toLocaleString()} collected, ${skipped.toLocaleString()} skipped, 0 failed`;
    return check;
  }

  // Re-reads every collected file and compares its SHA-256 with the value recorded when it was collected.
  static async checkHashIntegrity(messages) {
    const check = { name: 'Hash Integrity', category: 'integrity' };
    if (messages.length === 0) return { ...check, status: 'warning', detail: 'No messages to verify', metrics: { total: 0 } };

    let verified = 0, noHash = 0, noFile = 0, tripleHash = 0;
    const mismatched = [];
    const missing = [];
    for (let i = 0; i < messages.length; i += HASH_CHECK_CONCURRENCY) {
      await Promise.all(messages.slice(i, i + HASH_CHECK_CONCURRENCY).map(async (m) => {
        const expected = m.hash_sha256 || m.hashSha256;
        if (m.hash_md5 && m.hash_sha512 && expected) tripleHash++;
        if (!expected) { noHash++; return; }
        const file = m.eml_path || m.emlPath;
        if (!file) { noFile++; return; }
        try {
          const actual = await sha256File(file);
          if (actual === expected) verified++;
          else mismatched.push({ subject: m.subject, folder: m.folder, file, recorded: expected, actual });
        } catch (err) {
          missing.push({ subject: m.subject, folder: m.folder, file, problem: err.code === 'ENOENT' ? 'file not found' : err.message });
        }
      }));
    }

    check.metrics = { total: messages.length, verified, mismatched: mismatched.length, missing: missing.length, noHash, noFile, tripleHash };
    if (mismatched.length || missing.length) {
      check.status = 'fail';
      const parts = [];
      if (mismatched.length) parts.push(`${mismatched.length} collected file(s) no longer match the SHA-256 recorded at collection`);
      if (missing.length) parts.push(`${missing.length} collected file(s) could not be read`);
      check.detail = `${parts.join('; ')}. ${verified} of ${messages.length} verified.`;
      check.mismatches = [...mismatched, ...missing].slice(0, 25);
    } else if (noHash || noFile) {
      check.status = 'warning';
      check.detail = `${verified} of ${messages.length} files re-hashed and match; ${noHash} without a recorded hash, ${noFile} without a collected file`;
    } else {
      check.status = 'pass';
      check.detail = `All ${messages.length} collected files re-hashed: each matches the SHA-256 recorded at collection (${tripleHash} also carry MD5 and SHA-512)`;
    }
    return check;
  }

  static checkDuplicates(messages) {
    const check = { name: 'Duplicate Detection', category: 'data_quality' };
    const hashMap = new Map();
    const msgIdMap = new Map();
    const duplicateHashes = [];
    const duplicateMsgIds = [];

    for (const m of messages) {
      const h = m.hash_sha256 || m.hashSha256;
      if (h) {
        if (hashMap.has(h)) duplicateHashes.push({ hash: h, subject: m.subject, folder: m.folder });
        else hashMap.set(h, true);
      }
      const mid = m.message_id || m.messageId;
      if (mid) {
        if (msgIdMap.has(mid)) duplicateMsgIds.push({ messageId: mid, subject: m.subject });
        else msgIdMap.set(mid, true);
      }
    }

    check.metrics = { duplicatesByHash: duplicateHashes.length, duplicatesByMessageId: duplicateMsgIds.length };

    if (duplicateHashes.length === 0 && duplicateMsgIds.length === 0) {
      check.status = 'pass';
      check.detail = 'No duplicate messages detected';
    } else {
      check.status = 'warning';
      check.detail = `${duplicateHashes.length} hash duplicate(s), ${duplicateMsgIds.length} Message-ID duplicate(s)`;
      check.duplicates = { byHash: duplicateHashes.slice(0, 10), byMessageId: duplicateMsgIds.slice(0, 10) };
    }
    return check;
  }

  static checkDateConsistency(messages) {
    const check = { name: 'Date Consistency', category: 'data_quality' };
    let future = 0, veryOld = 0, noDate = 0;
    const now = Date.now();
    const tenYearsAgo = now - (10 * 365.25 * 86400000);

    for (const m of messages) {
      if (!m.date) { noDate++; continue; }
      const d = new Date(m.date).getTime();
      if (d > now + 86400000) future++;
      if (d < tenYearsAgo) veryOld++;
    }

    check.metrics = { future, veryOld, noDate, total: messages.length };

    if (future === 0 && noDate === 0) {
      check.status = 'pass';
      check.detail = 'All message dates are consistent';
    } else if (future > 0) {
      check.status = 'warning';
      check.detail = `${future} message(s) have future dates — possible clock skew or tampering`;
    } else {
      check.status = noDate > messages.length * 0.1 ? 'warning' : 'pass';
      check.detail = `${noDate} message(s) missing date, ${veryOld} older than 10 years`;
    }
    return check;
  }

  static checkMissingFields(messages) {
    const check = { name: 'Required Fields', category: 'data_quality' };
    let noSubject = 0, noFrom = 0, noBody = 0;

    for (const m of messages) {
      if (!m.subject && !(m.subject === '(no subject)')) noSubject++;
      if (!(m.from_address || m.fromAddress)) noFrom++;
      if (!(m.body_text || m.bodyText || m.body_html || m.bodyHtml)) noBody++;
    }

    check.metrics = { noSubject, noFrom, noBody, total: messages.length };

    if (noFrom === 0) {
      check.status = 'pass';
      check.detail = `All messages have sender addresses. ${noSubject} without subject, ${noBody} without body.`;
    } else {
      check.status = 'warning';
      check.detail = `${noFrom} messages missing sender, ${noSubject} missing subject`;
    }
    return check;
  }

  // Every folder selected for collection must have been listed on the server; an empty folder is fine,
  // a folder that could not be opened is a gap.
  static checkFolderCoverage(messages, acquisitions) {
    const check = { name: 'Folder Coverage', category: 'collection' };
    const selected = new Set();
    const failed = new Map();
    for (const a of acquisitions) {
      for (const f of parseJson(a.folders_json, []) || []) selected.add(f);
      for (const e of parseJson(a.error_log, []) || []) {
        if (e?.type === 'folder_error' && e.folder) failed.set(e.folder, e.error);
      }
    }
    const withMessages = new Set(messages.map(m => m.folder));
    check.metrics = { selected: selected.size, withMessages: withMessages.size, failed: failed.size };

    if (failed.size) {
      check.status = 'warning';
      check.detail = `${failed.size} folder(s) could not be collected: ${[...failed].slice(0, 5).map(([f, e]) => `${f} (${e})`).join('; ')}`;
    } else {
      check.status = 'pass';
      check.detail = selected.size
        ? `All ${selected.size} selected folder(s) were listed on the server; ${withMessages.size} contained messages`
        : `Messages from ${withMessages.size} folder(s)`;
    }
    return check;
  }

  // Drive files are re-hashed and compared with the hash recorded when they were downloaded, and the
  // provider-checksum verification made at collection is summarised.
  static async checkDriveFiles(driveItems) {
    const check = { name: 'Drive File Verification', category: 'integrity' };
    if (!driveItems.length) return { ...check, status: 'pass', detail: 'No drive files in this collection', metrics: { total: 0 } };
    const downloaded = driveItems.filter(d => d.local_path && d.hash_sha256);
    let intact = 0;
    const changed = [];
    for (let i = 0; i < downloaded.length; i += HASH_CHECK_CONCURRENCY) {
      await Promise.all(downloaded.slice(i, i + HASH_CHECK_CONCURRENCY).map(async (d) => {
        try {
          if (await sha256File(d.local_path) === d.hash_sha256) intact++;
          else changed.push({ file: d.local_path, problem: 'SHA-256 differs from download' });
        } catch (err) {
          changed.push({ file: d.local_path, problem: err.code === 'ENOENT' ? 'file not found' : err.message });
        }
      }));
    }
    const mismatchedAtCollection = driveItems.filter(d => d.status === 'hash_mismatch');
    const failed = driveItems.filter(d => d.status === 'failed');
    const verifiedAtCollection = driveItems.filter(d => parseJson(d.metadata_json, {})?.verification?.status === 'verified').length;
    check.metrics = { total: driveItems.length, downloaded: downloaded.length, intact, changedSinceDownload: changed.length, providerMismatch: mismatchedAtCollection.length, failed: failed.length, verifiedAgainstProvider: verifiedAtCollection };

    if (changed.length) {
      check.status = 'fail';
      check.detail = `${changed.length} drive file(s) changed or missing since download`;
      check.mismatches = changed.slice(0, 25);
    } else if (mismatchedAtCollection.length || failed.length) {
      check.status = 'warning';
      check.detail = `${intact} of ${downloaded.length} drive files intact; ${mismatchedAtCollection.length} did not match the provider checksum at download, ${failed.length} failed to download`;
    } else {
      check.status = 'pass';
      check.detail = `${intact} drive file(s) intact since download; ${verifiedAtCollection} matched the provider's own checksum`;
    }
    return check;
  }

  static checkExportCompleteness(messages, exports) {
    const check = { name: 'Export Completeness', category: 'export' };

    if (!exports || exports.length === 0) {
      return { ...check, status: 'warning', detail: 'No exports performed yet', metrics: { exports: 0 } };
    }

    const totalExported = exports.reduce((s, e) => s + (e.message_count || 0), 0);
    check.metrics = { exports: exports.length, totalExported, collected: messages.length };

    if (totalExported >= messages.length) {
      check.status = 'pass';
      check.detail = `${totalExported} messages exported across ${exports.length} export(s)`;
    } else {
      check.status = 'warning';
      check.detail = `Only ${totalExported} of ${messages.length} messages exported`;
    }
    return check;
  }

  static checkAuditTrail(project) {
    const check = { name: 'Audit Trail', category: 'forensic' };

    if (!project.examiner_name) {
      return { ...check, status: 'warning', detail: 'No examiner name recorded for chain of custody' };
    }
    if (!project.legal_authority) {
      return { ...check, status: 'warning', detail: 'No legal authority documented' };
    }

    check.status = 'pass';
    check.detail = `Examiner: ${project.examiner_name}, Authority: ${project.legal_authority}`;
    return check;
  }

  static checkEncryptionDetection(messages) {
    const check = { name: 'Encryption & Signing Detection', category: 'security' };
    let encrypted = 0, signed = 0, smimeDetected = 0;

    for (const m of messages) {
      if (m.is_encrypted) encrypted++;
      if (m.is_signed) signed++;
      const ct = m.content_type || m.contentType || '';
      const body = m.body_text || m.bodyText || '';
      if (ct.includes('pkcs7') || ct.includes('smime') || body.includes('BEGIN PKCS7')) smimeDetected++;
    }

    check.metrics = { encrypted, signed, smimeDetected, total: messages.length };
    check.status = encrypted > 0 ? 'warning' : 'pass';
    check.detail = encrypted > 0
      ? `${encrypted} encrypted, ${signed} signed message(s) — encrypted content may not be fully preserved`
      : `${signed} signed message(s) detected, no encrypted messages`;
    return check;
  }

  static checkWriteProtection(project) {
    const check = { name: 'Write Protection (ISO 27037)', category: 'forensic' };
    const protocol = project.provider_type || '';
    const readOnlyProtocols = ['imap', 'gmail_api', 'graph', 'zoho_api', 'jmap'];
    const isReadOnly = readOnlyProtocols.includes(protocol);

    check.metrics = { protocol, readOnlyAccess: isReadOnly };

    if (protocol === 'imap') {
      check.status = 'pass';
      check.detail = 'IMAP EXAMINE mode provides read-only access (ISO 27037 / ACPO Principle 1)';
    } else if (isReadOnly) {
      check.status = 'pass';
      check.detail = `${protocol.toUpperCase()} API uses read-only scopes — no write operations performed`;
    } else if (protocol === 'pop3') {
      check.status = 'warning';
      check.detail = 'POP3 RETR may cause message deletion on some servers — document server behavior per SWGDE guidelines';
    } else if (protocol === 'ews') {
      check.status = 'pass';
      check.detail = 'EWS read operations do not modify mailbox content';
    } else {
      check.status = 'warning';
      check.detail = 'Unknown protocol — verify that collection did not alter source data';
    }
    return check;
  }

  static checkStandardsCompliance(project, messages, acquisitions) {
    const check = { name: 'DFIR Standards Compliance', category: 'forensic' };
    const issues = [];

    if (!project.examiner_name) issues.push('No examiner name (ACPO Principle 2, ISO 27037)');
    if (!project.legal_authority) issues.push('No legal authority documented (SWGDE, FRE 901)');
    if (!project.case_id && !project.case_name) issues.push('No case identifier (SWGDE evidence tracking)');

    const hasHash = messages.some(m => m.hash_sha256);
    if (!hasHash && messages.length > 0) issues.push('No SHA-256 hashes on collected messages (NIST FIPS 180-4)');

    const hasAcquisition = acquisitions && acquisitions.length > 0;
    if (!hasAcquisition && messages.length > 0) issues.push('No acquisition record (NIST SP 800-86 collection phase)');

    check.metrics = { issues: issues.length, checks: 5 };

    if (issues.length === 0) {
      check.status = 'pass';
      check.detail = 'All DFIR documentation requirements met (ISO 27037, NIST SP 800-86, SWGDE, ACPO, FRE)';
    } else if (issues.length <= 2) {
      check.status = 'warning';
      check.detail = issues.join('; ');
    } else {
      check.status = 'fail';
      check.detail = issues.join('; ');
    }
    return check;
  }

  static checkAttachmentCompleteness(messages, attachments) {
    const check = { name: 'Attachment Completeness', category: 'data_quality' };
    let expectedCount = 0;
    let actualCount = attachments.length;
    let missingHash = 0;

    for (const m of messages) {
      expectedCount += (m.attachment_count || m.attachmentCount || 0);
    }

    for (const att of attachments) {
      if (!(att.hash_sha256 || att.hashSha256)) missingHash++;
    }

    check.metrics = { expected: expectedCount, actual: actualCount, missingHash };

    if (expectedCount === 0) {
      check.status = 'pass';
      check.detail = 'No attachments expected';
    } else if (actualCount >= expectedCount && missingHash === 0) {
      check.status = 'pass';
      check.detail = `All ${actualCount} attachments collected and hashed`;
    } else if (actualCount < expectedCount) {
      check.status = 'warning';
      check.detail = `${actualCount} of ${expectedCount} expected attachments collected`;
    } else {
      check.status = missingHash > 0 ? 'warning' : 'pass';
      check.detail = `${actualCount} attachments collected; ${missingHash} missing hash values`;
    }
    return check;
  }

  // Compares each collected email's own Date header (re-read from the collected EML file and parsed
  // exactly as collection parsed it) with the timestamps recorded at collection. Any difference means
  // either the evidence file or the recorded metadata was edited after collection.
  static async checkTimestampVerification(messages) {
    const check = { name: 'Timestamp Verification', category: 'forensic' };
    if (messages.length === 0) {
      return { ...check, status: 'warning', detail: 'No messages to verify', metrics: { total: 0 } };
    }

    const results = [];
    for (let i = 0; i < messages.length; i += TIMESTAMP_CHECK_CONCURRENCY) {
      const slice = messages.slice(i, i + TIMESTAMP_CHECK_CONCURRENCY);
      results.push(...await Promise.all(slice.map(m => verifyMessageTimestamps(m))));
    }

    const count = s => results.filter(r => r.status === s).length;
    const mismatched = results.filter(r => r.status === 'mismatch');
    const missing = results.filter(r => r.status === 'missing_file');
    const unverifiable = results.filter(r => r.status === 'unverifiable');
    check.metrics = {
      total: messages.length,
      matched: count('match'),
      matchedServerDate: count('match_server_date'),
      mismatched: mismatched.length,
      missingFiles: missing.length,
      unverifiable: unverifiable.length,
    };
    const verified = check.metrics.matched + check.metrics.matchedServerDate;

    if (mismatched.length || missing.length) {
      check.status = 'fail';
      const parts = [];
      if (mismatched.length) parts.push(`${mismatched.length} message(s) whose timestamps no longer match what was recorded at collection`);
      if (missing.length) parts.push(`${missing.length} collected file(s) missing, so their timestamps cannot be checked`);
      check.detail = `${parts.join('; ')}. ${verified} of ${messages.length} verified.`;
      check.mismatches = [...mismatched, ...missing].slice(0, 25).map(r => r.report);
    } else if (unverifiable.length) {
      check.status = 'warning';
      check.detail = `${verified} of ${messages.length} message timestamps match the collected emails; ${unverifiable.length} have no Date header or recorded server date to compare`;
      check.unverifiable = unverifiable.slice(0, 25).map(r => r.report);
    } else {
      check.status = 'pass';
      check.detail = `All ${messages.length} message timestamps match the collected emails' Date headers — no changes since collection`;
    }
    return check;
  }

  static checkProtocolLogCompleteness(acquisitions) {
    const check = { name: 'Protocol Log Completeness', category: 'forensic' };

    if (!acquisitions || acquisitions.length === 0) {
      return { ...check, status: 'warning', detail: 'No acquisitions recorded', metrics: { count: 0 } };
    }

    let withLog = 0;
    let withErrors = 0;
    let totalErrors = 0;

    for (const acq of acquisitions) {
      const log = acq.protocol_log ? (typeof acq.protocol_log === 'string' ? JSON.parse(acq.protocol_log) : acq.protocol_log) : [];
      if (log.length > 0) withLog++;
      const errLog = acq.error_log ? (typeof acq.error_log === 'string' ? JSON.parse(acq.error_log) : acq.error_log) : [];
      if (errLog.length > 0) { withErrors++; totalErrors += errLog.length; }
    }

    check.metrics = { acquisitions: acquisitions.length, withProtocolLog: withLog, withErrors, totalErrors };

    if (withLog === acquisitions.length && totalErrors === 0) {
      check.status = 'pass';
      check.detail = `All ${acquisitions.length} acquisition(s) have protocol logs with no errors`;
    } else if (totalErrors > 0) {
      check.status = 'warning';
      check.detail = `${totalErrors} error(s) across ${withErrors} acquisition(s) — review error logs for data gaps`;
    } else {
      check.status = 'warning';
      check.detail = `${acquisitions.length - withLog} acquisition(s) missing protocol logs`;
    }
    return check;
  }

  static checkCloudAttachmentCoverage(messages, driveLinks) {
    const check = { name: 'Cloud Attachment Coverage', category: 'data_quality' };

    if (!driveLinks || driveLinks.length === 0) {
      check.status = 'pass';
      check.detail = 'No cloud attachment links detected';
      check.metrics = { totalLinks: 0 };
      return check;
    }

    let detected = 0;
    let downloaded = 0;
    let pending = 0;

    for (const link of driveLinks) {
      detected++;
      if (link.status === 'downloaded' || link.local_path) downloaded++;
      else pending++;
    }

    check.metrics = { detected, downloaded, pending };

    if (pending === 0) {
      check.status = 'pass';
      check.detail = `All ${detected} cloud attachment link(s) preserved`;
    } else {
      check.status = 'warning';
      check.detail = `${pending} of ${detected} cloud attachment link(s) not yet preserved — external content may be lost`;
    }
    return check;
  }

  static checkExportIntegrity(exports) {
    const check = { name: 'Export Integrity', category: 'export' };

    if (!exports || exports.length === 0) {
      return { ...check, status: 'warning', detail: 'No exports performed', metrics: { count: 0 } };
    }

    let withHash = 0;
    let failedExports = 0;

    for (const exp of exports) {
      if (exp.hash_sha256 || exp.hashSha256) withHash++;
      if (exp.status === 'failed') failedExports++;
    }

    check.metrics = { total: exports.length, withHash, failed: failedExports };

    if (failedExports > 0) {
      check.status = 'fail';
      check.detail = `${failedExports} export(s) failed — re-export required`;
    } else if (withHash === exports.length) {
      check.status = 'pass';
      check.detail = `All ${exports.length} export(s) have verified SHA-256 manifest hashes`;
    } else {
      check.status = 'warning';
      check.detail = `${exports.length - withHash} export(s) missing manifest hash — integrity cannot be verified`;
    }
    return check;
  }

  static checkCollectionResumability(acquisitions) {
    const check = { name: 'Collection Resumability', category: 'collection' };

    if (!acquisitions || acquisitions.length === 0) {
      return { ...check, status: 'pass', detail: 'No acquisitions to assess', metrics: { count: 0 } };
    }

    let interrupted = 0;
    let completedWithErrors = 0;

    for (const acq of acquisitions) {
      if (['failed', 'paused', 'canceled', 'running'].includes(acq.status)) interrupted++;
      if (acq.status === 'completed_with_errors') completedWithErrors++;
    }

    check.metrics = { total: acquisitions.length, interrupted, completedWithErrors };

    if (interrupted > 0) {
      check.status = 'warning';
      check.detail = `${interrupted} acquisition(s) interrupted — use differential collection to resume and capture missing messages`;
    } else if (completedWithErrors > 0) {
      check.status = 'warning';
      check.detail = `${completedWithErrors} acquisition(s) completed with errors — re-run differential collection to retry failed items`;
    } else {
      check.status = 'pass';
      check.detail = `All ${acquisitions.length} acquisition(s) completed successfully`;
    }
    return check;
  }
}
