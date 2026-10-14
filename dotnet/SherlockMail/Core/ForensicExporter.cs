using System.Text;
using System.Text.Json;
using System.Xml;

namespace SherlockMail.Core;

public class ForensicExporter
{
    private readonly ForensicDatabase _db;
    private readonly string _projectId;

    public event Action<string, uint>? OnMessageExported;

    public ForensicExporter(ForensicDatabase db, string projectId)
    {
        _db = db;
        _projectId = projectId;
    }

    public async Task<Dictionary<string, object?>> ExportAsync(string format, string outputDir,
        int pstSizeGB = 10, string containerType = "mime")
    {
        var exportId = Guid.NewGuid().ToString();
        var startedAt = DateTime.UtcNow.ToString("o");
        Directory.CreateDirectory(outputDir);

        var messages = _db.GetAllMessages(_projectId);
        if (messages.Count == 0)
            return new Dictionary<string, object?> { ["exportId"] = exportId, ["format"] = format, ["count"] = 0, ["outputDir"] = outputDir };

        Dictionary<string, object?> result;
        switch (format.ToLower())
        {
            case "mbox": result = await ExportMboxAsync(messages, outputDir); break;
            case "eml": result = await ExportEmlAsync(messages, outputDir); break;
            case "xml": result = await ExportXmlAsync(messages, outputDir); break;
            case "msg": result = await ExportMsgAsync(messages, outputDir); break;
            case "pst": result = await ExportPstDeferredAsync(messages, outputDir, pstSizeGB); break;
            case "container": result = await ExportContainerAsync(messages, outputDir, containerType); break;
            default: throw new ArgumentException($"Unsupported export format: {format}");
        }

        var completedAt = DateTime.UtcNow.ToString("o");
        _db.AddExportRecord(exportId, _projectId, format, outputDir, startedAt, completedAt,
            messages.Count, "completed", JsonSerializer.Serialize(result));

        result["exportId"] = exportId;
        result["format"] = format;
        result["count"] = messages.Count;
        result["outputDir"] = outputDir;
        return result;
    }

    private async Task<Dictionary<string, object?>> ExportMboxAsync(List<Dictionary<string, object?>> messages, string outputDir)
    {
        var byFolder = GroupByFolder(messages);
        var files = new List<object>();

        foreach (var (folder, msgs) in byFolder)
        {
            var safeName = SanitizePath(folder) + ".mbox";
            var mboxPath = Path.Combine(outputDir, safeName);
            Directory.CreateDirectory(Path.GetDirectoryName(mboxPath)!);

            var sb = new StringBuilder();
            int exported = 0;

            foreach (var msg in msgs)
            {
                var emlPath = msg["eml_path"]?.ToString();
                if (string.IsNullOrEmpty(emlPath)) continue;
                try
                {
                    var content = await File.ReadAllTextAsync(emlPath);
                    var from = msg["from_address"]?.ToString() ?? "unknown";
                    var date = msg["date"]?.ToString();
                    var mboxDate = FormatMboxDate(date);
                    sb.AppendLine($"From {from} {mboxDate}");
                    sb.Append(content.Replace("\nFrom ", "\n>From "));
                    sb.AppendLine();
                    exported++;
                    OnMessageExported?.Invoke("mbox", Convert.ToUInt32(msg["uid"]));
                }
                catch { }
            }

            await File.WriteAllTextAsync(mboxPath, sb.ToString());
            var fileHash = await Hasher.HashFileAsync(mboxPath, "sha256");
            files.Add(new { path = mboxPath, folder, messageCount = exported, sha256 = fileHash });
        }

        return new Dictionary<string, object?> { ["files"] = files };
    }

