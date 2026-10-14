using System.Text.Json;
using MimeKit;
using SherlockMail.Protocols;

namespace SherlockMail.Core;

public class AcquisitionStats
{
    public int TotalMessages { get; set; }
    public int AcquiredMessages { get; set; }
    public int FailedMessages { get; set; }
    public int SkippedMessages { get; set; }
    public long TotalBytes { get; set; }
    public int DriveLinksDetected { get; set; }
    public string? StartTime { get; set; }
    public string? EndTime { get; set; }
}

public class AcquisitionConfig
{
    public string Host { get; set; } = "";
    public int Port { get; set; } = 993;
    public bool Tls { get; set; } = true;
    public string Email { get; set; } = "";
    public string? Username { get; set; }
    public string? Password { get; set; }
    public string? AppPassword { get; set; }
    public string? AccessToken { get; set; }
    public string OutputDir { get; set; } = "./output";
    public List<string>? IncludeFolders { get; set; }
    public List<string>? ExcludeFolders { get; set; }
    public Dictionary<string, List<uint>>? TargetedUids { get; set; }
    public int ThrottleDelay { get; set; }
    public string[] HashAlgorithms { get; set; } = ["md5", "sha256"];
    public bool Differential { get; set; }
    public bool CollectDriveLinks { get; set; } = true;
    public string? ExaminerName { get; set; }
    public string? ProviderType { get; set; }
}

public class AcquisitionEngine
{
    private readonly ForensicDatabase _db;
    private readonly string _projectId;
    private readonly AcquisitionConfig _config;
    private readonly ChainOfCustody _custody;
    private readonly DriveAttachmentDetector _driveDetector;
    public AcquisitionStats Stats { get; } = new();
    private bool _cancelled;

    public event Action<string>? OnLog;
    public event Action<string, uint, string?, int, int>? OnMessageAcquired;
    public event Action<string, uint, string>? OnMessageFailed;
    public event Action<string>? OnFolderStart;
    public event Action<string, int>? OnFolderComplete;
    public event Action<int>? OnDriveLinksDetected;

    public AcquisitionEngine(ForensicDatabase db, string projectId, AcquisitionConfig config)
    {
        _db = db;
        _projectId = projectId;
        _config = config;
        _custody = new ChainOfCustody(db, projectId, config.ExaminerName ?? "Unknown");
        _driveDetector = new DriveAttachmentDetector(db, projectId);
    }

    public void Cancel() => _cancelled = true;

    public async Task<(string AcquisitionId, AcquisitionStats Stats)> RunAsync(CancellationToken ct = default)
    {
        var acquisitionId = Guid.NewGuid().ToString();
        _db.CreateAcquisition(acquisitionId, _projectId);
        _db.UpdateProjectStatus(_projectId, "acquiring");
        Stats.StartTime = DateTime.UtcNow.ToString("o");

        _custody.LogAcquisitionStarted(acquisitionId, new
        {
            connectionType = _config.ProviderType,
            server = _config.Host,
            port = _config.Port,
            tls = _config.Tls
        });

        OnLog?.Invoke("Starting collection...");

        using var client = new ForensicImapClient(
            _config.Host, _config.Port, _config.Tls, _config.Email,
            _config.Username ?? _config.Email, _config.Password, _config.AppPassword, _config.AccessToken);

        try
        {
            await client.ConnectAsync(ct);
            OnLog?.Invoke($"Connected to {_config.Host}");

            var folders = await client.ListFoldersAsync(ct);
            var selectedFolders = FilterFolders(folders);

            foreach (var folder in selectedFolders)
                StoreFolderRecord(folder);

            foreach (var folder in selectedFolders)
            {
                if (_cancelled) break;
                await AcquireFolderAsync(client, folder, acquisitionId, ct);
            }

            Stats.EndTime = DateTime.UtcNow.ToString("o");

            _db.UpdateAcquisition(acquisitionId, new Dictionary<string, object?>
            {
                ["status"] = _cancelled ? "cancelled" : "completed",
                ["completed_at"] = Stats.EndTime,
                ["total_messages"] = Stats.TotalMessages,
                ["acquired_messages"] = Stats.AcquiredMessages,
                ["failed_messages"] = Stats.FailedMessages,
                ["skipped_messages"] = Stats.SkippedMessages,
                ["total_bytes"] = Stats.TotalBytes
            });

            _db.UpdateProjectStatus(_projectId, _cancelled ? "cancelled" : "completed");
            _custody.LogAcquisitionCompleted(acquisitionId, Stats);
            OnLog?.Invoke("Collection completed successfully");
        }
        catch (Exception ex)
        {
            Stats.EndTime = DateTime.UtcNow.ToString("o");
            _db.UpdateAcquisition(acquisitionId, new Dictionary<string, object?>
            {
                ["status"] = "failed",
                ["completed_at"] = Stats.EndTime,
                ["error_log"] = ex.Message,
                ["total_messages"] = Stats.TotalMessages,
                ["acquired_messages"] = Stats.AcquiredMessages,
                ["failed_messages"] = Stats.FailedMessages
            });
            _db.UpdateProjectStatus(_projectId, "failed");
            _custody.LogAcquisitionFailed(acquisitionId, ex);
            OnLog?.Invoke($"Collection failed: {ex.Message}");
            throw;
        }

        return (acquisitionId, Stats);
    }

