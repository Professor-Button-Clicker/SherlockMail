using System.Text.Json;
using SherlockMail.Protocols;

namespace SherlockMail.Core;

public class QCSummary
{
    public int TotalFoldersChecked { get; set; }
    public int TotalMessagesChecked { get; set; }
    public int FolderCountMatches { get; set; }
    public int FolderCountMismatches { get; set; }
    public int HashMatches { get; set; }
    public int HashMismatches { get; set; }
    public int MissingOnServer { get; set; }
    public int MissingInCollection { get; set; }
    public int SizeMatches { get; set; }
    public int SizeMismatches { get; set; }
    public int EmlFileMissing { get; set; }
    public int Errors { get; set; }
    public int TotalIssues { get; set; }
    public string OverallVerdict { get; set; } = "";
    public string VerdictNote { get; set; } = "";
}

public class QCResults
{
    public string? StartedAt { get; set; }
    public string? CompletedAt { get; set; }
    public string Status { get; set; } = "pending";
    public string? Error { get; set; }
    public List<object> FolderResults { get; set; } = [];
    public List<object> MessageResults { get; set; } = [];
    public QCSummary Summary { get; set; } = new();
}

public class QCVerifier
{
    private readonly ForensicDatabase _db;
    private readonly string _projectId;
    private readonly string _host;
    private readonly int _port;
    private readonly bool _tls;
    private readonly string _email;
    private readonly string? _username;
    private readonly string? _password;
    private readonly string? _appPassword;
    public QCResults Results { get; } = new();

    public event Action<string>? OnLog;
    public event Action<string, uint, string>? OnMessageVerified;

    public QCVerifier(ForensicDatabase db, string projectId, string host, int port, bool tls,
        string email, string? username, string? password, string? appPassword)
    {
        _db = db;
        _projectId = projectId;
        _host = host;
        _port = port;
        _tls = tls;
        _email = email;
        _username = username;
        _password = password;
        _appPassword = appPassword;
    }

    public async Task<QCResults> VerifyAsync(bool verifyHashes = true, int sampleSize = 0, CancellationToken ct = default)
    {
        Results.StartedAt = DateTime.UtcNow.ToString("o");
        Results.Status = "running";
        OnLog?.Invoke("Starting QC verification...");

        using var client = new ForensicImapClient(_host, _port, _tls, _email, _username, _password, _appPassword);

        try
        {
            await client.ConnectAsync(ct);
            OnLog?.Invoke($"Connected to {_host}");

            var serverFolders = await client.ListFoldersAsync(ct);
            var dbFolders = _db.GetFolders(_projectId);
            var selectableFolders = serverFolders.Where(f => f.Listed && !f.Flags.Contains("NoSelect")).ToList();

            foreach (var serverFolder in selectableFolders)
            {
                var dbFolder = dbFolders.FirstOrDefault(f => f["path"]?.ToString() == serverFolder.Path);
                await VerifyFolderAsync(client, serverFolder, dbFolder, verifyHashes, sampleSize, ct);
            }

            foreach (var dbFolder in dbFolders)
            {
                var path = dbFolder["path"]?.ToString() ?? "";
                if (!selectableFolders.Any(f => f.Path == path))
                {
                    Results.FolderResults.Add(new
                    {
                        folder = path,
                        status = "FOLDER_REMOVED_FROM_SERVER",
                        dbMessageCount = _db.GetMessageCount(_projectId, path),
                        note = "Folder existed during acquisition but is no longer on the server"
                    });
                }
            }

            Results.Status = "completed";
        }
        catch (Exception ex)
        {
            Results.Status = "failed";
            Results.Error = ex.Message;
            OnLog?.Invoke($"QC verification error: {ex.Message}");
        }
        finally
        {
            Results.CompletedAt = DateTime.UtcNow.ToString("o");
        }

        ComputeSummary();

        _db.AddQCResult(_projectId, Results.StartedAt, Results.CompletedAt,
            Results.Status, JsonSerializer.Serialize(Results));

        return Results;
    }

