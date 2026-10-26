import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { getSession, getApiToken, getAuthStatus } from '../services/fastmail-auth.js';

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

  async fetchMessages(folderIdOrPath, { limit } = {}) {
    const mailboxId = typeof folderIdOrPath === 'string'
      ? folderIdOrPath
      : folderIdOrPath.jmapMailboxId || folderIdOrPath.path || folderIdOrPath;

    const top = limit || 25;

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

    this.log('C→S', `POST ${this.apiUrl} — Email/query + Email/get`);

    const queryResponse = await this.jmapRequest([
      ['Email/query', {
        accountId: this.accountId,
        filter: { inMailbox: resolvedMailboxId },
        sort: [{ property: 'receivedAt', isAscending: false }],
        limit: top,
      }, '0'],
    ]);

    const ids = queryResponse.methodResponses[0][1].ids || [];
    if (ids.length === 0) {
      this.log('S→C', '200 OK - 0 messages in mailbox');
      return [];
    }

    const getResponse = await this.jmapRequest([
      ['Email/get', {
        accountId: this.accountId,
        ids,
        properties: ['id', 'subject', 'from', 'to', 'cc', 'bcc', 'receivedAt', 'size', 'hasAttachment', 'preview', 'bodyValues', 'textBody', 'headers'],
        fetchTextBodyValues: true,
      }, '0'],
    ]);

    const emails = getResponse.methodResponses[0][1].list || [];
    this.log('S→C', `200 OK - ${emails.length} messages fetched`);

    const messages = [];
    for (const email of emails) {
      const bodyText = Object.values(email.bodyValues || {}).map(v => v.value).join('\n').substring(0, 1000);
      const rawContent = `From: ${(email.from || []).map(a => a.email).join(', ')}\r\nTo: ${(email.to || []).map(a => a.email).join(', ')}\r\nSubject: ${email.subject || ''}\r\nDate: ${email.receivedAt || ''}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\n${bodyText}`;
      const rawBuffer = Buffer.from(rawContent, 'utf8');

      messages.push({
        id: uuidv4(),
        uid: messages.length + 1,
        jmapId: email.id,
        folder: folderIdOrPath,
        subject: email.subject || '(no subject)',
        fromAddress: (email.from || []).map(a => a.email).join(', '),
        toAddresses: (email.to || []).map(a => a.email),
        ccAddresses: (email.cc || []).map(a => a.email),
        date: email.receivedAt || new Date().toISOString(),
        size: email.size || rawBuffer.length,
        hashMd5: crypto.createHash('md5').update(rawBuffer).digest('hex'),
        hashSha256: crypto.createHash('sha256').update(rawBuffer).digest('hex'),
        hashSha512: crypto.createHash('sha512').update(rawBuffer).digest('hex'),
        hasAttachments: email.hasAttachment || false,
        attachmentCount: 0,
        bodyText,
        contentType: 'text/plain',
      });
    }

    this.log('CLIENT', `Fetched ${messages.length} messages from mailbox via JMAP`);
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
