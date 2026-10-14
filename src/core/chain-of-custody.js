import { hashString } from './hasher.js';
import { writeFile, appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import dayjs from 'dayjs';

export class ChainOfCustody {
  constructor(db, projectId, examiner) {
    this.db = db;
    this.projectId = projectId;
    this.examiner = examiner;
    this.entries = [];
    this.previousHash = '0'.repeat(64);
  }

  #computeEntryHash(entry) {
    const data = `${this.previousHash}|${entry.timestamp}|${entry.eventType}|${entry.description}`;
    return hashString(data, 'sha256');
  }

  log(eventType, description, details = null, acquisitionId = null) {
    const entry = {
      projectId: this.projectId,
      acquisitionId,
      eventType,
      description,
      details: details ? JSON.stringify(details) : null,
      examiner: this.examiner,
      timestamp: dayjs().toISOString()
    };
    entry.hash = this.#computeEntryHash(entry);
    this.previousHash = entry.hash;

    this.db.addAuditEntry(entry);
    this.entries.push(entry);
    return entry;
  }

  logProjectCreated(config) {
    return this.log('PROJECT_CREATED', `Project created for ${config.targetEmail}`, {
      targetEmail: config.targetEmail,
      providerType: config.providerType,
      caseName: config.caseName,
      caseId: config.caseId
    });
  }

  logAcquisitionStarted(acquisitionId, config) {
    return this.log('ACQUISITION_STARTED', 'Acquisition session started', {
      connectionType: config.providerType,
      server: config.host,
      port: config.port,
      tls: config.tls
    }, acquisitionId);
  }

  logFolderEnumerated(acquisitionId, folderPath, messageCount) {
    return this.log('FOLDER_ENUMERATED', `Enumerated folder: ${folderPath} (${messageCount} messages)`, {
      folder: folderPath,
      messageCount
    }, acquisitionId);
  }

  logMessageAcquired(acquisitionId, messageId, hashes, size) {
    return this.log('MESSAGE_ACQUIRED', `Message acquired: ${messageId}`, {
      messageId,
      hashes,
      size
    }, acquisitionId);
  }

  logMessageFailed(acquisitionId, uid, folder, error) {
    return this.log('MESSAGE_FAILED', `Failed to acquire message UID ${uid} from ${folder}`, {
      uid, folder, error: error.message
    }, acquisitionId);
  }

  logSearchExecuted(queryType, queryText, resultCount) {
    return this.log('SEARCH_EXECUTED', `${queryType} search executed: ${resultCount} results`, {
      queryType, queryText, resultCount
    });
  }

  logAcquisitionCompleted(acquisitionId, stats) {
    return this.log('ACQUISITION_COMPLETED', 'Acquisition session completed', stats, acquisitionId);
  }

  logAcquisitionFailed(acquisitionId, error) {
    return this.log('ACQUISITION_FAILED', `Acquisition failed: ${error.message}`, {
      error: error.message, stack: error.stack
    }, acquisitionId);
  }

  logIntegrityVerified(messageId, result) {
    return this.log('INTEGRITY_VERIFIED', `Hash verification for ${messageId}: ${result.valid ? 'PASS' : 'FAIL'}`, result);
  }

  async exportLog(outputDir) {
    await mkdir(outputDir, { recursive: true });
    const logPath = join(outputDir, `chain_of_custody_${dayjs().format('YYYYMMDD_HHmmss')}.json`);
    const auditLog = this.db.getAuditLog(this.projectId);
    const report = {
      projectId: this.projectId,
      examiner: this.examiner,
      generatedAt: dayjs().toISOString(),
      entryCount: auditLog.length,
      entries: auditLog
    };
    await writeFile(logPath, JSON.stringify(report, null, 2));

    const tsvPath = join(outputDir, `audit_log_${dayjs().format('YYYYMMDD_HHmmss')}.tsv`);
    const header = 'Timestamp\tEvent Type\tDescription\tHash\tExaminer\n';
    const rows = auditLog.map(e =>
      `${e.timestamp}\t${e.event_type}\t${e.description}\t${e.hash}\t${e.examiner}`
    ).join('\n');
    await writeFile(tsvPath, header + rows);

    return { jsonPath: logPath, tsvPath };
  }

  verifyChain() {
    const auditLog = this.db.getAuditLog(this.projectId).reverse();
    let prevHash = '0'.repeat(64);
    const results = [];
    for (const entry of auditLog) {
      const expected = hashString(
        `${prevHash}|${entry.timestamp}|${entry.event_type}|${entry.description}`,
        'sha256'
      );
      const valid = expected === entry.hash;
      results.push({ id: entry.id, valid, expected, actual: entry.hash });
      if (!valid) break;
      prevHash = entry.hash;
    }
    return {
      valid: results.every(r => r.valid),
      checked: results.length,
      total: auditLog.length,
      results
    };
  }
}
