import { EventEmitter } from 'node:events';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { simpleParser } from 'mailparser';
import { v4 as uuid } from 'uuid';
import dayjs from 'dayjs';

import { hashMultiple } from './hasher.js';
import { ChainOfCustody } from './chain-of-custody.js';
import { ForensicImapClient } from '../protocols/imap-client.js';
import { DriveAttachmentDetector } from './drive-attachments.js';

export class AcquisitionEngine extends EventEmitter {
  constructor(db, projectId, config) {
    super();
    this.db = db;
    this.projectId = projectId;
    this.config = config;
    this.custody = new ChainOfCustody(db, projectId, config.examinerName || 'Unknown');
    this.stats = {
      totalMessages: 0,
      acquiredMessages: 0,
      failedMessages: 0,
      skippedMessages: 0,
      totalBytes: 0,
      driveLinksDetected: 0,
      startTime: null,
      endTime: null
    };
    this.throttleDelay = config.throttleDelay || 0;
    this.hashAlgorithms = config.hashAlgorithms || ['md5', 'sha256'];
    this.collectDriveLinks = config.collectDriveLinks !== false;
    this.collectModernAttachments = config.collectModernAttachments !== false;
    this.driveDetector = new DriveAttachmentDetector(db, projectId);
    this.running = false;
    this.cancelled = false;
  }

  async run() {
    const acquisitionId = uuid();
    this.db.createAcquisition({ id: acquisitionId, projectId: this.projectId });
    this.db.updateProjectStatus(this.projectId, 'acquiring');
    this.stats.startTime = dayjs().toISOString();
    this.running = true;

    this.custody.logAcquisitionStarted(acquisitionId, this.config);
    this.emit('started', { acquisitionId, config: this.config });

    const client = new ForensicImapClient(this.config);

    try {
      await client.connect();
      this.emit('connected', { host: this.config.host });

      const folders = await client.listFolders();
      const selectedFolders = this.#filterFolders(folders);

      for (const folder of selectedFolders) {
        this.#storeFolderRecord(folder);
      }

      for (const folder of selectedFolders) {
        if (this.cancelled) break;
        await this.#acquireFolder(client, folder, acquisitionId);
      }

      this.stats.endTime = dayjs().toISOString();

      this.db.updateAcquisition(acquisitionId, {
        status: this.cancelled ? 'cancelled' : 'completed',
        completed_at: this.stats.endTime,
        total_messages: this.stats.totalMessages,
        acquired_messages: this.stats.acquiredMessages,
        failed_messages: this.stats.failedMessages,
        skipped_messages: this.stats.skippedMessages,
        total_bytes: this.stats.totalBytes
      });

      this.db.updateProjectStatus(this.projectId, this.cancelled ? 'cancelled' : 'completed');
      this.custody.logAcquisitionCompleted(acquisitionId, this.stats);
      this.emit('completed', { acquisitionId, stats: this.stats });

    } catch (error) {
      this.stats.endTime = dayjs().toISOString();
      this.db.updateAcquisition(acquisitionId, {
        status: 'failed',
        completed_at: this.stats.endTime,
        error_log: error.message,
        total_messages: this.stats.totalMessages,
        acquired_messages: this.stats.acquiredMessages,
        failed_messages: this.stats.failedMessages
      });
      this.db.updateProjectStatus(this.projectId, 'failed');
      this.custody.logAcquisitionFailed(acquisitionId, error);
      this.emit('error', { acquisitionId, error });
      throw error;

    } finally {
      this.running = false;
      await client.disconnect().catch(() => {});
    }

    return { acquisitionId, stats: this.stats };
  }

  cancel() {
    this.cancelled = true;
    this.emit('cancelling');
  }

