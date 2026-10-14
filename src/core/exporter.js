import { EventEmitter } from 'node:events';
import { mkdir, readFile, writeFile, copyFile, stat } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import dayjs from 'dayjs';
import { v4 as uuid } from 'uuid';
import { hashFile, hashBuffer } from './hasher.js';

export class ForensicExporter extends EventEmitter {
  constructor(db, projectId) {
    super();
    this.db = db;
    this.projectId = projectId;
  }

  async export(format, outputDir, options = {}) {
    const exportId = uuid();
    const startedAt = dayjs().toISOString();
    await mkdir(outputDir, { recursive: true });

    this.emit('started', { exportId, format, outputDir });

    const messages = this.db.prepare(
      'SELECT * FROM messages WHERE project_id = ? ORDER BY folder, date'
    ).all(this.projectId);

    if (messages.length === 0) {
      this.emit('completed', { exportId, format, count: 0 });
      return { exportId, format, count: 0, outputDir };
    }

    let result;
    switch (format.toLowerCase()) {
      case 'mbox':
        result = await this.#exportMbox(messages, outputDir, options);
        break;
      case 'eml':
        result = await this.#exportEml(messages, outputDir, options);
        break;
      case 'xml':
        result = await this.#exportXml(messages, outputDir, options);
        break;
      case 'msg':
        result = await this.#exportMsg(messages, outputDir, options);
        break;
      case 'pst':
        result = await this.#exportPstDeferred(messages, outputDir, options);
        break;
      case 'container':
        result = await this.#exportContainerized(messages, outputDir, options);
        break;
      default:
        throw new Error(`Unsupported export format: ${format}`);
    }

    const completedAt = dayjs().toISOString();
    this.db.addExportRecord({
      id: exportId,
      projectId: this.projectId,
      format,
      outputDir,
      startedAt,
      completedAt,
      messageCount: messages.length,
      status: 'completed',
      detailsJson: JSON.stringify(result)
    });

    this.emit('completed', { exportId, format, count: messages.length, ...result });
    return { exportId, format, count: messages.length, outputDir, ...result };
  }

  async #exportMbox(messages, outputDir, options) {
    const byFolder = this.#groupByFolder(messages);
    const files = [];

    for (const [folder, msgs] of Object.entries(byFolder)) {
      const safeName = this.#sanitizePath(folder) + '.mbox';
      const mboxPath = join(outputDir, safeName);
      await mkdir(dirname(mboxPath), { recursive: true });

      let content = '';
      let exported = 0;

      for (const msg of msgs) {
        if (!msg.eml_path) continue;
        try {
          const emlContent = await readFile(msg.eml_path, 'utf8');
          const fromLine = `From ${msg.from_address || 'unknown'} ${this.#mboxDate(msg.date)}\n`;
          const escaped = emlContent.replace(/^From /gm, '>From ');
          content += fromLine + escaped + '\n';
          exported++;
          this.emit('message_exported', { format: 'mbox', folder, uid: msg.uid, exported });
        } catch {
          this.emit('message_skipped', { format: 'mbox', folder, uid: msg.uid, reason: 'EML file not accessible' });
        }
      }

      await writeFile(mboxPath, content, 'utf8');
      const fileHash = await hashFile(mboxPath, 'sha256');
      files.push({ path: mboxPath, folder, messageCount: exported, sha256: fileHash });
    }

