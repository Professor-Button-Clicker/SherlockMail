import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.join(__dirname, '..', '..', 'data');
const CREDENTIALS_PATH = path.join(CONFIG_DIR, 'fastmail-credentials.json');

const SESSION_URL = 'https://api.fastmail.com/jmap/session';

function ensureDataDir() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

export function loadCredentials() {
  if (fs.existsSync(CREDENTIALS_PATH)) {
    return JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  }
  return null;
}

export function saveCredentials(credentialsJson) {
  ensureDataDir();
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(credentialsJson, null, 2));
}

export function getAuthStatus() {
  const creds = loadCredentials();
  if (!creds || !creds.api_token) return { configured: false, authorized: false };

  return {
    configured: true,
    authorized: true,
    tokenPrefix: creds.api_token.substring(0, 8) + '...',
  };
}

export async function getSession() {
  const creds = loadCredentials();
  if (!creds?.api_token) throw new Error('Fastmail API token not configured');

  const res = await fetch(SESSION_URL, {
    headers: { Authorization: `Bearer ${creds.api_token}` },
  });

  if (!res.ok) {
    if (res.status === 401) throw new Error('Invalid API token. Generate a new one in Fastmail Settings > Privacy & Security > API tokens.');
    throw new Error(`Session request failed (${res.status})`);
  }

  return res.json();
}

export function getApiToken() {
  const creds = loadCredentials();
  if (!creds?.api_token) throw new Error('Fastmail API token not configured');
  return creds.api_token;
}

export function revokeTokens() {
  if (fs.existsSync(CREDENTIALS_PATH)) fs.unlinkSync(CREDENTIALS_PATH);
}