    private async Task<Dictionary<string, object?>> ExportEmlAsync(List<Dictionary<string, object?>> messages, string outputDir)
    {
        int exported = 0, failed = 0;

        foreach (var msg in messages)
        {
            var folder = msg["folder"]?.ToString() ?? "UNKNOWN";
            var folderDir = Path.Combine(outputDir, SanitizePath(folder));
            Directory.CreateDirectory(folderDir);

            var emlPath = msg["eml_path"]?.ToString();
            if (string.IsNullOrEmpty(emlPath)) { failed++; continue; }

            var uid = Convert.ToUInt32(msg["uid"]);
            var subject = msg["subject"]?.ToString() ?? "no_subject";
            var filename = $"{uid}_{SanitizeFilename(subject)}.eml";
            var destPath = Path.Combine(folderDir, filename);

            try
            {
                File.Copy(emlPath, destPath, true);
                exported++;
                OnMessageExported?.Invoke("eml", uid);
            }
            catch { failed++; }
        }

        return new Dictionary<string, object?> { ["exported"] = exported, ["failed"] = failed };
    }

    private async Task<Dictionary<string, object?>> ExportXmlAsync(List<Dictionary<string, object?>> messages, string outputDir)
    {
        var xmlPath = Path.Combine(outputDir, $"forensic_export_{DateTime.UtcNow:yyyyMMdd_HHmmss}.xml");
        var project = _db.GetProject(_projectId);

        var settings = new XmlWriterSettings { Indent = true, Async = true, Encoding = Encoding.UTF8 };
        await using var writer = XmlWriter.Create(xmlPath, settings);

        await writer.WriteStartDocumentAsync();
        await writer.WriteStartElementAsync(null, "ForensicEmailExport", null);

        await writer.WriteStartElementAsync(null, "ExportMetadata", null);
        await WriteElementAsync(writer, "Tool", "SherlockMail");
        await WriteElementAsync(writer, "Version", "2.0.0");
        await WriteElementAsync(writer, "ExportDate", DateTime.UtcNow.ToString("o"));
        await WriteElementAsync(writer, "ProjectId", _projectId);
        await WriteElementAsync(writer, "ProjectName", project?["name"]?.ToString() ?? "");
        await WriteElementAsync(writer, "TargetEmail", project?["target_email"]?.ToString() ?? "");
        await WriteElementAsync(writer, "CaseId", project?["case_id"]?.ToString() ?? "");
        await WriteElementAsync(writer, "TotalMessages", messages.Count.ToString());
        await writer.WriteEndElementAsync();

        await writer.WriteStartElementAsync(null, "Messages", null);
        foreach (var msg in messages)
        {
            await writer.WriteStartElementAsync(null, "Message", null);
            await WriteElementAsync(writer, "Id", msg["id"]?.ToString() ?? "");
            await WriteElementAsync(writer, "UID", msg["uid"]?.ToString() ?? "");
            await WriteElementAsync(writer, "Folder", msg["folder"]?.ToString() ?? "");
            await WriteElementAsync(writer, "Subject", msg["subject"]?.ToString() ?? "");
            await WriteElementAsync(writer, "From", msg["from_address"]?.ToString() ?? "");
            await WriteElementAsync(writer, "To", msg["to_addresses"]?.ToString() ?? "");
            await WriteElementAsync(writer, "Date", msg["date"]?.ToString() ?? "");
            await WriteElementAsync(writer, "MessageId", msg["message_id"]?.ToString() ?? "");
            await WriteElementAsync(writer, "Size", msg["size"]?.ToString() ?? "0");
            await WriteElementAsync(writer, "HashMD5", msg["hash_md5"]?.ToString() ?? "");
            await WriteElementAsync(writer, "HashSHA256", msg["hash_sha256"]?.ToString() ?? "");
            await WriteElementAsync(writer, "HashSHA512", msg["hash_sha512"]?.ToString() ?? "");
            await WriteElementAsync(writer, "IsEncrypted", (Convert.ToInt32(msg["is_encrypted"] ?? 0) == 1).ToString().ToLower());
            await WriteElementAsync(writer, "IsSigned", (Convert.ToInt32(msg["is_signed"] ?? 0) == 1).ToString().ToLower());
            await WriteElementAsync(writer, "EmlPath", msg["eml_path"]?.ToString() ?? "");
            await writer.WriteEndElementAsync();
            OnMessageExported?.Invoke("xml", Convert.ToUInt32(msg["uid"]));
        }
        await writer.WriteEndElementAsync();
        await writer.WriteEndElementAsync();
        await writer.WriteEndDocumentAsync();

        var fileHash = await Hasher.HashFileAsync(xmlPath, "sha256");
        return new Dictionary<string, object?> { ["file"] = xmlPath, ["sha256"] = fileHash };
    }

