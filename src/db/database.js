import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

const __dirname = dirname(fileURLToPath(import.meta.url));

let db;

function getDataDir() {
  if (process.env.SHERLOCKMAIL_DATA_DIR) return process.env.SHERLOCKMAIL_DATA_DIR;
  return join(__dirname, '..', '..', 'data');
}

export function getDb() {
  if (!db) {
    const dataDir = getDataDir();
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    const dbPath = join(dataDir, 'fmc.sqlite');
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');
    initSchema();
  }
  return db;
}

function initSchema() {
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  migrate();
}

function migrate() {
  const cols = (table) => {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all();
    return new Set(rows.map(r => r.name));
  };
  const addCol = (table, col, type) => {
    if (!cols(table).has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  };
  addCol('acquisitions', 'folders_json', 'TEXT');
  addCol('messages', 'hash_sha1', 'TEXT');
  addCol('messages', 'hash_sha384', 'TEXT');
  addCol('attachments', 'hash_sha1', 'TEXT');
  addCol('attachments', 'hash_sha384', 'TEXT');
  addCol('projects', 'proxy_config', 'TEXT');
  addCol('projects', 'notification_config', 'TEXT');
  addCol('acquisitions', 'health_events_json', 'TEXT');
  addCol('acquisitions', 'pre_search_id', 'TEXT');
  addCol('acquisitions', 'is_differential', 'INTEGER DEFAULT 0');
  addCol('acquisitions', 'source_acquisition_id', 'TEXT');
  addCol('projects', 'evidence_id', 'TEXT');
  addCol('projects', 'custodian_name', 'TEXT');
  addCol('projects', 'evidence_description', 'TEXT');
  addCol('projects', 'client_name', 'TEXT');
  addCol('projects', 'client_matter_no', 'TEXT');
  addCol('acquisitions', 'completion_type', 'TEXT');
  addCol('acquisitions', 'session_dir', 'TEXT');
  addCol('messages', 'internal_date', 'TEXT');
  addCol('messages', 'folder_paths', 'TEXT');
  addCol('messages', 'labels', 'TEXT');
  addCol('acquisitions', 'query_json', 'TEXT');
  addCol('acquisitions', 'scope', 'TEXT');
  addCol('acquisitions', 'output_dir', 'TEXT');
  addCol('acquisitions', 'protocol', 'TEXT');
}

// A collection runs inside this process, so after a restart any acquisition still marked running was
// cut short (the app was closed, crashed, or the machine shut down). Record that instead of leaving the
// project showing "collecting" forever.
export function recoverInterruptedCollections() {
  const d = getDb();
  const running = d.prepare("SELECT id, project_id, started_at FROM acquisitions WHERE status IN ('running', 'pending')").all();
  const now = new Date().toISOString();
  for (const a of running) {
    d.prepare("UPDATE acquisitions SET status = 'failed', completion_type = 'interrupted', completed_at = ? WHERE id = ?").run(now, a.id);
    addAuditEntry(a.project_id, 'ACQUISITION_INTERRUPTED',
      'Acquisition did not finish: SherlockMail was closed or stopped while it was running',
      { acquisitionId: a.id, startedAt: a.started_at, detectedAt: now }, null, a.id);
  }
  const stuck = d.prepare("SELECT id FROM projects WHERE status = 'collecting'").all();
  for (const p of stuck) {
    d.prepare("UPDATE projects SET status = 'failed', updated_at = ? WHERE id = ?").run(now, p.id);
  }
  return { acquisitions: running.length, projects: stuck.length };
}

function rowToObj(row, columns) {
  if (!row) return null;
  if (!Array.isArray(row)) return row;
  const obj = {};
  for (let i = 0; i < columns.length; i++) obj[columns[i]] = row[i];
  return obj;
}

function computeAuditHash(entry, prevHash) {
  const data = `${prevHash || ''}|${entry.timestamp}|${entry.event_type}|${entry.description}|${JSON.stringify(entry.details)}`;
  return crypto.createHash('sha256').update(data).digest('hex');
}

// Recomputes every entry's hash from its stored content and previous-hash, so an edited entry is caught,
// and checks each entry links to the one before it. Entries written before chains were kept per project
// link to the previous entry of any project; those links are accepted.
export function verifyAuditLogChain(entries) {
  const allHashes = new Set(getDb().prepare('SELECT hash FROM audit_log').all().map(r => r.hash));
  const breaks = [];
  let legacyLinks = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const recomputed = computeAuditHash({ timestamp: e.timestamp, event_type: e.event_type, description: e.description, details: e.details }, e.prev_hash);
    if (recomputed !== e.hash) {
      breaks.push({ index: i, entryId: e.id, event: e.event_type, timestamp: e.timestamp, problem: 'Entry content no longer matches its hash: the entry was edited after it was written' });
    }
    const expectedPrev = i === 0 ? null : entries[i - 1].hash;
    if ((e.prev_hash || null) === expectedPrev) continue;
    if (e.prev_hash && allHashes.has(e.prev_hash)) { legacyLinks++; continue; }
    breaks.push({
      index: i, entryId: e.id, event: e.event_type, timestamp: e.timestamp, expected: expectedPrev, got: e.prev_hash,
      problem: e.prev_hash
        ? 'Links to an entry that is no longer in the log (an entry was deleted, or a project deleted)'
        : 'Has no link although earlier entries exist (an entry was inserted or the order changed)',
    });
  }
  return { valid: breaks.length === 0, entries: entries.length, breaks, legacyCrossProjectLinks: legacyLinks };
}

