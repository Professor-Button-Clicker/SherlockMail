// Conversation threading shared by the Threading analysis and the per-thread PDF report, so both group the
// same messages the same way. Messages are joined by Message-ID, In-Reply-To and References (RFC 5322);
// a message joined to nothing is grouped with others of the same normalised subject (JWZ fallback).
export function normalizeSubject(subject) {
  return (subject || '').replace(/^((Re|Fwd|Fw)\s*:\s*)+/i, '').trim().toLowerCase();
}

// Returns every message in exactly one group: { messages (oldest first), threadedBy: 'headers' | 'subject' | 'single' }.
export function threadMessages(messages) {
  const parent = new Map(messages.map(m => [m.id, m.id]));
  const find = (id) => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(id) !== root) { const next = parent.get(id); parent.set(id, root); id = next; }
    return root;
  };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  const byMessageId = new Map();
  for (const m of messages) {
    const mid = m.message_id || m.messageId;
    if (!mid) continue;
    if (!byMessageId.has(mid)) byMessageId.set(mid, m.id);
    else union(byMessageId.get(mid), m.id);
  }
  for (const m of messages) {
    const inReplyTo = m.in_reply_to || m.inReplyTo;
    const related = new Set(inReplyTo ? [inReplyTo] : []);
    try {
      const headers = typeof m.headers_json === 'string' ? JSON.parse(m.headers_json || '{}') : (m.headers || {});
      const refs = headers.references;
      for (const r of Array.isArray(refs) ? refs : String(refs || '').split(/\s+/)) if (r) related.add(r);
    } catch { /* a message with unreadable headers still threads by In-Reply-To */ }
    for (const ref of related) if (byMessageId.has(ref)) union(m.id, byMessageId.get(ref));
  }
  const byRoot = new Map();
  for (const m of messages) {
    const root = find(m.id);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(m);
  }
  const sortByDate = group => [...group].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const groups = [];
  const bySubject = new Map();
  for (const group of byRoot.values()) {
    if (group.length > 1) { groups.push({ messages: sortByDate(group), threadedBy: 'headers' }); continue; }
    const key = normalizeSubject(group[0].subject);
    if (key && key !== '(no subject)') {
      if (!bySubject.has(key)) bySubject.set(key, []);
      bySubject.get(key).push(group[0]);
    } else groups.push({ messages: group, threadedBy: 'single' });
  }
  for (const group of bySubject.values()) groups.push({ messages: sortByDate(group), threadedBy: group.length > 1 ? 'subject' : 'single' });
  return groups;
}
