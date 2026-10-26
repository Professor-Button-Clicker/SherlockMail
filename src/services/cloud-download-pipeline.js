import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { HashManager } from './hash-manager.js';
import { CloudCollectionService } from './cloud-collection.js';

export class CloudDownloadPipeline {

  static async processLinks(projectId, driveLinks, accessTokens, outputDir) {
    const results = [];
    const stagingDir = path.join(outputDir, 'cloud_attachments', 'staging');
    const finalDir = path.join(outputDir, 'cloud_attachments', 'files');
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.mkdirSync(finalDir, { recursive: true });

    for (const link of driveLinks) {
      const downloadId = uuidv4();
      const record = {
        id: downloadId,
        projectId,
        driveLinkId: link.id,
        provider: link.provider,
        remoteUrl: link.url,
        stage: 'queued',
      };

      try {
        record.stage = 'staging';
        const token = this._getTokenForProvider(link.provider, accessTokens);
        if (!token) {
          record.stage = 'failed';
          record.error = `No access token for provider: ${link.provider}`;
          results.push(record);
          continue;
        }

        record.stage = 'downloading';
        const stagingPath = path.join(stagingDir, `${downloadId}_${this._safeFilename(link.file_id || link.fileId || 'file')}`);

        let downloadResult;
        if (link.provider === 'google_drive' || link.provider === 'google_docs') {
          downloadResult = await CloudCollectionService.downloadGoogleDriveFile(token, link.file_id || link.fileId, stagingPath);
        } else if (link.provider === 'onedrive' || link.provider === 'sharepoint') {
          downloadResult = await CloudCollectionService.downloadOneDriveFile(token, link.file_id || link.fileId, stagingPath);
        } else {
          record.stage = 'failed';
          record.error = `Unsupported provider for download: ${link.provider}`;
          results.push(record);
          continue;
        }

        record.stage = 'hashing';
        const fileContent = fs.readFileSync(stagingPath);
        const hashes = HashManager.computeAll(fileContent);
        record.hashMd5 = hashes.md5;
        record.hashSha1 = hashes.sha1;
        record.hashSha256 = hashes.sha256;
        record.hashSha384 = hashes.sha384;
        record.fileSize = fileContent.length;

        record.stage = 'packaged';
        const ext = path.extname(link.url || '').split('?')[0] || '';
        const finalName = `${link.provider}_${hashes.sha256.substring(0, 12)}${ext}`;
        const finalPath = path.join(finalDir, finalName);
        fs.renameSync(stagingPath, finalPath);
        record.localPath = finalPath;
        record.fileName = finalName;
        record.startedAt = new Date().toISOString();
        record.completedAt = new Date().toISOString();

      } catch (err) {
        record.stage = 'failed';
        record.error = err.message;
      }

      results.push(record);
    }

    const manifest = this._generateManifest(results, outputDir);

    return {
      totalLinks: driveLinks.length,
      downloaded: results.filter(r => r.stage === 'packaged').length,
      failed: results.filter(r => r.stage === 'failed').length,
      totalBytes: results.reduce((s, r) => s + (r.fileSize || 0), 0),
      results,
      manifestPath: manifest.path,
      manifestHash: manifest.hash,
    };
  }

  static _getTokenForProvider(provider, tokens) {
    if (provider === 'google_drive' || provider === 'google_docs') return tokens.google;
    if (provider === 'onedrive' || provider === 'sharepoint') return tokens.microsoft;
    if (provider === 'dropbox') return tokens.dropbox;
    if (provider === 'box') return tokens.box;
    return null;
  }

  static _safeFilename(name) {
    return String(name).replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 100);
  }

  static _generateManifest(results, outputDir) {
    const lines = [
      '=' .repeat(64),
      'CLOUD ATTACHMENT DOWNLOAD MANIFEST',
      '='.repeat(64),
      `Generated: ${new Date().toISOString()}`,
      `Tool: SherlockMail v0.9.0`,
      `Total Files: ${results.filter(r => r.stage === 'packaged').length}`,
      `Failed: ${results.filter(r => r.stage === 'failed').length}`,
      '',
    ];

    for (const r of results.filter(r => r.stage === 'packaged')) {
      lines.push(`File: ${r.fileName}`);
      lines.push(`  Provider: ${r.provider}`);
      lines.push(`  Source: ${r.remoteUrl}`);
      lines.push(`  Size: ${r.fileSize} bytes`);
      lines.push(`  MD5: ${r.hashMd5}`);
      lines.push(`  SHA-1: ${r.hashSha1}`);
      lines.push(`  SHA-256: ${r.hashSha256}`);
      lines.push(`  SHA-384: ${r.hashSha384}`);
      lines.push('');
    }

    const text = lines.join('\n');
    const hash = crypto.createHash('sha256').update(text).digest('hex');
    const manifestPath = path.join(outputDir, 'cloud_attachments', 'manifest.txt');
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, text);

    return { path: manifestPath, hash, text };
  }
}
