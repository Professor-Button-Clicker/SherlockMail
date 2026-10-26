import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

const DEFAULT_EWS_URL = 'https://outlook.office365.com/EWS/Exchange.asmx';
const REQUEST_TIMEOUT_MS = 120000;
const AUTODISCOVER_TIMEOUT_MS = 30000;

export class EwsHandler {
  constructor(config) {
    this.config = config;
    this.protocolLog = [];
    this.authenticated = false;
    this.ewsUrl = null;
    this.authHeaders = {};
  }

  log(direction, message) {
    if (this.protocolLog.length >= 5000) this.protocolLog.shift();
    this.protocolLog.push({
      timestamp: new Date().toISOString(),
      direction,
      message
    });
  }

  async autodiscover(email) {
    const domain = email.split('@')[1];
    const autodiscoverUrls = [
      `https://autodiscover.${domain}/autodiscover/autodiscover.svc`,
      `https://${domain}/autodiscover/autodiscover.svc`,
    ];

    this.log('CLIENT', `Running Autodiscover for ${email}`);

    const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/requestschema/2006">
  <Request>
    <EMailAddress>${email}</EMailAddress>
    <AcceptableResponseSchema>http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a</AcceptableResponseSchema>
  </Request>
</Autodiscover>`;

    for (const url of autodiscoverUrls) {
      try {
        this.log('C→S', `POST ${url}`);
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'text/xml; charset=utf-8',
            ...this.authHeaders,
          },
          body: soapBody,
          signal: AbortSignal.timeout(AUTODISCOVER_TIMEOUT_MS),
        });

        if (res.ok) {
          const text = await res.text();
          const ewsMatch = text.match(/<EwsUrl>(.*?)<\/EwsUrl>/);
          if (ewsMatch) {
            this.log('S→C', `Autodiscover resolved: ${ewsMatch[1]}`);
            return { ewsUrl: ewsMatch[1], autodiscoverUrls, protocol: 'EWS' };
          }
        }
      } catch (err) {
        this.log('CLIENT', `Autodiscover failed at ${url}: ${err.message}`);
      }
    }

    this.log('CLIENT', `Autodiscover failed, using default: ${DEFAULT_EWS_URL}`);
    return { ewsUrl: DEFAULT_EWS_URL, autodiscoverUrls, protocol: 'EWS' };
  }

  buildAuthHeaders() {
    const { email, password, authType, accessToken } = this.config;

    if (authType === 'oauth2' && accessToken) {
      return { Authorization: `Bearer ${accessToken}` };
    }

    if (password) {
      const encoded = Buffer.from(`${email}:${password}`).toString('base64');
      return { Authorization: `Basic ${encoded}` };
    }

    return {};
  }

  buildSoapEnvelope(operation, body, impersonation) {
    const impersonateHeader = impersonation
      ? `<t:ExchangeImpersonation><t:ConnectingSID><t:SmtpAddress>${impersonation}</t:SmtpAddress></t:ConnectingSID></t:ExchangeImpersonation>`
      : '';

    return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2016"/>
    ${impersonateHeader}
  </soap:Header>
  <soap:Body>
    ${body}
  </soap:Body>
</soap:Envelope>`;
  }

  async soapRequest(operation, body) {
    const envelope = this.buildSoapEnvelope(operation, body, this.config.impersonate);

    if (this.config.tokenProvider) {
      this.authHeaders = { Authorization: `Bearer ${await this.config.tokenProvider()}` };
    }

    this.log('C→S', `SOAP ${operation} → ${this.ewsUrl}`);

    const res = await fetch(this.ewsUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        ...this.authHeaders,
      },
      body: envelope,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const text = await res.text();

    if (!res.ok || /ResponseCode>ErrorServerBusy</.test(text)) {
      const faultMatch = text.match(/<faultstring>(.*?)<\/faultstring>/s);
      const err = new Error(faultMatch ? faultMatch[1] : `EWS request failed (${res.status})`);
      const backoff = text.match(/Name="BackOffMilliseconds">(\d+)</);
      if (backoff) err.retryAfterMs = parseInt(backoff[1], 10);
      else if (res.status === 400 || res.status === 403) err.permanent = true;
      throw err;
    }

    this.log('S→C', `HTTP ${res.status} - ${operation} response received`);
    return text;
  }

