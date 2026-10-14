import { ImapFlow } from 'imapflow';
import { EventEmitter } from 'node:events';

export class ForensicImapClient extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.client = null;
    this.connected = false;
  }

  async connect() {
    this.client = new ImapFlow({
      host: this.config.host,
      port: this.config.port || 993,
      secure: this.config.tls !== false,
      auth: this.#buildAuth(),
      logger: false,
      emitLogs: false,
      tls: this.config.tlsOptions || { rejectUnauthorized: true }
    });

    await this.client.connect();
    this.connected = true;
    this.emit('connected', { host: this.config.host, port: this.config.port });
    return this;
  }

  #buildAuth() {
    if (this.config.oauth2) {
      return {
        user: this.config.email,
        accessToken: this.config.oauth2.accessToken
      };
    }
    return {
      user: this.config.username || this.config.email,
      pass: this.config.appPassword || this.config.password
    };
  }

  get authMethod() {
    if (this.config.oauth2) return 'oauth2';
    if (this.config.appPassword) return 'app-password';
    return 'password';
  }

  async disconnect() {
    if (this.client && this.connected) {
      await this.client.logout();
      this.connected = false;
      this.emit('disconnected');
    }
  }

  async listFolders() {
    const tree = await this.client.listTree();
    const folders = [];
    const flatten = (node, parentPath = '') => {
      if (node.path) {
        folders.push({
          path: node.path,
          name: node.name,
          delimiter: node.delimiter,
          flags: node.flags || [],
          specialUse: node.specialUse,
          listed: node.listed !== false
        });
      }
      if (node.folders) {
        for (const child of node.folders) {
          flatten(child, node.path);
        }
      }
    };
    flatten(tree);
    return folders;
  }

  async getFolderStatus(folderPath) {
    const status = await this.client.status(folderPath, {
      messages: true,
      unseen: true,
      uidNext: true,
      uidValidity: true
    });
    return {
      path: folderPath,
      messages: status.messages,
      unseen: status.unseen,
      uidNext: status.uidNext,
      uidValidity: status.uidValidity
    };
  }

  async *fetchMessages(folderPath, options = {}) {
    const lock = await this.client.getMailboxLock(folderPath);
    try {
      const range = options.uidRange || '1:*';
      const fetchOptions = {
        uid: true,
        flags: true,
        envelope: true,
        bodyStructure: true,
        size: true,
        source: true,
        internalDate: true
      };

      for await (const msg of this.client.fetch(range, fetchOptions, { uid: true })) {
        const result = {
          uid: msg.uid,
          flags: [...(msg.flags || [])],
          envelope: msg.envelope,
          bodyStructure: msg.bodyStructure,
          size: msg.size,
          source: msg.source,
          internalDate: msg.internalDate,
          folder: folderPath
        };
        this.emit('message', result);
        yield result;
      }
    } finally {
      lock.release();
    }
  }

  async fetchMessageByUid(folderPath, uid) {
    const lock = await this.client.getMailboxLock(folderPath);
    try {
      const msg = await this.client.fetchOne(String(uid), {
        uid: true,
        flags: true,
        envelope: true,
        bodyStructure: true,
        size: true,
        source: true,
        internalDate: true
      }, { uid: true });
      return {
        uid: msg.uid,
        flags: [...(msg.flags || [])],
        envelope: msg.envelope,
        bodyStructure: msg.bodyStructure,
        size: msg.size,
        source: msg.source,
        internalDate: msg.internalDate,
        folder: folderPath
      };
    } finally {
      lock.release();
    }
  }

  async searchMessages(folderPath, criteria) {
    const lock = await this.client.getMailboxLock(folderPath);
    try {
      const uids = await this.client.search(criteria, { uid: true });
      return uids;
    } finally {
      lock.release();
    }
  }

  async searchInPlace(folderPath, searchCriteria) {
    const imapCriteria = this.#buildSearchCriteria(searchCriteria);
    return this.searchMessages(folderPath, imapCriteria);
  }

  #buildSearchCriteria(criteria) {
    const parts = {};
    if (criteria.from) parts.from = criteria.from;
    if (criteria.to) parts.to = criteria.to;
    if (criteria.subject) parts.subject = criteria.subject;
    if (criteria.body) parts.body = criteria.body;
    if (criteria.text) parts.text = criteria.text;
    if (criteria.since) parts.since = new Date(criteria.since);
    if (criteria.before) parts.before = new Date(criteria.before);
    if (criteria.sentSince) parts.sentSince = new Date(criteria.sentSince);
    if (criteria.sentBefore) parts.sentBefore = new Date(criteria.sentBefore);
    if (criteria.seen !== undefined) parts.seen = criteria.seen;
    if (criteria.flagged !== undefined) parts.flagged = criteria.flagged;
    if (criteria.answered !== undefined) parts.answered = criteria.answered;
    if (criteria.deleted !== undefined) parts.deleted = criteria.deleted;
    if (criteria.larger) parts.larger = criteria.larger;
    if (criteria.smaller) parts.smaller = criteria.smaller;
    if (criteria.header) parts.header = criteria.header;
    return parts;
  }

  async getCapabilities() {
    return this.client?.capabilities || new Set();
  }
}