    private async Task<Dictionary<string, object?>> ExportMsgAsync(List<Dictionary<string, object?>> messages, string outputDir)
    {
        int exported = 0, failed = 0;

        foreach (var msg in messages)
        {
            var folder = msg["folder"]?.ToString() ?? "UNKNOWN";
            var folderDir = Path.Combine(outputDir, SanitizePath(folder));
            Directory.CreateDirectory(folderDir);

            var emlPath = msg["eml_path"]?.ToString();
            if (string.IsNullOrEmpty(emlPath)) { failed++; continue; }

            var uid = Convert.ToUInt32(msg["uid"]);
            var subject = msg["subject"]?.ToString() ?? "no_subject";
            var filename = $"{uid}_{SanitizeFilename(subject)}.msg";
            var destPath = Path.Combine(folderDir, filename);

            try
            {
                var emlContent = await File.ReadAllBytesAsync(emlPath);
                var header = JsonSerializer.Serialize(new
                {
                    _format = "SherlockMail-MSG-Container-v1",
                    messageId = msg["message_id"]?.ToString(),
                    subject,
                    from = msg["from_address"]?.ToString(),
                    to = msg["to_addresses"]?.ToString(),
                    date = msg["date"]?.ToString(),
                    size = msg["size"],
                    hashMd5 = msg["hash_md5"]?.ToString(),
                    hashSha256 = msg["hash_sha256"]?.ToString(),
                    folder,
                    uid,
                    contentType = msg["content_type"]?.ToString(),
                    hasAttachments = Convert.ToInt32(msg["has_attachments"] ?? 0) == 1,
                    attachmentCount = Convert.ToInt32(msg["attachment_count"] ?? 0)
                }, new JsonSerializerOptions { WriteIndented = true });

                var headerBytes = Encoding.UTF8.GetBytes(header + "\n---MIME-SOURCE---\n");
                var combined = new byte[headerBytes.Length + emlContent.Length];
                Buffer.BlockCopy(headerBytes, 0, combined, 0, headerBytes.Length);
                Buffer.BlockCopy(emlContent, 0, combined, headerBytes.Length, emlContent.Length);
                await File.WriteAllBytesAsync(destPath, combined);
                exported++;
                OnMessageExported?.Invoke("msg", uid);
            }
            catch { failed++; }
        }

        return new Dictionary<string, object?> { ["exported"] = exported, ["failed"] = failed };
    }

    private async Task<Dictionary<string, object?>> ExportPstDeferredAsync(
        List<Dictionary<string, object?>> messages, string outputDir, int maxSizeGB)
    {
        var maxSizeBytes = (long)maxSizeGB * 1024 * 1024 * 1024;
        var pstDir = Path.Combine(outputDir, "pst_deferred");
        Directory.CreateDirectory(pstDir);

        var sets = new List<(List<Dictionary<string, object?>> Messages, long TotalSize, int Index)>();
        var currentMsgs = new List<Dictionary<string, object?>>();
        long currentSize = 0;

        foreach (var msg in messages)
        {
            var size = Convert.ToInt64(msg["size"] ?? 0);
            if (currentSize + size > maxSizeBytes && currentMsgs.Count > 0)
            {
                sets.Add((currentMsgs, currentSize, sets.Count + 1));
                currentMsgs = [];
                currentSize = 0;
            }
            currentMsgs.Add(msg);
            currentSize += size;
        }
        if (currentMsgs.Count > 0)
            sets.Add((currentMsgs, currentSize, sets.Count + 1));

        foreach (var (msgs, totalSize, index) in sets)
        {
            var setDir = Path.Combine(pstDir, $"set_{index:D3}");
            Directory.CreateDirectory(setDir);

            int exported = 0;
            foreach (var msg in msgs)
            {
                var folder = msg["folder"]?.ToString() ?? "UNKNOWN";
                var folderDir = Path.Combine(setDir, "Items", SanitizePath(folder));
                Directory.CreateDirectory(folderDir);

                var emlPath = msg["eml_path"]?.ToString();
                if (string.IsNullOrEmpty(emlPath)) continue;
                try
                {
                    var uid = Convert.ToUInt32(msg["uid"]);
                    var subject = msg["subject"]?.ToString() ?? "no_subject";
                    var filename = $"{uid}_{SanitizeFilename(subject)}.eml";
                    File.Copy(emlPath, Path.Combine(folderDir, filename), true);
                    exported++;
                }
                catch { }
            }

            var manifest = new { setIndex = index, totalSets = sets.Count, messageCount = msgs.Count, exported, totalSizeBytes = totalSize, maxPstSizeGB = maxSizeGB };
            await File.WriteAllTextAsync(Path.Combine(setDir, "manifest.json"),
                JsonSerializer.Serialize(manifest, new JsonSerializerOptions { WriteIndented = true }));
        }

        return new Dictionary<string, object?> { ["totalSets"] = sets.Count, ["maxPstSizeGB"] = maxSizeGB };
    }

