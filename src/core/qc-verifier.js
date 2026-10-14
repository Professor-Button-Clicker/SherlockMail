import { EventEmitter } from 'node:events';
import { stat, readFile } from 'node:fs/promises';
import dayjs from 'dayjs';
import { ForensicImapClient } from '../protocols/imap-client.js';
import { hashBuffer, hashFile } from './hasher.js';

export class QCVerifier extends EventEmitter {
  constructor(db, projectId, connectionConfig) {
    super();
    this.db = db;
    this.projectId = projectId;
    this.connectionConfig = connectionConfig;
    this.results = {
      startedAt: null,
      completedAt: null,
      status: 'pending',
      folderResults: [],
      messageResults: [],
      summary: {
        totalFoldersChecked: 0,
        totalMessagesChecked: 0,
        folderCountMatches: 0,
        folderCountMismatches: 0,
        hashMatches: 0,
        hashMismatches: 0,
        missingOnServer: 0,
        missingInCollection: 0,
        sizeMatches: 0,
        sizeMismatches: 0,
        emlFileMissing: 0,
        errors: 0
      }
    };
  }

  async verify(options = {}) {
    this.results.startedAt = dayjs().toISOString();
    this.results.status = 'running';
    this.emit('started', { projectId: this.projectId });

    const client = new ForensicImapClient(this.connectionConfig);
    const verifyHashes = options.verifyHashes !== false;
    const sampleSize = options.sampleSize || 0; // 0 = verify all

    try {
      await client.connect();
      this.emit('connected', { host: this.connectionConfig.host });

      const serverFolders = await client.listFolders();
      const dbFolders = this.db.getFolders(this.projectId);

      const selectableFolders = serverFolders.filter(
        f => f.listed && !f.flags?.includes('\\Noselect')
      );

      for (const serverFolder of selectableFolders) {
        const dbFolder = dbFolders.find(f => f.path === serverFolder.path);
        await this.#verifyFolder(client, serverFolder, dbFolder, verifyHashes, sampleSize);
      }

      for (const dbFolder of dbFolders) {
        const exists = selectableFolders.some(f => f.path === dbFolder.path);
        if (!exists) {
          this.results.folderResults.push({
            folder: dbFolder.path,
            status: 'FOLDER_REMOVED_FROM_SERVER',
            dbMessageCount: this.#getDbMessageCount(dbFolder.path),
            serverMessageCount: null,
            note: 'Folder existed during acquisition but is no longer on the server'
          });
        }
      }

      this.results.status = 'completed';

    } catch (error) {
      this.results.status = 'failed';
      this.results.error = error.message;
      this.emit('error', { error: error.message });

    } finally {
      this.results.completedAt = dayjs().toISOString();
      await client.disconnect().catch(() => {});
      this.emit('completed', { results: this.results });
    }

    this.#computeSummary();
    this.db.addQCResult({
      projectId: this.projectId,
      startedAt: this.results.startedAt,
      completedAt: this.results.completedAt,
      status: this.results.status,
      resultsJson: JSON.stringify(this.results)
    });

    return this.results;
  }

  async #verifyFolder(client, serverFolder, dbFolder, verifyHashes, sampleSize) {
    this.emit('folder_start', { folder: serverFolder.path });
    this.results.summary.totalFoldersChecked++;

    let serverStatus;
    try {
      serverStatus = await client.getFolderStatus(serverFolder.path);
    } catch (err) {
      this.results.folderResults.push({
        folder: serverFolder.path,
        status: 'ERROR',
        error: `Cannot access folder: ${err.message}`
      });
      this.results.summary.errors++;
      return;
    }

    const dbMessageCount = this.#getDbMessageCount(serverFolder.path);
    const countMatch = serverStatus.messages === dbMessageCount;

    if (countMatch) {
      this.results.summary.folderCountMatches++;
    } else {
      this.results.summary.folderCountMismatches++;
    }

    const folderResult = {
      folder: serverFolder.path,
      status: countMatch ? 'COUNT_MATCH' : 'COUNT_MISMATCH',
      serverMessageCount: serverStatus.messages,
      dbMessageCount,
      difference: serverStatus.messages - dbMessageCount,
      messageVerifications: []
    };

