import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { URL } from 'url';
import { createAuthWaiters } from './auth-waiters.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_DIR = path.join(__dirname, '..', '..', 'data');
function getConfigDir() { return process.env.SHERLOCKMAIL_DATA_DIR || BUNDLED_DIR; }
function getTokensPath() { return path.join(getConfigDir(), 'google-tokens.json'); }
function getCredentialsPath() { return path.join(getConfigDir(), 'google-credentials.json'); }

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
];

let oAuth2Client = null;
let callbackServer = null;
const authWaiters = createAuthWaiters();

function ensureDataDir() {
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function loadCredentials() {
  if (fs.existsSync(getCredentialsPath())) {
    const raw = JSON.parse(fs.readFileSync(getCredentialsPath(), 'utf8'));
    const creds = raw.installed || raw.web;
    return creds;
  }
  const bundledPath = path.join(BUNDLED_DIR, 'google-credentials.json');
  if (bundledPath !== getCredentialsPath() && fs.existsSync(bundledPath)) {
    const raw = JSON.parse(fs.readFileSync(bundledPath, 'utf8'));
    ensureDataDir();
    fs.writeFileSync(getCredentialsPath(), JSON.stringify(raw, null, 2));
    return raw.installed || raw.web;
  }
  return null;
}

export function saveCredentials(credentialsJson) {
  ensureDataDir();
  fs.writeFileSync(getCredentialsPath(), JSON.stringify(credentialsJson, null, 2));
}

export function getOAuth2Client() {
  if (oAuth2Client) return oAuth2Client;

  const creds = loadCredentials();
  if (!creds) return null;

  oAuth2Client = new google.auth.OAuth2(
    creds.client_id,
    creds.client_secret,
    'http://localhost:3847/oauth2callback'
  );

  const tokens = loadTokens();
  if (tokens) {
    oAuth2Client.setCredentials(tokens);
    oAuth2Client.on('tokens', (newTokens) => {
      const merged = { ...tokens, ...newTokens };
      saveTokens(merged);
    });
  }

  return oAuth2Client;
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

export function getAuthUrl() {
  const client = getOAuth2Client();
  if (!client) return null;

  return client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });
}

export function getAuthStatus() {
  const creds = loadCredentials();
  if (!creds) return { configured: false, authorized: false };

  const tokens = loadTokens();
  if (!tokens) return { configured: true, authorized: false };

  const expired = tokens.expiry_date && tokens.expiry_date < Date.now();
  const hasRefresh = !!tokens.refresh_token;

  return {
    configured: true,
    authorized: true,
    hasRefreshToken: hasRefresh,
    expired,
    expiryDate: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
  };
}

export async function handleAuthCode(code) {
  const client = getOAuth2Client();
  if (!client) throw new Error('OAuth credentials not configured');

  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  saveTokens(tokens);

  client.on('tokens', (newTokens) => {
    const current = loadTokens() || {};
    const merged = { ...current, ...newTokens };
    saveTokens(merged);
  });

  return tokens;
}

export function startCallbackServer() {
  return new Promise((resolve, reject) => {
    if (callbackServer) {
      resolve();
      return;
    }

    callbackServer = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost:3847');

      if (url.pathname === '/oauth2callback') {
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body><h2>Authorization denied.</h2><p>You can close this window.</p></body></html>');
          authWaiters.settle({ error });
          return;
        }

        if (code) {
          try {
            const tokens = await handleAuthCode(code);
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

    callbackServer.listen(3847, '127.0.0.1', () => {
      resolve();
    });

    callbackServer.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve();
      } else {
        reject(err);
      }
    });
  });
}

export function waitForAuth() {
  return authWaiters.wait();
}

export function stopCallbackServer() {
  if (callbackServer) {
    callbackServer.close();
    callbackServer = null;
  }
}

export function revokeTokens() {
  if (fs.existsSync(getTokensPath())) fs.unlinkSync(getTokensPath());
  if (oAuth2Client) {
    oAuth2Client.revokeCredentials().catch(() => {});
    oAuth2Client = null;
  }
}