    return { files };
  }

  async #exportEml(messages, outputDir, options) {
    const exported = [];
    const failed = [];

    for (const msg of messages) {
      const folderDir = join(outputDir, this.#sanitizePath(msg.folder));
      await mkdir(folderDir, { recursive: true });

      const filename = `${msg.uid}_${this.#sanitizeFilename(msg.subject || 'no_subject')}.eml`;
      const destPath = join(folderDir, filename);

      if (!msg.eml_path) {
        failed.push({ uid: msg.uid, reason: 'No EML path recorded' });
        continue;
      }

      try {
        await copyFile(msg.eml_path, destPath);
        const fileHash = await hashFile(destPath, 'sha256');
        const hashValid = fileHash === msg.hash_sha256;
        exported.push({ uid: msg.uid, path: destPath, sha256: fileHash, hashValid });
        this.emit('message_exported', { format: 'eml', uid: msg.uid, path: destPath });
      } catch {
        failed.push({ uid: msg.uid, reason: 'EML file not accessible' });
        this.emit('message_skipped', { format: 'eml', uid: msg.uid, reason: 'EML file not accessible' });
      }
    }

    return { exported: exported.length, failed: failed.length, failures: failed };
  }

  async #exportXml(messages, outputDir, options) {
    const xmlPath = join(outputDir, `forensic_export_${dayjs().format('YYYYMMDD_HHmmss')}.xml`);

    const project = this.db.getProject(this.projectId);

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<ForensicEmailExport>\n';
    xml += `  <ExportMetadata>\n`;
    xml += `    <Tool>SherlockMail</Tool>\n`;
    xml += `    <Version>1.0.0</Version>\n`;
    xml += `    <ExportDate>${dayjs().toISOString()}</ExportDate>\n`;
    xml += `    <ProjectId>${this.#xmlEsc(this.projectId)}</ProjectId>\n`;
    xml += `    <ProjectName>${this.#xmlEsc(project?.name || '')}</ProjectName>\n`;
    xml += `    <TargetEmail>${this.#xmlEsc(project?.target_email || '')}</TargetEmail>\n`;
    xml += `    <CaseName>${this.#xmlEsc(project?.case_name || '')}</CaseName>\n`;
    xml += `    <CaseId>${this.#xmlEsc(project?.case_id || '')}</CaseId>\n`;
    xml += `    <TotalMessages>${messages.length}</TotalMessages>\n`;
    xml += `  </ExportMetadata>\n`;
    xml += `  <Messages>\n`;

    for (const msg of messages) {
      const attachments = this.db.prepare(
        'SELECT * FROM attachments WHERE message_id = ?'
      ).all(msg.id);

      xml += `    <Message>\n`;
      xml += `      <Id>${this.#xmlEsc(msg.id)}</Id>\n`;
      xml += `      <UID>${msg.uid}</UID>\n`;
      xml += `      <Folder>${this.#xmlEsc(msg.folder)}</Folder>\n`;
      xml += `      <Subject>${this.#xmlEsc(msg.subject || '')}</Subject>\n`;
      xml += `      <From>${this.#xmlEsc(msg.from_address || '')}</From>\n`;
      xml += `      <To>${this.#xmlEsc(msg.to_addresses || '')}</To>\n`;
      xml += `      <Cc>${this.#xmlEsc(msg.cc_addresses || '')}</Cc>\n`;
      xml += `      <Bcc>${this.#xmlEsc(msg.bcc_addresses || '')}</Bcc>\n`;
      xml += `      <Date>${this.#xmlEsc(msg.date || '')}</Date>\n`;
      xml += `      <MessageId>${this.#xmlEsc(msg.message_id || '')}</MessageId>\n`;
      xml += `      <InReplyTo>${this.#xmlEsc(msg.in_reply_to || '')}</InReplyTo>\n`;
      xml += `      <Size>${msg.size || 0}</Size>\n`;
      xml += `      <ContentType>${this.#xmlEsc(msg.content_type || '')}</ContentType>\n`;
      xml += `      <Hashes>\n`;
      xml += `        <MD5>${this.#xmlEsc(msg.hash_md5 || '')}</MD5>\n`;
      xml += `        <SHA256>${this.#xmlEsc(msg.hash_sha256 || '')}</SHA256>\n`;
      xml += `        <SHA512>${this.#xmlEsc(msg.hash_sha512 || '')}</SHA512>\n`;
      xml += `      </Hashes>\n`;
      xml += `      <Flags>${this.#xmlEsc(msg.flags || '')}</Flags>\n`;
      xml += `      <IsEncrypted>${msg.is_encrypted ? 'true' : 'false'}</IsEncrypted>\n`;
      xml += `      <IsSigned>${msg.is_signed ? 'true' : 'false'}</IsSigned>\n`;
      xml += `      <EmlPath>${this.#xmlEsc(msg.eml_path || '')}</EmlPath>\n`;
      xml += `      <AcquiredAt>${this.#xmlEsc(msg.acquired_at || '')}</AcquiredAt>\n`;

      if (attachments.length > 0) {
        xml += `      <Attachments>\n`;
        for (const att of attachments) {
          xml += `        <Attachment>\n`;
          xml += `          <Filename>${this.#xmlEsc(att.filename || '')}</Filename>\n`;
          xml += `          <ContentType>${this.#xmlEsc(att.content_type || '')}</ContentType>\n`;
          xml += `          <Size>${att.size || 0}</Size>\n`;
          xml += `          <MD5>${this.#xmlEsc(att.hash_md5 || '')}</MD5>\n`;
          xml += `          <SHA256>${this.#xmlEsc(att.hash_sha256 || '')}</SHA256>\n`;
          xml += `          <Disposition>${this.#xmlEsc(att.disposition || '')}</Disposition>\n`;
          xml += `          <IsInline>${att.is_inline ? 'true' : 'false'}</IsInline>\n`;
          xml += `        </Attachment>\n`;
        }
        xml += `      </Attachments>\n`;
      }

      xml += `    </Message>\n`;
      this.emit('message_exported', { format: 'xml', uid: msg.uid });
    }

    xml += `  </Messages>\n`;
    xml += '</ForensicEmailExport>\n';

    await writeFile(xmlPath, xml, 'utf8');
    const fileHash = await hashFile(xmlPath, 'sha256');

    return { file: xmlPath, sha256: fileHash };
  }

  async #exportMsg(messages, outputDir, options) {
    const exported = [];
    const failed = [];

    for (const msg of messages) {
      const folderDir = join(outputDir, this.#sanitizePath(msg.folder));
      await mkdir(folderDir, { recursive: true });

      const filename = `${msg.uid}_${this.#sanitizeFilename(msg.subject || 'no_subject')}.msg`;
      const destPath = join(folderDir, filename);

      if (!msg.eml_path) {
        failed.push({ uid: msg.uid, reason: 'No EML source available' });
        continue;
      }

      try {
        const emlContent = await readFile(msg.eml_path);
        const msgContent = this.#buildMsgContainer(msg, emlContent);
        await writeFile(destPath, msgContent);
        const fileHash = await hashFile(destPath, 'sha256');
        exported.push({ uid: msg.uid, path: destPath, sha256: fileHash });
        this.emit('message_exported', { format: 'msg', uid: msg.uid, path: destPath });
      } catch (err) {
        failed.push({ uid: msg.uid, reason: err.message });
        this.emit('message_skipped', { format: 'msg', uid: msg.uid, reason: err.message });
      }
    }

    return { exported: exported.length, failed: failed.length, failures: failed };
  }

  #buildMsgContainer(msg, emlContent) {
    const header = Buffer.from(JSON.stringify({
      _format: 'SherlockMail-MSG-Container-v1',
      _note: 'This is a SherlockMail MSG container wrapping the original MIME source. ' +
             'For native Outlook MSG format, use a dedicated conversion tool on the enclosed EML data.',
      messageId: msg.message_id,
      subject: msg.subject,
      from: msg.from_address,
      to: msg.to_addresses,
      date: msg.date,
      size: msg.size,
      hashMd5: msg.hash_md5,
      hashSha256: msg.hash_sha256,
      folder: msg.folder,
      uid: msg.uid,
      contentType: msg.content_type,
      hasAttachments: !!msg.has_attachments,
      attachmentCount: msg.attachment_count
    }, null, 2) + '\n---MIME-SOURCE---\n');

    return Buffer.concat([header, emlContent]);
  }

  async #exportPstDeferred(messages, outputDir, options) {
    const maxSizeGB = options.pstSizeGB || 10;
    const maxSizeBytes = maxSizeGB * 1024 * 1024 * 1024;

    const pstOutputDir = join(outputDir, 'pst_deferred');
    await mkdir(pstOutputDir, { recursive: true });

    const sets = [];
    let currentSet = { messages: [], totalSize: 0, index: 1 };

    for (const msg of messages) {
      const msgSize = msg.size || 0;

      if (currentSet.totalSize + msgSize > maxSizeBytes && currentSet.messages.length > 0) {
        sets.push(currentSet);
        currentSet = { messages: [], totalSize: 0, index: sets.length + 1 };
      }

      currentSet.messages.push(msg);
      currentSet.totalSize += msgSize;
    }

    if (currentSet.messages.length > 0) {
      sets.push(currentSet);
    }

    const setResults = [];

    for (const set of sets) {
      const setDir = join(pstOutputDir, `set_${String(set.index).padStart(3, '0')}`);
      await mkdir(setDir, { recursive: true });

      let exported = 0;
      let failed = 0;
      const byFolder = this.#groupByFolder(set.messages);

      for (const [folder, msgs] of Object.entries(byFolder)) {
        const folderDir = join(setDir, 'Items', this.#sanitizePath(folder));
        await mkdir(folderDir, { recursive: true });

        for (const msg of msgs) {
          if (!msg.eml_path) { failed++; continue; }
          try {
            const filename = `${msg.uid}_${this.#sanitizeFilename(msg.subject || 'no_subject')}.eml`;
            await copyFile(msg.eml_path, join(folderDir, filename));
            exported++;
          } catch { failed++; }
        }
      }

      const manifest = {
        _format: 'SherlockMail-PST-DeferredSet-v1',
        setIndex: set.index,
        totalSets: sets.length,
        messageCount: set.messages.length,
        totalSizeBytes: set.totalSize,
        maxPstSizeGB: maxSizeGB,
        exported,
        failed,
        folders: Object.keys(byFolder),
        createdAt: dayjs().toISOString(),
        note: 'This deferred output set contains EML files organized by folder structure, ' +
              'ready for conversion to PST format using a dedicated PST creation tool. ' +
              `Target PST size: ${maxSizeGB}GB per file.`
      };

      await writeFile(join(setDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
      setResults.push({ setDir, ...manifest });

      this.emit('pst_set_created', { setIndex: set.index, totalSets: sets.length, messageCount: exported });
    }

    return {
      totalSets: sets.length,
      maxPstSizeGB: maxSizeGB,
      sets: setResults,
      note: `${sets.length} deferred output set(s) created at ${maxSizeGB}GB max per PST file. ` +
            'Each set contains EML files organized by folder, with a manifest.json describing the contents.'
    };
  }

  async #exportContainerized(messages, outputDir, options) {
    const containerType = options.containerType || 'mime';
    const containerDir = join(outputDir, `container_${containerType}`);
    await mkdir(containerDir, { recursive: true });

    const byFolder = this.#groupByFolder(messages);
    let totalExported = 0;
    let totalFailed = 0;
    const folderManifests = {};

    for (const [folder, msgs] of Object.entries(byFolder)) {
      const folderDir = join(containerDir, this.#sanitizePath(folder));
      await mkdir(folderDir, { recursive: true });

      const folderItems = [];

      for (const msg of msgs) {
        if (!msg.eml_path) { totalFailed++; continue; }

        try {
          const ext = containerType === 'msg' ? '.msg' : '.eml';
          const filename = `${msg.uid}_${this.#sanitizeFilename(msg.subject || 'no_subject')}${ext}`;
          const destPath = join(folderDir, filename);

          if (containerType === 'msg') {
            const emlContent = await readFile(msg.eml_path);
            const msgContent = this.#buildMsgContainer(msg, emlContent);
            await writeFile(destPath, msgContent);
          } else {
            await copyFile(msg.eml_path, destPath);
          }

          folderItems.push({
            uid: msg.uid,
            messageId: msg.message_id,
            subject: msg.subject,
            from: msg.from_address,
            date: msg.date,
            size: msg.size,
            hashSha256: msg.hash_sha256,
            filename,
            hasAttachments: !!msg.has_attachments,
            attachmentCount: msg.attachment_count
          });

          totalExported++;
          this.emit('message_exported', { format: `container-${containerType}`, uid: msg.uid });
        } catch {
          totalFailed++;
        }
      }

      folderManifests[folder] = { messageCount: folderItems.length, items: folderItems };
      await writeFile(join(folderDir, '_manifest.json'), JSON.stringify(folderManifests[folder], null, 2));
    }

    const containerManifest = {
      _format: `SherlockMail-Container-${containerType.toUpperCase()}-v1`,
      projectId: this.projectId,
      containerType,
      createdAt: dayjs().toISOString(),
      totalMessages: totalExported,
      totalFailed,
      folderCount: Object.keys(byFolder).length,
      folders: Object.keys(byFolder)
    };

    await writeFile(join(containerDir, 'container_manifest.json'), JSON.stringify(containerManifest, null, 2));

    return { containerDir, exported: totalExported, failed: totalFailed, ...containerManifest };
  }

  #groupByFolder(messages) {
    const grouped = {};
    for (const msg of messages) {
      const folder = msg.folder || 'UNKNOWN';
      if (!grouped[folder]) grouped[folder] = [];
      grouped[folder].push(msg);
    }
    return grouped;
  }

  #mboxDate(dateStr) {
    if (!dateStr) return dayjs().format('ddd MMM DD HH:mm:ss YYYY');
    return dayjs(dateStr).format('ddd MMM DD HH:mm:ss YYYY');
  }

  #sanitizePath(path) {
    return path.replace(/[<>:"|?*]/g, '_').replace(/\//g, '_').replace(/\\/g, '_');
  }

  #sanitizeFilename(name) {
    return String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').substring(0, 80);
  }

  #xmlEsc(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}
