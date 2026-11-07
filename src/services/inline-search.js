import crypto from 'crypto';

const TEXT_FIELDS = new Set([
  'from', 'sender', 'to', 'recipient', 'cc', 'bcc', 'subject', 'body', 'folder', 'hash', 'messageid', 'attachment', 'filename',
]);
const RANGE_FIELDS = new Set(['sent', 'date', 'received', 'size', 'attachmentcount']);
const FLAG_FIELDS = new Set(['has', 'is']);

// Characters that end a bare word in a query.
const WORD_END = /[\s()]/;

function addressText(value) {
  if (Array.isArray(value)) return value.join(' ');
  if (typeof value !== 'string') return '';
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.join(' ') : value;
  } catch {
    return value;
  }
}

function wildcardRegex(pattern) {
  const body = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`, 'i');
}

function wordsOf(text) {
  return text.toLowerCase().split(/[^\p{L}\p{N}@._'-]+/u).map(w => w.replace(/^[._'-]+|[._'-]+$/g, '')).filter(Boolean);
}

function compileRegex(pattern, flags) {
  try {
    return new RegExp(pattern, flags.includes('i') ? flags : `${flags}i`);
  } catch (err) {
    throw new Error(`Invalid regular expression /${pattern}/: ${err.message}`);
  }
}

// YYYY/MM/DD, YYYY-MM-DD or anything Date can read. A day's end is inclusive for the upper bound.
function dayBound(value, endOfDay) {
  const m = String(value).trim().match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0)) : new Date(value);
  if (isNaN(d.getTime())) throw new Error(`Not a date: ${value}`);
  return d.getTime();
}

export class InlineSearchEngine {

  // options.attachmentsByMessage: Map of message id -> [filenames], so attachment: and filename: can match.
  static search(messages, query, options = {}) {
    if (!query || !query.trim()) return { results: messages, parsed: null, stats: {} };

    const parsed = this.parseQuery(query);
    const startTime = Date.now();
    const results = messages.filter(msg => this.evaluate(parsed, msg, options));
    const elapsed = Date.now() - startTime;

    return {
      results,
      parsed,
      stats: {
        total: messages.length,
        matched: results.length,
        elapsed,
        queryHash: crypto.createHash('sha256').update(query).digest('hex').substring(0, 16),
      },
    };
  }

  static tokenize(query) {
    const tokens = [];
    let i = 0;
    const word = (w) => query.substring(i, i + w.length).toUpperCase() === w && (i + w.length >= query.length || WORD_END.test(query[i + w.length]));

    while (i < query.length) {
      if (/\s/.test(query[i])) { i++; continue; }
      if (word('AND')) { tokens.push({ type: 'AND' }); i += 3; continue; }
      if (word('OR')) { tokens.push({ type: 'OR' }); i += 2; continue; }
      if (word('NOT')) { tokens.push({ type: 'NOT' }); i += 3; continue; }
      if (query[i] === '-' && i + 1 < query.length && !/\s/.test(query[i + 1])) { tokens.push({ type: 'NOT' }); i++; continue; }
      if (query[i] === '(') { tokens.push({ type: 'LPAREN' }); i++; continue; }
      if (query[i] === ')') { tokens.push({ type: 'RPAREN' }); i++; continue; }

      if (query[i] === '/' && query.indexOf('/', i + 1) > i) {
        const end = query.indexOf('/', i + 1);
        let fi = end + 1;
        let flags = '';
        while (fi < query.length && /[gimsuy]/.test(query[fi])) { flags += query[fi]; fi++; }
        tokens.push({ type: 'REGEX', regex: compileRegex(query.substring(i + 1, end), flags.replace('g', '')), pattern: query.substring(i + 1, end), flags });
        i = fi;
        continue;
      }

      if (query[i] === '"') {
        const end = query.indexOf('"', i + 1);
        if (end > i) {
          const phrase = query.substring(i + 1, end);
          let pi = end + 1;
          if (query[pi] === '~') {
            pi++;
            let num = '';
            while (pi < query.length && /\d/.test(query[pi])) { num += query[pi]; pi++; }
            tokens.push({ type: 'PROXIMITY', terms: phrase.split(/\s+/).filter(Boolean), distance: parseInt(num, 10) || 5 });
          } else {
            tokens.push({ type: 'PHRASE', value: phrase });
          }
          i = pi;
          continue;
        }
      }

      const fieldMatch = query.substring(i).match(/^(\w+):/);
      const field = fieldMatch?.[1].toLowerCase();
      if (field && (TEXT_FIELDS.has(field) || RANGE_FIELDS.has(field) || FLAG_FIELDS.has(field))) {
        i += fieldMatch[0].length;
        while (i < query.length && query[i] === ' ') i++;
        if (query[i] === '[' && query.indexOf(']', i) > i) {
          const end = query.indexOf(']', i);
          const range = query.substring(i + 1, end).split(/\s+TO\s+/i);
          if (range.length !== 2) throw new Error(`A range is written ${field}:[from TO to]`);
          tokens.push({ type: 'RANGE', field, from: range[0].trim(), to: range[1].trim() });
          i = end + 1;
          continue;
        }
        let value = '';
        if (query[i] === '"' && query.indexOf('"', i + 1) > i) {
          const end = query.indexOf('"', i + 1);
          value = query.substring(i + 1, end);
          i = end + 1;
        } else {
          const start = i;
          while (i < query.length && !WORD_END.test(query[i])) i++;
          value = query.substring(start, i);
        }
        tokens.push({ type: 'FIELD', field, value });
        continue;
      }

      // Anything else, "http://example.com" included, is a plain search word.
      const start = i;
      while (i < query.length && !WORD_END.test(query[i])) i++;
      const term = query.substring(start, i);
      if (term.endsWith('~') && term.length > 1) tokens.push({ type: 'FUZZY', value: term.slice(0, -1), distance: 2 });
      else if (term.includes('*') || term.includes('?')) tokens.push({ type: 'WILDCARD', pattern: term });
      else tokens.push({ type: 'TERM', value: term });
    }
    return tokens;
  }

  // OR binds loosest, then AND (written or implied by a space), then NOT; parentheses group.
  static parseQuery(query) {
    const tokens = this.tokenize(query);
    let pos = 0;
    const peek = () => tokens[pos];
    const parseOr = () => {
      let node = parseAnd();
      while (peek()?.type === 'OR') { pos++; node = { type: 'OR_NODE', left: node, right: parseAnd() }; }
      return node;
    };
    const parseAnd = () => {
      let node = parseNot();
      while (peek() && peek().type !== 'OR' && peek().type !== 'RPAREN') {
        if (peek().type === 'AND') pos++;
        node = { type: 'AND_NODE', left: node, right: parseNot() };
      }
      return node;
    };
    const parseNot = () => {
      if (peek()?.type === 'NOT') { pos++; return { type: 'NOT_NODE', operand: parseNot() }; }
      if (peek()?.type === 'LPAREN') {
        pos++;
        const node = parseOr();
        if (peek()?.type !== 'RPAREN') throw new Error('Unbalanced parentheses in the search');
        pos++;
        return node;
      }
      const token = peek();
      if (!token || ['AND', 'OR', 'RPAREN'].includes(token.type)) throw new Error('The search is incomplete: an operator has nothing to apply to');
      pos++;
      return token;
    };
    const tree = parseOr();
    if (pos < tokens.length) throw new Error('Unbalanced parentheses in the search');
    return tree;
  }

  static evaluate(node, msg, options = {}) {
    switch (node.type) {
      case 'OR_NODE': return this.evaluate(node.left, msg, options) || this.evaluate(node.right, msg, options);
      case 'AND_NODE': return this.evaluate(node.left, msg, options) && this.evaluate(node.right, msg, options);
      case 'NOT_NODE': return !this.evaluate(node.operand, msg, options);
      default: return this.matchToken(node, msg, options);
    }
  }

  static fullText(msg) {
    return [
      msg.subject || '', msg.from_address || msg.fromAddress || '', msg.body_text || msg.bodyText || '',
      addressText(msg.to_addresses ?? msg.toAddresses), addressText(msg.cc_addresses ?? msg.ccAddresses), addressText(msg.bcc_addresses ?? msg.bccAddresses),
    ].join(' ');
  }

  static fieldText(field, msg, options) {
    switch (field) {
      case 'from': case 'sender': return msg.from_address || msg.fromAddress || '';
      case 'to': case 'recipient': return addressText(msg.to_addresses ?? msg.toAddresses);
      case 'cc': return addressText(msg.cc_addresses ?? msg.ccAddresses);
      case 'bcc': return addressText(msg.bcc_addresses ?? msg.bccAddresses);
      case 'subject': return msg.subject || '';
      case 'body': return msg.body_text || msg.bodyText || '';
      case 'folder': return msg.folder || '';
      case 'hash': return msg.hash_sha256 || msg.hashSha256 || '';
      case 'messageid': return msg.message_id || msg.messageId || '';
      case 'attachment': case 'filename': return (options.attachmentsByMessage?.get(msg.id) || []).join(' ');
      default: return '';
    }
  }

  static matchToken(token, msg, options) {
    switch (token.type) {
      case 'TERM': return this.fullText(msg).toLowerCase().includes(token.value.toLowerCase());
      case 'PHRASE': return this.fullText(msg).toLowerCase().includes(token.value.toLowerCase());
      case 'REGEX': return token.regex.test(this.fullText(msg));
      case 'WILDCARD': { const re = wildcardRegex(token.pattern); return wordsOf(this.fullText(msg)).some(w => re.test(w)); }
      case 'FUZZY': { const target = token.value.toLowerCase(); return wordsOf(this.fullText(msg)).some(w => Math.abs(w.length - target.length) <= token.distance && this.levenshtein(w, target) <= token.distance); }
      case 'PROXIMITY': return this.matchProximity(token, msg);
      case 'RANGE': return this.matchRange(token, msg);
      case 'FIELD': return this.matchField(token, msg, options);
      default: return false;
    }
  }

  static matchProximity(token, msg) {
    const words = wordsOf(this.fullText(msg));
    const [t1, t2] = token.terms.map(t => t.toLowerCase());
    if (!t2) return words.some(w => w.includes(t1));
    for (let a = 0; a < words.length; a++) {
      if (!words[a].includes(t1)) continue;
      for (let b = Math.max(0, a - token.distance); b < Math.min(words.length, a + token.distance + 1); b++) {
        if (a !== b && words[b].includes(t2)) return true;
      }
    }
    return false;
  }

  static numericValue(field, msg) {
    if (field === 'size') return msg.size || 0;
    if (field === 'attachmentcount') return msg.attachment_count ?? msg.attachmentCount ?? 0;
    const raw = field === 'received' ? (msg.internal_date || msg.internalDate) : msg.date;
    const t = raw ? new Date(raw).getTime() : NaN;
    return isNaN(t) ? null : t;
  }

  static matchRange(token, msg) {
    const value = this.numericValue(token.field, msg);
    if (value === null) return false;
    const isDate = ['sent', 'date', 'received'].includes(token.field);
    const lower = isDate ? dayBound(token.from, false) : this.parseSize(token.from);
    const upper = isDate ? dayBound(token.to, true) : this.parseSize(token.to);
    return value >= lower && value <= upper;
  }

  static matchField(token, msg, options) {
    const value = token.value.toLowerCase();
    if (token.field === 'has') {
      if (/^attachments?$/.test(value)) return !!(msg.has_attachments ?? msg.hasAttachments);
      throw new Error(`has: only understands has:attachment, not has:${token.value}`);
    }
    if (token.field === 'is') {
      if (value === 'encrypted') return !!(msg.is_encrypted ?? msg.isEncrypted);
      if (value === 'signed') return !!(msg.is_signed ?? msg.isSigned);
      throw new Error(`is: only understands is:encrypted and is:signed, not is:${token.value}`);
    }
    if (RANGE_FIELDS.has(token.field)) {
      const current = this.numericValue(token.field, msg);
      if (current === null) return false;
      if (['sent', 'date', 'received'].includes(token.field)) {
        const bare = token.value.replace(/^[<>]=?/, '');
        if (token.value.startsWith('>')) return current > dayBound(bare, true);
        if (token.value.startsWith('<')) return current < dayBound(bare, false);
        return current >= dayBound(bare, false) && current <= dayBound(bare, true);
      }
      const target = this.parseSize(token.value);
      if (token.value.startsWith('>')) return current > target;
      if (token.value.startsWith('<')) return current < target;
      return current === target;
    }
    return this.fieldText(token.field, msg, options).toLowerCase().includes(value);
  }

  static levenshtein(a, b) {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        matrix[i][j] = b[i - 1] === a[j - 1]
          ? matrix[i - 1][j - 1]
          : Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
      }
    }
    return matrix[b.length][a.length];
  }

  static parseSize(val) {
    const clean = String(val).replace(/[<>=]/g, '');
    const match = clean.match(/^(\d+(?:\.\d+)?)\s*(k|m|g|kb|mb|gb)?$/i);
    if (!match) throw new Error(`Not a number: ${val}`);
    const num = parseFloat(match[1]);
    const unit = (match[2] || '').toLowerCase();
    if (unit === 'k' || unit === 'kb') return num * 1024;
    if (unit === 'm' || unit === 'mb') return num * 1024 * 1024;
    if (unit === 'g' || unit === 'gb') return num * 1024 * 1024 * 1024;
    return num;
  }

  static getSyntaxHelp() {
    return {
      operators: {
        'AND': 'Both terms must match (default when space-separated)',
        'OR': 'Either term matches',
        'NOT / -': 'Exclude results matching term',
        '()': 'Group sub-expressions',
      },
      types: {
        '"phrase"': 'Exact phrase match',
        '"term1 term2"~N': 'Proximity: terms within N words of each other',
        '/regex/flags': 'Regular expression (JavaScript syntax)',
        'term*': 'Wildcard: * matches any characters, ? matches one',
        'term~': 'Fuzzy match (Levenshtein distance <= 2)',
      },
      fields: {
        'from:': 'Search sender',
        'to: cc: bcc:': 'Search recipients',
        'subject:': 'Search subject line only',
        'body:': 'Search message body only',
        'folder:': 'Filter by folder name',
        'messageid:': 'Search the Message-ID',
        'attachment: filename:': 'Search attachment names',
        'sent:[2026/01/01 TO 2026/06/30]': 'Date range (also date: and received: for the server date; one day or >, < also work)',
        'size:>N size:[N TO M]': 'Size in bytes (supports K/M/G)',
        'attachmentcount:[1 TO 5]': 'Number of attachments',
        'has:attachment': 'Has at least one attachment',
        'is:encrypted is:signed': 'S/MIME or PGP protected',
        'hash:': 'Search by SHA-256 hash prefix',
      },
      examples: [
        'contract AND NOT draft',
        'from:john OR from:jane',
        '"wire transfer"~5',
        '/invoice.*\\d{4}/i',
        'subject:"quarterly report" from:finance',
        'size:>1M has:attachment',
        'sent:[2026/01/01 TO 2026/03/31] (is:encrypted OR is:signed)',
      ],
    };
  }
}