export function addAuditEntry(projectId, eventType, description, details, examiner, acquisitionId) {
  const d = getDb();
  const prev = d.prepare('SELECT hash FROM audit_log WHERE project_id = ? ORDER BY id DESC LIMIT 1').get(projectId);
  const prevHash = prev?.hash || null;
  const timestamp = new Date().toISOString();
  const entry = { timestamp, event_type: eventType, description, details: JSON.stringify(details || {}) };
  const hash = computeAuditHash(entry, prevHash);

  d.prepare(`INSERT INTO audit_log (project_id, acquisition_id, timestamp, event_type, description, details, hash, examiner, prev_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    projectId, acquisitionId || null, timestamp, eventType, description, entry.details, hash, examiner || null, prevHash
  );
  return hash;
}

export function createProject({ name, targetEmail, providerType, caseName, caseId, examinerName, agency, evidenceId, custodianName, evidenceDescription, clientName, clientMatterNo, legalAuthority, legalScope, config }) {
  const d = getDb();
  const id = uuidv4();
  const now = new Date().toISOString();
  const projectConfig = config || {};
  d.prepare(`INSERT INTO projects (id, name, target_email, provider_type, case_name, case_id, examiner_name, agency, evidence_id, custodian_name, evidence_description, client_name, client_matter_no, legal_authority, legal_scope, status, created_at, updated_at, config)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?)`).run(
    id, name, targetEmail, providerType || '', caseName || null, caseId || null,
    examinerName || null, agency || null, evidenceId || null, custodianName || null,
    evidenceDescription || null, clientName || null, clientMatterNo || null,
    legalAuthority || null, legalScope || null, now, now, JSON.stringify(projectConfig)
  );
  addAuditEntry(id, 'PROJECT_CREATED', `Project created for ${targetEmail}`, {
    targetEmail, providerType, caseId, evidenceId, custodianName
  }, examinerName);
  return { id, name, targetEmail, providerType, status: 'created', createdAt: now };
}

export function getProjects() {
  return getDb().prepare('SELECT * FROM projects ORDER BY created_at DESC').all();
}

export function getProjectsSummary() {
  const d = getDb();
  return d.prepare(`
    SELECT p.*,
      COALESCE(m.msg_count, 0) AS message_count,
      COALESCE(m.total_size, 0) AS total_size,
      COALESCE(m.attachment_total, 0) AS attachment_count,
      COALESCE(a.acq_count, 0) AS acquisition_count,
      a.last_collected,
      COALESCE(e.export_count, 0) AS export_count,
      e.last_exported
    FROM projects p
    LEFT JOIN (
      SELECT project_id,
        COUNT(*) AS msg_count,
        SUM(size) AS total_size,
        SUM(COALESCE(attachment_count, 0)) AS attachment_total
      FROM messages GROUP BY project_id
    ) m ON m.project_id = p.id
    LEFT JOIN (
      SELECT project_id,
        COUNT(*) AS acq_count,
        MAX(completed_at) AS last_collected
      FROM acquisitions GROUP BY project_id
    ) a ON a.project_id = p.id
    LEFT JOIN (
      SELECT project_id,
        COUNT(*) AS export_count,
        MAX(completed_at) AS last_exported
      FROM export_records GROUP BY project_id
    ) e ON e.project_id = p.id
    ORDER BY p.updated_at DESC
  `).all();
}

export function getProject(id) {
  return getDb().prepare('SELECT * FROM projects WHERE id = ?').get(id);
}

export function updateProjectStatus(id, status) {
  const now = new Date().toISOString();
  getDb().prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id);
}

export function updateProject(id, fields, examiner) {
  const d = getDb();
  const project = d.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!project) throw new Error('Project not found');
  const acq = d.prepare('SELECT COUNT(*) as count FROM acquisitions WHERE project_id = ? AND status = ?').get(id, 'completed');
  const postCollection = acq.count > 0;

  const allowed = ['name', 'target_email', 'provider_type', 'case_name', 'case_id', 'examiner_name', 'agency', 'legal_authority', 'legal_scope'];
  const changes = {};
  const sets = [];
  for (const key of allowed) {
    if (key in fields && fields[key] !== project[key]) {
      changes[key] = { from: project[key], to: fields[key] };
      sets.push(`${key} = ?`);
    }
  }

  const config = JSON.parse(project.config || '{}');
  const configFields = ['evidenceId', 'custodianName', 'authMethod'];
  let configChanged = false;
  for (const key of configFields) {
    if (key in fields && fields[key] !== (config[key] || '')) {
      changes[key] = { from: config[key] || '', to: fields[key] };
      config[key] = fields[key];
      configChanged = true;
    }
  }

  if (Object.keys(changes).length === 0) return project;

  const now = new Date().toISOString();
  if (configChanged) {
    sets.push('config = ?');
  }
  sets.push('updated_at = ?');
  const values = Object.keys(changes).filter(k => allowed.includes(k)).map(k => fields[k]);
  if (configChanged) values.push(JSON.stringify(config));
  values.push(now, id);
  d.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...values);

  const eventType = postCollection ? 'PROJECT_EDITED_POST_COLLECTION' : 'PROJECT_EDITED';
  const desc = postCollection
    ? `Project details modified AFTER collection completed — chain of custody impact`
    : `Project details modified`;
  addAuditEntry(id, eventType, desc, { changes, postCollection }, examiner || null);
  return d.prepare('SELECT * FROM projects WHERE id = ?').get(id);
}

// Every table that references a project (directly or through its messages, acquisitions or drive
// items), children first; with foreign keys on, missing one makes the whole delete fail.
const PROJECT_DELETE_STATEMENTS = [
  'DELETE FROM search_index WHERE message_id IN (SELECT id FROM messages WHERE project_id = ?)',
  'DELETE FROM drive_links WHERE project_id = ? OR message_id IN (SELECT id FROM messages WHERE project_id = ?)',
  'DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE project_id = ?)',
  'DELETE FROM drive_revisions WHERE drive_item_id IN (SELECT id FROM drive_items WHERE project_id = ?)',
  'DELETE FROM drive_items WHERE project_id = ?',
  'DELETE FROM folder_snapshots WHERE project_id = ? OR acquisition_id IN (SELECT id FROM acquisitions WHERE project_id = ?)',
  'DELETE FROM health_events WHERE project_id = ? OR acquisition_id IN (SELECT id FROM acquisitions WHERE project_id = ?)',
  'DELETE FROM acquisition_targets WHERE project_id = ? OR acquisition_id IN (SELECT id FROM acquisitions WHERE project_id = ?)',
  'DELETE FROM messages WHERE project_id = ?',
  'DELETE FROM folders WHERE project_id = ?',
  'DELETE FROM search_queries WHERE project_id = ?',
  'DELETE FROM export_records WHERE project_id = ?',
  'DELETE FROM qc_results WHERE project_id = ?',
  'DELETE FROM differential_ids WHERE project_id = ?',
  'DELETE FROM timestamp_records WHERE project_id = ?',
  'DELETE FROM rfc3161_timestamps WHERE project_id = ?',
  'DELETE FROM inline_searches WHERE project_id = ?',
  'DELETE FROM calendar_events WHERE project_id = ?',
  'DELETE FROM contacts WHERE project_id = ?',
  'DELETE FROM cloud_downloads WHERE project_id = ?',
  'DELETE FROM pre_acquisition_searches WHERE project_id = ?',
  'DELETE FROM smtp_settings WHERE project_id = ?',
  'DELETE FROM connectivity_tests WHERE project_id = ?',
  'DELETE FROM certificates WHERE project_id = ?',
  'DELETE FROM audit_log WHERE project_id = ?',
  'DELETE FROM acquisitions WHERE project_id = ?',
  'DELETE FROM projects WHERE id = ?',
];

export function deleteProject(id) {
  const d = getDb();
  d.exec('BEGIN');
  try {
    for (const sql of PROJECT_DELETE_STATEMENTS) {
      const params = Array((sql.match(/\?/g) || []).length).fill(id);
      d.prepare(sql).run(...params);
    }
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

export function saveFolders(projectId, folders) {
  const d = getDb();
  const stmt = d.prepare(`INSERT OR REPLACE INTO folders (id, project_id, path, name, delimiter, flags, total_messages, unseen_messages, parent_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const f of folders) {
    stmt.run(f.id || uuidv4(), projectId, f.path, f.name, f.delimiter || '/', JSON.stringify(f.flags || []),
      f.totalMessages || 0, f.unseenMessages || 0, f.parentPath || null);
  }
}

