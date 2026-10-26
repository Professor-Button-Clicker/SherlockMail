import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { URL } from 'url';
import crypto from 'crypto';
import { createAuthWaiters } from './auth-waiters.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.join(__dirname, '..', '..', 'data');
const TOKENS_PATH = path.join(CONFIG_DIR, 'zoho-tokens.json');
const CREDENTIALS_PATH = path.join(CONFIG_DIR, 'zoho-credentials.json');

const SCOPES = [
  'ZohoMail.messages.READ',
  'ZohoMail.folders.READ',
  'ZohoMail.accounts.READ',
  'ZohoMail.attachments.READ',
];

const REDIRECT_URI = 'http://localhost:3849/oauth2callback';

let callbackServer = null;
const authWaiters = createAuthWaiters();

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

function loadTokens() {
  if (fs.existsSync(TOKENS_PATH)) {
    return JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
  }
  return null;
}

function saveTokens(tokens) {
  ensureDataDir();
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));
}

function getAuthBase(region) {
  const regions = {
    us: 'https://accounts.zoho.com',
    eu: 'https://accounts.zoho.eu',
    in: 'https://accounts.zoho.in',
    au: 'https://accounts.zoho.com.au',
    jp: 'https://accounts.zoho.jp',
  };
  return regions[region] || regions.us;
}

export function getApiBase(region) {
  const regions = {
    us: 'https://mail.zoho.com',
    eu: 'https://mail.zoho.eu',
    in: 'https://mail.zoho.in',
    au: 'https://mail.zoho.com.au',
    jp: 'https://mail.zoho.jp',
  };
  return regions[region] || regions.us;
}

export function getAuthStatus() {
  const creds = loadCredentials();
  if (!creds || !creds.client_id) return { configured: false, authorized: false };

  const tokens = loadTokens();
  if (!tokens) return { configured: true, authorized: false };

  const expired = tokens.expires_at && tokens.expires_at < Date.now();
  const hasRefresh = !!tokens.refresh_token;

  return {
    configured: true,
    authorized: true,
    hasRefreshToken: hasRefresh,
    expired,
    region: creds.region || 'us',
    expiresAt: tokens.expires_at ? new Date(tokens.expires_at).toISOString() : null,
  };
}

export function getAuthUrl() {
  const creds = loadCredentials();
  if (!creds || !creds.client_id) return null;

  const authBase = getAuthBase(creds.region || 'us');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: creds.client_id,
    scope: SCOPES.join(','),
    redirect_uri: REDIRECT_URI,
    access_type: 'offline',
    prompt: 'consent',
  });

  return `${authBase}/oauth/v2/auth?${params.toString()}`;
}

async function exchangeCodeForTokens(code) {
  const creds = loadCredentials();
  if (!creds) throw new Error('Zoho credentials not configured');

  const authBase = getAuthBase(creds.region || 'us');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    redirect_uri: REDIRECT_URI,
    code,
  });

  const res = await fetch(`${authBase}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Token exchange failed (${res.status})`);
  }

  const data = await res.json();
  if (data.error) throw new Error(data.error);

  const tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + ((data.expires_in || 3600) * 1000),
    token_type: data.token_type,
    api_domain: data.api_domain,
  };
  saveTokens(tokens);
  return tokens;
}

export async function refreshAccessToken() {
  const creds = loadCredentials();
  const tokens = loadTokens();
  if (!creds || !tokens?.refresh_token) throw new Error('No refresh token available');

  const authBase = getAuthBase(creds.region || 'us');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    refresh_token: tokens.refresh_token,
  });

  const res = await fetch(`${authBase}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Token refresh failed (${res.status})`);
  }

  const data = await res.json();
  if (data.error) throw new Error(data.error);

  const updated = {
    access_token: data.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + ((data.expires_in || 3600) * 1000),
    token_type: data.token_type,
    api_domain: data.api_domain || tokens.api_domain,
  };
  saveTokens(updated);
  return updated;
}

export async function getAccessToken() {
  let tokens = loadTokens();
  if (!tokens) throw new Error('Zoho account not authorized');

  if (tokens.expires_at && tokens.expires_at < Date.now() + 60000) {
    tokens = await refreshAccessToken();
  }

  return tokens.access_token;
}

export function startCallbackServer() {
  return new Promise((resolve, reject) => {
    if (callbackServer) { resolve(); return; }

    callbackServer = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost:3849');

      if (url.pathname === '/oauth2callback') {
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`<html><body><h2>Authorization denied.</h2><p>${error}</p><p>You can close this window.</p></body></html>`);
          authWaiters.settle({ error });
          return;
        }

        if (code) {
          try {
            const tokens = await exchangeCodeForTokens(code);
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<html><body><h2>Authorization successful!</h2><p>You can close this window and return to SherlockMail.</p></body></html>');
            authWaiters.settle({ success: true, tokens });
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'text/html' });
            res.end(`<html><body><h2>Error</h2><p>${err.message}</p></body></html>`);
            authWaiters.settle({ error: err.message });
          }
          return;
        }
      }

      res.writeHead(404);
      res.end();
    });

    callbackServer.listen(3849, '127.0.0.1', () => resolve());
    callbackServer.on('error', (err) => {
      if (err.code === 'EADDRINUSE') resolve();
      else reject(err);
    });
  });
}

export function waitForAuth() {
  return authWaiters.wait();
}

export function stopCallbackServer() {
  if (callbackServer) { callbackServer.close(); callbackServer = null; }
}

export function revokeTokens() {
  if (fs.existsSync(TOKENS_PATH)) fs.unlinkSync(TOKENS_PATH);
}
