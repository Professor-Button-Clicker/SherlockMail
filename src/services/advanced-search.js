import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

export class AdvancedSearchService {

  // ── Pre-Acquisition Server-Side Search (Feature 21) ──

  static async preAcquisitionSearch(handler, criteria) {
    const results = { id: uuidv4(), criteria, uids: [], resultCount: 0, protocol: null };

    try {
      if (handler.client && typeof handler.client.search === 'function') {
        results.protocol = 'imap';
        const searchCriteria = this._buildImapSearchCriteria(criteria);
        const searchResult = await handler.client.search(searchCriteria);
        results.uids = searchResult || [];
        results.resultCount = results.uids.length;
      } else if (typeof handler.searchMessages === 'function') {
        results.protocol = handler.constructor.name.replace('Handler', '').toLowerCase();
        const searchResult = await handler.searchMessages(criteria);
        results.uids = searchResult.map(m => m.uid || m.id);
        results.resultCount = results.uids.length;
      }
    } catch (err) {
      results.error = err.message;
    }

    return results;
  }

  static _buildImapSearchCriteria(criteria) {
    const parts = [];

    if (criteria.from) parts.push(['FROM', criteria.from]);
    if (criteria.to) parts.push(['TO', criteria.to]);
    if (criteria.subject) parts.push(['SUBJECT', criteria.subject]);
    if (criteria.body) parts.push(['BODY', criteria.body]);
    if (criteria.since) parts.push(['SINCE', new Date(criteria.since)]);
    if (criteria.before) parts.push(['BEFORE', new Date(criteria.before)]);
    if (criteria.hasAttachment) parts.push(['HEADER', 'Content-Type', 'multipart/mixed']);
    if (criteria.flagged) parts.push('FLAGGED');
    if (criteria.unseen) parts.push('UNSEEN');
    if (criteria.larger) parts.push(['LARGER', criteria.larger]);
    if (criteria.smaller) parts.push(['SMALLER', criteria.smaller]);
    if (criteria.keyword) parts.push(['TEXT', criteria.keyword]);

    return parts.length > 0 ? parts : ['ALL'];
  }

  // ── Lucene-Style Full-Text Indexing (Feature 22) ──

  static buildIndex(messages) {
    const index = new Map();
    const docIndex = new Map();

    for (const msg of messages) {
      const docId = msg.id;
      const fields = {
        subject: msg.subject || '',
        from: msg.from_address || msg.fromAddress || '',
        to: JSON.stringify(msg.to_addresses || msg.toAddresses || []),
        cc: JSON.stringify(msg.cc_addresses || msg.ccAddresses || []),
        body: (msg.body_text || msg.bodyText || '').substring(0, 100000),
        folder: msg.folder || '',
        date: msg.date || '',
      };

      docIndex.set(docId, fields);

      for (const [field, content] of Object.entries(fields)) {
        const tokens = this._tokenize(content);
        for (const token of tokens) {
          if (!index.has(token)) index.set(token, []);
          index.get(token).push({ docId, field, position: 0 });
        }
      }
    }

    return { index, docIndex, totalDocs: messages.length, totalTerms: index.size };
  }

  static search(indexData, query, options = {}) {
    const { index } = indexData;
    const parsed = this._parseQuery(query);
    const limit = options.limit || 100;

    let resultIds;

    if (parsed.type === 'AND') {
      resultIds = this._intersect(parsed.terms.map(t => this._matchTerm(index, t, options.fields)));
    } else if (parsed.type === 'OR') {
      resultIds = this._union(parsed.terms.map(t => this._matchTerm(index, t, options.fields)));
    } else if (parsed.type === 'NOT') {
      const all = new Set(indexData.docIndex.keys());
      const excluded = this._matchTerm(index, parsed.terms[0], options.fields);
      resultIds = new Set([...all].filter(id => !excluded.has(id)));
    } else {
      resultIds = this._matchTerm(index, parsed.terms[0], options.fields);
    }

    return [...resultIds].slice(0, limit);
  }

  static _tokenize(text) {
    return String(text).toLowerCase()
      .replace(/[^\w\s@.-]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 2);
  }

  static _parseQuery(query) {
    const trimmed = query.trim();

    if (trimmed.includes(' AND ')) {
      return { type: 'AND', terms: trimmed.split(' AND ').map(t => t.trim().toLowerCase()) };
    }
    if (trimmed.includes(' OR ')) {
      return { type: 'OR', terms: trimmed.split(' OR ').map(t => t.trim().toLowerCase()) };
    }
    if (trimmed.startsWith('NOT ')) {
      return { type: 'NOT', terms: [trimmed.slice(4).trim().toLowerCase()] };
    }

    const tokens = this._tokenize(trimmed);
    if (tokens.length > 1) return { type: 'AND', terms: tokens };
    return { type: 'TERM', terms: tokens.length ? tokens : [trimmed.toLowerCase()] };
  }

  static _matchTerm(index, term, fields) {
    const results = new Set();
    const entries = index.get(term) || [];
    for (const entry of entries) {
      if (!fields || fields.includes(entry.field)) results.add(entry.docId);
    }
    if (results.size === 0) {
      for (const [key, entries] of index) {
        if (key.includes(term)) {
          for (const entry of entries) {
            if (!fields || fields.includes(entry.field)) results.add(entry.docId);
          }
        }
      }
    }
    return results;
  }

  static _intersect(sets) {
    if (sets.length === 0) return new Set();
    let result = sets[0];
    for (let i = 1; i < sets.length; i++) result = new Set([...result].filter(x => sets[i].has(x)));
    return result;
  }

  static _union(sets) {
    const result = new Set();
    for (const s of sets) for (const item of s) result.add(item);
    return result;
  }

  // ── Differential/Incremental Acquisition (Feature 23) ──

  static computeDifferentialPlan(existingMessages, serverFolders, options = {}) {
    const existingIds = new Set(existingMessages.map(m => m.service_id || m.serviceId || m.message_id || m.messageId).filter(Boolean));
    const existingUids = new Map();

    for (const m of existingMessages) {
      const folder = m.folder || '';
      if (!existingUids.has(folder)) existingUids.set(folder, new Set());
      const uid = m.uid || m.service_id || m.serviceId;
      if (uid) existingUids.get(folder).add(String(uid));
    }

    const plan = {
      id: uuidv4(),
      type: 'differential',
      existingMessageCount: existingMessages.length,
      folders: [],
      estimatedNewMessages: 0,
    };

    for (const folder of serverFolders) {
      const folderPath = folder.path || folder.name;
      const serverTotal = folder.total_messages || folder.totalMessages || 0;
      const existingInFolder = existingUids.get(folderPath)?.size || 0;
      const estimatedNew = Math.max(0, serverTotal - existingInFolder);

      plan.folders.push({
        path: folderPath,
        serverTotal,
        existingCount: existingInFolder,
        estimatedNew,
        needsCollection: estimatedNew > 0,
      });
      plan.estimatedNewMessages += estimatedNew;
    }

    return plan;
  }

  static filterNewMessages(messages, existingIds) {
    return messages.filter(m => {
      const id = m.service_id || m.serviceId || m.message_id || m.messageId || m.uid;
      return !existingIds.has(String(id));
    });
  }
}
