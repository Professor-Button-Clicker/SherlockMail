import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

const MAX_LOG_ENTRIES = 5000;

function compactUidSet(uids) {
  const sorted = [...uids].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i];
    while (i + 1 < sorted.length && sorted[i + 1] === sorted[i] + 1) i++;
    parts.push(start === sorted[i] ? `${start}` : `${start}:${sorted[i]}`);
  }
  return parts.join(',');
}

export class ImapHandler {
  constructor(config) {
    this.config = config;
    this.client = null;
    this.protocolLog = [];
  }

  log(direction, message) {
    if (this.protocolLog.length >= MAX_LOG_ENTRIES) this.protocolLog.splice(0, this.protocolLog.length - MAX_LOG_ENTRIES + 1);
    this.protocolLog.push({
      timestamp: new Date().toISOString(),
      direction,
      message: typeof message === 'string' ? message : JSON.stringify(message)
    });
  }

  async connect() {
    const { host, port, username, password, tls, email } = this.config;

    const effectivePort = port || (tls !== false ? 993 : 143);

    this.client = new ImapFlow({
      host,
      port: effectivePort,
      secure: tls !== false,
      auth: { user: username || email, pass: password },
      socketTimeout: 210000,
      greetingTimeout: 195000,
      logger: {
        // imapflow emits a debug entry per protocol line; serializing those dominated CPU on large pulls.
        debug: () => {},
        info: (msg) => this.log('INFO', msg),
        warn: (msg) => this.log('WARN', msg),
        error: (msg) => this.log('ERROR', msg),
      },
      emitLogs: false,
    });

    // Without a listener, imapflow's 'error' event (e.g. idle socket timeout) is unhandled and kills the process.
    const client = this.client;
    client.on('error', (err) => this.log('ERROR', `Connection error: ${err.message}`));
    try {
      await client.connect();
    } catch (err) {
      client.close();
      throw err;
    }
    this.log('CLIENT', `Connected to ${host}:${effectivePort}`);
    return { success: true, host, port: effectivePort };
  }

  cloneForWorker() {
    const h = new ImapHandler(this.config);
    h.protocolLog = this.protocolLog;
    return h;
  }

  async ensureConnected() {
    if (!this.client || !this.client.usable) await this.connect();
  }

  async openReadOnly(folderPath) {
    const mb = this.client.mailbox;
    if (!mb || mb.path !== folderPath || !mb.readOnly) {
      await this.client.mailboxOpen(folderPath, { readOnly: true });
    }
    return this.client.mailbox;
  }

  // Gmail exposes labels as IMAP folders, so one message appears in several of them.
  isGmail() {
    return !!this.client?.capabilities?.has('X-GM-EXT-1');
  }

  async isNonSelectable(folderPath) {
    const entry = (await this.client.list()).find(f => f.path === folderPath);
    return !!entry && [...(entry.flags || [])].some(f => /^\\(Noselect|NonExistent)$/i.test(f));
  }

  async enumerate(folderPath, { limit, searchCriteria } = {}) {
    await this.ensureConnected();
    let box;
    try {
      box = await this.openReadOnly(folderPath);
    } catch (err) {
      if (await this.isNonSelectable(folderPath).catch(() => false)) {
        this.log('CLIENT', `Skipped ${folderPath}: container folder that cannot hold messages`);
        return { key: folderPath, refs: [] };
      }
      throw err;
    }
    let uids = box.exists > 0 ? await this.client.search(searchCriteria || { all: true }, { uid: true }) : [];
    uids = (uids || []).sort((a, b) => a - b);
    if (limit > 0) uids = uids.slice(0, limit);
    const info = new Map();
    if (uids.length) {
      const wanted = new Set(uids);
      for await (const m of this.client.fetch(`${uids[0]}:${uids[uids.length - 1]}`, { uid: true, size: true }, { uid: true })) {
        if (wanted.has(m.uid)) info.set(m.uid, m);
      }
    }
    const gmail = this.isGmail();
    this.log('CLIENT', `Enumerated ${uids.length} UIDs in ${folderPath} (EXISTS ${box.exists}, UIDVALIDITY ${box.uidValidity})`);
    return {
      key: folderPath,
      refs: uids.map(uid => {
        const m = info.get(uid);
        const ref = { key: String(uid), uid, size: m?.size || 0 };
        if (gmail && m?.emailId) { ref.globalKey = `gmail:${m.emailId}`; ref.serviceId = m.emailId; }
        return ref;
      }),
    };
  }