    private List<FolderInfo> FilterFolders(List<FolderInfo> folders)
    {
        var selected = folders.Where(f => f.Listed && !f.Flags.Contains("NoSelect")).ToList();

        if (_config.IncludeFolders is { Count: > 0 })
            selected = selected.Where(f => _config.IncludeFolders.Any(p => f.Path.StartsWith(p))).ToList();

        if (_config.ExcludeFolders is { Count: > 0 })
            selected = selected.Where(f => !_config.ExcludeFolders.Any(p => f.Path.StartsWith(p))).ToList();

        if (_config.TargetedUids != null)
            selected = selected.Where(f => _config.TargetedUids.ContainsKey(f.Path) && _config.TargetedUids[f.Path].Count > 0).ToList();

        return selected;
    }

    private void StoreFolderRecord(FolderInfo folder)
    {
        var parentPath = folder.Path.Contains(folder.Delimiter)
            ? folder.Path[..folder.Path.LastIndexOf(folder.Delimiter)]
            : null;

        _db.InsertFolder(Guid.NewGuid().ToString(), _projectId, folder.Path, folder.Name,
            folder.Delimiter.ToString(), JsonSerializer.Serialize(folder.Flags),
            0, 0, parentPath);
    }

    private async Task AcquireFolderAsync(ForensicImapClient client, FolderInfo folder, string acquisitionId, CancellationToken ct)
    {
        OnFolderStart?.Invoke(folder.Path);
        OnLog?.Invoke($"Processing folder: {folder.Path}");

        int targetCount;
        try
        {
            var (messages, _, _, _) = await client.GetFolderStatusAsync(folder.Path, ct);
            targetCount = (_config.TargetedUids != null && _config.TargetedUids.ContainsKey(folder.Path))
                ? _config.TargetedUids[folder.Path].Count
                : messages;
        }
        catch
        {
            OnLog?.Invoke($"Cannot access folder: {folder.Path}");
            return;
        }

        _custody.LogFolderEnumerated(acquisitionId, folder.Path, targetCount);
        Stats.TotalMessages += targetCount;

        if (targetCount == 0)
        {
            OnFolderComplete?.Invoke(folder.Path, 0);
            return;
        }

        var outputDir = Path.Combine(_config.OutputDir, "Items", SanitizePath(folder.Path));
        Directory.CreateDirectory(outputDir);

        IList<uint>? specificUids = null;
        if (_config.TargetedUids != null && _config.TargetedUids.ContainsKey(folder.Path))
            specificUids = _config.TargetedUids[folder.Path];

        int folderAcquired = 0;
        var batch = new List<MessageRecord>();

        await foreach (var rawMsg in client.FetchMessagesAsync(folder.Path, specificUids, ct))
        {
            if (_cancelled) break;

            try
            {
                var record = await ProcessMessageAsync(rawMsg, folder.Path, acquisitionId, outputDir);
                if (record == null)
                {
                    Stats.SkippedMessages++;
                    continue;
                }

                batch.Add(record);
                if (batch.Count >= 50)
                {
                    _db.InsertMessageBatch(batch);
                    batch.Clear();
                }

                folderAcquired++;
                Stats.AcquiredMessages++;
                Stats.TotalBytes += rawMsg.Size;
                OnMessageAcquired?.Invoke(folder.Path, rawMsg.Uid, rawMsg.Subject, folderAcquired, targetCount);

                if (_config.ThrottleDelay > 0)
                    await Task.Delay(_config.ThrottleDelay, ct);
            }
            catch (Exception ex)
            {
                Stats.FailedMessages++;
                _custody.LogMessageFailed(acquisitionId, rawMsg.Uid, folder.Path, ex);
                OnMessageFailed?.Invoke(folder.Path, rawMsg.Uid, ex.Message);
            }
        }

        if (batch.Count > 0)
            _db.InsertMessageBatch(batch);

        OnFolderComplete?.Invoke(folder.Path, folderAcquired);
    }

