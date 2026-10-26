import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { getAccessToken, getAuthStatus, getApiBase, loadCredentials } from '../services/zoho-oauth.js';

export class ZohoHandler {
  constructor(config) {
    this.config = config;
    this.protocolLog = [];
    this.accessToken = null;
    this.apiBase = null;
    this.accountId = null;
  }

  log(direction, message) {
    this.protocolLog.push({
      timestamp: new Date().toISOString(),
      direction,
      message
    });
  }

  async zohoFetch(path, options = {}) {
    const url = `${this.apiBase}/api${path}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Zoho-oauthtoken ${this.accessToken}`,
        Accept: 'application/json',
        ...options.headers,
      },
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.data?.errorCode || err.message || `Zoho API error (${res.status})`);
    }

    return res.json();
  }

  async connect() {
    const status = getAuthStatus();
    if (!status.authorized) {
      throw new Error('Zoho account not authorized. Click "Authorize with Zoho" first.');
    }

    const creds = loadCredentials();
    this.apiBase = getApiBase(creds?.region || 'us');
    this.accessToken = await getAccessToken();

    this.log('CLIENT', 'Connecting to Zoho Mail API via OAuth2');
    this.log('C→S', `GET ${this.apiBase}/api/accounts`);

    const accountData = await this.zohoFetch('/accounts');
    const accounts = accountData.data || [];

    if (accounts.length === 0) throw new Error('No Zoho Mail accounts found');

    const account = accounts[0];
    this.accountId = account.accountId;

    this.log('S→C', `200 OK - accountId: "${this.accountId}", email: "${account.primaryEmailAddress}"`);

    return {
      success: true,
      email: account.primaryEmailAddress,
      accountId: this.accountId,
      displayName: account.displayName,
      capabilities: this.constructor.getCapabilities(),
    };
  }

  async listFolders() {
    this.log('C→S', `GET ${this.apiBase}/api/accounts/${this.accountId}/folders`);

    const data = await this.zohoFetch(`/accounts/${this.accountId}/folders`);
    const mailFolders = data.data || [];

    const folders = mailFolders.map(f => ({
      id: uuidv4(),
      path: f.folderName,
      name: f.folderName,
      zohoFolderId: f.folderId,
      totalMessages: f.messageCount || 0,
      unseenMessages: f.unreadMessageCount || 0,
    }));

    this.log('S→C', `200 OK - ${folders.length} folders returned`);
    return folders;
  }

  async searchMessages(criteria) {
    const searchParams = new URLSearchParams();
    if (criteria.keyword) searchParams.set('searchKey', criteria.keyword);
    if (criteria.from) searchParams.set('sender', criteria.from);
    if (criteria.subject) searchParams.set('subject', criteria.subject);
    searchParams.set('limit', '50');

    const url = `/accounts/${this.accountId}/messages/search?${searchParams.toString()}`;
    this.log('C→S', `GET ${this.apiBase}/api${url}`);

    const data = await this.zohoFetch(url);
    const results = data.data || [];

    this.log('S→C', `200 OK - ${results.length} messages matched`);

    return {
      query: searchParams.toString(),
      resultCount: results.length,
      searchId: uuidv4(),
    };
  }

  async fetchMessages(folderIdOrPath, { limit } = {}) {
    const folderId = typeof folderIdOrPath === 'string'
      ? folderIdOrPath
      : folderIdOrPath.zohoFolderId || folderIdOrPath.path || folderIdOrPath;

    const top = limit || 25;

    let resolvedFolderId = folderId;
    if (!/^\d+$/.test(folderId)) {
      const foldersData = await this.zohoFetch(`/accounts/${this.accountId}/folders`);
      const match = (foldersData.data || []).find(f => f.folderName === folderId);
      if (!match) throw new Error(`Folder "${folderId}" not found`);
      resolvedFolderId = match.folderId;
    }

    const listUrl = `/accounts/${this.accountId}/folders/${resolvedFolderId}/messages?limit=${top}`;
    this.log('C→S', `GET ${this.apiBase}/api${listUrl}`);

    const listData = await this.zohoFetch(listUrl);
    const msgStubs = listData.data || [];

    this.log('S→C', `200 OK - ${msgStubs.length} messages listed`);

    const messages = [];
    for (const stub of msgStubs) {
      this.log('C→S', `GET ${this.apiBase}/api/accounts/${this.accountId}/folders/${resolvedFolderId}/messages/${stub.messageId}`);

      const msgData = await this.zohoFetch(`/accounts/${this.accountId}/folders/${resolvedFolderId}/messages/${stub.messageId}`);
      const msg = msgData.data || {};

      const rawContent = `From: ${msg.sender || stub.fromAddress || ''}\r\nTo: ${msg.toAddress || ''}\r\nSubject: ${msg.subject || stub.subject || ''}\r\nDate: ${msg.receivedTime || stub.receivedTime || ''}\r\nMIME-Version: 1.0\r\nContent-Type: ${msg.contentType || 'text/plain'}\r\n\r\n${msg.content || ''}`;
      const rawBuffer = Buffer.from(rawContent, 'utf8');

      this.log('S→C', `200 OK - message content (${rawBuffer.length} bytes)`);

      messages.push({
        id: uuidv4(),
        uid: messages.length + 1,
        zohoMessageId: stub.messageId,
        folder: folderIdOrPath,
        subject: msg.subject || stub.subject || '(no subject)',
        fromAddress: msg.sender || stub.fromAddress || '',
        toAddresses: (msg.toAddress || stub.toAddress || '').split(',').map(s => s.trim()).filter(Boolean),
        ccAddresses: (msg.ccAddress || '').split(',').map(s => s.trim()).filter(Boolean),
        date: msg.receivedTime || stub.receivedTime || new Date().toISOString(),
        size: rawBuffer.length,
        hashMd5: crypto.createHash('md5').update(rawBuffer).digest('hex'),
        hashSha256: crypto.createHash('sha256').update(rawBuffer).digest('hex'),
        hashSha512: crypto.createHash('sha512').update(rawBuffer).digest('hex'),
        hasAttachments: (msg.hasAttachment === 'true' || stub.hasAttachment === 'true'),
        attachmentCount: parseInt(msg.attachmentCount || '0'),
        bodyText: (msg.content || '').substring(0, 1000),
        contentType: msg.contentType || 'text/plain',
      });
    }

    this.log('CLIENT', `Fetched ${messages.length} messages from folder ${folderIdOrPath} via Zoho API`);
    return messages;
  }

  async disconnect() {
    this.accessToken = null;
    this.accountId = null;
    this.log('CLIENT', 'Zoho Mail API session ended');
  }

  getProtocolLog() {
    return this.protocolLog;
  }

  static getCapabilities() {
    return {
      protocols: ['Zoho Mail REST API'],
      authentication: ['OAuth 2.0 (Authorization Code)'],
      features: [
        'Folder enumeration',
        'Message listing and reading',
        'Server-side search',
        'Attachment download',
        'Label and tag support',
        'Regional endpoints (US/EU/IN/AU/JP)',
        'Pagination support',
      ],
      searchOperators: [
        'searchKey (keyword)',
        'sender', 'subject',
        'receivedTime range',
        'hasAttachment',
        'flagid', 'status',
      ],
      scopes: [
        'ZohoMail.messages.READ',
        'ZohoMail.folders.READ',
        'ZohoMail.accounts.READ',
        'ZohoMail.attachments.READ',
      ],
    };
  }
}
