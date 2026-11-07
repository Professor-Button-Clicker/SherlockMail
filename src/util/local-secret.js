import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Secrets the app must reuse unattended (SMTP and proxy passwords, imported private keys) are encrypted with
// a random key kept in a separate file in the data folder, so the database alone does not reveal them.
// This protects a copied database; it does not protect against someone who has the whole data folder.
function keyPath() {
  return path.join(process.env.SHERLOCKMAIL_DATA_DIR || path.join(__dirname, '..', '..', 'data'), '.local-secret-key');
}

function localKey() {
  const file = keyPath();
  if (fs.existsSync(file)) return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, key.toString('base64'), { mode: 0o600 });
  return key;
}

export function encryptSecret(plaintext) {
  if (plaintext == null || plaintext === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', localKey(), iv);
  const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${data.toString('base64')}`;
}

export function decryptSecret(stored) {
  if (!stored) return null;
  const [version, iv, tag, data] = String(stored).split(':');
  if (version !== 'v1') throw new Error('Unknown secret format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', localKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}