export function getFolders(projectId) {
  return getDb().prepare('SELECT * FROM folders WHERE project_id = ? ORDER BY path').all(projectId);
}

export function createAcquisition(projectId, foldersJson, opts = {}) {
  const d = getDb();
  const id = uuidv4();
  const now = new Date().toISOString();
  d.prepare(`INSERT INTO acquisitions (id, project_id, status, started_at, folders_json, query_json, scope, output_dir, protocol, is_differential)
    VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?, ?)`).run(
    id, projectId, now, JSON.stringify(foldersJson || []), opts.query ? JSON.stringify(opts.query) : null,
    opts.scope || 'email', opts.outputDir || null, opts.protocol || null, opts.differential ? 1 : 0
  );
  addAuditEntry(projectId, 'ACQUISITION_STARTED', `Acquisition started (${opts.scope || 'email'}${opts.differential ? ', differential' : ''})`, {
    acquisitionId: id, folders: foldersJson, protocol: opts.protocol || null, scope: opts.scope || 'email',
    differential: !!opts.differential, query: opts.queryDescription || null, outputDir: opts.outputDir || null,
    saveAttachmentFiles: !!opts.attachmentFiles, downloadLinkedFiles: !!opts.linkedFiles,
  }, opts.examiner || null, id);
  return id;
}

const stmtCache = new Map();
function cachedStmt(sql) {
  let s = stmtCache.get(sql);
  if (!s) { s = getDb().prepare(sql); stmtCache.set(sql, s); }
  return s;
}