  async fetchBatch(folderPath, refs, deliver) {
    await this.openReadOnly(folderPath);
    const byUid = new Map(refs.map(r => [r.uid, r]));
    const out = [];
    const emit = deliver || (item => out.push(item));
    const gmail = this.isGmail();
    const query = { uid: true, flags: true, internalDate: true, source: true, labels: gmail };
    for await (const m of this.client.fetch(compactUidSet(byUid.keys()), query, { uid: true })) {
      const ref = byUid.get(m.uid);
      if (!ref || !m.source) continue;
      emit({
        ref,
        raw: m.source,
        meta: {
          flags: m.flags ? [...m.flags] : [],
          internalDate: m.internalDate ? new Date(m.internalDate).toISOString() : null,
          ...(gmail && m.labels ? { gmailLabels: [...m.labels] } : {}),
        },
      });
    }
    return out;
  }

  async listFolders() {
    const tree = await this.client.listTree();
    const folders = [];

    const flatten = (items, parentPath) => {
      for (const item of items) {
        const path = item.path || item.name;
        const flags = [...(item.flags || [])];
        // Containers such as Gmail's "[Gmail]" hold no messages and fail to open; list only their children.
        if (!flags.some(f => /^\\(Noselect|NonExistent)$/i.test(f))) {
          folders.push({
            id: uuidv4(),
            path,
            name: item.name,
            delimiter: item.delimiter || '/',
            flags,
            specialUse: item.specialUse || null,
            parentPath,
          });
        }
        if (item.folders?.length) {
          flatten(item.folders, path);
        }
      }
    };

    flatten(tree.folders || [], null);

    for (const folder of folders) {
      try {
        const st = await this.client.status(folder.path, { messages: true, unseen: true });
        folder.totalMessages = st.messages || 0;
        folder.unseenMessages = st.unseen || 0;
      } catch {
        folder.totalMessages = 0;
        folder.unseenMessages = 0;
      }
    }

    this.log('CLIENT', `Listed ${folders.length} folders`);
    return folders;
  }

  async listMessageUids(folderPath, { limit, searchCriteria } = {}) {
    const lock = await this.client.getMailboxLock(folderPath);
    try {
      const query = searchCriteria || { all: true };
      const uids = [];
      for await (const msg of this.client.fetch(query, { uid: true })) {
        uids.push(msg.uid);
        if (limit > 0 && uids.length >= limit) break;
      }
      this.log('CLIENT', `Enumerated ${uids.length} UIDs in ${folderPath}`);
      return uids;
    } finally {
      lock.release();
    }
  }

