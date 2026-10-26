import crypto from 'crypto';

export class InlineSearchEngine {

  static search(messages, query, options = {}) {
    if (!query || !query.trim()) return { results: messages, parsed: null, stats: {} };

    const parsed = this.parseQuery(query);
    const startTime = Date.now();
    const results = messages.filter(msg => this.matchMessage(msg, parsed, options));
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

  static parseQuery(query) {
    const tokens = [];
    let i = 0;

    while (i < query.length) {
      while (i < query.length && query[i] === ' ') i++;
      if (i >= query.length) break;

      if (query.substring(i, i + 3).toUpperCase() === 'AND') {
        if (i + 3 >= query.length || query[i + 3] === ' ') { tokens.push({ type: 'AND' }); i += 3; continue; }
      }
      if (query.substring(i, i + 2).toUpperCase() === 'OR') {
        if (i + 2 >= query.length || query[i + 2] === ' ') { tokens.push({ type: 'OR' }); i += 2; continue; }
      }
      if (query.substring(i, i + 3).toUpperCase() === 'NOT') {
        if (i + 3 >= query.length || query[i + 3] === ' ') { tokens.push({ type: 'NOT' }); i += 3; continue; }
      }

      if (query[i] === '-' && i + 1 < query.length && query[i + 1] !== ' ') {
        tokens.push({ type: 'NOT' });
        i++;
        continue;
      }

      if (query[i] === '(') { tokens.push({ type: 'LPAREN' }); i++; continue; }
      if (query[i] === ')') { tokens.push({ type: 'RPAREN' }); i++; continue; }

      if (query[i] === '/' && query.indexOf('/', i + 1) > i) {
        const end = query.indexOf('/', i + 1);
        let flags = '';
        let fi = end + 1;
        while (fi < query.length && /[gimsuy]/.test(query[fi])) { flags += query[fi]; fi++; }
        tokens.push({ type: 'REGEX', pattern: query.substring(i + 1, end), flags });
        i = fi;
        continue;
      }

      if (query[i] === '"') {
        const end = query.indexOf('"', i + 1);
        if (end > i) {
          let phrase = query.substring(i + 1, end);
          let proximity = 0;
          let pi = end + 1;
          if (pi < query.length && query[pi] === '~') {
            pi++;
            let num = '';
            while (pi < query.length && /\d/.test(query[pi])) { num += query[pi]; pi++; }
            proximity = parseInt(num) || 5;
          }
          if (proximity > 0) {
            tokens.push({ type: 'PROXIMITY', terms: phrase.split(/\s+/), distance: proximity });
          } else {
            tokens.push({ type: 'PHRASE', value: phrase });
          }
          i = pi;
          continue;
        }
      }

      const fieldMatch = query.substring(i).match(/^(\w+):/);
      if (fieldMatch) {
        const field = fieldMatch[1].toLowerCase();
        i += fieldMatch[0].length;
        while (i < query.length && query[i] === ' ') i++;

        let value = '';
        if (query[i] === '"') {
          const end = query.indexOf('"', i + 1);
          if (end > i) { value = query.substring(i + 1, end); i = end + 1; }
        } else {
          const start = i;
          while (i < query.length && query[i] !== ' ' && query[i] !== ')') i++;
          value = query.substring(start, i);
        }
        tokens.push({ type: 'FIELD', field, value });
        continue;
      }

      const start = i;
      while (i < query.length && query[i] !== ' ' && query[i] !== ')' && query[i] !== '(') i++;
      let term = query.substring(start, i);

      if (term.endsWith('~')) {
        tokens.push({ type: 'FUZZY', value: term.slice(0, -1), distance: 2 });
      } else if (term.includes('*') || term.includes('?')) {
        tokens.push({ type: 'WILDCARD', pattern: term });
      } else {
        tokens.push({ type: 'TERM', value: term });
      }
    }

    return tokens;
  }

  static matchMessage(msg, tokens, options) {
    const getText = () => {
      const parts = [
        msg.subject || '',
        msg.from_address || msg.fromAddress || '',
        msg.body_text || msg.bodyText || '',
      ];
      try {
        const to = typeof msg.to_addresses === 'string' ? JSON.parse(msg.to_addresses) : (msg.to_addresses || msg.toAddresses || []);
        if (Array.isArray(to)) parts.push(to.join(' '));
      } catch {}
      try {
        const cc = typeof msg.cc_addresses === 'string' ? JSON.parse(msg.cc_addresses) : (msg.cc_addresses || msg.ccAddresses || []);
        if (Array.isArray(cc)) parts.push(cc.join(' '));
      } catch {}
      return parts.join(' ');
    };

    const getField = (field) => {
      switch (field) {
        case 'from': case 'sender': return msg.from_address || msg.fromAddress || '';
        case 'to': case 'recipient': {
          const v = msg.to_addresses || msg.toAddresses || [];
          return (typeof v === 'string' ? v : JSON.stringify(v));
        }
        case 'cc': {
          const v = msg.cc_addresses || msg.ccAddresses || [];
          return (typeof v === 'string' ? v : JSON.stringify(v));
        }
        case 'subject': return msg.subject || '';
        case 'body': return msg.body_text || msg.bodyText || '';
        case 'date': return msg.date || '';
        case 'folder': return msg.folder || '';
        case 'hash': return msg.hash_sha256 || msg.hashSha256 || '';
        case 'size': return String(msg.size || 0);
        case 'attachment': case 'filename': return '';
        default: return getText();
      }
    };

    let result = null;
    let pendingOp = null;
    let negate = false;
    let i = 0;

    while (i < tokens.length) {
      const token = tokens[i];
      let match;

      switch (token.type) {
        case 'AND': pendingOp = 'AND'; i++; continue;
        case 'OR': pendingOp = 'OR'; i++; continue;
        case 'NOT': negate = !negate; i++; continue;
        case 'LPAREN': {
          let depth = 1;
          let j = i + 1;
          while (j < tokens.length && depth > 0) {
            if (tokens[j].type === 'LPAREN') depth++;
            if (tokens[j].type === 'RPAREN') depth--;
            j++;
          }
          match = this.matchMessage(msg, tokens.slice(i + 1, j - 1), options);
          i = j;
          break;
        }
        case 'RPAREN': i++; continue;

        case 'TERM': match = getText().toLowerCase().includes(token.value.toLowerCase()); i++; break;
        case 'PHRASE': match = getText().toLowerCase().includes(token.value.toLowerCase()); i++; break;
        case 'REGEX': {
          try {
            const re = new RegExp(token.pattern, token.flags || 'i');
            match = re.test(getText());
          } catch { match = false; }
          i++;
          break;
        }
        case 'WILDCARD': {
          const re = new RegExp('^' + token.pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
          match = getText().split(/\s+/).some(w => re.test(w));
          i++;
          break;
        }
        case 'FUZZY': {
          const words = getText().toLowerCase().split(/\s+/);
          match = words.some(w => this.levenshtein(w, token.value.toLowerCase()) <= token.distance);
          i++;
          break;
        }
        case 'PROXIMITY': {
          const text = getText().toLowerCase();
          const words = text.split(/\s+/);
          const [t1, t2] = token.terms.map(t => t.toLowerCase());
          match = false;
          for (let wi = 0; wi < words.length; wi++) {
            if (words[wi].includes(t1)) {
              for (let wj = Math.max(0, wi - token.distance); wj < Math.min(words.length, wi + token.distance + 1); wj++) {
                if (wi !== wj && words[wj].includes(t2)) { match = true; break; }
              }
            }
            if (match) break;
          }
          i++;
          break;
        }
        case 'FIELD': {
          const fieldText = getField(token.field);
          if (token.field === 'size') {
            const size = msg.size || 0;
            const val = this.parseSize(token.value);
            match = token.value.startsWith('>') ? size > val : token.value.startsWith('<') ? size < val : size === val;
          } else {
            match = fieldText.toLowerCase().includes(token.value.toLowerCase());
          }
          i++;
          break;
        }
        default: i++; continue;
      }

      if (negate) { match = !match; negate = false; }

      if (result === null) {
        result = match;
      } else if (pendingOp === 'OR') {
        result = result || match;
      } else {
        result = result && match;
      }
      pendingOp = null;
    }

    return result !== null ? result : true;
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
    const clean = val.replace(/[<>]/g, '');
    const match = clean.match(/^(\d+(?:\.\d+)?)\s*(k|m|g|kb|mb|gb)?$/i);
    if (!match) return parseInt(clean) || 0;
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
        'from:': 'Search sender address',
        'to:': 'Search recipient address',
        'cc:': 'Search CC addresses',
        'subject:': 'Search subject line only',
        'body:': 'Search message body only',
        'folder:': 'Filter by folder name',
        'date:': 'Filter by date string',
        'size:>N': 'Messages larger than N bytes (supports K/M/G)',
        'hash:': 'Search by SHA-256 hash prefix',
      },
      examples: [
        'contract AND NOT draft',
        'from:john OR from:jane',
        '"wire transfer"~5',
        '/invoice.*\\d{4}/i',
        'subject:"quarterly report" from:finance',
        'size:>1M has:attachment',
      ],
    };
  }
}
