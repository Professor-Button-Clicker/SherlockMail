// One collection query (from the wizard's Query step) applied the same way on every protocol.
// In-place: criteria the server can evaluate reliably go to the server; the rest are checked on each
// downloaded message, and messages that fail them are logged (with hashes) instead of kept as evidence.
// In-line: everything in the selected folders is collected; the query only tags which messages match.

const TEXT_FIELDS = ['from', 'to', 'subject', 'keywords'];
const MAX_TERMS = 50;
const MAX_TERM_LENGTH = 200;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

const LABELS = {
  dateRange: 'Date range',
  from: 'From',
  to: 'To / Cc',
  subject: 'Subject',
  keywords: 'Keywords (body)',
  hasAttachments: 'Has attachments',
  unreadOnly: 'Unread only',
};

function parseYmd(value, label) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (!YMD.test(s)) throw new Error(`${label} must be a date (YYYY-MM-DD)`);
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) throw new Error(`${label} is not a valid date: ${s}`);
  return s;
}

function terms(value, label) {
  const list = (Array.isArray(value) ? value : String(value ?? '').split(','))
    .map(t => String(t).trim())
    .filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const t of list) {
    if (t.length > MAX_TERM_LENGTH) throw new Error(`${label} term is too long (max ${MAX_TERM_LENGTH} characters)`);
    const k = t.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(t); }
  }
  if (out.length > MAX_TERMS) throw new Error(`${label} has too many terms (max ${MAX_TERMS})`);
  return out;
}

