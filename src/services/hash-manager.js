import crypto from 'crypto';
import fs from 'fs';

export class HashManager {

  static ALGORITHMS = ['md5', 'sha1', 'sha256', 'sha384', 'sha512'];

  static computeAll(data) {
    const buf = typeof data === 'string' ? Buffer.from(data) : data;
    const results = {};
    for (const alg of this.ALGORITHMS) {
      results[alg] = crypto.createHash(alg).update(buf).digest('hex');
    }
    results.byteLength = buf.length;
    return results;
  }

  static computeSelected(data, algorithms) {
    const buf = typeof data === 'string' ? Buffer.from(data) : data;
    const results = {};
    for (const alg of algorithms) {
      if (!this.ALGORITHMS.includes(alg)) throw new Error(`Unsupported algorithm: ${alg}`);
      results[alg] = crypto.createHash(alg).update(buf).digest('hex');
    }
    results.byteLength = buf.length;
    return results;
  }

  static computeStreaming(algorithms = this.ALGORITHMS) {
    const hashers = {};
    for (const alg of algorithms) hashers[alg] = crypto.createHash(alg);
    let totalBytes = 0;
    return {
      update(chunk) {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        totalBytes += buf.length;
        for (const h of Object.values(hashers)) h.update(buf);
        return this;
      },
      digest() {
        const results = {};
        for (const [alg, h] of Object.entries(hashers)) results[alg] = h.digest('hex');
        results.byteLength = totalBytes;
        return results;
      },
    };
  }

  static computeFileSync(filePath, algorithms = this.ALGORITHMS) {
    const data = fs.readFileSync(filePath);
    const results = {};
    for (const alg of algorithms) {
      results[alg] = crypto.createHash(alg).update(data).digest('hex');
    }
    results.byteLength = data.length;
    results.filePath = filePath;
    return results;
  }

  static async computeFileStreaming(filePath, algorithms = this.ALGORITHMS) {
    return new Promise((resolve, reject) => {
      const hashers = {};
      for (const alg of algorithms) hashers[alg] = crypto.createHash(alg);
      let totalBytes = 0;
      const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
      stream.on('data', chunk => {
        totalBytes += chunk.length;
        for (const h of Object.values(hashers)) h.update(chunk);
      });
      stream.on('end', () => {
        const results = {};
        for (const [alg, h] of Object.entries(hashers)) results[alg] = h.digest('hex');
        results.byteLength = totalBytes;
        results.filePath = filePath;
        resolve(results);
      });
      stream.on('error', reject);
    });
  }

  static verify(data, expectedHashes) {
    const computed = this.computeAll(data);
    const results = [];
    for (const [alg, expected] of Object.entries(expectedHashes)) {
      if (!expected || alg === 'byteLength') continue;
      const actual = computed[alg];
      results.push({ algorithm: alg, expected, computed: actual, match: actual === expected });
    }
    return {
      allMatch: results.every(r => r.match),
      verified: results.filter(r => r.match).length,
      failed: results.filter(r => !r.match).length,
      algorithms: results,
    };
  }

  static verifyFile(filePath, expectedHashes) {
    const computed = this.computeFileSync(filePath);
    const results = [];
    for (const [alg, expected] of Object.entries(expectedHashes)) {
      if (!expected || alg === 'byteLength' || alg === 'filePath') continue;
      const actual = computed[alg];
      results.push({ algorithm: alg, expected, computed: actual, match: actual === expected });
    }
    return {
      filePath,
      allMatch: results.every(r => r.match),
      verified: results.filter(r => r.match).length,
      failed: results.filter(r => !r.match).length,
      byteLength: computed.byteLength,
      algorithms: results,
    };
  }

  static computeCollectionDigest(messages, algorithm = 'sha256') {
    const hashes = messages
      .map(m => m[`hash_${algorithm}`] || m[`hash${algorithm.charAt(0).toUpperCase() + algorithm.slice(1)}`] || '')
      .filter(Boolean)
      .sort();
    return crypto.createHash(algorithm).update(hashes.join('|')).digest('hex');
  }

  static computeDirectoryManifest(dirPath, algorithms = this.ALGORITHMS) {
    const manifest = { files: [], totalBytes: 0, totalFiles: 0 };
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(full);
        else {
          const hashes = this.computeFileSync(full, algorithms);
          const relPath = full.slice(dirPath.length + 1).replace(/\\/g, '/');
          manifest.files.push({ path: relPath, ...hashes });
          manifest.totalBytes += hashes.byteLength;
          manifest.totalFiles++;
        }
      }
    };
    if (fs.existsSync(dirPath)) walk(dirPath);
    manifest.manifestHash = crypto.createHash('sha256')
      .update(manifest.files.map(f => `${f.path}:${f.sha256}`).sort().join('\n'))
      .digest('hex');
    return manifest;
  }

  static createMimeHashResult(messageId, mimeData, eml = null) {
    const mimeHashes = this.computeAll(mimeData);
    const result = { type: 'mime', messageId, mime: mimeHashes };
    if (eml) result.eml = this.computeAll(eml);
    return result;
  }

  static createDriveHashResult(itemId, fileData, metadata = {}) {
    return { type: 'drive', itemId, file: this.computeAll(fileData), ...metadata };
  }

  static createAttachmentHashResult(attachmentId, data, parentMessageId) {
    return { type: 'attachment', attachmentId, parentMessageId, ...this.computeAll(data) };
  }

  static getAlgorithmInfo() {
    return {
      md5: { name: 'MD5', bits: 128, oid: '1.2.840.113549.2.5', forensicUse: 'Legacy compatibility, fast deduplication', securityNote: 'Collision-vulnerable — not suitable as sole integrity proof' },
      sha1: { name: 'SHA-1', bits: 160, oid: '1.3.14.3.2.26', forensicUse: 'Legacy compatibility, backward compatibility', securityNote: 'Theoretical collision attacks — use SHA-256+ for new evidence' },
      sha256: { name: 'SHA-256', bits: 256, oid: '2.16.840.1.101.3.4.2.1', forensicUse: 'Primary forensic hash — NIST recommended', securityNote: 'No known attacks' },
      sha384: { name: 'SHA-384', bits: 384, oid: '2.16.840.1.101.3.4.2.2', forensicUse: 'Extended integrity verification, higher security margin', securityNote: 'Truncated SHA-512 variant' },
      sha512: { name: 'SHA-512', bits: 512, oid: '2.16.840.1.101.3.4.2.3', forensicUse: 'Maximum integrity assurance', securityNote: 'No known attacks, faster than SHA-256 on 64-bit' },
    };
  }
}
