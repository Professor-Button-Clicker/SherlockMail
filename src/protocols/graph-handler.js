import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { getAccessToken, refreshAccessToken, getAuthStatus } from '../services/microsoft-oauth.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const TOKEN_REUSE_MS = 30000;
const REQUEST_TIMEOUT_MS = 120000;
const WELL_KNOWN_FOLDERS = {
  inbox: 'inbox', 'sent items': 'sentitems', sent: 'sentitems', drafts: 'drafts',
  'deleted items': 'deleteditems', trash: 'deleteditems', 'junk email': 'junkemail', junk: 'junkemail',
  archive: 'archive', outbox: 'outbox',
};

export class GraphHandler {
  constructor(config) {
    this.config = config;
    this.protocolLog = [];
    this.accessToken = null;
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

  // Single-flight token access: concurrent workers share one in-flight read/refresh.
  getToken() {
    if (!this.tokenPromise || Date.now() - this.tokenFetchedAt > TOKEN_REUSE_MS) {
      this.tokenFetchedAt = Date.now();
      this.tokenPromise = getAccessToken().catch(err => { this.tokenPromise = null; throw err; });
    }
    return this.tokenPromise;
  }

  forceTokenRefresh() {
    this.tokenFetchedAt = Date.now();
    this.tokenPromise = refreshAccessToken().then(t => t.access_token).catch(err => { this.tokenPromise = null; throw err; });
    return this.tokenPromise;
  }

  async graphRequest(pathOrUrl, { raw = false, retriedAuth = false } = {}) {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${GRAPH_BASE}${pathOrUrl}`;
    const token = await this.getToken();
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

    if (res.status === 401 && !retriedAuth) {
      await this.forceTokenRefresh();
      return this.graphRequest(pathOrUrl, { raw, retriedAuth: true });
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = new Error(body.error?.message || `Graph API error (${res.status})`);
      err.status = res.status;
      if (res.status === 429 || res.status === 503 || res.status === 504) {
        const ra = parseFloat(res.headers.get('retry-after'));
        if (!isNaN(ra)) err.retryAfterMs = ra * 1000;
      } else if (res.status === 400 || res.status === 403 || res.status === 404) {
        err.permanent = true;
      }
      throw err;
    }
    return raw ? Buffer.from(await res.arrayBuffer()) : res.json();
  }

  async graphFetch(path) {
    return this.graphRequest(path);
  }

  async listAllPages(firstUrl) {
    const rows = [];
    for (let url = firstUrl; url; ) {
      const data = await this.graphRequest(url);
      rows.push(...(data.value || []));
      url = data['@odata.nextLink'] || null;
    }
    return rows;
  }

  async resolveFolderId(folder) {
    if (!this.folderIds) {
      const all = await this.listFolders();
      this.folderIds = new Map(all.map(f => [f.path, f.graphFolderId]));
    }
    if (this.folderIds.has(folder)) return this.folderIds.get(folder);
    const wellKnown = WELL_KNOWN_FOLDERS[String(folder).toLowerCase()];
    if (wellKnown) return wellKnown;
    if (/^[A-Za-z0-9_=-]{40,}$/.test(folder)) return folder;
    const err = new Error(`Folder "${folder}" not found`);
    err.permanent = true;
    throw err;
  }

  async enumerate(folder, { limit, searchCriteria } = {}) {
    const folderId = await this.resolveFolderId(folder);
    const filter = searchCriteria?.filter ? `&$filter=${encodeURIComponent(searchCriteria.filter)}` : '';
    const base = `/me/mailFolders/${folderId}/messages?$select=id,receivedDateTime&$top=1000${filter}`;
    // PR_MESSAGE_SIZE (0x0E08) gives each message's size so the ETA can be byte-based.
    const withSize = `${base}&$expand=${encodeURIComponent("singleValueExtendedProperties($filter=id eq 'Long 0x0E08')")}`;
    const list = async (firstUrl) => {
      const rows = [];
      for (let url = firstUrl; url && !(limit > 0 && rows.length >= limit); ) {
        const data = await this.graphRequest(url);
        for (const m of data.value || []) {
          rows.push({ id: m.id, receivedDateTime: m.receivedDateTime || null, size: parseInt(m.singleValueExtendedProperties?.[0]?.value || '0', 10) });
        }
        url = data['@odata.nextLink'] || null;
      }
      return rows;
    };
    let rows;
    try {
      rows = await list(withSize);
    } catch (err) {
      if (err.status !== 400) throw err;
      rows = await list(base);
    }
    const selected = limit > 0 ? rows.slice(0, limit) : rows;
    this.log('CLIENT', `Enumerated ${selected.length} messages in ${folder}${filter ? ` (filter: ${searchCriteria.filter})` : ''}`);
    return { key: folderId, refs: selected.map((r, i) => ({ key: r.id, uid: i + 1, serviceId: r.id, size: r.size, receivedDateTime: r.receivedDateTime })) };
  }

  async fetchBatch(_folderId, refs, deliver) {
    const out = [];
    const emit = deliver || (item => out.push(item));
    for (const ref of refs) {
      const raw = await this.graphRequest(`/me/messages/${ref.key}/$value`, { raw: true });
      emit({ ref, raw, meta: { flags: [], internalDate: ref.receivedDateTime || null } });
    }
    return out;
  }

  async connect() {
    const status = getAuthStatus();
    if (!status.authorized) {
      throw new Error('Microsoft account not authorized. Click "Authorize with Microsoft" first.');
    }

    this.accessToken = await this.getToken();

    this.log('CLIENT', 'Connecting to Microsoft Graph API via OAuth2');
    this.log('C→S', `GET ${GRAPH_BASE}/me`);

    const profile = await this.graphFetch('/me');
    this.userEmail = profile.mail || profile.userPrincipalName;

    this.log('S→C', `200 OK - displayName: "${profile.displayName}", mail: "${this.userEmail}"`);

    this.log('C→S', `GET ${GRAPH_BASE}/me/mailFolders?$top=1`);
    await this.graphFetch('/me/mailFolders?$top=1&$select=id');
    this.log('S→C', `200 OK - mail folders accessible`);

    return {
      success: true,
      email: this.userEmail,
      displayName: profile.displayName,
      graphVersion: 'v1.0',
      capabilities: this.constructor.getCapabilities(),
    };
  }

  async listFolders() {
    this.log('C→S', `GET ${GRAPH_BASE}/me/mailFolders (recursive)`);

    const select = '$select=id,displayName,totalItemCount,unreadItemCount,childFolderCount&$top=250';
    const folders = [];
    const walk = async (rows, parentPath) => {
      for (const f of rows) {
        const folderPath = parentPath ? `${parentPath}/${f.displayName}` : f.displayName;
        folders.push({
          id: uuidv4(),
          path: folderPath,
          name: f.displayName,
          graphFolderId: f.id,
          totalMessages: f.totalItemCount || 0,
          unseenMessages: f.unreadItemCount || 0,
          parentPath: parentPath || undefined,
        });
        if (f.childFolderCount > 0) {
          await walk(await this.listAllPages(`/me/mailFolders/${f.id}/childFolders?${select}`), folderPath);
        }
      }
    };
    await walk(await this.listAllPages(`/me/mailFolders?${select}`), null);

    this.log('S→C', `200 OK - ${folders.length} mail folders returned`);
    return folders;
  }

  async searchMessages(criteria) {
    const searchParams = [];
    const filterParams = [];

    if (criteria.keyword) searchParams.push(`"${criteria.keyword}"`);
    if (criteria.from) filterParams.push(`from/emailAddress/address eq '${criteria.from}'`);
    if (criteria.subject) searchParams.push(`subject:${criteria.subject}`);
    if (criteria.hasAttachment) filterParams.push('hasAttachments eq true');
    if (criteria.since) filterParams.push(`receivedDateTime ge ${criteria.since}`);
    if (criteria.before) filterParams.push(`receivedDateTime le ${criteria.before}`);

    const queryParts = [];
    if (searchParams.length) queryParts.push(`$search="${searchParams.join(' AND ')}"`);
    if (filterParams.length) queryParts.push(`$filter=${filterParams.join(' and ')}`);
    queryParts.push('$top=50', '$select=id,subject,from,toRecipients,receivedDateTime,hasAttachments,bodyPreview');

    const url = `/me/messages?${queryParts.join('&')}`;
    this.log('C→S', `GET ${GRAPH_BASE}${url}`);

    const data = await this.graphFetch(url);
    const results = data.value || [];

    this.log('S→C', `200 OK - ${results.length} messages matched`);

    return {
      query: queryParts.join('&'),
      resultCount: results.length,
      searchId: uuidv4(),
    };
  }

  async fetchMessages(folderIdOrPath, { limit, searchCriteria } = {}) {
    const folderId = typeof folderIdOrPath === 'string'
      ? folderIdOrPath
      : folderIdOrPath.graphFolderId || folderIdOrPath.path || folderIdOrPath;

    const pageSize = Math.min(limit || 50, 50);
    const maxMessages = limit || Infinity;

    let resolvedFolderId;
    if (folderId.match(/^[A-Za-z0-9_=-]+$/)) {
      resolvedFolderId = folderId;
    } else {
      const foldersData = await this.graphFetch('/me/mailFolders?$top=100');
      const match = (foldersData.value || []).find(f => f.displayName === folderId);
      if (!match) throw new Error(`Folder "${folderId}" not found`);
      resolvedFolderId = match.id;
    }

    const messages = [];
    let nextLink = null;
    let pageNum = 0;

    const firstUrl = `/me/mailFolders/${resolvedFolderId}/messages?$top=${pageSize}&$select=id,subject,from,toRecipients,ccRecipients,bccRecipients,receivedDateTime,hasAttachments,internetMessageHeaders`;

    do {
      const listUrl = nextLink || firstUrl;
      this.log('C→S', `GET ${nextLink ? '(nextLink page ' + (pageNum + 1) + ')' : GRAPH_BASE + listUrl}`);

      const listData = await this.graphFetch(listUrl);
      const msgStubs = listData.value || [];
      nextLink = listData['@odata.nextLink'] || null;
      pageNum++;

      this.log('S→C', `200 OK - ${msgStubs.length} messages (page ${pageNum})${nextLink ? ', more available' : ''}`);

      for (const stub of msgStubs) {
        if (messages.length >= maxMessages) break;

        this.log('C→S', `GET ${GRAPH_BASE}/me/messages/${stub.id}/$value`);

        const mimeRes = await fetch(`${GRAPH_BASE}/me/messages/${stub.id}/$value`, {
          headers: { Authorization: `Bearer ${this.accessToken}` },
        });

        if (!mimeRes.ok) {
          this.log('S→C', `${mimeRes.status} - Failed to fetch MIME for ${stub.id}`);
          continue;
        }

        const rawBuffer = Buffer.from(await mimeRes.arrayBuffer());
        this.log('S→C', `200 OK - MIME content (${rawBuffer.length} bytes)`);

        const headers = this.parseHeaders(rawBuffer.toString('utf8', 0, Math.min(rawBuffer.length, 8192)));

        const internetHeaders = stub.internetMessageHeaders || [];
        const messageIdHeader = internetHeaders.find(h => h.name.toLowerCase() === 'message-id');
        const attachmentCount = stub.hasAttachments
          ? (headers['content-type']?.match(/boundary=/i) ? this.countAttachmentBoundaries(rawBuffer.toString('utf8')) : 1)
          : 0;

        messages.push({
          id: uuidv4(),
          uid: messages.length + 1,
          serviceId: stub.id,
          graphMessageId: stub.id,
          folder: folderIdOrPath,
          subject: stub.subject || headers.subject || '(no subject)',
          fromAddress: stub.from?.emailAddress?.address || headers.from || '',
          toAddresses: (stub.toRecipients || []).map(r => r.emailAddress?.address),
          ccAddresses: (stub.ccRecipients || []).map(r => r.emailAddress?.address),
          bccAddresses: (stub.bccRecipients || []).map(r => r.emailAddress?.address),
          date: stub.receivedDateTime || (headers.date ? new Date(headers.date).toISOString() : new Date().toISOString()),
          messageId: messageIdHeader?.value || headers['message-id'] || null,
          inReplyTo: headers['in-reply-to'] || null,
          size: rawBuffer.length,
          hashMd5: crypto.createHash('md5').update(rawBuffer).digest('hex'),
          hashSha256: crypto.createHash('sha256').update(rawBuffer).digest('hex'),
          hashSha512: crypto.createHash('sha512').update(rawBuffer).digest('hex'),
          hasAttachments: stub.hasAttachments || false,
          attachmentCount,
          bodyText: this.extractBody(rawBuffer.toString('utf8')),
          contentType: headers['content-type'] || 'text/plain',
          rawMime: rawBuffer,
        });
      }
    } while (nextLink && messages.length < maxMessages);

    this.log('CLIENT', `Fetched ${messages.length} messages from ${folderIdOrPath} via Graph API (${pageNum} pages)`);
    return messages;
  }

  countAttachmentBoundaries(raw) {
    const ct = raw.match(/Content-Type:\s*([^\r\n]+)/i);
    if (!ct) return 0;
    const boundaryMatch = ct[1].match(/boundary="?([^";\r\n]+)"?/i);
    if (!boundaryMatch) return 0;
    const boundary = boundaryMatch[1];
    const parts = raw.split('--' + boundary).length - 2;
    return Math.max(parts - 1, 0);
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
    this.accessToken = null;
    this.log('CLIENT', 'Graph API session ended');
  }

  getProtocolLog() {
    return this.protocolLog;
  }

  static getCapabilities() {
    return {
      protocols: ['Microsoft Graph REST API v1.0'],
      authentication: ['Delegated (OAuth2 Authorization Code)', 'App-Only (Client Credentials)', 'App-Only (Certificate)'],
      features: [
        'Mail folder enumeration',
        'Server-side $search (KQL)',
        'Server-side $filter (OData)',
        'MIME content download ($value)',
        'Modern attachments (OneDrive/SharePoint links)',
        'Batch requests (up to 20 per batch)',
        'Delta queries (incremental sync)',
        'Change notifications (webhooks)',
        'Pagination via @odata.nextLink',
      ],
      searchOperators: [
        'from:', 'to:', 'cc:', 'bcc:', 'subject:', 'body:',
        'hasAttachments eq true/false',
        'receivedDateTime ge/le',
        'importance eq high/normal/low',
        'AND', 'OR', 'NOT',
      ],
      scopes: {
        delegated: ['Mail.Read', 'Mail.ReadBasic'],
        appOnly: ['Mail.Read', 'Mail.ReadBasic.All'],
      },
    };
  }
}
