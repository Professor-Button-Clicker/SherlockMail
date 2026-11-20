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
// User.Read lets the connection read who signed in (GET /me); without it Graph answers that call with 401.
const SCOPES = ['offline_access', 'User.Read', 'Mail.Read', 'Files.Read', 'Files.Read.All'];
const AUTH_BASE = process.env.SHERLOCKMAIL_MS_AUTH_URL || 'https://login.microsoftonline.com/common/oauth2/v2.0';

// IMAP, POP3 and EWS do not accept a Graph token: each needs a token issued for Exchange itself. The
// sign-in asks consent for the protocol being used, and its refresh token is then redeemed for that one
// resource (Microsoft issues a token for one resource at a time). EWS exists only for work or school
// accounts; Outlook.com/Hotmail mailboxes are reached through Graph, IMAP or POP3.
const PROTOCOL_SCOPES = {
  imap: 'https://outlook.office.com/IMAP.AccessAsUser.All',
  pop3: 'https://outlook.office.com/POP.AccessAsUser.All',
  ews: 'https://outlook.office365.com/EWS.AccessAsUser.All',
};
const isGraphScope = s => !/^https:\/\//.test(s);
const REDIRECT_URI = 'http://localhost:3848/oauth2callback';

let callbackServer = null;
const authWaiters = createAuthWaiters();

function ensureDataDir() {
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// The app registration shipped with SherlockMail is always used, read fresh from the program folder, so a
// new client secret in a new installer reaches every install. Only an examiner who saved a different
// application (client) ID of their own keeps theirs. Older versions copied the shipped file into the data
// folder; a copy with the shipped client ID is treated as the shipped registration, not as the examiner's.
export function loadCredentials() {
  const bundledPath = path.join(BUNDLED_DIR, 'microsoft-credentials.json');
  const bundled = bundledPath !== getCredentialsPath() ? readJson(bundledPath) : null;
  const saved = fs.existsSync(getCredentialsPath()) ? readJson(getCredentialsPath()) : null;
  if (saved?.client_id && (!bundled?.client_id || saved.client_id !== bundled.client_id)) return saved;
  if (bundled?.client_id) return bundled;
  return saved;
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

const FEATURE_SCOPES = { contacts: 'Contacts.Read', sharepoint: 'Sites.Read.All' };
let requestedScopes = SCOPES;

export function getAuthUrl(features = []) {
  requestedScopes = [...SCOPES, ...features.map(f => FEATURE_SCOPES[f] || PROTOCOL_SCOPES[f]).filter(Boolean)];
  const creds = loadCredentials();
  if (!creds || !creds.client_id) return null;

  const state = crypto.randomBytes(16).toString('hex');
  const params = new URLSearchParams({
    client_id: creds.client_id,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: requestedScopes.join(' '),
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
    // Consent covered every scope asked for; the token itself is for Graph only.
    scope: requestedScopes.filter(isGraphScope).join(' '),
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
    consented: requestedScopes,
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
    scope: tokens.scope || requestedScopes.join(' '),
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
    ...tokens,
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

// A token for IMAP, POP3 or EWS, from the same sign-in's refresh token. Kept apart from the Graph token
// and renewed a minute before it expires.
export async function getProtocolAccessToken(protocol, { force = false } = {}) {
  const scope = PROTOCOL_SCOPES[protocol];
  if (!scope) return getAccessToken();
  const creds = loadCredentials();
  const tokens = loadTokens();
  if (!tokens?.refresh_token) throw new Error('Microsoft account not authorized. Click "Authorize with Microsoft" first.');
  const cached = tokens.protocolTokens?.[protocol];
  if (!force && cached?.access_token && cached.expires_at > Date.now() + 60000) return cached.access_token;

  const label = { imap: 'IMAP', pop3: 'POP3', ews: 'EWS' }[protocol];
  const res = await fetch(`${AUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds?.client_id, client_secret: creds?.client_secret,
      refresh_token: tokens.refresh_token, grant_type: 'refresh_token', scope: `${scope} offline_access`,
    }).toString(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const why = String(err.error_description || err.error || `HTTP ${res.status}`).split(/[\r\n]/)[0].trim();
    const consent = /consent|AADSTS65001|invalid_grant|invalid_scope|AADSTS70000|AADSTS70011/i.test(why);
    throw new Error(consent
      ? `Microsoft has not given SherlockMail ${label} access for this account yet. With the ${label} profile selected, click "Revoke Access", then "Authorize with Microsoft" and accept. `
        + (protocol === 'ews' ? 'EWS works only for work or school (Microsoft 365) accounts, not Outlook.com or Hotmail. ' : '')
        + `(Microsoft said: ${why})`
      : `Could not get a Microsoft ${label} token: ${why}`);
  }
  const data = await res.json();
  const latest = loadTokens() || tokens;
  latest.refresh_token = data.refresh_token || latest.refresh_token;
  latest.protocolTokens = { ...(latest.protocolTokens || {}), [protocol]: { access_token: data.access_token, expires_at: Date.now() + data.expires_in * 1000, scope: data.scope } };
  saveTokens(latest);
  return data.access_token;
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
