import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { google } from 'googleapis';
import { getOAuth2Client, getAuthStatus } from '../services/google-oauth.js';

const ALL_MAIL_NAME = 'All Mail';
const ALL_MAIL_ID = 'ALL_MAIL';

export class GmailHandler {
  constructor(config) {
    this.config = config;
    this.protocolLog = [];
    this.gmail = null;
    this.userEmail = null;
  }

  log(direction, message) {
    if (this.protocolLog.length >= 5000) this.protocolLog.shift();
    this.protocolLog.push({
      timestamp: new Date().toISOString(),
      direction,
      message
    });
  }

  async connect() {
    const status = getAuthStatus();
    if (!status.authorized) {
      throw new Error('Google account not authorized. Click "Authorize with Google" first.');
    }

    const auth = getOAuth2Client();
    // Without a timeout a blocked or proxied network leaves requests hanging forever.
    this.gmail = google.gmail({ version: 'v1', auth, timeout: 60000 });

    this.log('CLIENT', 'Connecting to Gmail API via OAuth2');
    this.log('C→S', 'GET https://gmail.googleapis.com/gmail/v1/users/me/profile');

    const profile = await this.gmail.users.getProfile({ userId: 'me' });
    this.userEmail = profile.data.emailAddress;

    this.log('S→C', `200 OK - emailAddress: "${this.userEmail}", messagesTotal: ${profile.data.messagesTotal}`);

    return {
      success: true,
      email: this.userEmail,
      messagesTotal: profile.data.messagesTotal,
      threadsTotal: profile.data.threadsTotal,
      capabilities: this.constructor.getCapabilities(),
    };
  }

  async listLabels() {
    this.log('C→S', 'GET https://gmail.googleapis.com/gmail/v1/users/me/labels');

    const res = await this.gmail.users.labels.list({ userId: 'me' });
    const labels = res.data.labels || [];

    const [details, profile] = await Promise.all([
      Promise.all(labels.map(label => this.gmail.users.labels.get({ userId: 'me', id: label.id }))),
      this.gmail.users.getProfile({ userId: 'me' }),
    ]);
    const folders = [{
      id: uuidv4(),
      path: ALL_MAIL_NAME,
      name: ALL_MAIL_NAME,
      gmailLabelId: ALL_MAIL_ID,
      totalMessages: profile.data.messagesTotal || 0,
      unseenMessages: 0,
      flags: ['system'],
      delimiter: '/',
      parentPath: null,
    }];
    for (const detail of details) {
      const d = detail.data;
      folders.push({
        id: uuidv4(),
        path: d.name,
        name: d.name.split('/').pop(),
        gmailLabelId: d.id,
        totalMessages: d.messagesTotal || 0,
        unseenMessages: d.messagesUnread || 0,
        flags: [d.type?.toLowerCase() || 'user'],
        delimiter: '/',
        parentPath: d.name.includes('/') ? d.name.substring(0, d.name.lastIndexOf('/')) : null,
      });
    }

    this.log('S→C', `200 OK - ${folders.length} labels returned`);
    return folders;
  }

