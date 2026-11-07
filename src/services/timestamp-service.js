import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Rfc3161TimestampService } from './rfc3161-timestamp.js';

// Timestamps for collections and exports come only from an external RFC 3161 authority. Each one covers a
// file an examiner can hash independently, and its token is written beside that file (<file>.tsr).
export class TimestampService {

  // One line per item, sorted, so the file is reproducible from the evidence itself.
  static collectionDigestFile(messages) {
    const lines = messages
      .map(m => `${m.hash_sha256 || m.hashSha256 || ''}  ${m.message_id || m.messageId || ''}`)
      .filter(l => !l.startsWith('  '))
      .sort();
    return `${lines.join('\n')}\n`;
  }

  static async timestampFile(filePath, options = {}) {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    const record = await Rfc3161TimestampService.requestFromAny(hash, options);
    record.targetFile = filePath;
    if (record.timestampToken) {
      const tokenPath = `${filePath}.tsr`;
      fs.writeFileSync(tokenPath, Buffer.from(record.timestampToken, 'base64'));
      record.tokenFile = tokenPath;
    }
    return record;
  }

  static async timestampCollection(projectId, messages, dir, label, options = {}) {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `collection_hashes_${label}.txt`);
    fs.writeFileSync(file, this.collectionDigestFile(messages));
    const record = await this.timestampFile(file, options);
    return { ...record, projectId, targetType: 'collection', messageCount: messages.length };
  }

  static async timestampExport(projectId, exportDir, options = {}) {
    const record = await this.timestampFile(path.join(exportDir, 'manifest.txt'), options);
    return { ...record, projectId, targetType: 'export' };
  }

  static getInfo() {
    return Rfc3161TimestampService.getInfo();
  }
}