  async fetchSingleMessage(folderPath, uid) {
    const lock = await this.client.getMailboxLock(folderPath);
    try {
      const downloadWithTimeout = (timeoutMs = 240000) => new Promise(async (resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Download timeout for UID ${uid} after ${timeoutMs / 1000}s`)), timeoutMs);
        try {
          const raw = await this.client.download(uid.toString(), undefined, { uid: true });
          const chunks = [];
          for await (const chunk of raw.content) {
            chunks.push(chunk);
          }
          clearTimeout(timer);
          resolve(Buffer.concat(chunks));
        } catch (err) {
          clearTimeout(timer);
          reject(err);
        }
      });
      const rawBuffer = await downloadWithTimeout();

      const hashMd5 = crypto.createHash('md5').update(rawBuffer).digest('hex');
      const hashSha256 = crypto.createHash('sha256').update(rawBuffer).digest('hex');
      const hashSha512 = crypto.createHash('sha512').update(rawBuffer).digest('hex');

      const parsed = await simpleParser(rawBuffer);

      return {
        id: uuidv4(),
        uid,
        folder: folderPath,
        subject: parsed.subject || '(no subject)',
        fromAddress: parsed.from?.text || '',
        toAddresses: parsed.to?.value?.map(a => a.address) || [],
        ccAddresses: parsed.cc?.value?.map(a => a.address) || [],
        bccAddresses: parsed.bcc?.value?.map(a => a.address) || [],
        date: parsed.date?.toISOString() || new Date().toISOString(),
        messageId: parsed.messageId || null,
        inReplyTo: parsed.inReplyTo || null,
        size: rawBuffer.length,
        flags: [],
        hasAttachments: (parsed.attachments?.length || 0) > 0,
        attachmentCount: parsed.attachments?.length || 0,
        contentType: parsed.headers?.get('content-type')?.value || 'text/plain',
        hashMd5,
        hashSha256,
        hashSha512,
        bodyText: parsed.text || '',
        bodyHtml: parsed.html || '',
        headers: Object.fromEntries(parsed.headers || []),
        rawSource: rawBuffer.toString('base64'),
        attachments: (parsed.attachments || []).map(att => ({
          id: uuidv4(),
          filename: att.filename || 'unnamed',
          contentType: att.contentType || 'application/octet-stream',
          size: att.size || 0,
          hashMd5: crypto.createHash('md5').update(att.content).digest('hex'),
          hashSha256: crypto.createHash('sha256').update(att.content).digest('hex'),
          disposition: att.contentDisposition || 'attachment',
          contentId: att.contentId || null,
          isInline: att.contentDisposition === 'inline',
        })),
      };
    } finally {
      lock.release();
    }
  }

  async fetchMessages(folderPath, { limit, searchCriteria } = {}) {
    const uids = await this.listMessageUids(folderPath, { limit, searchCriteria });
    const messages = [];
    for (const uid of uids) {
      try {
        const msg = await this.fetchSingleMessage(folderPath, uid);
        messages.push(msg);
      } catch (err) {
        this.log('ERROR', `Failed to fetch UID ${uid}: ${err.message}`);
      }
    }
    this.log('CLIENT', `Fetched ${messages.length} messages from ${folderPath}`);
    return messages;
  }

  async serverSearch(folderPath, criteria) {
    const lock = await this.client.getMailboxLock(folderPath);
    try {
      const searchQuery = {};

      if (criteria.from) searchQuery.from = criteria.from;
      if (criteria.to) searchQuery.to = criteria.to;
      if (criteria.subject) searchQuery.subject = criteria.subject;
      if (criteria.body) searchQuery.body = criteria.body;
      if (criteria.since) searchQuery.since = new Date(criteria.since);
      if (criteria.before) searchQuery.before = new Date(criteria.before);
      if (criteria.hasAttachment) searchQuery.header = { 'Content-Type': 'multipart/mixed' };
      if (criteria.flagged) searchQuery.flagged = true;
      if (criteria.unseen) searchQuery.unseen = true;
      if (criteria.keyword) searchQuery.or = [
        { subject: criteria.keyword },
        { body: criteria.keyword },
        { from: criteria.keyword }
      ];

      const results = await this.client.search(searchQuery);
      this.log('CLIENT', `Server-side search returned ${results.length} results in ${folderPath}`);
      return { count: results.length, uids: results };
    } finally {
      lock.release();
    }
  }

  async disconnect() {
    if (this.client) {
      if (this.client.usable) await this.client.logout();
      else this.client.close();
      this.client = null;
      this.log('CLIENT', 'Disconnected');
    }
  }

  getProtocolLog() {
    return this.protocolLog;
  }

  static getProviderPresets() {
    return {
      gmail: { host: 'imap.gmail.com', port: 993, tls: true, note: 'Requires App Password or OAuth2' },
      outlook: { host: 'outlook.office365.com', port: 993, tls: true, note: 'May require OAuth2' },
      yahoo: { host: 'imap.mail.yahoo.com', port: 993, tls: true, note: 'Requires App Password' },
      aol: { host: 'imap.aol.com', port: 993, tls: true },
      zoho: { host: 'imap.zoho.com', port: 993, tls: true },
      icloud: { host: 'imap.mail.me.com', port: 993, tls: true, note: 'Requires App-Specific Password' },
      fastmail: { host: 'imap.fastmail.com', port: 993, tls: true },
      protonmail: { host: '127.0.0.1', port: 1143, tls: false, note: 'Requires ProtonMail Bridge' },
      yandex: { host: 'imap.yandex.com', port: 993, tls: true },
      custom: { host: '', port: 993, tls: true },
    };
  }
}
