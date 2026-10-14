using System.Text.Json;

namespace SherlockMail.Core;

public class ChainOfCustody
{
    private readonly ForensicDatabase _db;
    private readonly string _projectId;
    private readonly string _examiner;
    private string _previousHash;

    public ChainOfCustody(ForensicDatabase db, string projectId, string examiner)
    {
        _db = db;
        _projectId = projectId;
        _examiner = examiner;
        _previousHash = new string('0', 64);
    }

    private string ComputeEntryHash(string timestamp, string eventType, string description)
    {
        var data = $"{_previousHash}|{timestamp}|{eventType}|{description}";
        return Hasher.HashString(data, "sha256");
    }

    public void Log(string eventType, string description, object? details = null, string? acquisitionId = null)
    {
        var timestamp = DateTime.UtcNow.ToString("o");
        var hash = ComputeEntryHash(timestamp, eventType, description);
        _previousHash = hash;

        _db.AddAuditEntry(
            _projectId, acquisitionId, timestamp, eventType, description,
            details != null ? JsonSerializer.Serialize(details) : null,
            hash, _examiner);
    }

    public void LogProjectCreated(object config) =>
        Log("PROJECT_CREATED", $"Project created", config);

    public void LogAcquisitionStarted(string acquisitionId, object config) =>
        Log("ACQUISITION_STARTED", "Acquisition session started", config, acquisitionId);

    public void LogFolderEnumerated(string acquisitionId, string folderPath, int messageCount) =>
        Log("FOLDER_ENUMERATED", $"Enumerated folder: {folderPath} ({messageCount} messages)",
            new { folder = folderPath, messageCount }, acquisitionId);

    public void LogMessageAcquired(string acquisitionId, string? messageId, Dictionary<string, string> hashes, long size) =>
        Log("MESSAGE_ACQUIRED", $"Message acquired: {messageId}",
            new { messageId, hashes, size }, acquisitionId);

    public void LogMessageFailed(string acquisitionId, uint uid, string folder, Exception error) =>
        Log("MESSAGE_FAILED", $"Failed to acquire message UID {uid} from {folder}",
            new { uid, folder, error = error.Message }, acquisitionId);

    public void LogAcquisitionCompleted(string acquisitionId, object stats) =>
        Log("ACQUISITION_COMPLETED", "Acquisition session completed", stats, acquisitionId);

    public void LogAcquisitionFailed(string acquisitionId, Exception error) =>
        Log("ACQUISITION_FAILED", $"Acquisition failed: {error.Message}",
            new { error = error.Message, stack = error.StackTrace }, acquisitionId);

    public void LogSearchExecuted(string queryType, string queryText, int resultCount) =>
        Log("SEARCH_EXECUTED", $"{queryType} search executed: {resultCount} results",
            new { queryType, queryText, resultCount });

    public void LogIntegrityVerified(string messageId, object result) =>
        Log("INTEGRITY_VERIFIED", $"Hash verification for {messageId}", result);

    public (bool Valid, int Checked, int Total, List<ChainVerifyResult> Results) VerifyChain()
    {
        var auditLog = _db.GetAuditLog(_projectId);
        auditLog.Reverse();

        var prevHash = new string('0', 64);
        var results = new List<ChainVerifyResult>();

        foreach (var entry in auditLog)
        {
            var timestamp = entry["timestamp"]?.ToString() ?? "";
            var eventType = entry["event_type"]?.ToString() ?? "";
            var description = entry["description"]?.ToString() ?? "";
            var actualHash = entry["hash"]?.ToString() ?? "";

            var data = $"{prevHash}|{timestamp}|{eventType}|{description}";
            var expected = Hasher.HashString(data, "sha256");
            var valid = expected == actualHash;

            results.Add(new ChainVerifyResult
            {
                Id = Convert.ToInt64(entry["id"]),
                Valid = valid,
                Expected = expected,
                Actual = actualHash
            });

            if (!valid) break;
            prevHash = actualHash;
        }

        return (results.All(r => r.Valid), results.Count, auditLog.Count, results);
    }

    public async Task<(string JsonPath, string TsvPath)> ExportLogAsync(string outputDir)
    {
        Directory.CreateDirectory(outputDir);
        var auditLog = _db.GetAuditLog(_projectId);
        var timestamp = DateTime.UtcNow.ToString("yyyyMMdd_HHmmss");

        var jsonPath = Path.Combine(outputDir, $"chain_of_custody_{timestamp}.json");
        var report = new
        {
            projectId = _projectId,
            examiner = _examiner,
            generatedAt = DateTime.UtcNow.ToString("o"),
            entryCount = auditLog.Count,
            entries = auditLog
        };
        await File.WriteAllTextAsync(jsonPath, JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }));

        var tsvPath = Path.Combine(outputDir, $"audit_log_{timestamp}.tsv");
        var header = "Timestamp\tEvent Type\tDescription\tHash\tExaminer\n";
        var rows = string.Join('\n', auditLog.Select(e =>
            $"{e["timestamp"]}\t{e["event_type"]}\t{e["description"]}\t{e["hash"]}\t{e["examiner"]}"));
        await File.WriteAllTextAsync(tsvPath, header + rows);

        return (jsonPath, tsvPath);
    }
}

public class ChainVerifyResult
{
    public long Id { get; set; }
    public bool Valid { get; set; }
    public string Expected { get; set; } = "";
    public string Actual { get; set; } = "";
}
