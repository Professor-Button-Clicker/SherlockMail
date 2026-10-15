using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.FileProviders;
using SherlockMail.Auth;
using SherlockMail.Core;
using SherlockMail.Protocols;
using SherlockMail.Search;

namespace SherlockMail.Web;

public static class WebServer
{
    private static readonly ConcurrentDictionary<string, CollectionProgress> ActiveCollections = new();
    private static GoogleOAuth? _oauth;

    public static async Task RunAsync(string dbPath, int port, string wwwrootPath, CancellationToken ct = default)
    {
        var db = ForensicDatabase.Create(dbPath);
        var configDir = Path.Combine(Path.GetDirectoryName(dbPath)!, "..", "config");
        _oauth = new GoogleOAuth(configDir, port);

        var builder = WebApplication.CreateBuilder();
        builder.WebHost.ConfigureKestrel(o => o.ListenAnyIP(port));
        builder.Logging.ClearProviders();

        var app = builder.Build();

        if (Directory.Exists(wwwrootPath))
            app.UseStaticFiles(new StaticFileOptions { FileProvider = new PhysicalFileProvider(wwwrootPath) });

        var api = app.MapGroup("/api");

        // --- Projects ---
        api.MapGet("/projects", () => db.ListProjects().Select(p => WithParsedConfig(p)));

        api.MapPost("/projects", (JsonElement body) =>
        {
            var id = Guid.NewGuid().ToString();
            var name = body.GetProperty("name").GetString() ?? "";
            var caseId = body.TryGetProperty("caseId", out var ci) ? ci.GetString() : null;
            var custodianName = body.TryGetProperty("custodianName", out var cn) ? cn.GetString() : null;
            var examinerId = body.TryGetProperty("examinerId", out var ei) ? ei.GetString() : null;
            var examinerName = body.TryGetProperty("examinerName", out var en) ? en.GetString() : null;
            var config = body.TryGetProperty("config", out var cfg) ? cfg.GetRawText() : "{}";

            db.CreateProject(id, name, caseId, custodianName, examinerId, examinerName, null, config);
            var custody = new ChainOfCustody(db, id, examinerName ?? "Unknown");
            custody.LogProjectCreated(new { caseId, custodianName, examinerId });
            return Results.Json(new { id });
        });

        api.MapGet("/projects/{id}", (string id) =>
        {
            var project = db.GetProject(id);
            if (project == null) return Results.NotFound(new { error = "Project not found" });
            var stats = db.GetProjectStats(id);
            var result = WithParsedConfig(project);
            result["stats"] = stats;
            return Results.Json(result);
        });

        api.MapGet("/projects/{id}/folders", (string id) => db.GetFolders(id));

        api.MapGet("/projects/{id}/messages", (string id, string? folder, int limit = 100, int offset = 0) =>
        {
            if (folder != null)
                return db.GetMessagesByFolder(id, folder, limit, offset);
            return db.QueryAll("SELECT * FROM messages WHERE project_id = @p0 ORDER BY date DESC LIMIT @p1 OFFSET @p2", id, limit, offset);
        });

        api.MapGet("/projects/{id}/messages/{msgId}", (string id, string msgId) =>
        {
            var msg = db.GetMessage(msgId);
            if (msg == null) return Results.NotFound(new { error = "Message not found" });
            var attachments = db.GetAttachments(msgId);
            msg["attachments"] = attachments;
            msg["headers"] = TryParseJson(msg["headers_json"]?.ToString());
            return Results.Json(msg);
        });

        api.MapGet("/projects/{id}/search", (string id, string? q, string type = "basic") =>
        {
            if (string.IsNullOrEmpty(q)) return Results.Json(Array.Empty<object>());
            if (type == "inline")
            {
                var all = db.QueryAll("SELECT * FROM messages WHERE project_id = @p0", id);
                var search = new InlineSearch();
                return Results.Json(search.Search(all, q));
            }
            return Results.Json(db.SearchMessages(id, q));
        });

        api.MapGet("/projects/{id}/audit", (string id) => db.GetAuditLog(id));

        api.MapGet("/projects/{id}/audit/verify", (string id) =>
        {
            var custody = new ChainOfCustody(db, id, "");
            var (valid, @checked, total, results) = custody.VerifyChain();
            return new { valid, @checked, total, results };
        });

        api.MapGet("/projects/{id}/stats", (string id) => db.GetProjectStats(id));

        api.MapGet("/projects/{id}/acquisitions", (string id) => db.ListAcquisitions(id));

        api.MapPost("/projects/{id}/verify/{msgId}", async (string id, string msgId) =>
        {
            var msg = db.GetMessage(msgId);
            if (msg == null) return Results.NotFound(new { error = "Message not found" });
            var emlPath = msg["eml_path"]?.ToString();
            if (string.IsNullOrEmpty(emlPath)) return Results.BadRequest(new { error = "No EML file path" });
            if (!File.Exists(emlPath)) return Results.NotFound(new { error = "EML file not found on disk" });

            var hash = await Hasher.HashFileAsync(emlPath, "sha256");
            var expected = msg["hash_sha256"]?.ToString() ?? "";
            return Results.Json(new { valid = hash == expected, expected, actual = hash, algorithm = "sha256", emlPath });
        });

        api.MapGet("/projects/{id}/eml/{msgId}", async (string id, string msgId) =>
        {
            var msg = db.GetMessage(msgId);
            var emlPath = msg?["eml_path"]?.ToString();
            if (string.IsNullOrEmpty(emlPath) || !File.Exists(emlPath))
                return Results.NotFound(new { error = "EML not found" });
            var content = await File.ReadAllTextAsync(emlPath);
            return Results.Text(content, "message/rfc822");
        });

        // --- Provider Detection ---
        api.MapPost("/detect-provider", async (JsonElement body) =>
        {
            var email = body.GetProperty("email").GetString();
            if (string.IsNullOrEmpty(email)) return Results.BadRequest(new { error = "Email required" });
            var result = await ProviderDetect.DetectAsync(email);
            return Results.Json(result);
        });

        api.MapGet("/providers", () => ProviderDetect.ListProviders());

        // --- QC Verification ---
        api.MapPost("/projects/{id}/qc", async (string id, JsonElement body) =>
        {
            var project = db.GetProject(id);
            if (project == null) return Results.NotFound(new { error = "Project not found" });

            var host = body.GetProperty("host").GetString();
            if (string.IsNullOrEmpty(host)) return Results.BadRequest(new { error = "IMAP host is required" });

            var port = body.TryGetProperty("port", out var p) ? p.GetInt32() : 993;
            var tls = !body.TryGetProperty("tls", out var t) || t.GetBoolean();
            var username = body.TryGetProperty("username", out var u) ? u.GetString() : project["target_email"]?.ToString();
            var password = body.TryGetProperty("password", out var pw) ? pw.GetString() : null;
            var appPassword = body.TryGetProperty("appPassword", out var ap) ? ap.GetString() : null;
            var verifyHashes = !body.TryGetProperty("verifyHashes", out var vh) || vh.GetBoolean();
            var sampleSize = body.TryGetProperty("sampleSize", out var ss) ? ss.GetInt32() : 0;

            try
            {
                var verifier = new QCVerifier(db, id, host, port, tls,
                    project["target_email"]?.ToString() ?? "", username, password, appPassword);
                var results = await verifier.VerifyAsync(verifyHashes, sampleSize);
                return Results.Json(results);
            }
            catch (Exception ex)
            {
                return Results.Json(new { error = ex.Message }, statusCode: 500);
            }
        });

        api.MapGet("/projects/{id}/qc", (string id) =>
        {
            var results = db.GetQCResults(id);
            return results.Select(r =>
            {
                r["results"] = TryParseJson(r["results_json"]?.ToString());
                return r;
            });
        });

        // --- Export ---
        api.MapPost("/projects/{id}/export", async (string id, JsonElement body) =>
        {
            var project = db.GetProject(id);
            if (project == null) return Results.NotFound(new { error = "Project not found" });

            var format = body.GetProperty("format").GetString();
            if (string.IsNullOrEmpty(format)) return Results.BadRequest(new { error = "Export format is required" });

            var exeDir = AppContext.BaseDirectory;
            var outputDir = body.TryGetProperty("outputDir", out var od) ? od.GetString()
                : Path.Combine(exeDir, "exports", id, format);

            try
            {
                var exporter = new ForensicExporter(db, id);
                var result = await exporter.ExportAsync(format, outputDir!);
                return Results.Json(result);
            }
            catch (Exception ex)
            {
                return Results.Json(new { error = ex.Message }, statusCode: 500);
            }
        });

        api.MapGet("/projects/{id}/exports", (string id) =>
        {
            var records = db.GetExportRecords(id);
            return records.Select(r =>
            {
                r["details"] = TryParseJson(r["details_json"]?.ToString());
                return r;
            });
        });

        // --- Drive Links ---
        api.MapPost("/projects/{id}/scan-drive-links", async (string id) =>
        {
            var detector = new DriveAttachmentDetector(db, id);
            var (scanned, withLinks, totalLinks, byProvider) = await detector.ScanAllMessagesAsync();
            return new { scanned, withLinks, totalLinks, byProvider };
        });

        api.MapGet("/projects/{id}/drive-links", (string id, string? messageId) =>
            db.GetDriveLinks(id, messageId));

        api.MapGet("/projects/{id}/drive-link-stats", (string id) =>
        {
            var detector = new DriveAttachmentDetector(db, id);
            return detector.GetDriveLinkStats();
        });

        // --- Test Connection ---
        api.MapPost("/test-connection", async (JsonElement body) =>
        {
            var host = body.GetProperty("host").GetString()!;
            var email = body.GetProperty("email").GetString()!;
            var port = body.TryGetProperty("port", out var p) ? p.GetInt32() : 993;
            var tls = !body.TryGetProperty("tls", out var t) || t.GetBoolean();
            var username = body.TryGetProperty("username", out var u) ? u.GetString() : email;
            var password = body.TryGetProperty("password", out var pw) ? pw.GetString() : null;
            var appPassword = body.TryGetProperty("appPassword", out var ap) ? ap.GetString() : null;
            var useOAuth = body.TryGetProperty("useOAuth", out var oa) && oa.GetBoolean();

            string? accessToken = null;
            if (useOAuth && _oauth != null)
            {
                accessToken = await _oauth.GetAccessTokenAsync(email);
                if (accessToken == null)
                    return Results.Json(new { success = false, message = "No OAuth tokens found. Please sign in with Google first." });
            }

            using var client = new ForensicImapClient(host, port, tls, email, username, password, appPassword, accessToken);
            try
            {
                await client.ConnectAsync();
                await client.DisconnectAsync();
                return Results.Json(new { success = true, message = "Connection successful" });
            }
            catch (Exception ex)
            {
                return Results.Json(new { success = false, message = ex.Message });
            }
        });

        // --- List Remote Folders ---
        api.MapPost("/list-remote-folders", async (JsonElement body) =>
        {
            var host = body.GetProperty("host").GetString()!;
            var email = body.GetProperty("email").GetString()!;
            var port = body.TryGetProperty("port", out var p) ? p.GetInt32() : 993;
            var tls = !body.TryGetProperty("tls", out var t) || t.GetBoolean();
            var username = body.TryGetProperty("username", out var u) ? u.GetString() : email;
            var password = body.TryGetProperty("password", out var pw) ? pw.GetString() : null;
            var appPassword = body.TryGetProperty("appPassword", out var ap) ? ap.GetString() : null;
            var useOAuth = body.TryGetProperty("useOAuth", out var oa) && oa.GetBoolean();

            string? accessToken = null;
            if (useOAuth && _oauth != null)
                accessToken = await _oauth.GetAccessTokenAsync(email);

            using var client = new ForensicImapClient(host, port, tls, email, username, password, appPassword, accessToken);
            try
            {
                await client.ConnectAsync();
                var folders = await client.ListFoldersAsync();
                await client.DisconnectAsync();
                return Results.Json(folders);
            }
            catch (Exception ex)
            {
                return Results.Json(new { error = ex.Message }, statusCode: 500);
            }
        });

        // --- Search Remote ---
        api.MapPost("/search-remote", async (JsonElement body) =>
        {
            var conn = body.GetProperty("connection");
            var host = conn.GetProperty("host").GetString()!;
            var email = conn.GetProperty("email").GetString()!;
            var port = conn.TryGetProperty("port", out var p) ? p.GetInt32() : 993;
            var tls = !conn.TryGetProperty("tls", out var t) || t.GetBoolean();
            var username = conn.TryGetProperty("username", out var u) ? u.GetString() : email;
            var password = conn.TryGetProperty("password", out var pw) ? pw.GetString() : null;
            var appPassword = conn.TryGetProperty("appPassword", out var ap) ? ap.GetString() : null;
            var useOAuth = conn.TryGetProperty("useOAuth", out var oa) && oa.GetBoolean();

            string? accessToken = null;
            if (useOAuth && _oauth != null)
                accessToken = await _oauth.GetAccessTokenAsync(email);

            var foldersEl = body.GetProperty("folders");
            var folders = foldersEl.EnumerateArray().Select(f => f.GetString()!).ToList();
            var criteriaEl = body.GetProperty("criteria");
            var criteria = new Dictionary<string, string?>();
            foreach (var prop in criteriaEl.EnumerateObject())
                criteria[prop.Name] = prop.Value.GetString();

            using var client = new ForensicImapClient(host, port, tls, email, username, password, appPassword, accessToken);
            try
            {
                await client.ConnectAsync();
                var searchQuery = ForensicImapClient.BuildSearchQuery(criteria);
                var results = new List<object>();

                foreach (var folderPath in folders)
                {
                    var uids = await client.SearchMessagesAsync(folderPath, searchQuery);
                    if (uids.Count == 0) continue;

                    await foreach (var msg in client.FetchMessagesAsync(folderPath, uids))
                    {
                        results.Add(new
                        {
                            uid = msg.Uid,
                            folder = folderPath,
                            from = msg.FromAddress ?? "",
                            to = msg.ToAddresses ?? "",
                            subject = msg.Subject ?? "(no subject)",
                            date = msg.Date ?? "",
                            size = msg.Size
                        });
                    }
                }

                await client.DisconnectAsync();
                return Results.Json(new { results, total = results.Count });
            }
            catch (Exception ex)
            {
                return Results.Json(new { error = ex.Message }, statusCode: 500);
            }
        });

        // --- Start Collection ---
        api.MapPost("/start-collection", async (JsonElement body) =>
        {
            var projectId = body.GetProperty("projectId").GetString()!;
            var project = db.GetProject(projectId);
            if (project == null) return Results.NotFound(new { error = "Project not found" });

            var conn = body.GetProperty("connection");
            var collectionId = Guid.NewGuid().ToString();
            var exeDir = AppContext.BaseDirectory;

            var connEmail = conn.GetProperty("email").GetString()!;
            var useOAuth = conn.TryGetProperty("useOAuth", out var oaVal) && oaVal.GetBoolean();
            string? oauthToken = null;
            if (useOAuth && _oauth != null)
                oauthToken = await _oauth.GetAccessTokenAsync(connEmail);

            var config = new AcquisitionConfig
            {
                Host = conn.GetProperty("host").GetString()!,
                Port = conn.TryGetProperty("port", out var p) ? p.GetInt32() : 993,
                Tls = !conn.TryGetProperty("tls", out var t) || t.GetBoolean(),
                Email = connEmail,
                Username = conn.TryGetProperty("username", out var u) ? u.GetString() : null,
                Password = conn.TryGetProperty("password", out var pw) ? pw.GetString() : null,
                AppPassword = conn.TryGetProperty("appPassword", out var ap) ? ap.GetString() : null,
                AccessToken = oauthToken,
                OutputDir = body.TryGetProperty("outputDir", out var od) ? od.GetString()! : Path.Combine(exeDir, "output", projectId),
                CollectDriveLinks = !body.TryGetProperty("collectDriveLinks", out var cdl) || cdl.GetBoolean(),
                ExaminerName = project["examiner_name"]?.ToString() ?? "Unknown"
            };

            if (body.TryGetProperty("targetedUids", out var tu) && tu.ValueKind == JsonValueKind.Object)
            {
                config.TargetedUids = new Dictionary<string, List<uint>>();
                foreach (var prop in tu.EnumerateObject())
                    config.TargetedUids[prop.Name] = prop.Value.EnumerateArray().Select(v => v.GetUInt32()).ToList();
            }

            var progress = new CollectionProgress
            {
                Id = collectionId,
                ProjectId = projectId,
                Status = "running",
                Phase = "connecting",
                StartTime = DateTime.UtcNow.ToString("o")
            };
            progress.Logs.Add("Starting collection...");
            ActiveCollections[collectionId] = progress;

            var engine = new AcquisitionEngine(db, projectId, config);
            engine.OnLog += msg => progress.Logs.Add(msg);
            engine.OnMessageAcquired += (folder, uid, subject, acquired, total) =>
            {
                progress.AcquiredMessages = acquired;
                progress.TotalBytes = engine.Stats.TotalBytes;
            };
            engine.OnMessageFailed += (folder, uid, error) =>
            {
                progress.FailedMessages++;
                progress.Errors.Add(error);
            };

            _ = Task.Run(async () =>
            {
                try
                {
                    await engine.RunAsync(ct);
                    progress.Status = "completed";
                    progress.Phase = "completed";
                    progress.EndTime = DateTime.UtcNow.ToString("o");
                    progress.TotalMessages = engine.Stats.TotalMessages;
                    progress.AcquiredMessages = engine.Stats.AcquiredMessages;
                    progress.TotalBytes = engine.Stats.TotalBytes;
                }
                catch (Exception ex)
                {
                    progress.Status = "failed";
                    progress.Phase = "failed";
                    progress.EndTime = DateTime.UtcNow.ToString("o");
                    progress.Errors.Add(ex.Message);
                }
            });

            return Results.Json(new { collectionId, status = "started" });
        });

        api.MapGet("/collection-progress/{collectionId}", (string collectionId) =>
        {
            if (ActiveCollections.TryGetValue(collectionId, out var progress))
                return Results.Json(progress);
            return Results.NotFound(new { error = "Collection not found" });
        });

        // --- Transfer ---
        api.MapPost("/transfer", (JsonElement body) =>
        {
            var sourceDir = body.GetProperty("sourceDir").GetString();
            var destDir = body.GetProperty("destDir").GetString();
            if (string.IsNullOrEmpty(sourceDir) || string.IsNullOrEmpty(destDir))
                return Results.BadRequest(new { error = "Source and destination directories required" });
            try
            {
                CopyDirectory(sourceDir, destDir);
                return Results.Json(new { success = true, source = sourceDir, destination = destDir });
            }
            catch (Exception ex) { return Results.Json(new { error = ex.Message }, statusCode: 500); }
        });

        // --- Google OAuth ---
        api.MapGet("/oauth/google/status", (string? email) =>
        {
            if (_oauth == null) return Results.Json(new { configured = false });
            var result = new
            {
                configured = _oauth.IsConfigured,
                hasTokens = !string.IsNullOrEmpty(email) && _oauth.HasTokens(email),
                email = !string.IsNullOrEmpty(email) ? _oauth.GetTokenInfo(email)?.Email : null,
                expiresAt = !string.IsNullOrEmpty(email) ? _oauth.GetTokenInfo(email)?.ExpiresAt.ToString("o") : null
            };
            return Results.Json(result);
        });

        api.MapPost("/oauth/google/configure", (JsonElement body) =>
        {
            if (_oauth == null) return Results.Json(new { error = "OAuth not initialized" }, statusCode: 500);
            var clientId = body.GetProperty("clientId").GetString();
            var clientSecret = body.GetProperty("clientSecret").GetString();
            if (string.IsNullOrEmpty(clientId) || string.IsNullOrEmpty(clientSecret))
                return Results.BadRequest(new { error = "Client ID and Secret are required" });
            _oauth.SaveCredentials(clientId, clientSecret);
            return Results.Json(new { success = true });
        });

        api.MapPost("/oauth/google/start", (JsonElement body) =>
        {
            if (_oauth == null) return Results.Json(new { error = "OAuth not initialized" }, statusCode: 500);
            var email = body.TryGetProperty("email", out var e) ? e.GetString() ?? "" : "";
            try
            {
                var (authUrl, state) = _oauth.StartAuthFlow(email);
                return Results.Json(new { authUrl, state });
            }
            catch (Exception ex)
            {
                return Results.Json(new { error = ex.Message }, statusCode: 400);
            }
        });

        app.MapGet("/api/oauth/google/callback", async (HttpContext ctx) =>
        {
            var code = ctx.Request.Query["code"].ToString();
            var state = ctx.Request.Query["state"].ToString();
            var error = ctx.Request.Query["error"].ToString();

            if (!string.IsNullOrEmpty(error))
            {
                ctx.Response.ContentType = "text/html";
                await ctx.Response.WriteAsync(OAuthResultPage("Authorization Denied",
                    $"Google returned an error: {error}. You can close this tab.", false));
                return;
            }

            try
            {
                var tokens = await _oauth!.HandleCallbackAsync(code, state);
                ctx.Response.ContentType = "text/html";
                await ctx.Response.WriteAsync(OAuthResultPage("Authorization Successful",
                    $"Signed in as <strong>{tokens.Email}</strong>. You can close this tab and return to SherlockMail.", true));
            }
            catch (Exception ex)
            {
                ctx.Response.ContentType = "text/html";
                await ctx.Response.WriteAsync(OAuthResultPage("Authorization Failed",
                    $"Error: {ex.Message}", false));
            }
        });

        api.MapPost("/oauth/google/token", async (JsonElement body) =>
        {
            if (_oauth == null) return Results.Json(new { error = "OAuth not initialized" }, statusCode: 500);
            var email = body.GetProperty("email").GetString();
            if (string.IsNullOrEmpty(email)) return Results.BadRequest(new { error = "Email required" });

            try
            {
                var accessToken = await _oauth.GetAccessTokenAsync(email);
                if (accessToken == null)
                    return Results.Json(new { error = "No tokens found. Please sign in first." }, statusCode: 401);
                return Results.Json(new { accessToken, email });
            }
            catch (Exception ex)
            {
                return Results.Json(new { error = ex.Message }, statusCode: 500);
            }
        });

        api.MapPost("/oauth/google/revoke", (JsonElement body) =>
        {
            if (_oauth == null) return Results.Json(new { error = "OAuth not initialized" }, statusCode: 500);
            var email = body.GetProperty("email").GetString();
            if (string.IsNullOrEmpty(email)) return Results.BadRequest(new { error = "Email required" });
            _oauth.RevokeTokens(email);
            return Results.Json(new { success = true });
        });

        // --- System ---
        api.MapGet("/system", () =>
        {
            var stats = db.GetSystemStats();
            return new
            {
                version = "2.0.0",
                name = "SherlockMail",
                runtime = ".NET " + Environment.Version,
                totalProjects = stats["totalProjects"],
                totalMessages = stats["totalMessages"],
                totalSize = stats["totalSize"],
                uptime = Environment.TickCount64 / 1000
            };
        });

        app.MapFallbackToFile("index.html");

        Console.WriteLine();
        Console.WriteLine("  SherlockMail Dashboard");
        Console.WriteLine("  ========================");
        Console.WriteLine($"  Running at: http://localhost:{port}");
        Console.WriteLine($"  Database:   {dbPath}");
        Console.WriteLine($"  Runtime:    .NET {Environment.Version}");
        Console.WriteLine();

        await app.RunAsync(ct);
    }

