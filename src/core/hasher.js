import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';

export const SUPPORTED_ALGORITHMS = ['md5', 'sha1', 'sha256', 'sha512'];

export function hashBuffer(buffer, algorithm = 'sha256') {
  return createHash(algorithm).update(buffer).digest('hex');
}

export function hashString(str, algorithm = 'sha256') {
  return createHash(algorithm).update(str, 'utf8').digest('hex');
}

export async function hashFile(filePath, algorithm = 'sha256') {
  return new Promise((resolve, reject) => {
    const hash = createHash(algorithm);
    const stream = createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

export function hashMultiple(buffer, algorithms = ['md5', 'sha256']) {
  const results = {};
  for (const alg of algorithms) {
    results[alg] = createHash(alg).update(buffer).digest('hex');
  }
  return results;
}

export async function verifyFileHash(filePath, expectedHash, algorithm = 'sha256') {
  const actualHash = await hashFile(filePath, algorithm);
  return {
    valid: actualHash === expectedHash.toLowerCase(),
    expected: expectedHash.toLowerCase(),
    actual: actualHash,
    algorithm
  };
}