    private async Task<Dictionary<string, object?>> ExportContainerAsync(
        List<Dictionary<string, object?>> messages, string outputDir, string containerType)
    {
        var containerDir = Path.Combine(outputDir, $"container_{containerType}");
        Directory.CreateDirectory(containerDir);

        int exported = 0, failed = 0;
        var byFolder = GroupByFolder(messages);

        foreach (var (folder, msgs) in byFolder)
        {
            var folderDir = Path.Combine(containerDir, SanitizePath(folder));
            Directory.CreateDirectory(folderDir);

            foreach (var msg in msgs)
            {
                var emlPath = msg["eml_path"]?.ToString();
                if (string.IsNullOrEmpty(emlPath)) { failed++; continue; }
                try
                {
                    var uid = Convert.ToUInt32(msg["uid"]);
                    var subject = msg["subject"]?.ToString() ?? "no_subject";
                    var ext = containerType == "msg" ? ".msg" : ".eml";
                    var filename = $"{uid}_{SanitizeFilename(subject)}{ext}";
                    File.Copy(emlPath, Path.Combine(folderDir, filename), true);
                    exported++;
                    OnMessageExported?.Invoke($"container-{containerType}", uid);
                }
                catch { failed++; }
            }
        }

        var manifest = new { projectId = _projectId, containerType, createdAt = DateTime.UtcNow.ToString("o"), totalMessages = exported, totalFailed = failed };
        await File.WriteAllTextAsync(Path.Combine(containerDir, "container_manifest.json"),
            JsonSerializer.Serialize(manifest, new JsonSerializerOptions { WriteIndented = true }));

        return new Dictionary<string, object?> { ["containerDir"] = containerDir, ["exported"] = exported, ["failed"] = failed };
    }

    private static Dictionary<string, List<Dictionary<string, object?>>> GroupByFolder(List<Dictionary<string, object?>> messages)
    {
        var grouped = new Dictionary<string, List<Dictionary<string, object?>>>();
        foreach (var msg in messages)
        {
            var folder = msg["folder"]?.ToString() ?? "UNKNOWN";
            if (!grouped.ContainsKey(folder)) grouped[folder] = [];
            grouped[folder].Add(msg);
        }
        return grouped;
    }

    private static string FormatMboxDate(string? dateStr)
    {
        if (string.IsNullOrEmpty(dateStr)) return DateTime.UtcNow.ToString("ddd MMM dd HH:mm:ss yyyy");
        return DateTime.TryParse(dateStr, out var dt)
            ? dt.ToString("ddd MMM dd HH:mm:ss yyyy")
            : DateTime.UtcNow.ToString("ddd MMM dd HH:mm:ss yyyy");
    }

    private static async Task WriteElementAsync(XmlWriter writer, string name, string value)
    {
        await writer.WriteStartElementAsync(null, name, null);
        await writer.WriteStringAsync(value);
        await writer.WriteEndElementAsync();
    }

    private static string SanitizePath(string path) =>
        System.Text.RegularExpressions.Regex.Replace(path, @"[<>:""|?*/\\]", "_");

    private static string SanitizeFilename(string name)
    {
        var sanitized = System.Text.RegularExpressions.Regex.Replace(name, @"[<>:""/\\|?*\x00-\x1f]", "_");
        return sanitized.Length > 80 ? sanitized[..80] : sanitized;
    }
}