  async resolveFolderRef(folder) {
    if (!this.folderIds) {
      this.folderIds = new Map();
      for (const f of await this.listFolders()) {
        if (!this.folderIds.has(f.path)) this.folderIds.set(f.path, f.ewsFolderId);
      }
    }
    const id = this.folderIds.get(folder);
    if (id) return `<t:FolderId Id="${this.escapeXml(id)}"/>`;
    const wellKnown = this.mapWellKnownFolder(folder, null);
    if (wellKnown) return `<t:DistinguishedFolderId Id="${wellKnown}"/>`;
    if (/^[A-Za-z0-9+/=_-]{40,}$/.test(folder)) return `<t:FolderId Id="${this.escapeXml(folder)}"/>`;
    const err = new Error(`EWS folder "${folder}" not found`);
    err.permanent = true;
    throw err;
  }

  async enumerate(folder, { limit, searchCriteria } = {}) {
    const folderRef = await this.resolveFolderRef(folder);
    const pageSize = 1000;
    const restriction = searchCriteria?.restriction || '';
    const refs = [];
    for (let offset = 0; ; ) {
      const xml = await this.soapRequest('FindItem', `<m:FindItem Traversal="Shallow">
        <m:ItemShape>
          <t:BaseShape>IdOnly</t:BaseShape>
          <t:AdditionalProperties><t:FieldURI FieldURI="item:Size"/><t:FieldURI FieldURI="item:DateTimeReceived"/></t:AdditionalProperties>
        </m:ItemShape>
        <m:IndexedPageItemView MaxEntriesReturned="${pageSize}" Offset="${offset}" BasePoint="Beginning"/>
        ${restriction}
        <m:ParentFolderIds>${folderRef}</m:ParentFolderIds>
      </m:FindItem>`);
      let count = 0;
      for (const m of xml.matchAll(/<t:ItemId\b([^>]*)\/>([\s\S]*?)(?=<t:ItemId\b|<\/t:Items>)/g)) {
        const id = m[1].match(/\bId="([^"]+)"/)?.[1];
        if (!id) continue;
        refs.push({
          key: id, uid: refs.length + 1, serviceId: id,
          changeKey: m[1].match(/\bChangeKey="([^"]+)"/)?.[1] || '',
          size: parseInt(m[2].match(/<t:Size>(\d+)<\/t:Size>/)?.[1] || '0', 10),
          received: m[2].match(/<t:DateTimeReceived>([^<]+)<\/t:DateTimeReceived>/)?.[1] || null,
        });
        count++;
      }
      offset += count;
      if (count === 0 || xml.includes('IncludesLastItemInRange="true"') || (limit > 0 && refs.length >= limit)) break;
    }
    const selected = limit > 0 ? refs.slice(0, limit) : refs;
    this.log('CLIENT', `Enumerated ${selected.length} items in ${folder}${restriction ? ' (with restriction)' : ''}`);
    return { key: folder, refs: selected };
  }

  async fetchBatch(_folder, refs, deliver) {
    const ids = refs.map(r => `<t:ItemId Id="${this.escapeXml(r.key)}"/>`).join('');
    const xml = await this.soapRequest('GetItem', `<m:GetItem>
      <m:ItemShape><t:BaseShape>IdOnly</t:BaseShape><t:IncludeMimeContent>true</t:IncludeMimeContent></m:ItemShape>
      <m:ItemIds>${ids}</m:ItemIds>
    </m:GetItem>`);

    const responses = xml.split('<m:GetItemResponseMessage').slice(1);
    const out = [];
    let firstError = null;
    responses.forEach((block, i) => {
      const ref = refs[i];
      if (!ref) return;
      if (!/^\s*ResponseClass="Success"/.test(block)) {
        firstError = firstError || block.match(/<m:ResponseCode>([^<]+)</)?.[1] || 'EWS item error';
        return;
      }
      const open = block.indexOf('<t:MimeContent');
      if (open < 0) return;
      const start = block.indexOf('>', open) + 1;
      const end = block.indexOf('</t:MimeContent>', start);
      out.push({ ref, raw: Buffer.from(block.slice(start, end), 'base64'), meta: { flags: [], internalDate: ref.received || null } });
    });
    if (out.length === 0 && refs.length === 1 && firstError) {
      const err = new Error(firstError);
      if (firstError === 'ErrorItemNotFound') err.permanent = true;
      throw err;
    }
    if (deliver) for (const item of out) deliver(item);
    return out;
  }

  async connect() {
    const { email, ewsUrl } = this.config;
    this.authHeaders = this.buildAuthHeaders();

    this.log('CLIENT', `Connecting via EWS - Auth: ${this.config.authType || 'basic'}`);

    if (ewsUrl) {
      this.ewsUrl = ewsUrl;
    } else {
      const discovered = await this.autodiscover(email);
      this.ewsUrl = discovered.ewsUrl;
    }

    const body = `<m:GetFolder>
      <m:FolderShape><t:BaseShape>Default</t:BaseShape></m:FolderShape>
      <m:FolderIds><t:DistinguishedFolderId Id="inbox"/></m:FolderIds>
    </m:GetFolder>`;

    await this.soapRequest('GetFolder', body);
    this.authenticated = true;
    this.log('CLIENT', `Authenticated to EWS as ${email}`);

    return {
      success: true,
      ewsUrl: this.ewsUrl,
      capabilities: this.constructor.getCapabilities(),
    };
  }

  async listFolders() {
    this.log('C→S', 'SOAP FindFolder - Traversal: Deep');

    const folders = [];
    for (let offset = 0; ; ) {
      const body = `<m:FindFolder Traversal="Deep">
        <m:FolderShape>
          <t:BaseShape>Default</t:BaseShape>
          <t:AdditionalProperties>
            <t:FieldURI FieldURI="folder:FolderClass"/>
            <t:FieldURI FieldURI="folder:TotalCount"/>
            <t:FieldURI FieldURI="folder:UnreadCount"/>
            <t:FieldURI FieldURI="folder:DisplayName"/>
            <t:FieldURI FieldURI="folder:ParentFolderId"/>
          </t:AdditionalProperties>
        </m:FolderShape>
        <m:IndexedPageFolderView MaxEntriesReturned="500" Offset="${offset}" BasePoint="Beginning"/>
        <m:ParentFolderIds>
          <t:DistinguishedFolderId Id="msgfolderroot"/>
        </m:ParentFolderIds>
      </m:FindFolder>`;

      const xml = await this.soapRequest('FindFolder', body);
      const page = this.parseFolders(xml);
      folders.push(...page);
      const returned = (xml.match(/<t:FolderId\b/g) || []).length;
      offset += returned;
      if (returned === 0 || xml.includes('IncludesLastItemInRange="true"')) break;
    }

    // Display names repeat across the tree (two "Archive" folders are common); the full path keeps
    // each folder distinct so selecting one never collects the other.
    const byId = new Map(folders.map(f => [f.ewsFolderId, f]));
    const pathOf = (f, depth = 0) => {
      const parent = f.ewsParentFolderId && byId.get(f.ewsParentFolderId);
      return parent && depth < 64 ? `${pathOf(parent, depth + 1)}/${f.name}` : f.name;
    };
    for (const f of folders) {
      f.path = pathOf(f);
      const parent = f.ewsParentFolderId && byId.get(f.ewsParentFolderId);
      f.parentPath = parent ? pathOf(parent) : null;
    }

    this.log('S→C', `FindFolder returned ${folders.length} folders`);
    return folders;
  }

  parseFolders(xml) {
    const folders = [];
    const folderRegex = /<t:Folder>([\s\S]*?)<\/t:Folder>/g;
    let match;

    while ((match = folderRegex.exec(xml)) !== null) {
      const block = match[1];
      const folderId = this.extractXml(block, 't:FolderId', 'Id');
      const parentFolderId = this.extractXml(block, 't:ParentFolderId', 'Id');
      const rawName = this.extractXmlText(block, 't:DisplayName');
      const displayName = rawName && rawName
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
      const totalCount = parseInt(this.extractXmlText(block, 't:TotalCount') || '0', 10);
      const unreadCount = parseInt(this.extractXmlText(block, 't:UnreadCount') || '0', 10);
      const folderClass = this.extractXmlText(block, 't:FolderClass') || 'IPF.Note';

      if (displayName) {
        folders.push({
          id: uuidv4(),
          path: displayName,
          name: displayName,
          ewsFolderId: folderId,
          ewsParentFolderId: parentFolderId,
          totalMessages: totalCount,
          unseenMessages: unreadCount,
          folderClass,
        });
      }
    }

    return folders;
  }

  async searchMailboxes(criteria) {
    const kql = this.buildKqlQuery(criteria);
    this.log('C→S', `SOAP SearchMailboxes - KQL: "${kql}"`);

    const body = `<m:SearchMailboxes>
      <m:SearchQueries>
        <t:MailboxQuery>
          <t:Query>${this.escapeXml(kql)}</t:Query>
          <t:MailboxSearchScopes>
            <t:MailboxSearchScope>
              <t:Mailbox>${this.escapeXml(this.config.email)}</t:Mailbox>
              <t:SearchScope>All</t:SearchScope>
            </t:MailboxSearchScope>
          </t:MailboxSearchScopes>
        </t:MailboxQuery>
      </m:SearchQueries>
      <m:ResultType>PreviewOnly</m:ResultType>
    </m:SearchMailboxes>`;

    const xml = await this.soapRequest('SearchMailboxes', body);
    const countMatch = xml.match(/<m:ItemCount>(\d+)<\/m:ItemCount>/);
    const resultCount = countMatch ? parseInt(countMatch[1], 10) : 0;

    this.log('S→C', `SearchMailboxes returned ${resultCount} results`);
    return { query: kql, resultCount, searchId: uuidv4() };
  }

  // Alias for collection route compatibility
  async searchMessages(criteria) {
    return this.searchMailboxes(criteria);
  }

  buildKqlQuery(criteria) {
    const parts = [];
    if (criteria.keyword) parts.push(criteria.keyword);
    if (criteria.from) parts.push(`from:${criteria.from}`);
    if (criteria.to) parts.push(`to:${criteria.to}`);
    if (criteria.subject) parts.push(`subject:"${criteria.subject}"`);
    if (criteria.hasAttachment) parts.push('hasattachment:true');
    if (criteria.since) parts.push(`received>=${criteria.since}`);
    if (criteria.before) parts.push(`received<=${criteria.before}`);
    if (criteria.size) parts.push(`size>${criteria.size}`);
    return parts.join(' AND ') || '*';
  }

  async fetchMessages(folderPath, { limit, searchCriteria } = {}) {
    const pageSize = Math.min(limit || 50, 50);
    const maxMessages = limit || Infinity;

    let folderId;
    if (folderPath.match(/^[A-Za-z0-9+/=]+$/) && folderPath.length > 40) {
      folderId = folderPath;
    } else {
      folderId = null;
    }

    const folderRef = folderId
      ? `<t:FolderId Id="${this.escapeXml(folderId)}"/>`
      : `<t:DistinguishedFolderId Id="${this.mapWellKnownFolder(folderPath)}"/>`;

    const messages = [];
    let offset = 0;
    let hasMore = true;

    while (hasMore && messages.length < maxMessages) {
      const body = `<m:FindItem Traversal="Shallow">
        <m:ItemShape>
          <t:BaseShape>IdOnly</t:BaseShape>
          <t:AdditionalProperties>
            <t:FieldURI FieldURI="item:Subject"/>
            <t:FieldURI FieldURI="item:DateTimeReceived"/>
            <t:FieldURI FieldURI="item:HasAttachments"/>
            <t:FieldURI FieldURI="item:Size"/>
            <t:FieldURI FieldURI="message:From"/>
            <t:FieldURI FieldURI="message:ToRecipients"/>
            <t:FieldURI FieldURI="message:CcRecipients"/>
            <t:FieldURI FieldURI="message:BccRecipients"/>
            <t:FieldURI FieldURI="message:InternetMessageId"/>
            <t:FieldURI FieldURI="message:InReplyTo"/>
          </t:AdditionalProperties>
        </m:ItemShape>
        <m:IndexedPageItemView MaxEntriesReturned="${pageSize}" Offset="${offset}" BasePoint="Beginning"/>
        <m:SortOrder>
          <t:FieldOrder Order="Descending"><t:FieldURI FieldURI="item:DateTimeReceived"/></t:FieldOrder>
        </m:SortOrder>
        <m:ParentFolderIds>${folderRef}</m:ParentFolderIds>
      </m:FindItem>`;

      this.log('C→S', `SOAP FindItem - Folder: ${folderPath}, Offset: ${offset}, PageSize: ${pageSize}`);
      const xml = await this.soapRequest('FindItem', body);

      const items = this.parseItemStubs(xml);
      this.log('S→C', `FindItem returned ${items.length} items`);

      if (items.length === 0) break;

      const includesLastMatch = xml.includes('IncludesLastItemInRange="true"');
      hasMore = !includesLastMatch && items.length === pageSize;
      offset += items.length;

      for (const stub of items) {
        if (messages.length >= maxMessages) break;

        const mimeBody = `<m:GetItem>
          <m:ItemShape>
            <t:BaseShape>IdOnly</t:BaseShape>
            <t:IncludeMimeContent>true</t:IncludeMimeContent>
          </m:ItemShape>
          <m:ItemIds>
            <t:ItemId Id="${this.escapeXml(stub.itemId)}" ChangeKey="${this.escapeXml(stub.changeKey || '')}"/>
          </m:ItemIds>
        </m:GetItem>`;

        this.log('C→S', `SOAP GetItem (MIME) - ${stub.subject?.substring(0, 40) || stub.itemId.substring(0, 20)}`);

        try {
          const mimeXml = await this.soapRequest('GetItem', mimeBody);
          const mimeContent = this.extractXmlText(mimeXml, 't:MimeContent');

          if (!mimeContent) {
            this.log('S→C', `No MIME content for ${stub.itemId.substring(0, 20)}`);
            continue;
          }

          const rawBuffer = Buffer.from(mimeContent, 'base64');
          this.log('S→C', `200 OK - MIME content (${rawBuffer.length} bytes)`);

          messages.push({
            id: uuidv4(),
            uid: messages.length + 1,
            serviceId: stub.itemId,
            ewsItemId: stub.itemId,
            folder: folderPath,
            subject: stub.subject || '(no subject)',
            fromAddress: stub.from || '',
            toAddresses: stub.toRecipients || [],
            ccAddresses: stub.ccRecipients || [],
            bccAddresses: stub.bccRecipients || [],
            date: stub.dateReceived || new Date().toISOString(),
            messageId: stub.internetMessageId || null,
            inReplyTo: stub.inReplyTo || null,
            size: rawBuffer.length,
            hashMd5: crypto.createHash('md5').update(rawBuffer).digest('hex'),
            hashSha256: crypto.createHash('sha256').update(rawBuffer).digest('hex'),
            hashSha512: crypto.createHash('sha512').update(rawBuffer).digest('hex'),
            hasAttachments: stub.hasAttachments || false,
            attachmentCount: 0,
            bodyText: this.extractPlainBody(rawBuffer.toString('utf8')),
            contentType: 'message/rfc822',
            rawSource: rawBuffer.toString('base64'),
          });
        } catch (err) {
          this.log('CLIENT', `Failed to fetch MIME for ${stub.itemId.substring(0, 20)}: ${err.message}`);
        }
      }
    }

    this.log('CLIENT', `Fetched ${messages.length} messages from ${folderPath} via EWS`);
    return messages;
  }

  parseItemStubs(xml) {
    const items = [];
    const msgRegex = /<t:Message>([\s\S]*?)<\/t:Message>/g;
    let match;

    while ((match = msgRegex.exec(xml)) !== null) {
      const block = match[1];
      const itemId = this.extractXml(block, 't:ItemId', 'Id');
      const changeKey = this.extractXml(block, 't:ItemId', 'ChangeKey');

      items.push({
        itemId: itemId || '',
        changeKey: changeKey || '',
        subject: this.extractXmlText(block, 't:Subject'),
        dateReceived: this.extractXmlText(block, 't:DateTimeReceived'),
        hasAttachments: this.extractXmlText(block, 't:HasAttachments') === 'true',
        size: parseInt(this.extractXmlText(block, 't:Size') || '0', 10),
        internetMessageId: this.extractXmlText(block, 't:InternetMessageId'),
        inReplyTo: this.extractXmlText(block, 't:InReplyTo'),
        from: this.extractEmailAddress(block, 't:From'),
        toRecipients: this.extractEmailAddresses(block, 't:ToRecipients'),
        ccRecipients: this.extractEmailAddresses(block, 't:CcRecipients'),
        bccRecipients: this.extractEmailAddresses(block, 't:BccRecipients'),
      });
    }

    return items;
  }

  extractXml(block, tag, attr) {
    const regex = new RegExp(`<${tag}[^>]*\\s${attr}="([^"]*)"`, 'i');
    const match = block.match(regex);
    return match ? match[1] : null;
  }

  extractXmlText(block, tag) {
    const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
    const match = block.match(regex);
    return match ? match[1].trim() : null;
  }

  extractEmailAddress(block, tag) {
    const section = this.extractXmlText(block, tag);
    if (!section) return '';
    const addr = this.extractXmlText(section, 't:EmailAddress');
    return addr || '';
  }

  extractEmailAddresses(block, tag) {
    const section = this.extractXmlText(block, tag);
    if (!section) return [];
    const addresses = [];
    const regex = /<t:EmailAddress>([^<]+)<\/t:EmailAddress>/g;
    let match;
    while ((match = regex.exec(section)) !== null) {
      addresses.push(match[1]);
    }
    return addresses;
  }

  extractPlainBody(raw) {
    const bodyStart = raw.indexOf('\r\n\r\n');
    if (bodyStart < 0) return '';
    return raw.substring(bodyStart + 4, bodyStart + 4 + 1000).trim();
  }

  escapeXml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  mapWellKnownFolder(folderPath, fallback = 'inbox') {
    const map = {
      'inbox': 'inbox', 'Inbox': 'inbox',
      'sent items': 'sentitems', 'Sent Items': 'sentitems', 'Sent': 'sentitems',
      'drafts': 'drafts', 'Drafts': 'drafts',
      'deleted items': 'deleteditems', 'Deleted Items': 'deleteditems', 'Trash': 'deleteditems',
      'junk email': 'junkemail', 'Junk Email': 'junkemail', 'Spam': 'junkemail', 'Junk': 'junkemail',
      'archive': 'archivemsgfolderroot', 'Archive': 'archivemsgfolderroot',
      'outbox': 'outbox', 'Outbox': 'outbox',
      'recoverable items': 'recoverableitemsroot', 'Recoverable Items': 'recoverableitemsroot',
    };
    return map[folderPath] || fallback;
  }

  async disconnect() {
    this.authenticated = false;
    this.log('CLIENT', 'EWS session ended');
  }

  getProtocolLog() {
    return this.protocolLog;
  }

  static getCapabilities() {
    return {
      protocols: ['EWS SOAP API'],
      authentication: ['Basic', 'NTLM', 'OAuth2', 'App-Only (Certificate)', 'App-Only (Client Secret)'],
      features: [
        'Autodiscover endpoint resolution',
        'In-place eDiscovery search (KQL)',
        'Recoverable Items Folder access',
        'In-place Archive access',
        'Public Folder access',
        'Calendar and Contact items',
        'Delegate and impersonation access',
        'Batch item retrieval',
        'MIME content export',
        'Paginated FindItem with offset',
      ],
      searchOperators: [
        'from:', 'to:', 'cc:', 'bcc:', 'subject:', 'body:',
        'received>=', 'received<=', 'sent>=', 'sent<=',
        'hasattachment:', 'size>', 'size<', 'kind:',
        'AND', 'OR', 'NOT', 'NEAR(n)',
      ],
    };
  }
}