  async fetchMessages(labelIdOrFolder, { limit } = {}) {
    const labelId = typeof labelIdOrFolder === 'string'
      ? labelIdOrFolder
      : labelIdOrFolder.gmailLabelId || labelIdOrFolder.path || labelIdOrFolder;

    const maxResults = (limit && limit > 0) ? limit : 999999;
    this.log('C→S', `GET /users/me/messages?labelIds=${labelId}&maxResults=${maxResults}`);

    const messages = [];
    let pageToken = null;
    let fetched = 0;

    do {
      const params = {
        userId: 'me',
        labelIds: [labelId],
        maxResults: Math.min(maxResults - fetched, 100),
      };
      if (pageToken) params.pageToken = pageToken;

      const list = await this.gmail.users.messages.list(params);
      const msgIds = list.data.messages || [];
      pageToken = list.data.nextPageToken;

      for (const stub of msgIds) {
        if (fetched >= maxResults) break;

        this.log('C→S', `GET /users/me/messages/${stub.id}?format=raw`);

        const full = await this.gmail.users.messages.get({
          userId: 'me',
          id: stub.id,
          format: 'raw',
        });

        const rawBuffer = Buffer.from(full.data.raw, 'base64url');
        this.log('S→C', `200 OK - raw MIME (${rawBuffer.length} bytes)`);

        const headers = this.parseHeaders(rawBuffer.toString('utf8', 0, Math.min(rawBuffer.length, 8192)));

        messages.push({
          id: uuidv4(),
          uid: fetched + 1,
          gmailId: stub.id,
          folder: labelId,
          subject: headers.subject || '(no subject)',
          fromAddress: headers.from || '',
          toAddresses: headers.to ? headers.to.split(',').map(s => s.trim()) : [],
          ccAddresses: headers.cc ? headers.cc.split(',').map(s => s.trim()) : [],
          date: headers.date ? new Date(headers.date).toISOString() : new Date(parseInt(full.data.internalDate)).toISOString(),
          size: rawBuffer.length,
          hashMd5: crypto.createHash('md5').update(rawBuffer).digest('hex'),
          hashSha256: crypto.createHash('sha256').update(rawBuffer).digest('hex'),
          hashSha512: crypto.createHash('sha512').update(rawBuffer).digest('hex'),
          hasAttachments: (full.data.payload?.parts || []).some(p => p.filename),
          attachmentCount: (full.data.payload?.parts || []).filter(p => p.filename).length,
          bodyText: this.extractBody(rawBuffer.toString('utf8')),
          contentType: headers['content-type'] || 'text/plain',
          rawMime: rawBuffer,
        });

        fetched++;
      }
    } while (pageToken && fetched < maxResults);

    this.log('CLIENT', `Fetched ${messages.length} messages from ${labelId} via Gmail API`);
    return messages;
  }