  #filterFolders(folders) {
    const include = this.config.includeFolders;
    const exclude = this.config.excludeFolders || [];
    let selected = folders.filter(f => f.listed && !f.flags?.includes('\\Noselect'));
    if (include?.length) {
      selected = selected.filter(f => include.some(p => f.path.startsWith(p)));
    }
    if (exclude.length) {
      selected = selected.filter(f => !exclude.some(p => f.path.startsWith(p)));
    }
    if (this.config.targetedUids) {
      selected = selected.filter(f => this.config.targetedUids[f.path]?.length > 0);
    }
    return selected;
  }

  #storeFolderRecord(folder) {
    this.db.insertFolder({
      id: uuid(),
      projectId: this.projectId,
      path: folder.path,
      name: folder.name,
      delimiter: folder.delimiter,
      flags: JSON.stringify(folder.flags),
      totalMessages: 0,
      unseenMessages: 0,
      parentPath: folder.path.includes(folder.delimiter)
        ? folder.path.substring(0, folder.path.lastIndexOf(folder.delimiter))
        : null
    });
  }

  async #acquireFolder(client, folder, acquisitionId) {
    this.emit('folder_start', { folder: folder.path });

    let status;
    try {
      status = await client.getFolderStatus(folder.path);
    } catch {
      this.emit('folder_error', { folder: folder.path, error: 'Cannot get folder status' });
      return;
    }

    const targetCount = (this.config.targetedUids && this.config.targetedUids[folder.path])
      ? this.config.targetedUids[folder.path].length
      : status.messages;
    this.custody.logFolderEnumerated(acquisitionId, folder.path, targetCount);
    this.stats.totalMessages += targetCount;
    this.emit('folder_status', { folder: folder.path, total: targetCount });

    if (targetCount === 0) {
      this.emit('folder_complete', { folder: folder.path, acquired: 0 });
      return;
    }

    const outputDir = join(this.config.outputDir, 'Items', this.#sanitizePath(folder.path));
    await mkdir(outputDir, { recursive: true });

    let folderAcquired = 0;
    const batch = [];

    const fetchOpts = {};
    if (this.config.targetedUids && this.config.targetedUids[folder.path]) {
      fetchOpts.uidRange = this.config.targetedUids[folder.path].join(',');
    }

    try {
      for await (const rawMsg of client.fetchMessages(folder.path, fetchOpts)) {
        if (this.cancelled) break;

        try {
          const record = await this.#processMessage(rawMsg, folder.path, acquisitionId, outputDir);
          batch.push(record);

          if (batch.length >= 50) {
            this.db.insertMessageBatch(batch);
            batch.length = 0;
          }

          folderAcquired++;
          this.stats.acquiredMessages++;
          this.stats.totalBytes += rawMsg.size || 0;
          this.emit('message_acquired', {
            folder: folder.path,
            uid: rawMsg.uid,
            subject: rawMsg.envelope?.subject,
            acquired: folderAcquired,
            total: status.messages
          });

          if (this.throttleDelay > 0) {
            await new Promise(r => setTimeout(r, this.throttleDelay));
          }

        } catch (msgError) {
          this.stats.failedMessages++;
          this.custody.logMessageFailed(acquisitionId, rawMsg.uid, folder.path, msgError);
          this.emit('message_failed', { folder: folder.path, uid: rawMsg.uid, error: msgError.message });
        }
      }

      if (batch.length > 0) {
        this.db.insertMessageBatch(batch);
      }

    } catch (folderError) {
      this.emit('folder_error', { folder: folder.path, error: folderError.message });
    }

    this.emit('folder_complete', { folder: folder.path, acquired: folderAcquired });
  }

  async #processMessage(rawMsg, folderPath, acquisitionId, outputDir) {
    const source = rawMsg.source;
    const sourceBuffer = Buffer.isBuffer(source) ? source : Buffer.from(source);

    const hashes = hashMultiple(sourceBuffer, this.hashAlgorithms);

    if (this.config.differential) {
      const serviceId = rawMsg.envelope?.messageId || `uid:${rawMsg.uid}`;
      if (this.db.isDifferentialExcluded(this.projectId, serviceId)) {
        this.stats.skippedMessages++;
        return null;
      }
    }

    const parsed = await simpleParser(sourceBuffer);

    const msgId = uuid();
    const filename = `${rawMsg.uid}_${this.#sanitizeFilename(parsed.subject || 'no_subject')}.eml`;
    const emlPath = join(outputDir, filename);

    await writeFile(emlPath, sourceBuffer);

    const attachments = [];
    if (parsed.attachments?.length) {
      for (const att of parsed.attachments) {
        const attHashes = hashMultiple(att.content, ['md5', 'sha256']);
        const attRecord = {
          id: uuid(),
          messageId: msgId,
          filename: att.filename || 'unnamed',
          contentType: att.contentType,
          size: att.size,
          hashMd5: attHashes.md5,
          hashSha256: attHashes.sha256,
          disposition: att.contentDisposition,
          contentId: att.contentId,
          isInline: att.contentDisposition === 'inline'
        };
        this.db.insertAttachment(attRecord);
        attachments.push(attRecord);
      }
    }

    const headersObj = {};
    if (parsed.headers) {
      for (const [key, value] of parsed.headers) {
        headersObj[key] = typeof value === 'object' && value.text ? value.text : String(value);
      }
    }

    const isEncrypted = parsed.headers?.has('content-type') &&
      String(parsed.headers.get('content-type')).includes('pkcs7-mime');
    const isSigned = parsed.headers?.has('content-type') &&
      (String(parsed.headers.get('content-type')).includes('pkcs7-signature') ||
       String(parsed.headers.get('content-type')).includes('pgp-signature'));

    const record = {
      id: msgId,
      acquisitionId,
      projectId: this.projectId,
      uid: rawMsg.uid,
      serviceId: parsed.messageId || `uid:${rawMsg.uid}`,
      folder: folderPath,
      subject: parsed.subject || '',
      from: parsed.from?.text || '',
      to: parsed.to?.text || '',
      cc: parsed.cc?.text || '',
      bcc: parsed.bcc?.text || '',
      date: parsed.date?.toISOString() || rawMsg.internalDate?.toISOString() || '',
      messageId: parsed.messageId || '',
      inReplyTo: parsed.inReplyTo || '',
      size: sourceBuffer.length,
      flags: JSON.stringify(rawMsg.flags),
      hasAttachments: (parsed.attachments?.length || 0) > 0,
      attachmentCount: parsed.attachments?.length || 0,
      contentType: parsed.headers?.get('content-type')?.value || 'text/plain',
      hashMd5: hashes.md5 || '',
      hashSha256: hashes.sha256 || '',
      hashSha512: hashes.sha512 || '',
      emlPath,
      headersJson: JSON.stringify(headersObj),
      isEncrypted: !!isEncrypted,
      isSigned: !!isSigned
    };

    this.custody.logMessageAcquired(acquisitionId, record.messageId, hashes, record.size);

    if (this.collectDriveLinks) {
      try {
        const driveLinks = this.driveDetector.detectLinksInContent(sourceBuffer.toString('utf8'));
        if (driveLinks.length > 0) {
          for (const link of driveLinks) {
            this.db.insertDriveLink({
              id: uuid(),
              projectId: this.projectId,
              messageId: msgId,
              provider: link.provider,
              url: link.url,
              fileId: link.fileId,
              status: 'detected',
              detectedAt: dayjs().toISOString()
            });
          }
          this.stats.driveLinksDetected += driveLinks.length;
          this.emit('drive_links_detected', {
            uid: rawMsg.uid,
            subject: parsed.subject,
            links: driveLinks
          });
        }
      } catch {}
    }

    return record;
  }

  #sanitizePath(path) {
    return path.replace(/[<>:"|?*]/g, '_').replace(/\//g, '_');
  }

  #sanitizeFilename(name) {
    return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').substring(0, 80);
  }
}
