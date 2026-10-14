import { EventEmitter } from 'node:events';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import dayjs from 'dayjs';
import { v4 as uuid } from 'uuid';
import { hashBuffer } from './hasher.js';

const DRIVE_LINK_PATTERNS = [
  { provider: 'Google Drive', pattern: /https?:\/\/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?id=)([a-zA-Z0-9_-]+)/g },
  { provider: 'Google Drive', pattern: /https?:\/\/docs\.google\.com\/(?:document|spreadsheets|presentation|forms)\/d\/([a-zA-Z0-9_-]+)/g },
  { provider: 'OneDrive', pattern: /https?:\/\/(?:1drv\.ms|onedrive\.live\.com)\/[^\s"<>]+/g },
  { provider: 'OneDrive', pattern: /https?:\/\/[a-zA-Z0-9-]+\.sharepoint\.com\/(?::f:|:b:|:w:|:x:|:p:)\/[^\s"<>]+/g },
  { provider: 'SharePoint', pattern: /https?:\/\/[a-zA-Z0-9-]+\.sharepoint\.com\/sites\/[^\s"<>]+/g },
  { provider: 'Dropbox', pattern: /https?:\/\/(?:www\.)?dropbox\.com\/(?:s|sh|scl)\/[a-zA-Z0-9_-]+[^\s"<>]*/g },
  { provider: 'Box', pattern: /https?:\/\/(?:app\.)?box\.com\/s\/[a-zA-Z0-9]+/g },
  { provider: 'iCloud', pattern: /https?:\/\/www\.icloud\.com\/iclouddrive\/[^\s"<>]+/g },
];

export class DriveAttachmentDetector extends EventEmitter {
  constructor(db, projectId) {
    super();
    this.db = db;
    this.projectId = projectId;
  }

  detectLinksInContent(content) {
    if (!content) return [];
    const links = [];
    const seen = new Set();

    for (const { provider, pattern } of DRIVE_LINK_PATTERNS) {
      const regex = new RegExp(pattern.source, pattern.flags);
      let match;
      while ((match = regex.exec(content)) !== null) {
        const url = match[0];
        if (!seen.has(url)) {
          seen.add(url);
          links.push({
            provider,
            url: url.replace(/[">'\])\s]+$/, ''),
            fileId: match[1] || null
          });
        }
      }
    }

    return links;
  }

  async scanMessage(messageId, emlPath) {
    if (!emlPath) return [];

    try {
      const emlContent = await readFile(emlPath, 'utf8');
      const links = this.detectLinksInContent(emlContent);

      for (const link of links) {
        this.db.insertDriveLink({
          id: uuid(),
          projectId: this.projectId,
          messageId,
          provider: link.provider,
          url: link.url,
          fileId: link.fileId,
          status: 'detected',
          detectedAt: dayjs().toISOString()
        });
      }

      return links;
    } catch {
      return [];
    }
  }

  async scanAllMessages() {
    const messages = this.db.prepare(
      'SELECT id, eml_path, subject, from_address FROM messages WHERE project_id = ?'
    ).all(this.projectId);

    let totalLinks = 0;
    const results = { scanned: 0, withLinks: 0, totalLinks: 0, byProvider: {} };

    for (const msg of messages) {
      const links = await this.scanMessage(msg.id, msg.eml_path);
      results.scanned++;

      if (links.length > 0) {
        results.withLinks++;
        results.totalLinks += links.length;

        for (const link of links) {
          results.byProvider[link.provider] = (results.byProvider[link.provider] || 0) + 1;
        }

        this.emit('links_found', {
          messageId: msg.id,
          subject: msg.subject,
          from: msg.from_address,
          linkCount: links.length
        });
      }

      this.emit('progress', { scanned: results.scanned, total: messages.length });
    }

    return results;
  }

  getDriveLinks(messageId) {
    if (messageId) {
      return this.db.prepare(
        'SELECT * FROM drive_links WHERE project_id = ? AND message_id = ? ORDER BY detected_at'
      ).all(this.projectId, messageId);
    }
    return this.db.prepare(
      'SELECT * FROM drive_links WHERE project_id = ? ORDER BY detected_at'
    ).all(this.projectId);
  }

  getDriveLinkStats() {
    const total = this.db.prepare(
      'SELECT COUNT(*) as count FROM drive_links WHERE project_id = ?'
    ).get(this.projectId);

    const byProvider = this.db.prepare(
      'SELECT provider, COUNT(*) as count FROM drive_links WHERE project_id = ? GROUP BY provider'
    ).all(this.projectId);

    const byStatus = this.db.prepare(
      'SELECT status, COUNT(*) as count FROM drive_links WHERE project_id = ? GROUP BY status'
    ).all(this.projectId);

    const messagesWithLinks = this.db.prepare(
      'SELECT COUNT(DISTINCT message_id) as count FROM drive_links WHERE project_id = ?'
    ).get(this.projectId);

    return {
      totalLinks: total?.count || 0,
      messagesWithLinks: messagesWithLinks?.count || 0,
      byProvider,
      byStatus
    };
  }

  async createDrivePackages(outputDir, options = {}) {
    await mkdir(outputDir, { recursive: true });

    const links = this.getDriveLinks();
    if (links.length === 0) return { packages: 0, note: 'No drive links detected' };

    const packageDir = join(outputDir, 'drive_attachment_packages');
    await mkdir(packageDir, { recursive: true });

    const byMessage = {};
    for (const link of links) {
      if (!byMessage[link.message_id]) byMessage[link.message_id] = [];
      byMessage[link.message_id].push(link);
    }

    const packages = [];

    for (const [messageId, msgLinks] of Object.entries(byMessage)) {
      const msg = this.db.getMessage(messageId);
      if (!msg) continue;

      const pkgName = `pkg_${msg.uid}_${this.#sanitizeFilename(msg.subject || 'no_subject')}`;
      const pkgDir = join(packageDir, this.#sanitizePath(msg.folder), pkgName);
      await mkdir(pkgDir, { recursive: true });

      if (msg.eml_path) {
        try {
          const emlContent = await readFile(msg.eml_path);
          await writeFile(join(pkgDir, `parent_${msg.uid}.eml`), emlContent);
        } catch {}
      }

      const regularAttachments = this.db.prepare(
        'SELECT * FROM attachments WHERE message_id = ?'
      ).all(messageId);

      const packageManifest = {
        _format: 'SherlockMail-DrivePackage-v1',
        parentMessage: {
          id: msg.id,
          uid: msg.uid,
          messageId: msg.message_id,
          subject: msg.subject,
          from: msg.from_address,
          to: msg.to_addresses,
          date: msg.date,
          folder: msg.folder,
          hashSha256: msg.hash_sha256
        },
        regularAttachments: regularAttachments.map(a => ({
          filename: a.filename,
          contentType: a.content_type,
          size: a.size,
          hashSha256: a.hash_sha256
        })),
        driveLinks: msgLinks.map(l => ({
          provider: l.provider,
          url: l.url,
          fileId: l.file_id,
          status: l.status,
          detectedAt: l.detected_at,
          note: 'Drive link detected in email content. Actual file download requires ' +
                'authenticated access to the respective cloud storage provider.'
        })),
        createdAt: dayjs().toISOString()
      };

      await writeFile(join(pkgDir, 'package_manifest.json'), JSON.stringify(packageManifest, null, 2));
      packages.push({ messageId, folder: msg.folder, subject: msg.subject, linkCount: msgLinks.length, pkgDir });

      this.emit('package_created', { messageId, subject: msg.subject, linkCount: msgLinks.length });
    }

    const masterManifest = {
      _format: 'SherlockMail-DrivePackages-v1',
      projectId: this.projectId,
      createdAt: dayjs().toISOString(),
      totalPackages: packages.length,
      totalLinks: links.length,
      packages: packages.map(p => ({
        messageId: p.messageId,
        folder: p.folder,
        subject: p.subject,
        driveLinks: p.linkCount
      }))
    };

    await writeFile(join(packageDir, 'master_manifest.json'), JSON.stringify(masterManifest, null, 2));

    return { packages: packages.length, totalLinks: links.length, outputDir: packageDir };
  }

  async createStagedOutput(outputDir, options = {}) {
    await mkdir(outputDir, { recursive: true });

    const stagedDir = join(outputDir, 'staged_output');
    await mkdir(stagedDir, { recursive: true });

    const messages = this.db.prepare(
      'SELECT * FROM messages WHERE project_id = ? ORDER BY folder, date'
    ).all(this.projectId);

    const links = this.getDriveLinks();
    const linksByMessage = {};
    for (const link of links) {
      if (!linksByMessage[link.message_id]) linksByMessage[link.message_id] = [];
      linksByMessage[link.message_id].push(link);
    }

    let withPackage = 0;
    let withoutPackage = 0;
    let failed = 0;

    for (const msg of messages) {
      const folderDir = join(stagedDir, this.#sanitizePath(msg.folder));
      await mkdir(folderDir, { recursive: true });

      const hasDriveLinks = linksByMessage[msg.id]?.length > 0;

      if (hasDriveLinks) {
        const pkgName = `pkg_${msg.uid}_${this.#sanitizeFilename(msg.subject || 'no_subject')}`;
        const pkgDir = join(folderDir, pkgName);
        await mkdir(pkgDir, { recursive: true });

        if (msg.eml_path) {
          try {
            const emlContent = await readFile(msg.eml_path);
            await writeFile(join(pkgDir, `parent_${msg.uid}.eml`), emlContent);
          } catch { failed++; continue; }
        }

        const driveLinksForMsg = linksByMessage[msg.id];
        const pkgManifest = {
          parentMessage: {
            uid: msg.uid,
            messageId: msg.message_id,
            subject: msg.subject,
            from: msg.from_address,
            date: msg.date,
            hashSha256: msg.hash_sha256
          },
          driveLinks: driveLinksForMsg.map(l => ({
            provider: l.provider,
            url: l.url,
            status: l.status
          }))
        };

        await writeFile(join(pkgDir, '_package.json'), JSON.stringify(pkgManifest, null, 2));
        withPackage++;

      } else {
        if (msg.eml_path) {
          try {
            const filename = `${msg.uid}_${this.#sanitizeFilename(msg.subject || 'no_subject')}.eml`;
            const emlContent = await readFile(msg.eml_path);
            await writeFile(join(folderDir, filename), emlContent);
            withoutPackage++;
          } catch { failed++; }
        } else {
          failed++;
        }
      }

      this.emit('staged', { uid: msg.uid, hasDriveLinks, folder: msg.folder });
    }

    const stagingManifest = {
      _format: 'SherlockMail-StagedOutput-v1',
      projectId: this.projectId,
      createdAt: dayjs().toISOString(),
      totalMessages: messages.length,
      withDrivePackages: withPackage,
      withoutDrivePackages: withoutPackage,
      failed,
      note: 'Staged output retains original folder structure. Emails with drive attachments ' +
            'are packaged into subdirectories with their parent email and drive link metadata. ' +
            'Emails without drive attachments are stored as standalone EML files.'
    };

    await writeFile(join(stagedDir, 'staging_manifest.json'), JSON.stringify(stagingManifest, null, 2));

    return { stagedDir, ...stagingManifest };
  }

  #sanitizePath(path) {
    return String(path).replace(/[<>:"|?*]/g, '_').replace(/\//g, '_').replace(/\\/g, '_');
  }

  #sanitizeFilename(name) {
    return String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').substring(0, 80);
  }
}
