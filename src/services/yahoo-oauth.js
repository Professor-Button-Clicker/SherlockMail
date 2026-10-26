import crypto from 'crypto';
import https from 'https';
import http from 'http';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.SHERLOCKMAIL_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const CREDS_PATH = path.join(DATA_DIR, 'yahoo-oauth.json');

const YAHOO_AUTH_URL = 'https://api.login.yahoo.com/oauth2/request_auth';
const YAHOO_TOKEN_URL = 'https://api.login.yahoo.com/oauth2/get_token';
const REDIRECT_URI = 'http://localhost:8891/yahoo/callback';
const SCOPES = 'mail-r openid';

let state = { credentials: null, tokens: null, callbackServer: null };

export function getAuthStatus() {
  loadCredentials();
  return {
    configured: !!state.credentials,
    authenticated: !!state.tokens?.access_token,
    email: state.tokens?.email || null,
    expiresAt: state.tokens?.expires_at || null,
  };
}

export function saveCredentials(creds) {
  state.credentials = { clientId: creds.clientId || creds.client_id, clientSecret: creds.clientSecret || creds.client_secret };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CREDS_PATH, JSON.stringify(state.credentials, null, 2));
}

export function loadCredentials() {
  if (state.credentials) return;
  try {
    state.credentials = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
  } catch {}
}

export function getAuthUrl() {
  loadCredentials();
  if (!state.credentials) return null;
  const csrfState = crypto.randomBytes(16).toString('hex');
  state.csrfState = csrfState;
  const params = new URLSearchParams({
    client_id: state.credentials.clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    state: csrfState,
  });
  return `${YAHOO_AUTH_URL}?${params}`;
}

export function startCallbackServer() {
  return new Promise((resolve) => {
    if (state.callbackServer) { resolve(); return; }
    state.callbackServer = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:8891`);
      if (url.pathname === '/yahoo/callback') {
        state.authCode = url.searchParams.get('code');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>Yahoo Authentication Successful</h2><p>You can close this window.</p></body></html>');
      } else {
        res.writeHead(404); res.end();
      }
    });
    state.callbackServer.listen(8891, resolve);
  });
}

export async function waitForAuth() {
  const timeout = 120000;
  const start = Date.now();
  while (!state.authCode && Date.now() - start < timeout) {
    await new Promise(r => setTimeout(r, 500));
  }
  if (!state.authCode) throw new Error('Authentication timeout');
  const tokens = await exchangeCode(state.authCode);
  state.tokens = tokens;
  state.authCode = null;
  return { success: true, email: tokens.email };
}

export function stopCallbackServer() {
  if (state.callbackServer) { state.callbackServer.close(); state.callbackServer = null; }
}

async function exchangeCode(code) {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: state.credentials.clientId,
    client_secret: state.credentials.clientSecret,
  });

  const data = await httpPost(YAHOO_TOKEN_URL, params.toString(), 'application/x-www-form-urlencoded');
  const tokens = JSON.parse(data);
  tokens.expires_at = new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString();
  return tokens;
}

export async function refreshTokens() {
  if (!state.tokens?.refresh_token) throw new Error('No refresh token');
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: state.tokens.refresh_token,
    client_id: state.credentials.clientId,
    client_secret: state.credentials.clientSecret,
  });
  const data = await httpPost(YAHOO_TOKEN_URL, params.toString(), 'application/x-www-form-urlencoded');
  const newTokens = JSON.parse(data);
  state.tokens = { ...state.tokens, ...newTokens, expires_at: new Date(Date.now() + (newTokens.expires_in || 3600) * 1000).toISOString() };
  return state.tokens;
}

export function getAccessToken() {
  return state.tokens?.access_token || null;
}

export function revokeTokens() {
  state.tokens = null;
  return { success: true };
}

function httpPost(url, body, contentType) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.request({
      hostname: parsed.hostname, port: parsed.port, path: parsed.pathname,
      method: 'POST',
      headers: { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString()));
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}