const SAVE_MESSAGE_SQL = `INSERT OR REPLACE INTO messages (id, acquisition_id, project_id, uid, service_id, folder, subject, from_address, to_addresses, cc_addresses, bcc_addresses, date, message_id, in_reply_to, size, flags, has_attachments, attachment_count, content_type, hash_md5, hash_sha256, hash_sha512, eml_path, acquired_at, headers_json, is_encrypted, is_signed, body_text, body_html, internal_date, folder_paths, labels)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

// node:sqlite refuses undefined; imported messages, for example, have no acquisition.
const bindable = values => values.map(v => (v === undefined ? null : v));

export function saveMessage(msg) {
  const id = msg.id || uuidv4();
  cachedStmt(SAVE_MESSAGE_SQL).run(...bindable([
    id, msg.acquisitionId, msg.projectId, msg.uid || null, msg.serviceId || null,
    msg.folder, msg.subject, msg.fromAddress, JSON.stringify(msg.toAddresses || []),
    JSON.stringify(msg.ccAddresses || []), JSON.stringify(msg.bccAddresses || []),
    msg.date, msg.messageId || null, msg.inReplyTo || null, msg.size || 0,
    JSON.stringify(msg.flags || []), msg.hasAttachments ? 1 : 0, msg.attachmentCount || 0,
    msg.contentType || 'text/plain', msg.hashMd5 || null, msg.hashSha256 || null,
    msg.hashSha512 || null, msg.emlPath || null, new Date().toISOString(),
    JSON.stringify(msg.headers || {}), msg.isEncrypted ? 1 : 0, msg.isSigned ? 1 : 0,
    msg.bodyText || null, msg.bodyHtml || null, msg.internalDate || null,
    JSON.stringify(msg.folderPaths || [msg.folder]), msg.gmailLabels ? JSON.stringify(msg.gmailLabels) : null,
  ]));
  return id;
}

// One transaction per batch: per-row autocommit costs a WAL sync for every message.
export function saveMessagesBatch(msgs) {
  const d = getDb();
  d.exec('BEGIN');
  try {
    for (const msg of msgs) {
      saveMessage(msg);
      for (const att of msg.attachments || []) saveAttachment({ ...att, messageId: msg.id });
    }
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

export function getProjectMessageKeys(projectId) {
  return getDb().prepare('SELECT message_id, hash_sha256 FROM messages WHERE project_id = ?').all(projectId);
}

export function getMessages(projectId, { folder, limit, offset, search } = {}) {
  const d = getDb();
  let sql = 'SELECT * FROM messages WHERE project_id = ?';
  const params = [projectId];
  if (folder) { sql += ' AND folder = ?'; params.push(folder); }
  if (search) {
    sql += ' AND (subject LIKE ? OR from_address LIKE ? OR body_text LIKE ?)';
    const s = `%${search}%`;
    params.push(s, s, s);
  }
  sql += ' ORDER BY date DESC';
  if (limit) { sql += ' LIMIT ?'; params.push(limit); }
  if (offset) { sql += ' OFFSET ?'; params.push(offset); }
  return d.prepare(sql).all(...params);
}

export function getMessageCount(projectId) {
  return getDb().prepare('SELECT COUNT(*) as count FROM messages WHERE project_id = ?').get(projectId)?.count || 0;
}

export function saveSearchQuery(projectId, queryType, queryText, criteriaJson) {
  const d = getDb();
  const id = uuidv4();
  d.prepare(`INSERT INTO search_queries (id, project_id, query_type, query_text, criteria_json, executed_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(id, projectId, queryType, queryText, JSON.stringify(criteriaJson || {}), new Date().toISOString());
  return id;
}

export function getSearchQueries(projectId) {
  return getDb().prepare('SELECT * FROM search_queries WHERE project_id = ? ORDER BY executed_at DESC').all(projectId);
}

export function saveExportRecord(projectId, format, outputDir, messageCount, totalBytes, hashSha256) {
  const d = getDb();
  const id = uuidv4();
  const now = new Date().toISOString();
  d.prepare(`INSERT INTO export_records (id, project_id, format, output_dir, started_at, completed_at, message_count, total_bytes, status, hash_sha256)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?)`).run(
    id, projectId, format, outputDir, now, now, messageCount, totalBytes, hashSha256
  );
  return id;
}

export function getExportRecords(projectId) {
  return getDb().prepare('SELECT * FROM export_records WHERE project_id = ? ORDER BY started_at DESC').all(projectId);
}

export function getAuditLog(projectId) {
  return getDb().prepare('SELECT * FROM audit_log WHERE project_id = ? ORDER BY id ASC').all(projectId);
}

export function getFullAuditLog() {
  return getDb().prepare('SELECT * FROM audit_log ORDER BY id ASC').all();
}

export function getMessage(id) {
  return getDb().prepare('SELECT * FROM messages WHERE id = ?').get(id);
}

export function getAllProjectMessages(projectId) {
  return getDb().prepare('SELECT * FROM messages WHERE project_id = ? ORDER BY date DESC').all(projectId);
}