  async call(fn) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status || err.code;
      const reason = err.errors?.[0]?.reason || '';
      if (status === 429 || (status === 403 && /rateLimitExceeded|userRateLimitExceeded/.test(reason))) {
        const ra = parseFloat(err.response?.headers?.['retry-after']);
        if (!isNaN(ra)) err.retryAfterMs = ra * 1000;
      } else if (status === 400 || status === 404) {
        err.permanent = true;
      }
      throw err;
    }
  }

  async loadLabelMaps() {
    if (this.labelIds) return;
    const res = await this.call(() => this.gmail.users.labels.list({ userId: 'me' }));
    this.labelIds = new Map();
    this.labelNames = new Map();
    for (const l of res.data.labels || []) {
      this.labelIds.set(l.id, l.id);
      this.labelIds.set(l.name, l.id);
      this.labelNames.set(l.id, l.name);
    }
  }

  async resolveLabelId(folder) {
    if (String(folder).toLowerCase() === ALL_MAIL_NAME.toLowerCase() || folder === ALL_MAIL_ID) return ALL_MAIL_ID;
    await this.loadLabelMaps();
    const id = this.labelIds.get(folder) || this.labelIds.get(String(folder).toUpperCase());
    if (!id) {
      const err = new Error(`Gmail label "${folder}" not found`);
      err.permanent = true;
      throw err;
    }
    return id;
  }

  async enumerate(folder, { limit, searchCriteria } = {}) {
    const labelId = await this.resolveLabelId(folder);
    const allMail = labelId === ALL_MAIL_ID;
    const ids = [];
    let pageToken;
    do {
      const res = await this.call(() => this.gmail.users.messages.list({
        userId: 'me',
        // All Mail mirrors Gmail's IMAP "[Gmail]/All Mail": every message, archived ones included, but not Spam or Trash.
        labelIds: allMail ? undefined : [labelId],
        maxResults: 500,
        includeSpamTrash: !allMail,
        q: typeof searchCriteria === 'string' && searchCriteria ? searchCriteria : undefined,
        pageToken,
        fields: 'messages/id,nextPageToken',
      }));
      for (const m of res.data.messages || []) ids.push(m.id);
      pageToken = res.data.nextPageToken;
    } while (pageToken && !(limit > 0 && ids.length >= limit));
    const selected = limit > 0 ? ids.slice(0, limit) : ids;
    this.log('CLIENT', `Enumerated ${selected.length} messages in ${allMail ? 'All Mail' : `label ${folder} (${labelId})`}`);
    return { key: labelId, refs: selected.map((id, i) => ({ key: id, uid: i + 1, serviceId: id, globalKey: `gmail:${id}` })) };
  }

  // messages.list returns no sizes, so the pre-collection estimate measures a random sample.
  async sampleSizes(refs, sampleSize = 100) {
    const pool = refs.slice();
    const sample = [];
    while (pool.length && sample.length < sampleSize) {
      sample.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    }
    const sizes = [];
    for (let i = 0; i < sample.length; i += 10) {
      const results = await Promise.allSettled(sample.slice(i, i + 10).map(ref => this.call(() =>
        this.gmail.users.messages.get({ userId: 'me', id: ref.key, format: 'minimal', fields: 'sizeEstimate' }))));
      for (const r of results) if (r.status === 'fulfilled' && r.value.data.sizeEstimate > 0) sizes.push(r.value.data.sizeEstimate);
    }
    return { sampled: sizes.length, averageBytes: sizes.length ? sizes.reduce((a, b) => a + b, 0) / sizes.length : 0 };
  }

  async fetchBatch(_labelId, refs, deliver) {
    await this.loadLabelMaps();
    const out = [];
    const emit = deliver || (item => out.push(item));
    for (const ref of refs) {
      const res = await this.call(() => this.gmail.users.messages.get({
        userId: 'me', id: ref.key, format: 'raw', fields: 'id,threadId,labelIds,internalDate,raw',
      }));
      const labelIds = res.data.labelIds || [];
      emit({
        ref,
        raw: Buffer.from(res.data.raw, 'base64url'),
        meta: {
          flags: labelIds,
          gmailLabels: labelIds.map(id => this.labelNames.get(id) || id),
          internalDate: res.data.internalDate ? new Date(parseInt(res.data.internalDate, 10)).toISOString() : null,
        },
      });
    }
    return out;
  }

  parseHeaders(headerBlock) {
    const headers = {};
    const endOfHeaders = headerBlock.indexOf('\r\n\r\n');
    const block = endOfHeaders > 0 ? headerBlock.substring(0, endOfHeaders) : headerBlock;
    const lines = block.split(/\r?\n/);
    let currentKey = null;

    for (const line of lines) {
      if (line.startsWith(' ') || line.startsWith('\t')) {
        if (currentKey) headers[currentKey] += ' ' + line.trim();
      } else {
        const colonIdx = line.indexOf(':');
        if (colonIdx > 0) {
          currentKey = line.substring(0, colonIdx).toLowerCase();
          headers[currentKey] = line.substring(colonIdx + 1).trim();
        }
      }
    }

    return headers;
  }

  extractBody(raw) {
    const bodyStart = raw.indexOf('\r\n\r\n');
    if (bodyStart < 0) return '';
    return raw.substring(bodyStart + 4, bodyStart + 4 + 1000).trim();
  }

  async disconnect() {
    this.gmail = null;
    this.log('CLIENT', 'Gmail API session ended');
  }

  getProtocolLog() {
    return this.protocolLog;
  }

  static getCapabilities() {
    return {
      protocols: ['Gmail REST API v1'],
      authentication: ['OAuth2 (Authorization Code)', 'Service Account (Domain-Wide Delegation)'],
      features: [
        'Label-based folder structure',
        'Server-side search (Gmail search syntax)',
        'Raw MIME content download (format=raw)',
        'Batch requests (up to 100 per batch)',
        'History-based incremental sync',
        'Thread-based conversation grouping',
        'Push notifications via Pub/Sub',
        'Pagination via nextPageToken',
        'Trash and Spam access',
      ],
      searchOperators: [
        'from:', 'to:', 'cc:', 'bcc:', 'subject:',
        'has:attachment', 'filename:', 'label:',
        'after:', 'before:', 'older:', 'newer:',
        'larger:', 'smaller:', 'size:',
        'is:unread', 'is:starred', 'is:important',
        'in:inbox', 'in:sent', 'in:trash', 'in:spam', 'in:anywhere',
        'category:', 'deliveredto:', 'list:',
        'OR', '-', '""', '()',
      ],
      scopes: [
        'gmail.readonly',
        'gmail.metadata',
      ],
    };
  }
}
