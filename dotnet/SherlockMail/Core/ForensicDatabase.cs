using Microsoft.Data.Sqlite;
using System.Text.Json;

namespace SherlockMail.Core;

public class ForensicDatabase : IDisposable
{
    private readonly SqliteConnection _conn;
    public string DbPath { get; }

    private ForensicDatabase(SqliteConnection conn, string dbPath)
    {
        _conn = conn;
        DbPath = dbPath;
    }

    public static ForensicDatabase Create(string dbPath)
    {
        var dir = Path.GetDirectoryName(dbPath);
        if (!string.IsNullOrEmpty(dir))
            Directory.CreateDirectory(dir);

        var conn = new SqliteConnection($"Data Source={dbPath}");
        conn.Open();

        var db = new ForensicDatabase(conn, dbPath);
        db.Execute("PRAGMA foreign_keys = ON");
        db.Execute("PRAGMA journal_mode = WAL");
        db.Initialize();
        return db;
    }

    private void Initialize()
    {
        Execute(@"
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                case_id TEXT,
                custodian_name TEXT,
                examiner_id TEXT,
                examiner_name TEXT,
                target_email TEXT,
                provider_type TEXT,
                status TEXT DEFAULT 'created',
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now')),
                config TEXT
            )");

        Execute(@"
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
            )");

        Execute(@"
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
            )");

        Execute(@"
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
            )");

        Execute(@"
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
            )");

        Execute(@"
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
            )");

        Execute(@"
            CREATE TABLE IF NOT EXISTS search_queries (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                query_type TEXT NOT NULL,
                query_text TEXT NOT NULL,
                result_count INTEGER,
                executed_at TEXT DEFAULT (datetime('now'))
            )");

        Execute(@"
            CREATE TABLE IF NOT EXISTS differential_ids (
                project_id TEXT NOT NULL,
                service_id TEXT NOT NULL,
                folder TEXT,
                source_project_id TEXT,
                PRIMARY KEY (project_id, service_id)
            )");

        Execute(@"
            CREATE TABLE IF NOT EXISTS qc_results (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id TEXT NOT NULL,
                started_at TEXT,
                completed_at TEXT,
                status TEXT DEFAULT 'pending',
                results_json TEXT
            )");

        Execute(@"
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
            )");

        Execute(@"
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
            )");

        Execute("CREATE INDEX IF NOT EXISTS idx_messages_project ON messages(project_id)");
        Execute("CREATE INDEX IF NOT EXISTS idx_messages_folder ON messages(folder)");
        Execute("CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(date)");
        Execute("CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_address)");
        Execute("CREATE INDEX IF NOT EXISTS idx_messages_hash ON messages(hash_sha256)");
        Execute("CREATE INDEX IF NOT EXISTS idx_audit_project ON audit_log(project_id)");
        Execute("CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id)");
        Execute("CREATE INDEX IF NOT EXISTS idx_drive_links_project ON drive_links(project_id)");
        Execute("CREATE INDEX IF NOT EXISTS idx_drive_links_message ON drive_links(message_id)");
        Execute("CREATE INDEX IF NOT EXISTS idx_qc_results_project ON qc_results(project_id)");
        Execute("CREATE INDEX IF NOT EXISTS idx_export_records_project ON export_records(project_id)");
    }

    public void Execute(string sql, params object?[] parameters)
    {
        using var cmd = _conn.CreateCommand();
        cmd.CommandText = sql;
        for (int i = 0; i < parameters.Length; i++)
            cmd.Parameters.AddWithValue($"@p{i}", parameters[i] ?? DBNull.Value);
        cmd.ExecuteNonQuery();
    }

    public Dictionary<string, object?>? QueryOne(string sql, params object?[] parameters)
    {
        using var cmd = _conn.CreateCommand();
        cmd.CommandText = sql;
        for (int i = 0; i < parameters.Length; i++)
            cmd.Parameters.AddWithValue($"@p{i}", parameters[i] ?? DBNull.Value);
        using var reader = cmd.ExecuteReader();
        if (!reader.Read()) return null;
        return ReadRow(reader);
    }

    public List<Dictionary<string, object?>> QueryAll(string sql, params object?[] parameters)
    {
        using var cmd = _conn.CreateCommand();
        cmd.CommandText = sql;
        for (int i = 0; i < parameters.Length; i++)
            cmd.Parameters.AddWithValue($"@p{i}", parameters[i] ?? DBNull.Value);
        using var reader = cmd.ExecuteReader();
        var rows = new List<Dictionary<string, object?>>();
        while (reader.Read())
            rows.Add(ReadRow(reader));
        return rows;
    }

    private static Dictionary<string, object?> ReadRow(SqliteDataReader reader)
    {
        var row = new Dictionary<string, object?>();
        for (int i = 0; i < reader.FieldCount; i++)
        {
            var name = reader.GetName(i);
            row[name] = reader.IsDBNull(i) ? null : reader.GetValue(i);
        }
        return row;
    }

    // --- Projects ---
    public Dictionary<string, object?> CreateProject(string id, string name, string? caseId,
        string? custodianName, string? examinerId, string? examinerName,
        string? targetEmail, string? config)
    {
        Execute(@"INSERT INTO projects (id, name, case_id, custodian_name, examiner_id, examiner_name, target_email, config)
                  VALUES (@p0, @p1, @p2, @p3, @p4, @p5, @p6, @p7)",
            id, name, caseId, custodianName, examinerId, examinerName, targetEmail, config ?? "{}");
        return GetProject(id)!;
    }

    public Dictionary<string, object?>? GetProject(string id) =>
        QueryOne("SELECT * FROM projects WHERE id = @p0", id);

    public List<Dictionary<string, object?>> ListProjects() =>
        QueryAll("SELECT * FROM projects ORDER BY created_at DESC");

    public void UpdateProjectStatus(string id, string status)
    {
        Execute("UPDATE projects SET status = @p0, updated_at = datetime('now') WHERE id = @p1", status, id);
    }

    // --- Acquisitions ---
    public void CreateAcquisition(string id, string projectId)
    {
        Execute("INSERT INTO acquisitions (id, project_id, status, started_at) VALUES (@p0, @p1, 'running', datetime('now'))",
            id, projectId);
    }

    public void UpdateAcquisition(string id, Dictionary<string, object?> data)
    {
        var setClauses = data.Keys.Select((k, i) => $"{k} = @p{i}").ToList();
        var values = data.Values.ToList();
        values.Add(id);
        Execute($"UPDATE acquisitions SET {string.Join(", ", setClauses)} WHERE id = @p{values.Count - 1}",
            values.ToArray());
    }

    public Dictionary<string, object?>? GetAcquisition(string id) =>
        QueryOne("SELECT * FROM acquisitions WHERE id = @p0", id);

    public List<Dictionary<string, object?>> ListAcquisitions(string projectId) =>
        QueryAll("SELECT * FROM acquisitions WHERE project_id = @p0 ORDER BY started_at DESC", projectId);

    // --- Messages ---
    public void InsertMessage(string id, string acquisitionId, string projectId, long? uid, string? serviceId,
        string folder, string? subject, string? from, string? to, string? cc, string? bcc,
        string? date, string? messageId, string? inReplyTo, long? size, string? flags,
        bool hasAttachments, int attachmentCount, string? contentType,
        string? hashMd5, string? hashSha256, string? hashSha512, string? emlPath,
        string? headersJson, bool isEncrypted, bool isSigned)
    {
        Execute(@"INSERT INTO messages (id, acquisition_id, project_id, uid, service_id, folder, subject,
            from_address, to_addresses, cc_addresses, bcc_addresses, date, message_id,
            in_reply_to, size, flags, has_attachments, attachment_count, content_type,
            hash_md5, hash_sha256, hash_sha512, eml_path, headers_json, is_encrypted, is_signed)
            VALUES (@p0,@p1,@p2,@p3,@p4,@p5,@p6,@p7,@p8,@p9,@p10,@p11,@p12,@p13,@p14,@p15,@p16,@p17,@p18,@p19,@p20,@p21,@p22,@p23,@p24,@p25)",
            id, acquisitionId, projectId, uid, serviceId, folder, subject,
            from, to, cc, bcc, date, messageId, inReplyTo, size, flags,
            hasAttachments ? 1 : 0, attachmentCount, contentType,
            hashMd5, hashSha256, hashSha512, emlPath, headersJson,
            isEncrypted ? 1 : 0, isSigned ? 1 : 0);
    }

    public void InsertMessageBatch(List<MessageRecord> messages)
    {
        using var transaction = _conn.BeginTransaction();
        foreach (var m in messages)
        {
            InsertMessage(m.Id, m.AcquisitionId, m.ProjectId, m.Uid, m.ServiceId,
                m.Folder, m.Subject, m.From, m.To, m.Cc, m.Bcc,
                m.Date, m.MessageId, m.InReplyTo, m.Size, m.Flags,
                m.HasAttachments, m.AttachmentCount, m.ContentType,
                m.HashMd5, m.HashSha256, m.HashSha512, m.EmlPath,
                m.HeadersJson, m.IsEncrypted, m.IsSigned);
        }
        transaction.Commit();
    }

    public Dictionary<string, object?>? GetMessage(string id) =>
        QueryOne("SELECT * FROM messages WHERE id = @p0", id);

    public List<Dictionary<string, object?>> GetMessagesByFolder(string projectId, string folder, int limit = 100, int offset = 0) =>
        QueryAll("SELECT * FROM messages WHERE project_id = @p0 AND folder = @p1 ORDER BY date DESC LIMIT @p2 OFFSET @p3",
            projectId, folder, limit, offset);

    public List<Dictionary<string, object?>> SearchMessages(string projectId, string query)
    {
        var pattern = $"%{query}%";
        return QueryAll(@"SELECT * FROM messages WHERE project_id = @p0 AND (
            subject LIKE @p1 OR from_address LIKE @p2 OR to_addresses LIKE @p3 OR message_id LIKE @p4
        ) ORDER BY date DESC LIMIT 500", projectId, pattern, pattern, pattern, pattern);
    }

    public List<Dictionary<string, object?>> GetAllMessages(string projectId) =>
        QueryAll("SELECT * FROM messages WHERE project_id = @p0 ORDER BY folder, date", projectId);

    // --- Folders ---
    public List<Dictionary<string, object?>> GetFolders(string projectId) =>
        QueryAll("SELECT * FROM folders WHERE project_id = @p0 ORDER BY path", projectId);

    public void InsertFolder(string id, string projectId, string path, string name,
        string? delimiter, string? flags, int totalMessages, int unseenMessages, string? parentPath)
    {
        Execute(@"INSERT OR REPLACE INTO folders (id, project_id, path, name, delimiter, flags, total_messages, unseen_messages, parent_path)
                  VALUES (@p0,@p1,@p2,@p3,@p4,@p5,@p6,@p7,@p8)",
            id, projectId, path, name, delimiter, flags, totalMessages, unseenMessages, parentPath);
    }

    // --- Attachments ---
    public void InsertAttachment(string id, string messageId, string? filename, string? contentType,
        long? size, string? hashMd5, string? hashSha256, string? disposition, string? contentId, bool isInline)
    {
        Execute(@"INSERT INTO attachments (id, message_id, filename, content_type, size, hash_md5, hash_sha256, disposition, content_id, is_inline)
                  VALUES (@p0,@p1,@p2,@p3,@p4,@p5,@p6,@p7,@p8,@p9)",
            id, messageId, filename, contentType, size, hashMd5, hashSha256, disposition, contentId, isInline ? 1 : 0);
    }

    public List<Dictionary<string, object?>> GetAttachments(string messageId) =>
        QueryAll("SELECT * FROM attachments WHERE message_id = @p0", messageId);

    // --- Audit Log ---
    public void AddAuditEntry(string? projectId, string? acquisitionId, string timestamp,
        string eventType, string description, string? details, string? hash, string? examiner)
    {
        Execute(@"INSERT INTO audit_log (project_id, acquisition_id, timestamp, event_type, description, details, hash, examiner)
                  VALUES (@p0,@p1,@p2,@p3,@p4,@p5,@p6,@p7)",
            projectId, acquisitionId, timestamp, eventType, description, details, hash, examiner);
    }

    public List<Dictionary<string, object?>> GetAuditLog(string projectId) =>
        QueryAll("SELECT * FROM audit_log WHERE project_id = @p0 ORDER BY timestamp DESC", projectId);

    // --- Stats ---
    public Dictionary<string, object?> GetProjectStats(string projectId)
    {
        var messages = QueryOne("SELECT COUNT(*) as count, COALESCE(SUM(size),0) as totalSize FROM messages WHERE project_id = @p0", projectId);
        var folders = QueryOne("SELECT COUNT(*) as count FROM folders WHERE project_id = @p0", projectId);
        var attachments = QueryOne(@"SELECT COUNT(*) as count FROM attachments a
            JOIN messages m ON a.message_id = m.id WHERE m.project_id = @p0", projectId);
        var acquisitions = ListAcquisitions(projectId);

        return new Dictionary<string, object?>
        {
            ["messages"] = messages,
            ["folders"] = folders,
            ["attachments"] = attachments,
            ["acquisitions"] = acquisitions
        };
    }

    // --- Differential ---
    public bool IsDifferentialExcluded(string projectId, string serviceId) =>
        QueryOne("SELECT 1 FROM differential_ids WHERE project_id = @p0 AND service_id = @p1", projectId, serviceId) != null;

    public void AddDifferentialId(string projectId, string serviceId, string? folder, string? sourceProjectId)
    {
        Execute("INSERT OR IGNORE INTO differential_ids (project_id, service_id, folder, source_project_id) VALUES (@p0,@p1,@p2,@p3)",
            projectId, serviceId, folder, sourceProjectId);
    }

    // --- QC Results ---
    public void AddQCResult(string projectId, string? startedAt, string? completedAt, string status, string resultsJson)
    {
        Execute("INSERT INTO qc_results (project_id, started_at, completed_at, status, results_json) VALUES (@p0,@p1,@p2,@p3,@p4)",
            projectId, startedAt, completedAt, status, resultsJson);
    }

    public List<Dictionary<string, object?>> GetQCResults(string projectId) =>
        QueryAll("SELECT * FROM qc_results WHERE project_id = @p0 ORDER BY started_at DESC", projectId);

    // --- Export Records ---
    public void AddExportRecord(string id, string projectId, string format, string? outputDir,
        string? startedAt, string? completedAt, int messageCount, string status, string? detailsJson)
    {
        Execute(@"INSERT INTO export_records (id, project_id, format, output_dir, started_at, completed_at, message_count, status, details_json)
                  VALUES (@p0,@p1,@p2,@p3,@p4,@p5,@p6,@p7,@p8)",
            id, projectId, format, outputDir, startedAt, completedAt, messageCount, status, detailsJson);
    }

    public List<Dictionary<string, object?>> GetExportRecords(string projectId) =>
        QueryAll("SELECT * FROM export_records WHERE project_id = @p0 ORDER BY started_at DESC", projectId);

    // --- Drive Links ---
    public void InsertDriveLink(string id, string projectId, string messageId, string? provider,
        string url, string? fileId, string status, string? detectedAt)
    {
        Execute(@"INSERT OR IGNORE INTO drive_links (id, project_id, message_id, provider, url, file_id, status, detected_at)
                  VALUES (@p0,@p1,@p2,@p3,@p4,@p5,@p6,@p7)",
            id, projectId, messageId, provider, url, fileId, status, detectedAt);
    }

    public List<Dictionary<string, object?>> GetDriveLinks(string projectId, string? messageId = null)
    {
        if (messageId != null)
            return QueryAll("SELECT * FROM drive_links WHERE project_id = @p0 AND message_id = @p1 ORDER BY detected_at", projectId, messageId);
        return QueryAll("SELECT * FROM drive_links WHERE project_id = @p0 ORDER BY detected_at", projectId);
    }

    // --- System stats ---
    public Dictionary<string, object?> GetSystemStats()
    {
        var projects = QueryOne("SELECT COUNT(*) as c FROM projects");
        var messages = QueryOne("SELECT COUNT(*) as c FROM messages");
        var totalSize = QueryOne("SELECT COALESCE(SUM(size), 0) as s FROM messages");
        return new Dictionary<string, object?>
        {
            ["totalProjects"] = projects?["c"],
            ["totalMessages"] = messages?["c"],
            ["totalSize"] = totalSize?["s"]
        };
    }

    public int GetMessageCount(string projectId, string folder)
    {
        var row = QueryOne("SELECT COUNT(*) as count FROM messages WHERE project_id = @p0 AND folder = @p1", projectId, folder);
        return Convert.ToInt32(row?["count"] ?? 0);
    }

    public List<Dictionary<string, object?>> GetMessagesByProjectAndFolder(string projectId, string folder) =>
        QueryAll("SELECT * FROM messages WHERE project_id = @p0 AND folder = @p1 ORDER BY uid", projectId, folder);

    public void Dispose()
    {
        _conn.Close();
        _conn.Dispose();
    }
}

public class MessageRecord
{
    public string Id { get; set; } = "";
    public string AcquisitionId { get; set; } = "";
    public string ProjectId { get; set; } = "";
    public long? Uid { get; set; }
    public string? ServiceId { get; set; }
    public string Folder { get; set; } = "";
    public string? Subject { get; set; }
    public string? From { get; set; }
    public string? To { get; set; }
    public string? Cc { get; set; }
    public string? Bcc { get; set; }
    public string? Date { get; set; }
    public string? MessageId { get; set; }
    public string? InReplyTo { get; set; }
    public long? Size { get; set; }
    public string? Flags { get; set; }
    public bool HasAttachments { get; set; }
    public int AttachmentCount { get; set; }
    public string? ContentType { get; set; }
    public string? HashMd5 { get; set; }
    public string? HashSha256 { get; set; }
    public string? HashSha512 { get; set; }
    public string? EmlPath { get; set; }
    public string? HeadersJson { get; set; }
    public bool IsEncrypted { get; set; }
    public bool IsSigned { get; set; }
}
