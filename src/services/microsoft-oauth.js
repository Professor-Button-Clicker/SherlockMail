import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { URL } from 'url';
import crypto from 'crypto';
import { createAuthWaiters } from './auth-waiters.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_DIR = path.join(__dirname, '..', '..', 'data');
function getConfigDir() { return process.env.SHERLOCKMAIL_DATA_DIR || BUNDLED_DIR; }
function getTokensPath() { return path.join(getConfigDir(), 'microsoft-tokens.json'); }
function getCredentialsPath() { return path.join(getConfigDir(), 'microsoft-credentials.json'); }

// Files.Read.All lets linked files that others shared with the account be downloaded, not only its own.
const SCOPES = ['offline_access', 'Mail.Read', 'Files.Read', 'Files.Read.All'];
const AUTH_BASE = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const REDIRECT_URI = 'http://localhost:3848/oauth2callback';

let callbackServer = null;
const authWaiters = createAuthWaiters();

function ensureDataDir() {
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function loadCredentials() {
  if (fs.existsSync(getCredentialsPath())) {
    return JSON.parse(fs.readFileSync(getCredentialsPath(), 'utf8'));
  }
  const bundledPath = path.join(BUNDLED_DIR, 'microsoft-credentials.json');
  if (bundledPath !== getCredentialsPath() && fs.existsSync(bundledPath)) {
    const raw = JSON.parse(fs.readFileSync(bundledPath, 'utf8'));
    ensureDataDir();
    fs.writeFileSync(getCredentialsPath(), JSON.stringify(raw, null, 2));
    return raw;
  }
  return null;
}

export function saveCredentials(credentialsJson) {
  ensureDataDir();
  fs.writeFileSync(getCredentialsPath(), JSON.stringify(credentialsJson, null, 2));
}

function loadTokens() {
  if (fs.existsSync(getTokensPath())) {
    return JSON.parse(fs.readFileSync(getTokensPath(), 'utf8'));
  }
  return null;
}

function saveTokens(tokens) {
  ensureDataDir();
  fs.writeFileSync(getTokensPath(), JSON.stringify(tokens, null, 2));
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
    expiresAt: tokens.expires_at ? new Date(tokens.expires_at).toISOString() : null,
  };
}

export function getAuthUrl() {
  const creds = loadCredentials();
  if (!creds || !creds.client_id) return null;

  const state = crypto.randomBytes(16).toString('hex');
  const params = new URLSearchParams({
    client_id: creds.client_id,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES.join(' '),
    response_mode: 'query',
    state,
    prompt: 'consent',
  });

  return `${AUTH_BASE}/authorize?${params.toString()}`;
}

async function exchangeCodeForTokens(code) {
  const creds = loadCredentials();
  if (!creds) throw new Error('Microsoft credentials not configured');

  const body = new URLSearchParams({
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    code,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
    scope: SCOPES.join(' '),
  });

  const res = await fetch(`${AUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error_description || err.error || `Token exchange failed (${res.status})`);
  }

  const data = await res.json();
  const tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in * 1000),
    token_type: data.token_type,
    scope: data.scope,
  };
  saveTokens(tokens);
  return tokens;
}

export async function refreshAccessToken() {
  const creds = loadCredentials();
  const tokens = loadTokens();
  if (!creds || !tokens?.refresh_token) throw new Error('No refresh token available');

  const body = new URLSearchParams({
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    refresh_token: tokens.refresh_token,
    grant_type: 'refresh_token',
    scope: SCOPES.join(' '),
  });

  const res = await fetch(`${AUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error_description || err.error || `Token refresh failed (${res.status})`);
  }

  const data = await res.json();
  const updated = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || tokens.refresh_token,
    expires_at: Date.now() + (data.expires_in * 1000),
    token_type: data.token_type,
    scope: data.scope,
  };
  saveTokens(updated);
  return updated;
}

export async function getAccessToken() {
  let tokens = loadTokens();
  if (!tokens) throw new Error('Microsoft account not authorized');

  if (tokens.expires_at && tokens.expires_at < Date.now() + 60000) {
    tokens = await refreshAccessToken();
  }

  return tokens.access_token;
}

export function startCallbackServer() {
  return new Promise((resolve, reject) => {
    if (callbackServer) { resolve(); return; }

    callbackServer = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost:3848');

      if (url.pathname === '/oauth2callback') {
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');
        const errorDesc = url.searchParams.get('error_description');

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`<html><body><h2>Authorization denied.</h2><p>${errorDesc || error}</p><p>You can close this window.</p></body></html>`);
          authWaiters.settle({ error: errorDesc || error });
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

    callbackServer.listen(3848, '127.0.0.1', () => resolve());

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
  if (fs.existsSync(getTokensPath())) fs.unlinkSync(getTokensPath());
}