    private async Task<MessageRecord?> ProcessMessageAsync(FetchedMessage rawMsg, string folderPath,
        string acquisitionId, string outputDir)
    {
        var source = rawMsg.Source;
        var hashes = Hasher.HashMultiple(source, _config.HashAlgorithms);

        if (_config.Differential)
        {
            var serviceId = rawMsg.EnvelopeMessageId ?? $"uid:{rawMsg.Uid}";
            if (_db.IsDifferentialExcluded(_projectId, serviceId))
                return null;
        }

        MimeMessage parsed;
        using (var ms = new MemoryStream(source))
            parsed = await MimeMessage.LoadAsync(ms);

        var msgId = Guid.NewGuid().ToString();
        var subjectSafe = SanitizeFilename(parsed.Subject ?? "no_subject");
        var filename = $"{rawMsg.Uid}_{subjectSafe}.eml";
        var emlPath = Path.Combine(outputDir, filename);

        await File.WriteAllBytesAsync(emlPath, source);

        if (parsed.Attachments != null)
        {
            foreach (var att in parsed.Attachments)
            {
                byte[] attContent;
                using (var ms = new MemoryStream())
                {
                    if (att is MimePart part)
                        await part.Content.DecodeToAsync(ms);
                    attContent = ms.ToArray();
                }

                var attHashes = Hasher.HashMultiple(attContent, ["md5", "sha256"]);
                var attFilename = att is MimePart mp ? mp.FileName : "unnamed";

                _db.InsertAttachment(
                    Guid.NewGuid().ToString(), msgId,
                    attFilename ?? "unnamed", att.ContentType?.MimeType,
                    attContent.Length,
                    attHashes.GetValueOrDefault("md5"), attHashes.GetValueOrDefault("sha256"),
                    att.ContentDisposition?.Disposition, att.ContentId,
                    att.ContentDisposition?.Disposition == "inline");
            }
        }

        var headersObj = new Dictionary<string, string>();
        foreach (var header in parsed.Headers)
            headersObj[header.Field] = header.Value;

        var contentTypeStr = parsed.Headers["Content-Type"] ?? "text/plain";
        var isEncrypted = contentTypeStr.Contains("pkcs7-mime", StringComparison.OrdinalIgnoreCase);
        var isSigned = contentTypeStr.Contains("pkcs7-signature", StringComparison.OrdinalIgnoreCase)
                    || contentTypeStr.Contains("pgp-signature", StringComparison.OrdinalIgnoreCase);

        var record = new MessageRecord
        {
            Id = msgId,
            AcquisitionId = acquisitionId,
            ProjectId = _projectId,
            Uid = rawMsg.Uid,
            ServiceId = parsed.MessageId ?? $"uid:{rawMsg.Uid}",
            Folder = folderPath,
            Subject = parsed.Subject ?? "",
            From = parsed.From?.ToString() ?? "",
            To = parsed.To?.ToString() ?? "",
            Cc = parsed.Cc?.ToString() ?? "",
            Bcc = parsed.Bcc?.ToString() ?? "",
            Date = parsed.Date.UtcDateTime.ToString("o"),
            MessageId = parsed.MessageId ?? "",
            InReplyTo = parsed.InReplyTo ?? "",
            Size = source.Length,
            Flags = JsonSerializer.Serialize(rawMsg.Flags),
            HasAttachments = parsed.Attachments?.Any() == true,
            AttachmentCount = parsed.Attachments?.Count() ?? 0,
            ContentType = contentTypeStr,
            HashMd5 = hashes.GetValueOrDefault("md5") ?? "",
            HashSha256 = hashes.GetValueOrDefault("sha256") ?? "",
            HashSha512 = hashes.GetValueOrDefault("sha512") ?? "",
            EmlPath = emlPath,
            HeadersJson = JsonSerializer.Serialize(headersObj),
            IsEncrypted = isEncrypted,
            IsSigned = isSigned
        };

        _custody.LogMessageAcquired(acquisitionId, record.MessageId, hashes, record.Size ?? 0);

        if (_config.CollectDriveLinks)
        {
            try
            {
                var sourceText = System.Text.Encoding.UTF8.GetString(source);
                var driveLinks = _driveDetector.DetectLinksInContent(sourceText);
                foreach (var link in driveLinks)
                {
                    _db.InsertDriveLink(Guid.NewGuid().ToString(), _projectId, msgId,
                        link.Provider, link.Url, link.FileId, "detected", DateTime.UtcNow.ToString("o"));
                }
                if (driveLinks.Count > 0)
                {
                    Stats.DriveLinksDetected += driveLinks.Count;
                    OnDriveLinksDetected?.Invoke(driveLinks.Count);
                }
            }
            catch { }
        }

        return record;
    }

    private static string SanitizePath(string path) =>
        System.Text.RegularExpressions.Regex.Replace(path, @"[<>:""|?*/\\]", "_");

    private static string SanitizeFilename(string name)
    {
        var sanitized = System.Text.RegularExpressions.Regex.Replace(name, @"[<>:""/\\|?*\x00-\x1f]", "_");
        return sanitized.Length > 80 ? sanitized[..80] : sanitized;
    }
}
