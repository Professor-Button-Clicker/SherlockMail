import initSqlJs from 'sql.js';
import { join, dirname } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';

let SQL;

function getSqlWasmPath() {
  try {
    const require = createRequire(import.meta.url);
    return join(dirname(require.resolve('sql.js')), 'dist', 'sql-wasm.wasm');
  } catch {
    return undefined;
  }
}

class PreparedStatement {
  constructor(db, sql, autoSave) {
    this.db = db;
    this.sql = sql;
    this.autoSave = autoSave;
  }

  run(...params) {
    this.db.run(this.sql, params);
    this.autoSave();
  }

  get(...params) {
    const stmt = this.db.prepare(this.sql);
    try {
      stmt.bind(params);
      if (stmt.step()) return stmt.getAsObject();
      return undefined;
    } finally {
      stmt.free();
    }
  }

  all(...params) {
    const stmt = this.db.prepare(this.sql);
    const rows = [];
    try {
      stmt.bind(params);
      while (stmt.step()) rows.push(stmt.getAsObject());
    } finally {
      stmt.free();
    }
    return rows;
  }
}

export class ForensicDatabase {
  constructor(sqlDb, dbPath) {
    this.db = sqlDb;
    this.dbPath = dbPath;
    this._dirty = false;
  }

  static async create(dbPath) {
    mkdirSync(join(dbPath, '..'), { recursive: true });
    if (!SQL) {
      const wasmPath = getSqlWasmPath();
      const opts = wasmPath && existsSync(wasmPath)
        ? { locateFile: () => wasmPath }
        : {};
      SQL = await initSqlJs(opts);
    }
    let sqlDb;
    if (existsSync(dbPath)) {
      const buffer = readFileSync(dbPath);
      sqlDb = new SQL.Database(buffer);
    } else {
      sqlDb = new SQL.Database();
    }
    const instance = new ForensicDatabase(sqlDb, dbPath);
    instance.db.run('PRAGMA foreign_keys = ON');
    instance.#initialize();
    instance.#save();
    return instance;
  }

