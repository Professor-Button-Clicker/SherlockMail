import { v4 as uuidv4 } from 'uuid';
import { getAccessToken, getAuthStatus, getApiBase, loadCredentials } from '../services/zoho-oauth.js';
import { buildMessageRecord, withRetry } from '../services/collection-engine.js';

const LIST_PAGE = 200; // the most Zoho's messages/view returns per request

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

  // The original message (MIME) as Zoho stores it. Zoho may answer with the message itself or with JSON
  // whose data.content holds it as text.
  async originalMessage(messageId) {
    const url = `${this.apiBase}/api/accounts/${this.accountId}/messages/${messageId}/originalmessage`;
    const res = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${this.accessToken}`, Accept: '*/*' }, signal: AbortSignal.timeout(120000) });
    if (!res.ok) {
      const err = new Error(`Original message download failed (HTTP ${res.status})`);
      if (res.status === 404) err.permanent = true;
      throw err;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (/json/i.test(res.headers.get('content-type') || '')) {
      const content = JSON.parse(buf.toString('utf8'))?.data?.content;
      if (typeof content !== 'string' || !content) throw new Error('Zoho returned no original message content');
      return { raw: Buffer.from(content, 'utf8'), fromJson: true };
    }
    return { raw: buf, fromJson: false };
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

  // Every message in the folder (or the first `limit`), each built from its original message. A message
  // whose original cannot be downloaded is returned with fetchError and no content; nothing is made up.
  async fetchMessages(folderIdOrPath, { limit } = {}) {
    const folderId = typeof folderIdOrPath === 'string'
      ? folderIdOrPath
      : folderIdOrPath.zohoFolderId || folderIdOrPath.path || folderIdOrPath;

    let resolvedFolderId = folderId;
    if (!/^\d+$/.test(folderId)) {
      const foldersData = await this.zohoFetch(`/accounts/${this.accountId}/folders`);
      const match = (foldersData.data || []).find(f => f.folderName === folderId);
      if (!match) throw new Error(`Folder "${folderId}" not found`);
      resolvedFolderId = match.folderId;
    }

    const stubs = [];
    for (let start = 1; ;) {
      const listUrl = `/accounts/${this.accountId}/messages/view?folderId=${encodeURIComponent(resolvedFolderId)}&start=${start}&limit=${LIST_PAGE}`;
      this.log('C→S', `GET ${this.apiBase}/api${listUrl}`);
      const page = (await this.zohoFetch(listUrl)).data || [];
      stubs.push(...page);
      start += page.length;
      if (page.length < LIST_PAGE || (limit > 0 && stubs.length >= limit)) break;
    }
    const selected = limit > 0 ? stubs.slice(0, limit) : stubs;
    this.log('S→C', `200 OK - ${selected.length} message(s) listed`);

    const messages = [];
    let fromJson = 0;
    for (const stub of selected) {
      const uid = messages.length + 1;
      const received = Number(stub.receivedTime);
      try {
        const original = await withRetry(() => this.originalMessage(stub.messageId), { attempts: 3 });
        if (original.fromJson) fromJson++;
        const record = await buildMessageRecord(original.raw, {
          uid, serviceId: String(stub.messageId), folder: folderIdOrPath,
          internalDate: Number.isFinite(received) && received > 0 ? new Date(received).toISOString() : null,
        });
        messages.push({ ...record, zohoMessageId: stub.messageId, rawFromJson: original.fromJson });
      } catch (err) {
        messages.push({ id: uuidv4(), uid, zohoMessageId: stub.messageId, serviceId: String(stub.messageId), folder: folderIdOrPath, subject: stub.subject, fetchError: err.message });
      }
    }

    // Text inside JSON cannot carry bytes that are not valid UTF-8, so such a message may differ from
    // the stored copy; say so rather than imply byte-exactness.
    if (fromJson) this.log('CLIENT', `Note: Zoho returned ${fromJson} original message(s) as JSON text; any 8-bit content that was not UTF-8 cannot be byte-identical to the server's copy`);
    this.log('CLIENT', `Fetched ${messages.filter(m => !m.fetchError).length} original message(s) from folder ${folderIdOrPath} via Zoho API${messages.some(m => m.fetchError) ? `; ${messages.filter(m => m.fetchError).length} could not be downloaded` : ''}`);
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