    private async Task VerifyFolderAsync(ForensicImapClient client, FolderInfo serverFolder,
        Dictionary<string, object?>? dbFolder, bool verifyHashes, int sampleSize, CancellationToken ct)
    {
        OnLog?.Invoke($"Verifying folder: {serverFolder.Path}");
        Results.Summary.TotalFoldersChecked++;

        int serverMessageCount;
        try
        {
            var (messages, _, _, _) = await client.GetFolderStatusAsync(serverFolder.Path, ct);
            serverMessageCount = messages;
        }
        catch (Exception ex)
        {
            Results.FolderResults.Add(new { folder = serverFolder.Path, status = "ERROR", error = $"Cannot access folder: {ex.Message}" });
            Results.Summary.Errors++;
            return;
        }

        var dbMessageCount = _db.GetMessageCount(_projectId, serverFolder.Path);
        var countMatch = serverMessageCount == dbMessageCount;

        if (countMatch) Results.Summary.FolderCountMatches++;
        else Results.Summary.FolderCountMismatches++;

        var messageVerifications = new List<object>();

        if (verifyHashes && dbMessageCount > 0)
        {
            var dbMessages = _db.GetMessagesByProjectAndFolder(_projectId, serverFolder.Path);

            if (sampleSize > 0 && dbMessages.Count > sampleSize)
            {
                var step = dbMessages.Count / sampleSize;
                var sampled = new List<Dictionary<string, object?>>();
                for (int i = 0; i < dbMessages.Count && sampled.Count < sampleSize; i += step)
                    sampled.Add(dbMessages[i]);
                dbMessages = sampled;
            }

            foreach (var dbMsg in dbMessages)
            {
                var msgResult = await VerifyMessageAsync(client, serverFolder.Path, dbMsg, ct);
                messageVerifications.Add(msgResult);
                Results.MessageResults.Add(msgResult);
                Results.Summary.TotalMessagesChecked++;

                var uid = Convert.ToUInt32(dbMsg["uid"]);
                var status = ((dynamic)msgResult).status;
                OnMessageVerified?.Invoke(serverFolder.Path, uid, status);
            }
        }

        Results.FolderResults.Add(new
        {
            folder = serverFolder.Path,
            status = countMatch ? "COUNT_MATCH" : "COUNT_MISMATCH",
            serverMessageCount,
            dbMessageCount,
            difference = serverMessageCount - dbMessageCount,
            messageVerifications
        });
    }

    private async Task<object> VerifyMessageAsync(ForensicImapClient client, string folderPath,
        Dictionary<string, object?> dbMsg, CancellationToken ct)
    {
        var uid = Convert.ToUInt32(dbMsg["uid"]);
        var messageId = dbMsg["message_id"]?.ToString();
        var subject = dbMsg["subject"]?.ToString();
        var dbSize = Convert.ToInt64(dbMsg["size"] ?? 0);
        var dbHash = dbMsg["hash_sha256"]?.ToString() ?? "";
        var emlPath = dbMsg["eml_path"]?.ToString();

        var checks = new Dictionary<string, object>();

        try
        {
            var serverMsg = await client.FetchMessageByUidAsync(folderPath, uid, ct);

            if (serverMsg == null || serverMsg.Source.Length == 0)
            {
                Results.Summary.MissingOnServer++;
                return new { messageId, uid, folder = folderPath, subject, status = "MISSING_ON_SERVER",
                    checks = new { serverPresence = new { passed = false, note = "Message not found on server by UID" } } };
            }

            var sizeMatch = serverMsg.Source.Length == dbSize;
            checks["size"] = new { passed = sizeMatch, serverSize = serverMsg.Source.Length, collectedSize = dbSize };
            if (sizeMatch) Results.Summary.SizeMatches++;
            else Results.Summary.SizeMismatches++;

            var serverHash = Hasher.HashBuffer(serverMsg.Source, "sha256");
            var hashMatch = serverHash == dbHash;
            checks["sha256"] = new { passed = hashMatch, serverHash, collectedHash = dbHash };
            if (hashMatch) Results.Summary.HashMatches++;
            else Results.Summary.HashMismatches++;

            if (!string.IsNullOrEmpty(emlPath))
            {
                try
                {
                    if (File.Exists(emlPath))
                    {
                        var fileHash = await Hasher.HashFileAsync(emlPath, "sha256");
                        var emlMatch = fileHash == dbHash;
                        checks["emlFile"] = new { passed = emlMatch, fileHash, expectedHash = dbHash, path = emlPath };
                    }
                    else
                    {
                        checks["emlFile"] = new { passed = false, note = "EML file not found on disk" };
                        Results.Summary.EmlFileMissing++;
                    }
                }
                catch
                {
                    checks["emlFile"] = new { passed = false, note = "EML file not found on disk" };
                    Results.Summary.EmlFileMissing++;
                }
            }

            var allPassed = checks.Values.All(c =>
            {
                var json = JsonSerializer.Serialize(c);
                return json.Contains("\"passed\":true");
            });

            return new { messageId, uid, folder = folderPath, subject, status = allPassed ? "VERIFIED" : "MISMATCH", checks };
        }
        catch (Exception ex)
        {
            Results.Summary.Errors++;
            return new { messageId, uid, folder = folderPath, subject, status = "ERROR", error = ex.Message };
        }
    }

    private void ComputeSummary()
    {
        var s = Results.Summary;
        s.TotalIssues = s.FolderCountMismatches + s.HashMismatches + s.SizeMismatches
                      + s.MissingOnServer + s.EmlFileMissing + s.Errors;
        s.OverallVerdict = s.TotalIssues == 0 ? "PASS" : "ISSUES_FOUND";

        s.VerdictNote = s.TotalIssues > 0
            ? $"{s.TotalIssues} issue(s) found during QC verification. " +
              "Review individual results for details. " +
              "This does NOT indicate data was fabricated — it may reflect server-side changes " +
              "(new messages, deletions, or modifications) since the acquisition."
            : "All checked items match between the collection and the mail server.";
    }
}