    if (verifyHashes && dbMessageCount > 0) {
      const dbMessages = this.db.prepare(
        'SELECT * FROM messages WHERE project_id = ? AND folder = ? ORDER BY uid'
      ).all(this.projectId, serverFolder.path);

      let messagesToVerify = dbMessages;
      if (sampleSize > 0 && dbMessages.length > sampleSize) {
        const step = Math.floor(dbMessages.length / sampleSize);
        messagesToVerify = [];
        for (let i = 0; i < dbMessages.length && messagesToVerify.length < sampleSize; i += step) {
          messagesToVerify.push(dbMessages[i]);
        }
      }

      for (const dbMsg of messagesToVerify) {
        const msgResult = await this.#verifyMessage(client, serverFolder.path, dbMsg);
        folderResult.messageVerifications.push(msgResult);
        this.results.messageResults.push(msgResult);
        this.results.summary.totalMessagesChecked++;

        this.emit('message_verified', {
          folder: serverFolder.path,
          uid: dbMsg.uid,
          status: msgResult.status
        });
      }
    }

    this.results.folderResults.push(folderResult);
    this.emit('folder_complete', { folder: serverFolder.path, result: folderResult });
  }

  async #verifyMessage(client, folderPath, dbMsg) {
    const result = {
      messageId: dbMsg.message_id,
      uid: dbMsg.uid,
      folder: folderPath,
      subject: dbMsg.subject,
      checks: {}
    };

    try {
      const serverMsg = await client.fetchMessageByUid(folderPath, dbMsg.uid);

      if (!serverMsg || !serverMsg.source) {
        result.status = 'MISSING_ON_SERVER';
        result.checks.serverPresence = { passed: false, note: 'Message not found on server by UID' };
        this.results.summary.missingOnServer++;
        return result;
      }

      const serverSource = Buffer.isBuffer(serverMsg.source)
        ? serverMsg.source
        : Buffer.from(serverMsg.source);

      // Size check
      const sizeMatch = serverSource.length === dbMsg.size;
      result.checks.size = {
        passed: sizeMatch,
        serverSize: serverSource.length,
        collectedSize: dbMsg.size
      };
      if (sizeMatch) this.results.summary.sizeMatches++;
      else this.results.summary.sizeMismatches++;

      // Hash check
      const serverHash = hashBuffer(serverSource, 'sha256');
      const hashMatch = serverHash === dbMsg.hash_sha256;
      result.checks.sha256 = {
        passed: hashMatch,
        serverHash,
        collectedHash: dbMsg.hash_sha256
      };
      if (hashMatch) this.results.summary.hashMatches++;
      else this.results.summary.hashMismatches++;

      // EML file integrity check
      if (dbMsg.eml_path) {
        try {
          const fileStat = await stat(dbMsg.eml_path);
          if (fileStat.isFile()) {
            const fileHash = await hashFile(dbMsg.eml_path, 'sha256');
            const emlMatch = fileHash === dbMsg.hash_sha256;
            result.checks.emlFile = {
              passed: emlMatch,
              fileHash,
              expectedHash: dbMsg.hash_sha256,
              path: dbMsg.eml_path
            };
          }
        } catch {
          result.checks.emlFile = { passed: false, note: 'EML file not found on disk' };
          this.results.summary.emlFileMissing++;
        }
      }

      const allPassed = Object.values(result.checks).every(c => c.passed);
      result.status = allPassed ? 'VERIFIED' : 'MISMATCH';

    } catch (error) {
      result.status = 'ERROR';
      result.error = error.message;
      this.results.summary.errors++;
    }

    return result;
  }

  #getDbMessageCount(folderPath) {
    const row = this.db.prepare(
      'SELECT COUNT(*) as count FROM messages WHERE project_id = ? AND folder = ?'
    ).get(this.projectId, folderPath);
    return row?.count || 0;
  }

  #computeSummary() {
    const s = this.results.summary;
    const totalIssues = s.folderCountMismatches + s.hashMismatches +
      s.sizeMismatches + s.missingOnServer + s.emlFileMissing + s.errors;

    this.results.summary.totalIssues = totalIssues;
    this.results.summary.overallVerdict = totalIssues === 0 ? 'PASS' : 'ISSUES_FOUND';

    if (totalIssues > 0) {
      this.results.summary.verdictNote =
        `${totalIssues} issue(s) found during QC verification. ` +
        `Review individual results for details. ` +
        `This does NOT indicate data was fabricated — it may reflect server-side changes ` +
        `(new messages, deletions, or modifications) since the acquisition.`;
    } else {
      this.results.summary.verdictNote =
        'All checked items match between the collection and the mail server.';
    }
  }
}