  #save() {
    const data = this.db.export();
    writeFileSync(this.dbPath, Buffer.from(data));
  }

  #autoSave = () => { this.#save(); };

  prepare(sql) {
    return new PreparedStatement(this.db, sql, this.#autoSave);
  }

  #initialize() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        target_email TEXT NOT NULL,
        provider_type TEXT,
        case_name TEXT,
        case_id TEXT,
        examiner_name TEXT,
        agency TEXT,
        status TEXT DEFAULT 'created',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        config TEXT
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS acquisitions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        started_at TEXT,
        completed_at TEXT,
        total_messages INTEGER DEFAULT 0,
        acquired_messages INTEGER DEFAULT 0,
        failed_messages INTEGER DEFAULT 0,
        skipped_messages INTEGER DEFAULT 0,
        total_bytes INTEGER DEFAULT 0,
        error_log TEXT
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        acquisition_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        uid INTEGER,
        service_id TEXT,
        folder TEXT NOT NULL,
        subject TEXT,
        from_address TEXT,
        to_addresses TEXT,
        cc_addresses TEXT,
        bcc_addresses TEXT,
        date TEXT,
        message_id TEXT,
        in_reply_to TEXT,
        size INTEGER,
        flags TEXT,
        has_attachments INTEGER DEFAULT 0,
        attachment_count INTEGER DEFAULT 0,
        content_type TEXT,
        hash_md5 TEXT,
        hash_sha256 TEXT,
        hash_sha512 TEXT,
        eml_path TEXT,
        acquired_at TEXT DEFAULT (datetime('now')),
        headers_json TEXT,
        is_encrypted INTEGER DEFAULT 0,
        is_signed INTEGER DEFAULT 0
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        filename TEXT,
        content_type TEXT,
        size INTEGER,
        hash_md5 TEXT,
        hash_sha256 TEXT,
        disposition TEXT,
        content_id TEXT,
        is_inline INTEGER DEFAULT 0
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS folders (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        delimiter TEXT,
        flags TEXT,
        total_messages INTEGER DEFAULT 0,
        unseen_messages INTEGER DEFAULT 0,
        parent_path TEXT
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT,
        acquisition_id TEXT,
        timestamp TEXT DEFAULT (datetime('now')),
        event_type TEXT NOT NULL,
        description TEXT,
        details TEXT,
        hash TEXT,
        examiner TEXT
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS search_queries (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        query_type TEXT NOT NULL,
        query_text TEXT NOT NULL,
        result_count INTEGER,
        executed_at TEXT DEFAULT (datetime('now'))
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS differential_ids (
        project_id TEXT NOT NULL,
        service_id TEXT NOT NULL,
        folder TEXT,
        source_project_id TEXT,
        PRIMARY KEY (project_id, service_id)
      )
    `);
    this.db.run('CREATE INDEX IF NOT EXISTS idx_messages_project ON messages(project_id)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_messages_folder ON messages(folder)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(date)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_address)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_messages_hash ON messages(hash_sha256)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_audit_project ON audit_log(project_id)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id)');

    this.db.run(`
      CREATE TABLE IF NOT EXISTS qc_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        status TEXT DEFAULT 'pending',
        results_json TEXT
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS export_records (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        format TEXT NOT NULL,
        output_dir TEXT,
        started_at TEXT,
        completed_at TEXT,
        message_count INTEGER DEFAULT 0,
        status TEXT DEFAULT 'pending',
        details_json TEXT
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS drive_links (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        provider TEXT,
        url TEXT NOT NULL,
        file_id TEXT,
        status TEXT DEFAULT 'detected',
        detected_at TEXT,
        downloaded_at TEXT,
        local_path TEXT,
        file_size INTEGER,
        hash_sha256 TEXT
      )
    `);
    this.db.run('CREATE INDEX IF NOT EXISTS idx_drive_links_project ON drive_links(project_id)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_drive_links_message ON drive_links(message_id)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_qc_results_project ON qc_results(project_id)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_export_records_project ON export_records(project_id)');
  }

  createProject(project) {
    this.db.run(
      `INSERT INTO projects (id, name, target_email, provider_type, case_name, case_id, examiner_name, agency, config)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [project.id, project.name, project.targetEmail, project.providerType,
       project.caseName, project.caseId, project.examinerName, project.agency,
       JSON.stringify(project.config || {})]
    );
    this.#save();
    return project;
  }

  getProject(id) {
    return this.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  }

  listProjects() {
    return this.prepare('SELECT * FROM projects ORDER BY created_at DESC').all();
  }

  updateProjectStatus(id, status) {
    this.db.run('UPDATE projects SET status = ?, updated_at = datetime("now") WHERE id = ?', [status, id]);
    this.#save();
  }

  createAcquisition(acq) {
    this.db.run(
      `INSERT INTO acquisitions (id, project_id, status, started_at)
       VALUES (?, ?, 'running', datetime('now'))`,
      [acq.id, acq.projectId]
    );
    this.#save();
    return acq;
  }

  updateAcquisition(id, data) {
    const fields = Object.entries(data).map(([key]) => `${key} = ?`).join(', ');
    const values = Object.values(data);
    this.db.run(`UPDATE acquisitions SET ${fields} WHERE id = ?`, [...values, id]);
    this.#save();
  }

  getAcquisition(id) {
    return this.prepare('SELECT * FROM acquisitions WHERE id = ?').get(id);
  }

  listAcquisitions(projectId) {
    return this.prepare('SELECT * FROM acquisitions WHERE project_id = ? ORDER BY started_at DESC').all(projectId);
  }

  insertMessage(msg) {
    this.db.run(
      `INSERT INTO messages (id, acquisition_id, project_id, uid, service_id, folder, subject,
        from_address, to_addresses, cc_addresses, bcc_addresses, date, message_id,
        in_reply_to, size, flags, has_attachments, attachment_count, content_type,
        hash_md5, hash_sha256, hash_sha512, eml_path, headers_json, is_encrypted, is_signed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [msg.id, msg.acquisitionId, msg.projectId, msg.uid, msg.serviceId, msg.folder,
       msg.subject, msg.from, msg.to, msg.cc, msg.bcc, msg.date, msg.messageId,
       msg.inReplyTo, msg.size, msg.flags, msg.hasAttachments ? 1 : 0, msg.attachmentCount,
       msg.contentType, msg.hashMd5, msg.hashSha256, msg.hashSha512, msg.emlPath,
       msg.headersJson, msg.isEncrypted ? 1 : 0, msg.isSigned ? 1 : 0]
    );
    this.#save();
  }

  insertMessageBatch(messages) {
    this.db.run('BEGIN TRANSACTION');
    for (const msg of messages) {
      this.db.run(
        `INSERT INTO messages (id, acquisition_id, project_id, uid, service_id, folder, subject,
          from_address, to_addresses, cc_addresses, bcc_addresses, date, message_id,
          in_reply_to, size, flags, has_attachments, attachment_count, content_type,
          hash_md5, hash_sha256, hash_sha512, eml_path, headers_json, is_encrypted, is_signed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [msg.id, msg.acquisitionId, msg.projectId, msg.uid, msg.serviceId, msg.folder,
         msg.subject, msg.from, msg.to, msg.cc, msg.bcc, msg.date, msg.messageId,
         msg.inReplyTo, msg.size, msg.flags, msg.hasAttachments ? 1 : 0, msg.attachmentCount,
         msg.contentType, msg.hashMd5, msg.hashSha256, msg.hashSha512, msg.emlPath,
         msg.headersJson, msg.isEncrypted ? 1 : 0, msg.isSigned ? 1 : 0]
      );
    }
    this.db.run('COMMIT');
    this.#save();
  }

  getMessage(id) {
    return this.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  }

  getMessagesByFolder(projectId, folder, limit = 100, offset = 0) {
    return this.prepare(
      'SELECT * FROM messages WHERE project_id = ? AND folder = ? ORDER BY date DESC LIMIT ? OFFSET ?'
    ).all(projectId, folder, limit, offset);
  }

  searchMessages(projectId, query) {
    const pattern = `%${query}%`;
    return this.prepare(`
      SELECT * FROM messages WHERE project_id = ? AND (
        subject LIKE ? OR from_address LIKE ? OR to_addresses LIKE ? OR message_id LIKE ?
      ) ORDER BY date DESC LIMIT 500
    `).all(projectId, pattern, pattern, pattern, pattern);
  }

  getFolders(projectId) {
    return this.prepare('SELECT * FROM folders WHERE project_id = ? ORDER BY path').all(projectId);
  }

  insertFolder(folder) {
    this.db.run(
      `INSERT OR REPLACE INTO folders (id, project_id, path, name, delimiter, flags, total_messages, unseen_messages, parent_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [folder.id, folder.projectId, folder.path, folder.name, folder.delimiter,
       folder.flags, folder.totalMessages, folder.unseenMessages, folder.parentPath]
    );
    this.#save();
  }

  insertAttachment(att) {
    this.db.run(
      `INSERT INTO attachments (id, message_id, filename, content_type, size, hash_md5, hash_sha256, disposition, content_id, is_inline)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [att.id, att.messageId, att.filename, att.contentType, att.size,
       att.hashMd5, att.hashSha256, att.disposition, att.contentId, att.isInline ? 1 : 0]
    );
    this.#save();
  }

  addAuditEntry(entry) {
    this.db.run(
      `INSERT INTO audit_log (project_id, acquisition_id, timestamp, event_type, description, details, hash, examiner)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [entry.projectId, entry.acquisitionId, entry.timestamp, entry.eventType,
       entry.description, entry.details, entry.hash, entry.examiner]
    );
    this.#save();
  }

  getAuditLog(projectId) {
    return this.prepare('SELECT * FROM audit_log WHERE project_id = ? ORDER BY timestamp DESC').all(projectId);
  }

  getProjectStats(projectId) {
    const messages = this.prepare('SELECT COUNT(*) as count, SUM(size) as totalSize FROM messages WHERE project_id = ?').get(projectId);
    const folders = this.prepare('SELECT COUNT(*) as count FROM folders WHERE project_id = ?').get(projectId);
    const attachments = this.prepare(`
      SELECT COUNT(*) as count FROM attachments a
      JOIN messages m ON a.message_id = m.id WHERE m.project_id = ?
    `).get(projectId);
    const acquisitions = this.prepare('SELECT * FROM acquisitions WHERE project_id = ? ORDER BY started_at DESC').all(projectId);
    return { messages, folders, attachments, acquisitions };
  }

  isDifferentialExcluded(projectId, serviceId) {
    return !!this.prepare('SELECT 1 FROM differential_ids WHERE project_id = ? AND service_id = ?').get(projectId, serviceId);
  }

  addDifferentialId(projectId, serviceId, folder, sourceProjectId) {
    this.db.run(
      `INSERT OR IGNORE INTO differential_ids (project_id, service_id, folder, source_project_id)
       VALUES (?, ?, ?, ?)`,
      [projectId, serviceId, folder, sourceProjectId]
    );
    this.#save();
  }

  addQCResult(result) {
    this.db.run(
      `INSERT INTO qc_results (project_id, started_at, completed_at, status, results_json)
       VALUES (?, ?, ?, ?, ?)`,
      [result.projectId, result.startedAt, result.completedAt, result.status, result.resultsJson]
    );
    this.#save();
  }

  getQCResults(projectId) {
    return this.prepare('SELECT * FROM qc_results WHERE project_id = ? ORDER BY started_at DESC').all(projectId);
  }

  addExportRecord(record) {
    this.db.run(
      `INSERT INTO export_records (id, project_id, format, output_dir, started_at, completed_at, message_count, status, details_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [record.id, record.projectId, record.format, record.outputDir, record.startedAt,
       record.completedAt, record.messageCount, record.status, record.detailsJson]
    );
    this.#save();
  }

  getExportRecords(projectId) {
    return this.prepare('SELECT * FROM export_records WHERE project_id = ? ORDER BY started_at DESC').all(projectId);
  }

  insertDriveLink(link) {
    this.db.run(
      `INSERT OR IGNORE INTO drive_links (id, project_id, message_id, provider, url, file_id, status, detected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [link.id, link.projectId, link.messageId, link.provider, link.url,
       link.fileId, link.status, link.detectedAt]
    );
    this.#save();
  }

  getDriveLinks(projectId, messageId) {
    if (messageId) {
      return this.prepare('SELECT * FROM drive_links WHERE project_id = ? AND message_id = ?').all(projectId, messageId);
    }
    return this.prepare('SELECT * FROM drive_links WHERE project_id = ? ORDER BY detected_at').all(projectId);
  }

  close() {
    this.#save();
    this.db.close();
  }
}