    private static Dictionary<string, object?> WithParsedConfig(Dictionary<string, object?> project)
    {
        if (project.TryGetValue("config", out var cfg) && cfg is string json)
            project["config"] = TryParseJson(json);
        return project;
    }

    private static object? TryParseJson(string? json)
    {
        if (string.IsNullOrEmpty(json)) return json;
        try { return JsonSerializer.Deserialize<object>(json); }
        catch { return json; }
    }

    private static string OAuthResultPage(string title, string message, bool success)
    {
        var color = success ? "#3ddfa0" : "#f06868";
        var icon = success ? "&#10003;" : "&#10007;";
        return $@"<!DOCTYPE html><html><head><title>{title}</title>
<style>body{{font-family:'Inter',sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#0F1B2D;color:#F0EBE3}}
.card{{text-align:center;padding:48px;border-radius:12px;background:#142236;max-width:400px}}
.icon{{font-size:48px;color:{color};margin-bottom:16px}}
h1{{font-size:20px;margin-bottom:12px}}p{{color:#9AA8B8;line-height:1.6}}</style></head>
<body><div class='card'><div class='icon'>{icon}</div><h1>{title}</h1><p>{message}</p></div>
<script>setTimeout(()=>window.close(),5000)</script></body></html>";
    }

    private static void CopyDirectory(string source, string dest)
    {
        Directory.CreateDirectory(dest);
        foreach (var file in Directory.GetFiles(source))
            File.Copy(file, Path.Combine(dest, Path.GetFileName(file)), true);
        foreach (var dir in Directory.GetDirectories(source))
            CopyDirectory(dir, Path.Combine(dest, Path.GetFileName(dir)));
    }
}

internal class CollectionProgress
{
    public string Id { get; set; } = "";
    public string ProjectId { get; set; } = "";
    public string Status { get; set; } = "pending";
    public string Phase { get; set; } = "";
    public int TotalMessages { get; set; }
    public int AcquiredMessages { get; set; }
    public int FailedMessages { get; set; }
    public int SkippedMessages { get; set; }
    public long TotalBytes { get; set; }
    public int DriveLinksDetected { get; set; }
    public string CurrentFolder { get; set; } = "";
    public List<string> Errors { get; set; } = [];
    public List<string> Logs { get; set; } = [];
    public string? StartTime { get; set; }
    public string? EndTime { get; set; }
}
