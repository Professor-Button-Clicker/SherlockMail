using System.Text.Json;
using System.Text.RegularExpressions;

namespace SherlockMail.Core;

public class DriveLink
{
    public string Provider { get; set; } = "";
    public string Url { get; set; } = "";
    public string? FileId { get; set; }
}

public class DriveAttachmentDetector
{
    private static readonly (string Provider, Regex Pattern)[] DriveLinkPatterns =
    [
        ("Google Drive", new Regex(@"https?://drive\.google\.com/(?:file/d/|open\?id=|uc\?id=)([a-zA-Z0-9_-]+)", RegexOptions.Compiled)),
        ("Google Drive", new Regex(@"https?://docs\.google\.com/(?:document|spreadsheets|presentation|forms)/d/([a-zA-Z0-9_-]+)", RegexOptions.Compiled)),
        ("OneDrive", new Regex(@"https?://(?:1drv\.ms|onedrive\.live\.com)/[^\s""<>]+", RegexOptions.Compiled)),
        ("OneDrive", new Regex(@"https?://[a-zA-Z0-9-]+\.sharepoint\.com/(?::f:|:b:|:w:|:x:|:p:)/[^\s""<>]+", RegexOptions.Compiled)),
        ("SharePoint", new Regex(@"https?://[a-zA-Z0-9-]+\.sharepoint\.com/sites/[^\s""<>]+", RegexOptions.Compiled)),
        ("Dropbox", new Regex(@"https?://(?:www\.)?dropbox\.com/(?:s|sh|scl)/[a-zA-Z0-9_-]+[^\s""<>]*", RegexOptions.Compiled)),
        ("Box", new Regex(@"https?://(?:app\.)?box\.com/s/[a-zA-Z0-9]+", RegexOptions.Compiled)),
        ("iCloud", new Regex(@"https?://www\.icloud\.com/iclouddrive/[^\s""<>]+", RegexOptions.Compiled)),
    ];

    private readonly ForensicDatabase _db;
    private readonly string _projectId;

    public DriveAttachmentDetector(ForensicDatabase db, string projectId)
    {
        _db = db;
        _projectId = projectId;
    }

    public List<DriveLink> DetectLinksInContent(string content)
    {
        if (string.IsNullOrEmpty(content)) return [];

        var links = new List<DriveLink>();
        var seen = new HashSet<string>();

        foreach (var (provider, pattern) in DriveLinkPatterns)
        {
            foreach (Match match in pattern.Matches(content))
            {
                var url = match.Value.TrimEnd('"', '>', '\'', ']', ')', ' ');
                if (seen.Add(url))
                {
                    links.Add(new DriveLink
                    {
                        Provider = provider,
                        Url = url,
                        FileId = match.Groups.Count > 1 ? match.Groups[1].Value : null
                    });
                }
            }
        }

        return links;
    }

    public async Task<(int Scanned, int WithLinks, int TotalLinks, Dictionary<string, int> ByProvider)>
        ScanAllMessagesAsync()
    {
        var messages = _db.QueryAll(
            "SELECT id, eml_path, subject, from_address FROM messages WHERE project_id = @p0", _projectId);

        int scanned = 0, withLinks = 0, totalLinks = 0;
        var byProvider = new Dictionary<string, int>();

        foreach (var msg in messages)
        {
            var emlPath = msg["eml_path"]?.ToString();
            if (string.IsNullOrEmpty(emlPath)) { scanned++; continue; }

            try
            {
                var content = await File.ReadAllTextAsync(emlPath);
                var links = DetectLinksInContent(content);
                scanned++;

                if (links.Count > 0)
                {
                    withLinks++;
                    totalLinks += links.Count;

                    foreach (var link in links)
                    {
                        _db.InsertDriveLink(Guid.NewGuid().ToString(), _projectId,
                            msg["id"]!.ToString()!, link.Provider, link.Url, link.FileId,
                            "detected", DateTime.UtcNow.ToString("o"));

                        byProvider[link.Provider] = byProvider.GetValueOrDefault(link.Provider) + 1;
                    }
                }
            }
            catch { scanned++; }
        }

        return (scanned, withLinks, totalLinks, byProvider);
    }

    public Dictionary<string, object?> GetDriveLinkStats()
    {
        var total = _db.QueryOne("SELECT COUNT(*) as count FROM drive_links WHERE project_id = @p0", _projectId);
        var byProvider = _db.QueryAll("SELECT provider, COUNT(*) as count FROM drive_links WHERE project_id = @p0 GROUP BY provider", _projectId);
        var byStatus = _db.QueryAll("SELECT status, COUNT(*) as count FROM drive_links WHERE project_id = @p0 GROUP BY status", _projectId);
        var messagesWithLinks = _db.QueryOne("SELECT COUNT(DISTINCT message_id) as count FROM drive_links WHERE project_id = @p0", _projectId);

        return new Dictionary<string, object?>
        {
            ["totalLinks"] = total?["count"],
            ["messagesWithLinks"] = messagesWithLinks?["count"],
            ["byProvider"] = byProvider,
            ["byStatus"] = byStatus
        };
    }
}
