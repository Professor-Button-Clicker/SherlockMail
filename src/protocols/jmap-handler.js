import { v4 as uuidv4 } from 'uuid';
import { getSession, getApiToken, getAuthStatus } from '../services/fastmail-auth.js';
import { buildMessageRecord, withRetry } from '../services/collection-engine.js';

const QUERY_PAGE = 256;
const GET_BATCH = 100;
const KEYWORD_FLAGS = { $seen: '\\Seen', $flagged: '\\Flagged', $answered: '\\Answered', $draft: '\\Draft' };

export class JmapHandler {
  constructor(config) {
    this.config = config;
    this.protocolLog = [];
    this.apiUrl = null;
    this.accountId = null;
    this.apiToken = null;
  }

  log(direction, message) {
    this.protocolLog.push({
      timestamp: new Date().toISOString(),
      direction,
      message
    });
  }

  async jmapRequest(methodCalls) {
    const body = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls,
    };

    const res = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `JMAP error (${res.status})`);
    }

    return res.json();
  }

  async connect() {
    const status = getAuthStatus();
    if (!status.authorized) {
      throw new Error('Fastmail API token not configured. Enter your API token first.');
    }

    this.apiToken = getApiToken();

    this.log('CLIENT', 'Connecting to Fastmail via JMAP');
    this.log('C→S', 'GET https://api.fastmail.com/jmap/session');

    const session = await getSession();
    this.apiUrl = session.apiUrl;
    this.downloadUrl = session.downloadUrl;
    this.accountId = session.primaryAccounts['urn:ietf:params:jmap:mail'];

    const account = session.accounts[this.accountId];

    this.log('S→C', `200 OK - accountId: "${this.accountId}", name: "${account.name}"`);

    return {
      success: true,
      email: account.name,
      accountId: this.accountId,
      apiUrl: this.apiUrl,
      capabilities: this.constructor.getCapabilities(),
    };
  }

  async listFolders() {
    this.log('C→S', `POST ${this.apiUrl} — Mailbox/get`);

    const response = await this.jmapRequest([
      ['Mailbox/get', { accountId: this.accountId }, '0'],
    ]);

    const mailboxes = response.methodResponses[0][1].list || [];

    const folders = mailboxes.map(mb => ({
      id: uuidv4(),
      path: mb.name,
      name: mb.name,
      jmapMailboxId: mb.id,
      totalMessages: mb.totalEmails || 0,
      unseenMessages: mb.unreadEmails || 0,
      role: mb.role,
      sortOrder: mb.sortOrder,
    }));

    this.log('S→C', `200 OK - ${folders.length} mailboxes returned`);
    return folders;
  }

  async searchMessages(criteria) {
    const filter = {};
    if (criteria.keyword) filter.text = criteria.keyword;
    if (criteria.from) filter.from = criteria.from;
    if (criteria.subject) filter.subject = criteria.subject;
    if (criteria.hasAttachment) filter.hasAttachment = true;
    if (criteria.since) filter.after = criteria.since;
    if (criteria.before) filter.before = criteria.before;

    this.log('C→S', `POST ${this.apiUrl} — Email/query`);

    const response = await this.jmapRequest([
      ['Email/query', {
        accountId: this.accountId,
        filter,
        sort: [{ property: 'receivedAt', isAscending: false }],
        limit: 50,
      }, '0'],
    ]);

    const queryResult = response.methodResponses[0][1];
    const ids = queryResult.ids || [];

    this.log('S→C', `200 OK - ${ids.length} messages matched`);

    return {
      query: JSON.stringify(filter),
      resultCount: ids.length,
      searchId: uuidv4(),
    };
  }

  // The raw RFC 5322 message the server stores is the email's blob (RFC 8621 section 4.1.1); it is
  // downloaded byte for byte from the session's downloadUrl.
  async downloadBlob(blobId) {
    if (!this.downloadUrl) throw new Error('The JMAP session gave no downloadUrl, so the raw message cannot be fetched');
    const url = this.downloadUrl
      .replace('{accountId}', encodeURIComponent(this.accountId))
      .replace('{blobId}', encodeURIComponent(blobId))
      .replace('{name}', 'message.eml')
      .replace('{type}', encodeURIComponent('message/rfc822'));
    const res = await fetch(url, { headers: { Authorization: `Bearer ${this.apiToken}` }, signal: AbortSignal.timeout(120000) });
    if (!res.ok) {
      const err = new Error(`Raw message download failed (HTTP ${res.status})`);
      if (res.status === 404) err.permanent = true;
      throw err;
    }
    return Buffer.from(await res.arrayBuffer());
  }

  // Every email in the mailbox (or the first `limit`), each built from its raw message. An email whose
  // raw message cannot be downloaded is returned with fetchError and no content; nothing is made up.
  async fetchMessages(folderIdOrPath, { limit } = {}) {
    const mailboxId = typeof folderIdOrPath === 'string'
      ? folderIdOrPath
      : folderIdOrPath.jmapMailboxId || folderIdOrPath.path || folderIdOrPath;

    let resolvedMailboxId = mailboxId;
    if (!mailboxId.startsWith('M') && !/^[a-f0-9-]+$/i.test(mailboxId)) {
      const mbResponse = await this.jmapRequest([
        ['Mailbox/get', { accountId: this.accountId }, '0'],
      ]);
      const mailboxes = mbResponse.methodResponses[0][1].list || [];
      const match = mailboxes.find(mb => mb.name === mailboxId || mb.role === mailboxId.toLowerCase());
      if (!match) throw new Error(`Mailbox "${mailboxId}" not found`);
      resolvedMailboxId = match.id;
    }

    this.log('C→S', `POST ${this.apiUrl} — Email/query (paged) + Email/get + raw message downloads`);

    const ids = [];
    for (let position = 0; ;) {
      const queryResponse = await this.jmapRequest([
        ['Email/query', {
          accountId: this.accountId,
          filter: { inMailbox: resolvedMailboxId },
          sort: [{ property: 'receivedAt', isAscending: false }],
          position,
          limit: QUERY_PAGE,
          calculateTotal: true,
        }, '0'],
      ]);
      const result = queryResponse.methodResponses[0][1];
      const page = result.ids || [];
      ids.push(...page);
      position += page.length;
      if (!page.length || (result.total != null && position >= result.total) || (limit > 0 && ids.length >= limit)) break;
    }
    const selected = limit > 0 ? ids.slice(0, limit) : ids;
    this.log('S→C', `200 OK - ${selected.length} message(s) listed`);

    const messages = [];
    for (let i = 0; i < selected.length; i += GET_BATCH) {
      const getResponse = await this.jmapRequest([
        ['Email/get', {
          accountId: this.accountId,
          ids: selected.slice(i, i + GET_BATCH),
          properties: ['id', 'blobId', 'receivedAt', 'size', 'keywords'],
        }, '0'],
      ]);
      for (const email of getResponse.methodResponses[0][1].list || []) {
        const uid = messages.length + 1;
        const flags = Object.keys(email.keywords || {}).filter(k => email.keywords[k]).map(k => KEYWORD_FLAGS[k] || k);
        try {
          const raw = await withRetry(() => this.downloadBlob(email.blobId), { attempts: 3 });
          const record = await buildMessageRecord(raw, { uid, serviceId: email.id, folder: folderIdOrPath, flags, internalDate: email.receivedAt || null });
          messages.push({ ...record, jmapId: email.id });
        } catch (err) {
          messages.push({ id: uuidv4(), uid, jmapId: email.id, serviceId: email.id, folder: folderIdOrPath, fetchError: err.message });
        }
      }
    }

    this.log('CLIENT', `Fetched ${messages.filter(m => !m.fetchError).length} raw message(s) from mailbox via JMAP${messages.some(m => m.fetchError) ? `; ${messages.filter(m => m.fetchError).length} could not be downloaded` : ''}`);
    return messages;
  }

  async disconnect() {
    this.apiUrl = null;
    this.accountId = null;
    this.apiToken = null;
    this.log('CLIENT', 'JMAP session ended');
  }

  getProtocolLog() {
    return this.protocolLog;
  }

  static getCapabilities() {
    return {
      protocols: ['JMAP (RFC 8621)'],
      authentication: ['Bearer Token (API Key)', 'OAuth 2.0'],
      features: [
        'Mailbox enumeration',
        'Email query with filters',
        'Full message content retrieval',
        'Attachment metadata',
        'Server-side sorting',
        'Batch method calls',
        'Delta sync via state tokens',
        'Pagination via position/anchor',
      ],
      searchOperators: [
        'text (full-text)', 'from', 'to', 'cc', 'bcc',
        'subject', 'body',
        'after', 'before',
        'hasAttachment',
        'inMailbox', 'inMailboxOtherThan',
        'AND', 'OR', 'NOT (operator)',
      ],
      scopes: ['JMAP core', 'JMAP mail'],
    };
  }
}
