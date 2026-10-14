export class InlineSearch {
  constructor(options = {}) {
    this.normalizeAccents = options.normalizeAccents || false;
    this.searchAttachments = options.searchAttachments !== false;
    this.metadataOnly = options.metadataOnly || false;
  }

  search(messages, query) {
    const parsed = this.#parseQuery(query);
    return messages.filter(msg => this.#matchMessage(msg, parsed));
  }

  #parseQuery(query) {
    const tokens = [];
    let remaining = query.trim();

    while (remaining.length > 0) {
      remaining = remaining.trim();
      if (!remaining) break;

      if (remaining.startsWith('NOT ')) {
        remaining = remaining.substring(4);
        const next = this.#parseNextToken(remaining);
        next.token.negated = true;
        tokens.push(next.token);
        remaining = next.remaining;
      } else if (remaining.startsWith('OR ')) {
        remaining = remaining.substring(3);
        if (tokens.length > 0) tokens[tokens.length - 1].orNext = true;
      } else if (remaining.startsWith('AND ')) {
        remaining = remaining.substring(4);
      } else {
        const next = this.#parseNextToken(remaining);
        tokens.push(next.token);
        remaining = next.remaining;
      }
    }
    return tokens;
  }

  #parseNextToken(str) {
    str = str.trim();

    const fieldMatch = str.match(/^(\w+):/);
    if (fieldMatch) {
      const field = fieldMatch[1].toLowerCase();
      str = str.substring(fieldMatch[0].length);
      const value = this.#extractValue(str);
      return {
        token: { type: 'field', field, value: value.value, ...this.#parseModifiers(value.value) },
        remaining: value.remaining
      };
    }

    if (str.startsWith('/') && str.indexOf('/', 1) > 0) {
      const end = str.indexOf('/', 1);
      const pattern = str.substring(1, end);
      return {
        token: { type: 'regex', pattern: new RegExp(pattern, 'i') },
        remaining: str.substring(end + 1)
      };
    }

    const value = this.#extractValue(str);
    return {
      token: { type: 'text', value: value.value, ...this.#parseModifiers(value.value) },
      remaining: value.remaining
    };
  }

  #extractValue(str) {
    str = str.trim();
    if (str.startsWith('"')) {
      const end = str.indexOf('"', 1);
      if (end > 0) {
        return { value: str.substring(1, end), remaining: str.substring(end + 1), exact: true };
      }
    }
    if (str.startsWith('[')) {
      const end = str.indexOf(']');
      if (end > 0) {
        return { value: str.substring(0, end + 1), remaining: str.substring(end + 1) };
      }
    }
    const spaceIdx = str.search(/\s/);
    if (spaceIdx > 0) {
      return { value: str.substring(0, spaceIdx), remaining: str.substring(spaceIdx) };
    }
    return { value: str, remaining: '' };
  }

  #parseModifiers(value) {
    const mods = {};
    if (value.endsWith('~')) {
      mods.fuzzy = true;
      mods.value = value.slice(0, -1);
    }
    const proximityMatch = value.match(/"(.+)"~(\d+)/);
    if (proximityMatch) {
      mods.proximity = parseInt(proximityMatch[2]);
      mods.value = proximityMatch[1];
    }
    if (value.includes('*') || value.includes('?')) {
      mods.wildcard = true;
    }
    return mods;
  }

  #matchMessage(msg, tokens) {
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      let match = this.#evaluateToken(msg, token);
      if (token.negated) match = !match;

      if (token.orNext && i + 1 < tokens.length) {
        const nextMatch = this.#evaluateToken(msg, tokens[i + 1]);
        if (!match && !nextMatch) return false;
        i++;
        continue;
      }

      if (!match) return false;
    }
    return true;
  }

  #evaluateToken(msg, token) {
    if (token.type === 'regex') {
      return this.#searchAllFields(msg, text => token.pattern.test(text));
    }

    const value = this.#normalizeText(token.value || '');

    if (token.type === 'field') {
      const fieldValue = this.#getFieldValue(msg, token.field);
      if (fieldValue === null) return false;

      if (token.field === 'earliestdate' || token.field === 'latestdate' ||
          token.field === 'sent' || token.field === 'received') {
        return this.#matchDateRange(fieldValue, value);
      }

      if (token.field === 'attachmentcount') {
        return this.#matchRange(parseInt(fieldValue) || 0, value);
      }

      return this.#matchText(this.#normalizeText(fieldValue), value, token);
    }

    return this.#searchAllFields(msg, text =>
      this.#matchText(this.#normalizeText(text), value, token)
    );
  }

  #getFieldValue(msg, field) {
    const map = {
      from: 'from_address',
      to: 'to_addresses',
      cc: 'cc_addresses',
      bcc: 'bcc_addresses',
      subject: 'subject',
      messageid: 'message_id',
      attachmentcount: 'attachment_count',
      sent: 'date',
      received: 'date',
      earliestdate: 'date',
      latestdate: 'date'
    };
    const dbField = map[field] || field;
    return msg[dbField] ?? null;
  }

  #searchAllFields(msg, matcher) {
    const fields = ['subject', 'from_address', 'to_addresses', 'cc_addresses', 'bcc_addresses', 'message_id'];
    return fields.some(f => msg[f] && matcher(String(msg[f])));
  }

  #matchText(haystack, needle, token = {}) {
    if (token.wildcard) {
      const pattern = needle.replace(/\*/g, '.*').replace(/\?/g, '.');
      return new RegExp(pattern, 'i').test(haystack);
    }
    if (token.fuzzy) {
      return this.#fuzzyMatch(haystack, needle, 2);
    }
    return haystack.toLowerCase().includes(needle.toLowerCase());
  }

  #matchDateRange(fieldDate, rangeStr) {
    const match = rangeStr.match(/\[(.+)\s+TO\s+(.+)\]/i);
    if (!match) return false;
    const start = new Date(match[1].replace(/\//g, '-'));
    const end = new Date(match[2].replace(/\//g, '-'));
    const date = new Date(fieldDate);
    return date >= start && date <= end;
  }

  #matchRange(num, rangeStr) {
    const match = rangeStr.match(/\[(\d+)\s+TO\s+(\d+)\]/i);
    if (!match) return false;
    return num >= parseInt(match[1]) && num <= parseInt(match[2]);
  }

  #normalizeText(text) {
    if (!text) return '';
    text = String(text);
    if (this.normalizeAccents) {
      text = text.normalize('NFD').replace(/[̀-ͯ]/g, '');
    }
    return text;
  }

  #fuzzyMatch(haystack, needle, maxDistance) {
    const words = haystack.toLowerCase().split(/\s+/);
    return words.some(word => this.#levenshtein(word, needle.toLowerCase()) <= maxDistance);
  }

  #levenshtein(a, b) {
    const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
      Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
    );
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j - 1] + cost
        );
      }
    }
    return matrix[a.length][b.length];
  }
}