// Local midnight of the examiner's machine, which is where the dates were entered.
export function dayStart(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function nextDay(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return dt.toISOString().slice(0, 10);
}

export function normalizeQuery(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const q = {
    type: raw.type === 'in-line' ? 'in-line' : 'in-place',
    dateFrom: parseYmd(raw.dateFrom, 'Date From'),
    dateTo: parseYmd(raw.dateTo, 'Date To'),
    from: terms(raw.from, 'From Address'),
    to: terms(raw.to, 'To Address'),
    subject: terms(raw.subject, 'Subject'),
    keywords: terms(raw.keywords, 'Keywords'),
    hasAttachments: raw.hasAttachments === true,
    unreadOnly: raw.unreadOnly === true,
  };
  if (q.dateFrom && q.dateTo && q.dateFrom > q.dateTo) throw new Error('Date From is after Date To');
  return activeKeys(q).length ? q : null;
}

export function activeKeys(q) {
  if (!q) return [];
  const keys = [];
  if (q.dateFrom || q.dateTo) keys.push('dateRange');
  for (const f of TEXT_FIELDS) if (q[f]?.length) keys.push(f);
  if (q.hasAttachments) keys.push('hasAttachments');
  if (q.unreadOnly) keys.push('unreadOnly');
  return keys;
}

export function describeQuery(q) {
  if (!q) return 'None (all messages in the selected folders)';
  const parts = [];
  if (q.dateFrom || q.dateTo) parts.push(`Date ${q.dateFrom || 'any'} to ${q.dateTo || 'any'} (inclusive)`);
  const list = arr => arr.map(t => `"${t}"`).join(', ');
  if (q.from.length) parts.push(`From contains any of ${list(q.from)}`);
  if (q.to.length) parts.push(`To/Cc contains any of ${list(q.to)}`);
  if (q.subject.length) parts.push(`Subject contains any of ${list(q.subject)}`);
  if (q.keywords.length) parts.push(`Body contains any of ${list(q.keywords)}`);
  if (q.hasAttachments) parts.push('Has attachments');
  if (q.unreadOnly) parts.push('Unread only');
  return `${q.type === 'in-line' ? 'In-line' : 'In-place'}: ${parts.join('; ')}`;
}

export function describeKeys(keys) {
  return keys.map(k => LABELS[k] || k).join(', ');
}

function gmailTerm(t) {
  return /[\s(){}"]/.test(t) ? `"${t.replace(/"/g, '')}"` : t;
}

function gmailQuery(q) {
  const parts = [];
  if (q.dateFrom) parts.push(`after:${Math.floor(dayStart(q.dateFrom).getTime() / 1000) - 1}`);
  if (q.dateTo) parts.push(`before:${Math.floor(dayStart(nextDay(q.dateTo)).getTime() / 1000)}`);
  const anyOf = (op, list) => {
    const items = list.map(t => (op ? `${op}:${gmailTerm(t)}` : gmailTerm(t)));
    return items.length === 1 ? items[0] : `{${items.join(' ')}}`;
  };
  if (q.from.length) parts.push(anyOf('from', q.from));
  if (q.to.length) parts.push(`{${[...q.to.map(t => `to:${gmailTerm(t)}`), ...q.to.map(t => `cc:${gmailTerm(t)}`)].join(' ')}}`);
  if (q.subject.length) parts.push(anyOf('subject', q.subject));
  if (q.keywords.length) parts.push(anyOf('', q.keywords));
  if (q.hasAttachments) parts.push('has:attachment');
  if (q.unreadOnly) parts.push('is:unread');
  return parts.join(' ');
}

// IMAP takes one OR group per search object, so at most one multi-branch text field goes to the server;
// any other text field is checked on the downloaded message.
function imapCriteria(q) {
  const criteria = {};
  const serverKeys = [];
  if (q.dateFrom || q.dateTo) {
    if (q.dateFrom) criteria.since = q.dateFrom;
    if (q.dateTo) criteria.before = nextDay(q.dateTo);
    serverKeys.push('dateRange');
  }
  if (q.unreadOnly) { criteria.seen = false; serverKeys.push('unreadOnly'); }
  let orUsed = false;
  const branches = {
    from: q.from.map(t => ({ from: t })),
    to: q.to.flatMap(t => [{ to: t }, { cc: t }]),
    subject: q.subject.map(t => ({ subject: t })),
    keywords: q.keywords.map(t => ({ body: t })),
  };
  const single = { from: 'from', subject: 'subject', keywords: 'body' };
  for (const f of TEXT_FIELDS) {
    const b = branches[f];
    if (!b.length) continue;
    if (b.length === 1 && single[f]) {
      criteria[single[f]] = q[f][0];
      serverKeys.push(f);
    } else if (!orUsed) {
      criteria.or = b;
      orUsed = true;
      serverKeys.push(f);
    }
  }
  return { criteria: Object.keys(criteria).length ? criteria : undefined, serverKeys };
}

function graphFilter(q) {
  const parts = [];
  const serverKeys = [];
  if (q.dateFrom || q.dateTo) {
    if (q.dateFrom) parts.push(`receivedDateTime ge ${dayStart(q.dateFrom).toISOString()}`);
    if (q.dateTo) parts.push(`receivedDateTime lt ${dayStart(nextDay(q.dateTo)).toISOString()}`);
    serverKeys.push('dateRange');
  }
  if (q.hasAttachments) { parts.push('hasAttachments eq true'); serverKeys.push('hasAttachments'); }
  if (q.unreadOnly) { parts.push('isRead eq false'); serverKeys.push('unreadOnly'); }
  return { criteria: parts.length ? { filter: parts.join(' and ') } : undefined, serverKeys };
}

function ewsRestriction(q) {
  const conds = [];
  const serverKeys = [];
  const cmp = (op, field, value) => `<t:${op}><t:FieldURI FieldURI="${field}"/><t:FieldURIOrConstant><t:Constant Value="${value}"/></t:FieldURIOrConstant></t:${op}>`;
  if (q.dateFrom || q.dateTo) {
    if (q.dateFrom) conds.push(cmp('IsGreaterThanOrEqualTo', 'item:DateTimeReceived', dayStart(q.dateFrom).toISOString()));
    if (q.dateTo) conds.push(cmp('IsLessThan', 'item:DateTimeReceived', dayStart(nextDay(q.dateTo)).toISOString()));
    serverKeys.push('dateRange');
  }
  if (q.hasAttachments) { conds.push(cmp('IsEqualTo', 'item:HasAttachments', 'true')); serverKeys.push('hasAttachments'); }
  if (q.unreadOnly) { conds.push(cmp('IsEqualTo', 'message:IsRead', 'false')); serverKeys.push('unreadOnly'); }
  if (!conds.length) return { criteria: undefined, serverKeys };
  const body = conds.length === 1 ? conds[0] : `<t:And>${conds.join('')}</t:And>`;
  return { criteria: { restriction: `<m:Restriction>${body}</m:Restriction>` }, serverKeys };
}

// Protocols whose downloaded messages carry read/unread state.
const FLAG_PROTOCOLS = new Set(['imap', 'gmail_api']);

/**
 * How a query runs on one protocol. server: protocol-native criteria passed to enumerate();
 * localKeys: criteria checked on each downloaded message (in-place); inlineKeys: criteria used to
 * tag matches when the query is in-line; unsupported: criteria this protocol cannot evaluate at all.
 */
export function planQuery(protocol, q) {
  const plan = { query: q, server: undefined, serverKeys: [], localKeys: [], inlineKeys: [], unsupported: [], notes: [] };
  if (!q) return plan;
  const keys = activeKeys(q);
  const canReadFlags = FLAG_PROTOCOLS.has(protocol);

  if (q.type === 'in-line') {
    plan.inlineKeys = keys.filter(k => k !== 'unreadOnly' || canReadFlags);
    if (keys.includes('unreadOnly') && !canReadFlags) plan.unsupported.push('unreadOnly');
    plan.notes.push('In-line query: every message in the selected folders is collected; matches are tagged after download.');
    return plan;
  }

  let native = { criteria: undefined, serverKeys: [] };
  if (protocol === 'imap') native = imapCriteria(q);
  else if (protocol === 'gmail_api') native = { criteria: gmailQuery(q) || undefined, serverKeys: keys.slice() };
  else if (protocol === 'graph') native = graphFilter(q);
  else if (protocol === 'ews') native = ewsRestriction(q);

  plan.server = native.criteria;
  plan.serverKeys = native.serverKeys;
  for (const k of keys) {
    if (plan.serverKeys.includes(k)) continue;
    if (k === 'unreadOnly' && !canReadFlags) plan.unsupported.push(k);
    else plan.localKeys.push(k);
  }
  if (plan.serverKeys.length) plan.notes.push(`Applied by the server: ${describeKeys(plan.serverKeys)}.`);
  if (plan.localKeys.length) plan.notes.push(`Checked on each downloaded message (non-matching messages are logged, not kept): ${describeKeys(plan.localKeys)}.`);
  if (protocol === 'imap' && plan.serverKeys.includes('dateRange')) plan.notes.push('IMAP date filtering uses the server\'s received date at day granularity.');
  return plan;
}

function includesAny(haystack, list) {
  const h = String(haystack || '').toLowerCase();
  return list.some(t => h.includes(t.toLowerCase()));
}

// The date a message was received, as every server's own date filter uses it (IMAP INTERNALDATE, Gmail
// internalDate, Graph receivedDateTime, EWS DateTimeReceived); the Date header only when the protocol
// gives no received date (POP3).
function messageDate(msg) {
  const d = new Date(msg.internalDate || msg.date || NaN);
  return isNaN(d.getTime()) ? null : d;
}

// The To and Cc headers as written, display names included (as a server's TO/CC search sees them),
// plus the bare addresses.
function recipientText(msg) {
  const text = v => (v && typeof v === 'object' ? v.text || '' : String(v || ''));
  const h = msg.headers || {};
  return [text(h.to), text(h.cc), ...(msg.toAddresses || []), ...(msg.ccAddresses || [])].join(' ');
}

// IMAP: unread means no \Seen flag. Gmail API: the flags are label IDs and unread is the UNREAD label.
function isUnread(msg, protocol) {
  const flags = Array.isArray(msg.flags) ? msg.flags.map(f => String(f).toLowerCase()) : null;
  if (!flags) return null;
  if (protocol === 'imap') return !flags.includes('\\seen');
  if (protocol === 'gmail_api') return flags.includes('unread');
  return null;
}

export function matchesLocally(msg, q, keys, protocol) {
  const failed = [];
  for (const k of keys) {
    let ok = true;
    switch (k) {
      case 'dateRange': {
        const d = messageDate(msg);
        if (!d) ok = false;
        else {
          if (q.dateFrom && d < dayStart(q.dateFrom)) ok = false;
          if (q.dateTo && d >= dayStart(nextDay(q.dateTo))) ok = false;
        }
        break;
      }
      case 'from': ok = includesAny(msg.fromAddress, q.from); break;
      case 'to': ok = includesAny(recipientText(msg), q.to); break;
      case 'subject': ok = includesAny(msg.subject, q.subject); break;
      case 'keywords': ok = includesAny(`${msg.bodyText || ''}\n${msg.bodyHtml ? msg.bodyHtml.replace(/<[^>]+>/g, ' ') : ''}`, q.keywords); break;
      case 'hasAttachments': {
        const atts = msg.attachments;
        ok = Array.isArray(atts) ? atts.some(a => !a.isInline) : !!msg.hasAttachments;
        break;
      }
      case 'unreadOnly': ok = isUnread(msg, protocol) === true; break;
      default: break;
    }
    if (!ok) failed.push(k);
  }
  return { match: failed.length === 0, failed };
}