export function updateAcquisition(id, data) {
  const d = getDb();
  const sets = [];
  const vals = [];
  if (data.status) { sets.push('status = ?'); vals.push(data.status); }
  if (data.completionType) { sets.push('completion_type = ?'); vals.push(data.completionType); }
  if (data.totalMessages != null) { sets.push('total_messages = ?'); vals.push(data.totalMessages); }
  if (data.acquiredMessages != null) { sets.push('acquired_messages = ?'); vals.push(data.acquiredMessages); }
  if (data.failedMessages != null) { sets.push('failed_messages = ?'); vals.push(data.failedMessages); }
  if (data.totalBytes != null) { sets.push('total_bytes = ?'); vals.push(data.totalBytes); }
  if (data.skippedMessages != null) { sets.push('skipped_messages = ?'); vals.push(data.skippedMessages); }
  if (data.protocolLog) { sets.push('protocol_log = ?'); vals.push(JSON.stringify(data.protocolLog)); }
  if (data.errorLog) { sets.push('error_log = ?'); vals.push(JSON.stringify(data.errorLog)); }
  if (data.sessionDir) { sets.push('session_dir = ?'); vals.push(data.sessionDir); }
  if (['completed', 'completed_with_errors', 'failed', 'canceled'].includes(data.status)) {
    sets.push('completed_at = ?'); vals.push(new Date().toISOString());
  }
  if (sets.length) {
    vals.push(id);
    d.prepare(`UPDATE acquisitions SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
}

export function getAcquisitions(projectId) {
  return getDb().prepare('SELECT * FROM acquisitions WHERE project_id = ? ORDER BY started_at DESC').all(projectId);
}

export function saveAttachment(att) {
  cachedStmt(`INSERT OR REPLACE INTO attachments (id, message_id, filename, content_type, size, hash_md5, hash_sha256, disposition, content_id, is_inline, local_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...bindable([
    att.id, att.messageId, att.filename, att.contentType, att.size,
    att.hashMd5, att.hashSha256, att.disposition, att.contentId,
    att.isInline ? 1 : 0, att.localPath || null,
  ]));
}

export function getAttachments(messageId) {
  return getDb().prepare('SELECT * FROM attachments WHERE message_id = ?').all(messageId);
}

export function getProjectAttachments(projectId) {
  return getDb().prepare('SELECT a.* FROM attachments a JOIN messages m ON a.message_id = m.id WHERE m.project_id = ?').all(projectId);
}

export function saveDriveLink(link) {
  const d = getDb();
  d.prepare(`INSERT OR REPLACE INTO drive_links (id, project_id, message_id, provider, url, file_id, status, detected_at, downloaded_at, local_path, file_size, hash_sha256)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    link.id, link.projectId, link.messageId, link.provider, link.url, link.fileId || null, link.status || 'detected', new Date().toISOString(),
    link.downloadedAt || null, link.localPath || null, link.size ?? null, link.sha256 || null
  );
}

export function setAttachmentLocalPath(id, localPath) {
  getDb().prepare('UPDATE attachments SET local_path = ? WHERE id = ?').run(localPath, id);
}

export function getDriveLinks(projectId) {
  return getDb().prepare('SELECT * FROM drive_links WHERE project_id = ? ORDER BY detected_at DESC').all(projectId);
}

export function saveTimestampRecord(projectId, type, targetHash, timestampData) {
  const d = getDb();
  const id = uuidv4();
  d.prepare(`INSERT INTO timestamp_records (id, project_id, type, target_hash, timestamp_data, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(id, projectId, type, targetHash, JSON.stringify(timestampData), new Date().toISOString());
  return id;
}

export function getTimestampRecords(projectId) {
  return getDb().prepare('SELECT * FROM timestamp_records WHERE project_id = ? ORDER BY created_at DESC').all(projectId);
}

export function saveInlineSearch(projectId, query, resultCount, elapsedMs) {
  const d = getDb();
  const id = uuidv4();
  d.prepare(`INSERT INTO inline_searches (id, project_id, query, result_count, elapsed_ms, executed_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(id, projectId, query, resultCount, elapsedMs, new Date().toISOString());
  return id;
}

export function getInlineSearches(projectId) {
  return getDb().prepare('SELECT * FROM inline_searches WHERE project_id = ? ORDER BY executed_at DESC').all(projectId);
}

export function saveQcResult(projectId, results) {
  const d = getDb();
  const now = new Date().toISOString();
  d.prepare(`INSERT INTO qc_results (project_id, started_at, completed_at, status, results_json) VALUES (?, ?, ?, ?, ?)`).run(
    projectId, now, now, results.overallStatus, JSON.stringify(results)
  );
}

export function getQcResults(projectId) {
  return getDb().prepare('SELECT * FROM qc_results WHERE project_id = ? ORDER BY completed_at DESC').all(projectId);
}

export function getDifferentialIds(projectId) {
  return getDb().prepare('SELECT * FROM differential_ids WHERE project_id = ?').all(projectId);
}

export function saveDifferentialId(projectId, serviceId, folder, sourceProjectId) {
  const d = getDb();
  d.prepare(`INSERT OR REPLACE INTO differential_ids (project_id, service_id, folder, source_project_id) VALUES (?, ?, ?, ?)`).run(
    projectId, serviceId, folder, sourceProjectId || null
  );
}

export function updateExportRecord(id, data) {
  const d = getDb();
  const sets = [];
  const vals = [];
  if (data.status) { sets.push('status = ?'); vals.push(data.status); }
  if (data.outputDir) { sets.push('output_dir = ?'); vals.push(data.outputDir); }
  if (data.totalBytes != null) { sets.push('total_bytes = ?'); vals.push(data.totalBytes); }
  if (data.detailsJson) { sets.push('details_json = ?'); vals.push(JSON.stringify(data.detailsJson)); }
  if (data.status === 'completed') { sets.push('completed_at = ?'); vals.push(new Date().toISOString()); }
  if (sets.length) {
    vals.push(id);
    d.prepare(`UPDATE export_records SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
}

export function getStats() {
  const d = getDb();
  const totalBytes = d.prepare('SELECT COALESCE(SUM(size), 0) as total FROM messages').get().total;
  return {
    projects: d.prepare('SELECT COUNT(*) as count FROM projects').get().count,
    messages: d.prepare('SELECT COUNT(*) as count FROM messages').get().count,
    acquisitions: d.prepare('SELECT COUNT(*) as count FROM acquisitions').get().count,
    exports: d.prepare('SELECT COUNT(*) as count FROM export_records').get().count,
    auditEntries: d.prepare('SELECT COUNT(*) as count FROM audit_log').get().count,
    totalBytes,
  };
}

// ── RFC 3161 Timestamps ──
export function saveRfc3161Timestamp(record) {
  const d = getDb();
  d.prepare(`INSERT INTO rfc3161_timestamps (id, project_id, target_type, target_hash, tsa_url, tsa_name, request_nonce, tst_info, timestamp_token, gen_time, serial_number, hash_algorithm, status, verification_result, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    record.id, record.projectId, record.targetType, record.targetHash, record.tsaUrl,
    record.tsaName || null, record.requestNonce || null, record.tstInfo || null,
    record.timestampToken || null, record.genTime || null, record.serialNumber || null,
    record.hashAlgorithm || 'sha256', record.status || 'pending', record.verificationResult || null,
    new Date().toISOString()
  );
}

export function getRfc3161Timestamps(projectId) {
  return getDb().prepare('SELECT * FROM rfc3161_timestamps WHERE project_id = ? ORDER BY created_at DESC').all(projectId);
}

// ── Folder Snapshots ──
export function saveFolderSnapshot(record) {
  const d = getDb();
  d.prepare(`INSERT INTO folder_snapshots (id, project_id, acquisition_id, snapshot_type, captured_at, folder_data, total_folders, total_messages, hash_sha256)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    record.id, record.projectId, record.acquisitionId || null, record.snapshotType,
    new Date().toISOString(), JSON.stringify(record.folderData), record.totalFolders || 0,
    record.totalMessages || 0, record.hashSha256 || null
  );
}

export function getFolderSnapshots(projectId) {
  return getDb().prepare('SELECT * FROM folder_snapshots WHERE project_id = ? ORDER BY captured_at DESC').all(projectId);
}

// ── Drive Items ──
export function saveDriveItem(item) {
  const d = getDb();
  d.prepare(`INSERT OR REPLACE INTO drive_items (id, project_id, provider, item_type, name, mime_type, size, remote_id, parent_id, path, web_url, created_time, modified_time, owner, shared, revision_count, local_path, hash_md5, hash_sha256, status, downloaded_at, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    item.id, item.projectId, item.provider, item.itemType, item.name, item.mimeType || null,
    item.size || 0, item.remoteId || null, item.parentId || null, item.path || null,
    item.webUrl || null, item.createdTime || null, item.modifiedTime || null,
    item.owner || null, item.shared ? 1 : 0, item.revisionCount || 0,
    item.localPath || null, item.hashMd5 || null, item.hashSha256 || null,
    item.status || 'listed', item.downloadedAt || null, JSON.stringify(item.metadata || {})
  );
}

export function getDriveItems(projectId, provider) {
  if (provider) return getDb().prepare('SELECT * FROM drive_items WHERE project_id = ? AND provider = ? ORDER BY path').all(projectId, provider);
  return getDb().prepare('SELECT * FROM drive_items WHERE project_id = ? ORDER BY path').all(projectId);
}

export function updateDriveItem(id, data) {
  const d = getDb();
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(data)) {
    const col = k.replace(/([A-Z])/g, '_$1').toLowerCase();
    sets.push(`${col} = ?`);
    vals.push(v);
  }
  if (sets.length) { vals.push(id); d.prepare(`UPDATE drive_items SET ${sets.join(', ')} WHERE id = ?`).run(...vals); }
}

// ── Calendar Events ──
export function saveCalendarEvent(evt) {
  const d = getDb();
  d.prepare(`INSERT OR REPLACE INTO calendar_events (id, project_id, provider, event_id, summary, description, location, start_time, end_time, organizer, attendees_json, recurrence, status, ical_data, hash_sha256, collected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    evt.id, evt.projectId, evt.provider, evt.eventId || null, evt.summary || null,
    evt.description || null, evt.location || null, evt.startTime || null, evt.endTime || null,
    evt.organizer || null, JSON.stringify(evt.attendees || []), evt.recurrence || null,
    evt.status || null, evt.icalData || null, evt.hashSha256 || null, new Date().toISOString()
  );
}

export function getCalendarEvents(projectId) {
  return getDb().prepare('SELECT * FROM calendar_events WHERE project_id = ? ORDER BY start_time DESC').all(projectId);
}

// ── Contacts ──
export function saveContact(contact) {
  const d = getDb();
  d.prepare(`INSERT OR REPLACE INTO contacts (id, project_id, provider, contact_id, display_name, email_addresses, phone_numbers, organization, title, notes, vcard_data, hash_sha256, collected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    contact.id, contact.projectId, contact.provider, contact.contactId || null,
    contact.displayName || null, JSON.stringify(contact.emailAddresses || []),
    JSON.stringify(contact.phoneNumbers || []), contact.organization || null,
    contact.title || null, contact.notes || null, contact.vcardData || null,
    contact.hashSha256 || null, new Date().toISOString()
  );
}

export function getContacts(projectId) {
  return getDb().prepare('SELECT * FROM contacts WHERE project_id = ? ORDER BY display_name').all(projectId);
}

// ── Cloud Downloads ──
export function saveCloudDownload(dl) {
  const d = getDb();
  d.prepare(`INSERT OR REPLACE INTO cloud_downloads (id, project_id, drive_link_id, provider, remote_url, file_name, file_size, mime_type, stage, local_path, hash_md5, hash_sha1, hash_sha256, hash_sha384, error, started_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    dl.id, dl.projectId, dl.driveLinkId || null, dl.provider, dl.remoteUrl || null,
    dl.fileName || null, dl.fileSize || null, dl.mimeType || null, dl.stage || 'queued',
    dl.localPath || null, dl.hashMd5 || null, dl.hashSha1 || null,
    dl.hashSha256 || null, dl.hashSha384 || null, dl.error || null,
    dl.startedAt || null, dl.completedAt || null
  );
}

export function getCloudDownloads(projectId) {
  return getDb().prepare('SELECT * FROM cloud_downloads WHERE project_id = ? ORDER BY started_at DESC').all(projectId);
}

export function updateCloudDownload(id, data) {
  const d = getDb();
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(data)) {
    const col = k.replace(/([A-Z])/g, '_$1').toLowerCase();
    sets.push(`${col} = ?`);
    vals.push(v);
  }
  if (sets.length) { vals.push(id); d.prepare(`UPDATE cloud_downloads SET ${sets.join(', ')} WHERE id = ?`).run(...vals); }
}

// ── Pre-Acquisition Search ──
export function savePreAcquisitionSearch(record) {
  const d = getDb();
  d.prepare(`INSERT INTO pre_acquisition_searches (id, project_id, criteria_json, protocol, result_count, selected_count, uids_json, executed_at, applied)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    record.id, record.projectId, JSON.stringify(record.criteria), record.protocol || null,
    record.resultCount || 0, record.selectedCount || 0, JSON.stringify(record.uids || []),
    new Date().toISOString(), record.applied ? 1 : 0
  );
}

export function getPreAcquisitionSearches(projectId) {
  return getDb().prepare('SELECT * FROM pre_acquisition_searches WHERE project_id = ? ORDER BY executed_at DESC').all(projectId);
}

// ── Search Index (Lucene-style) ──
export function indexMessage(projectId, messageId, fields) {
  const d = getDb();
  const stmt = d.prepare('INSERT INTO search_index (project_id, message_id, field, content) VALUES (?, ?, ?, ?)');
  for (const [field, content] of Object.entries(fields)) {
    if (content) stmt.run(projectId, messageId, field, String(content).toLowerCase());
  }
}

export function searchIndex(projectId, query, fields) {
  const d = getDb();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  let sql = 'SELECT DISTINCT message_id FROM search_index WHERE project_id = ?';
  const params = [projectId];
  if (fields && fields.length) {
    sql += ` AND field IN (${fields.map(() => '?').join(',')})`;
    params.push(...fields);
  }
  for (const term of terms) {
    sql += ' AND content LIKE ?';
    params.push(`%${term}%`);
  }
  return d.prepare(sql).all(...params).map(r => r.message_id);
}

// ── SMTP Settings ──
export function saveSmtpSettings(settings) {
  const d = getDb();
  d.prepare(`INSERT OR REPLACE INTO smtp_settings (id, project_id, host, port, secure, username, password_encrypted, from_address, to_addresses, notify_on_complete, notify_on_error, notify_on_export, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    settings.id, settings.projectId || null, settings.host, settings.port || 587,
    settings.secure ? 1 : 0, settings.username || null, settings.passwordEncrypted || null,
    settings.fromAddress || null, JSON.stringify(settings.toAddresses || []),
    settings.notifyOnComplete ? 1 : 0, settings.notifyOnError ? 1 : 0,
    settings.notifyOnExport ? 1 : 0, new Date().toISOString()
  );
}

export function getSmtpSettings(projectId) {
  const d = getDb();
  const specific = d.prepare('SELECT * FROM smtp_settings WHERE project_id = ?').get(projectId);
  if (specific) return specific;
  return d.prepare('SELECT * FROM smtp_settings WHERE project_id IS NULL ORDER BY created_at DESC LIMIT 1').get();
}

// ── Health Events ──
export function saveHealthEvent(evt) {
  const d = getDb();
  d.prepare(`INSERT INTO health_events (project_id, acquisition_id, event_type, severity, message, details_json, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    evt.projectId || null, evt.acquisitionId || null, evt.eventType, evt.severity || 'info',
    evt.message || null, JSON.stringify(evt.details || {}), new Date().toISOString()
  );
}

export function getHealthEvents(projectId) {
  return getDb().prepare('SELECT * FROM health_events WHERE project_id = ? ORDER BY recorded_at DESC').all(projectId);
}

// ── Acquisition Targets (Multi-Target) ──
export function saveAcquisitionTarget(target) {
  const d = getDb();
  d.prepare(`INSERT OR REPLACE INTO acquisition_targets (id, batch_id, project_id, target_email, provider_type, config_json, status, acquisition_id, started_at, completed_at, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    target.id, target.batchId, target.projectId || null, target.targetEmail,
    target.providerType, JSON.stringify(target.config || {}), target.status || 'pending',
    target.acquisitionId || null, target.startedAt || null, target.completedAt || null,
    target.error || null
  );
}

export function getAcquisitionTargets(batchId) {
  return getDb().prepare('SELECT * FROM acquisition_targets WHERE batch_id = ? ORDER BY id').all(batchId);
}

export function updateAcquisitionTarget(id, data) {
  const d = getDb();
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(data)) {
    const col = k.replace(/([A-Z])/g, '_$1').toLowerCase();
    sets.push(`${col} = ?`);
    vals.push(typeof v === 'object' && v !== null ? JSON.stringify(v) : v);
  }
  if (sets.length) { vals.push(id); d.prepare(`UPDATE acquisition_targets SET ${sets.join(', ')} WHERE id = ?`).run(...vals); }
}

// ── Connectivity Tests ──
export function saveConnectivityTest(test) {
  const d = getDb();
  d.prepare(`INSERT INTO connectivity_tests (id, project_id, host, port, protocol, tls_version, certificate_info, dns_resolved, latency_ms, auth_tested, auth_result, imap_capabilities, status, error, tested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    test.id, test.projectId || null, test.host, test.port || null, test.protocol || null,
    test.tlsVersion || null, JSON.stringify(test.certificateInfo || {}),
    test.dnsResolved || null, test.latencyMs || null, test.authTested ? 1 : 0,
    test.authResult || null, test.imapCapabilities || null, test.status,
    test.error || null, new Date().toISOString()
  );
}

export function getConnectivityTests(projectId) {
  return getDb().prepare('SELECT * FROM connectivity_tests WHERE project_id = ? ORDER BY tested_at DESC').all(projectId);
}

// ── Proxy Settings ──
export function saveProxySettings(proxy) {
  const d = getDb();
  d.prepare(`INSERT OR REPLACE INTO proxy_settings (id, name, proxy_type, host, port, username, password_encrypted, is_default, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    proxy.id, proxy.name, proxy.proxyType, proxy.host || null, proxy.port || null,
    proxy.username || null, proxy.passwordEncrypted || null, proxy.isDefault ? 1 : 0,
    new Date().toISOString()
  );
}

export function getProxySettings() {
  return getDb().prepare('SELECT * FROM proxy_settings ORDER BY is_default DESC, name').all();
}

export function getDefaultProxy() {
  return getDb().prepare('SELECT * FROM proxy_settings WHERE is_default = 1 LIMIT 1').get();
}

// ── Server Profiles ──
export function saveServerProfile(profile) {
  const d = getDb();
  d.prepare(`INSERT OR REPLACE INTO server_profiles (id, domain, provider_name, imap_host, imap_port, pop3_host, pop3_port, smtp_host, smtp_port, mx_records, spf_record, autodiscover_url, oauth_required, detected_protocol, confidence, detected_at, last_verified)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    profile.id, profile.domain, profile.providerName || null,
    profile.imapHost || null, profile.imapPort || null,
    profile.pop3Host || null, profile.pop3Port || null,
    profile.smtpHost || null, profile.smtpPort || null,
    JSON.stringify(profile.mxRecords || []), profile.spfRecord || null,
    profile.autodiscoverUrl || null, profile.oauthRequired ? 1 : 0,
    profile.detectedProtocol || null, profile.confidence || 0,
    new Date().toISOString(), null
  );
}

export function getServerProfile(domain) {
  return getDb().prepare('SELECT * FROM server_profiles WHERE domain = ?').get(domain);
}

export function getAllServerProfiles() {
  return getDb().prepare('SELECT * FROM server_profiles ORDER BY domain').all();
}

// ── Certificates ──
export function saveCertificate(cert) {
  const d = getDb();
  d.prepare(`INSERT OR REPLACE INTO certificates (id, project_id, subject, issuer, serial_number, thumbprint_sha256, not_before, not_after, key_usage, email_address, pem_data, pfx_path, cert_type, imported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    cert.id, cert.projectId || null, cert.subject || null, cert.issuer || null,
    cert.serialNumber || null, cert.thumbprintSha256 || null,
    cert.notBefore || null, cert.notAfter || null, cert.keyUsage || null,
    cert.emailAddress || null, cert.pemData || null, cert.pfxPath || null,
    cert.certType, new Date().toISOString()
  );
}

export function getCertificates(projectId) {
  if (projectId) return getDb().prepare('SELECT * FROM certificates WHERE project_id = ? OR project_id IS NULL ORDER BY imported_at DESC').all(projectId);
  return getDb().prepare('SELECT * FROM certificates ORDER BY imported_at DESC').all();
}

// ── Saved Credentials ──
export function saveCredential(cred) {
  const d = getDb();
  d.prepare(`INSERT OR REPLACE INTO saved_credentials (id, label, credential_type, target_host, username, encrypted_data, iv, auth_tag, metadata_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    cred.id, cred.label, cred.credentialType, cred.targetHost || null,
    cred.username || null, cred.encryptedData || null, cred.iv || null,
    cred.authTag || null, JSON.stringify(cred.metadata || {}),
    new Date().toISOString(), new Date().toISOString()
  );
}

export function getCredentials() {
  return getDb().prepare('SELECT id, label, credential_type, target_host, username, metadata_json, created_at, updated_at FROM saved_credentials ORDER BY label').all();
}

export function getCredential(id) {
  return getDb().prepare('SELECT * FROM saved_credentials WHERE id = ?').get(id);
}

export function deleteCredential(id) {
  getDb().prepare('DELETE FROM saved_credentials WHERE id = ?').run(id);
}

// ── Custom IMAP Profiles ──
export function saveCustomImapProfile(profile) {
  const d = getDb();
  d.prepare(`INSERT OR REPLACE INTO custom_imap_profiles (id, name, host, port, tls, auth_method, imap_capabilities, special_folders, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    profile.id, profile.name, profile.host, profile.port || 993,
    profile.tls !== false ? 1 : 0, profile.authMethod || 'password',
    profile.imapCapabilities || null, JSON.stringify(profile.specialFolders || {}),
    profile.notes || null, new Date().toISOString(), new Date().toISOString()
  );
}

export function getCustomImapProfiles() {
  return getDb().prepare('SELECT * FROM custom_imap_profiles ORDER BY name').all();
}

export function getCustomImapProfile(id) {
  return getDb().prepare('SELECT * FROM custom_imap_profiles WHERE id = ?').get(id);
}

export function deleteCustomImapProfile(id) {
  getDb().prepare('DELETE FROM custom_imap_profiles WHERE id = ?').run(id);
}
