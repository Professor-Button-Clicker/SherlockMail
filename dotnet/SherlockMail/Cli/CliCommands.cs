using System.CommandLine;
using SherlockMail.Auth;
using SherlockMail.Core;
using SherlockMail.Search;

namespace SherlockMail.Cli;

public static class CliCommands
{
    public static RootCommand BuildRootCommand(string dbPath, string exeDir)
    {
        var root = new RootCommand("SherlockMail — Forensic email acquisition and analysis tool");

        root.AddCommand(BuildCreateCommand(dbPath));
        root.AddCommand(BuildAcquireCommand(dbPath));
        root.AddCommand(BuildListCommand(dbPath));
        root.AddCommand(BuildSearchCommand(dbPath));
        root.AddCommand(BuildDetectCommand());
        root.AddCommand(BuildQCCommand(dbPath));
        root.AddCommand(BuildExportCommand(dbPath));
        root.AddCommand(BuildDriveScanCommand(dbPath));
        root.AddCommand(BuildAuditCommand(dbPath));
        root.AddCommand(BuildProvidersCommand());
        root.AddCommand(BuildServeCommand(dbPath, exeDir));

        return root;
    }

    private static Command BuildCreateCommand(string dbPath)
    {
        var cmd = new Command("create", "Create a new forensic acquisition project");
        var nameOpt = new Option<string>("--name", "Project name") { IsRequired = true };
        nameOpt.AddAlias("-n");
        var emailOpt = new Option<string>("--email", "Target email address") { IsRequired = true };
        emailOpt.AddAlias("-e");
        var caseIdOpt = new Option<string?>("--case-id", "Case/matter ID");
        var examinerOpt = new Option<string?>("--examiner", "Examiner name");

        cmd.AddOption(nameOpt);
        cmd.AddOption(emailOpt);
        cmd.AddOption(caseIdOpt);
        cmd.AddOption(examinerOpt);

        cmd.SetHandler(async (string name, string email, string? caseId, string? examiner) =>
        {
            using var db = ForensicDatabase.Create(dbPath);
            var id = Guid.NewGuid().ToString();
            db.CreateProject(id, name, caseId, null, null, examiner, email, "{}");

            var custody = new ChainOfCustody(db, id, examiner ?? "CLI");
            custody.LogProjectCreated(new { targetEmail = email, caseId });

            Console.WriteLine($"\n  Project created");
            Console.WriteLine($"  ID:    {id}");
            Console.WriteLine($"  Name:  {name}");
            Console.WriteLine($"  Email: {email}");
        }, nameOpt, emailOpt, caseIdOpt, examinerOpt);

        return cmd;
    }

    private static Command BuildAcquireCommand(string dbPath)
    {
        var cmd = new Command("acquire", "Run a forensic email acquisition");
        var projectOpt = new Option<string>("--project", "Project ID") { IsRequired = true };
        projectOpt.AddAlias("-p");
        var hostOpt = new Option<string>("--host", "IMAP server host") { IsRequired = true };
        hostOpt.AddAlias("-H");
        var portOpt = new Option<int>("--port", () => 993, "IMAP server port");
        var userOpt = new Option<string?>("--user", "Username");
        userOpt.AddAlias("-u");
        var passwordOpt = new Option<string?>("--password", "Password");
        var appPasswordOpt = new Option<string?>("--app-password", "App-specific password");
        var outputOpt = new Option<string>("--output", () => "./projects", "Output directory");
        outputOpt.AddAlias("-o");

        cmd.AddOption(projectOpt);
        cmd.AddOption(hostOpt);
        cmd.AddOption(portOpt);
        cmd.AddOption(userOpt);
        cmd.AddOption(passwordOpt);
        cmd.AddOption(appPasswordOpt);
        cmd.AddOption(outputOpt);

        cmd.SetHandler(async (string projectId, string host, int port, string? user, string? password, string? appPassword, string output) =>
        {
            using var db = ForensicDatabase.Create(dbPath);
            var project = db.GetProject(projectId);
            if (project == null) { Console.Error.WriteLine("Project not found"); return; }

            Console.WriteLine($"\n  SherlockMail — Acquisition");
            Console.WriteLine($"  Project: {project["name"]}");
            Console.WriteLine($"  Target:  {project["target_email"]}");
            Console.WriteLine($"  Server:  {host}:{port}\n");

            var config = new AcquisitionConfig
            {
                Host = host, Port = port, Tls = true,
                Email = project["target_email"]?.ToString() ?? "",
                Username = user ?? project["target_email"]?.ToString(),
                Password = password, AppPassword = appPassword,
                OutputDir = Path.Combine(output, projectId),
                ExaminerName = project["examiner_name"]?.ToString()
            };

            var engine = new AcquisitionEngine(db, projectId, config);
            engine.OnLog += msg => Console.WriteLine($"  {msg}");
            engine.OnFolderStart += folder => Console.WriteLine($"\n  Acquiring folder: {folder}");
            engine.OnMessageAcquired += (folder, uid, subject, acquired, total) =>
                Console.Write($"\r  [{acquired}/{total}] {(subject ?? "(no subject)")[..Math.Min(subject?.Length ?? 0, 60)]}".PadRight(80));
            engine.OnMessageFailed += (folder, uid, error) =>
                Console.WriteLine($"\n  FAIL UID {uid}: {error}");

            try
            {
                var (_, stats) = await engine.RunAsync();
                Console.WriteLine($"\n\n  Acquisition Complete");
                Console.WriteLine($"  Acquired:   {stats.AcquiredMessages}");
                Console.WriteLine($"  Failed:     {stats.FailedMessages}");
                Console.WriteLine($"  Skipped:    {stats.SkippedMessages}");
                Console.WriteLine($"  Total size: {FormatBytes(stats.TotalBytes)}\n");
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"\n  Acquisition failed: {ex.Message}");
            }
        }, projectOpt, hostOpt, portOpt, userOpt, passwordOpt, appPasswordOpt, outputOpt);

        return cmd;
    }

    private static Command BuildListCommand(string dbPath)
    {
        var cmd = new Command("list", "List all projects");
        cmd.SetHandler(() =>
        {
            using var db = ForensicDatabase.Create(dbPath);
            var projects = db.ListProjects();
            if (projects.Count == 0) { Console.WriteLine("  No projects found."); return; }
            Console.WriteLine("\n  Projects\n  ========");
            foreach (var p in projects)
                Console.WriteLine($"  {p["id"]?.ToString()?[..8]}  {p["name"]?.ToString()?.PadRight(30)}  {p["target_email"]?.ToString()?.PadRight(30)}  {p["status"]}  {p["created_at"]}");
            Console.WriteLine();
        });
        return cmd;
    }

    private static Command BuildSearchCommand(string dbPath)
    {
        var cmd = new Command("search", "Search messages in a project");
        var projectOpt = new Option<string>("--project", "Project ID") { IsRequired = true };
        projectOpt.AddAlias("-p");
        var queryOpt = new Option<string>("--query", "Search query") { IsRequired = true };
        queryOpt.AddAlias("-q");
        var inlineOpt = new Option<bool>("--inline", "Use inline search");

        cmd.AddOption(projectOpt);
        cmd.AddOption(queryOpt);
        cmd.AddOption(inlineOpt);

        cmd.SetHandler((string projectId, string query, bool inline) =>
        {
            using var db = ForensicDatabase.Create(dbPath);
            List<Dictionary<string, object?>> results;
            if (inline)
            {
                var all = db.QueryAll("SELECT * FROM messages WHERE project_id = @p0", projectId);
                var search = new InlineSearch();
                results = search.Search(all, query);
            }
            else
            {
                results = db.SearchMessages(projectId, query);
            }

            Console.WriteLine($"\n  Search Results ({results.Count})\n  ==============");
            foreach (var m in results.Take(50))
                Console.WriteLine($"  {m["date"]?.ToString()?[..Math.Min(m["date"]?.ToString()?.Length ?? 0, 10)]}  {m["from_address"]?.ToString()?.PadRight(30)[..30]}  {m["subject"]?.ToString()?[..Math.Min(m["subject"]?.ToString()?.Length ?? 0, 50)]}");
            if (results.Count > 50) Console.WriteLine($"  ... and {results.Count - 50} more");
            Console.WriteLine();
        }, projectOpt, queryOpt, inlineOpt);

        return cmd;
    }

    private static Command BuildDetectCommand()
    {
        var cmd = new Command("detect", "Detect email provider from email address");
        var emailArg = new Argument<string>("email", "Email address");
        cmd.AddArgument(emailArg);

        cmd.SetHandler(async (string email) =>
        {
            var result = await ProviderDetect.DetectAsync(email);
            Console.WriteLine($"\n  Provider Detection");
            Console.WriteLine($"  Provider: {result.Profile.Name}");
            Console.WriteLine($"  Type:     {result.Profile.Type}");
            Console.WriteLine($"  Method:   {result.Method}");
            Console.WriteLine($"  IMAP:     {result.Profile.ImapHost}:{result.Profile.ImapPort}");
            if (result.Profile.SupportsOAuth) Console.WriteLine("  Supports OAuth 2.0");
            if (result.Profile.RequiresAppPassword) Console.WriteLine("  Requires app-specific password");
            Console.WriteLine();
        }, emailArg);

        return cmd;
    }

    private static Command BuildQCCommand(string dbPath)
    {
        var cmd = new Command("qc", "Run QC verification against the mail server");
        var projectOpt = new Option<string>("--project", "Project ID") { IsRequired = true };
        projectOpt.AddAlias("-p");
        var hostOpt = new Option<string>("--host", "IMAP server host") { IsRequired = true };
        hostOpt.AddAlias("-H");
        var portOpt = new Option<int>("--port", () => 993, "IMAP server port");
        var userOpt = new Option<string?>("--user", "Username");
        var passwordOpt = new Option<string?>("--password", "Password");
        var appPasswordOpt = new Option<string?>("--app-password", "App-specific password");
        var sampleOpt = new Option<int>("--sample-size", () => 0, "Verify a sample of N messages per folder (0=all)");

        cmd.AddOption(projectOpt);
        cmd.AddOption(hostOpt);
        cmd.AddOption(portOpt);
        cmd.AddOption(userOpt);
        cmd.AddOption(passwordOpt);
        cmd.AddOption(appPasswordOpt);
        cmd.AddOption(sampleOpt);

        cmd.SetHandler(async (string projectId, string host, int port, string? user, string? password, string? appPassword, int sampleSize) =>
        {
            using var db = ForensicDatabase.Create(dbPath);
            var project = db.GetProject(projectId);
            if (project == null) { Console.Error.WriteLine("Project not found"); return; }

            Console.WriteLine($"\n  SherlockMail — QC Verification");
            Console.WriteLine($"  Project: {project["name"]}");
            Console.WriteLine($"  Server:  {host}:{port}\n");

            var email = project["target_email"]?.ToString() ?? "";
            var verifier = new QCVerifier(db, projectId, host, port, true, email, user ?? email, password, appPassword);
            verifier.OnLog += msg => Console.WriteLine($"  {msg}");
            verifier.OnMessageVerified += (folder, uid, status) =>
                Console.Write($"\r  {(status == "VERIFIED" ? "OK" : "!!")} UID {uid}: {status}".PadRight(60));

            try
            {
                var results = await verifier.VerifyAsync(sampleSize: sampleSize);
                var s = results.Summary;
                Console.WriteLine($"\n\n  {(s.OverallVerdict == "PASS" ? "QC VERIFICATION PASSED" : "QC ISSUES FOUND")}");
                Console.WriteLine($"  Folders checked:  {s.TotalFoldersChecked}");
                Console.WriteLine($"  Messages checked: {s.TotalMessagesChecked}");
                Console.WriteLine($"  Hash matches:     {s.HashMatches}");
                Console.WriteLine($"  Hash mismatches:  {s.HashMismatches}");
                Console.WriteLine($"  Count mismatches: {s.FolderCountMismatches}\n");
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"\n  QC verification failed: {ex.Message}");
            }
        }, projectOpt, hostOpt, portOpt, userOpt, passwordOpt, appPasswordOpt, sampleOpt);

        return cmd;
    }

    private static Command BuildExportCommand(string dbPath)
    {
        var cmd = new Command("export", "Export collected mail to various formats");
        var projectOpt = new Option<string>("--project", "Project ID") { IsRequired = true };
        projectOpt.AddAlias("-p");
        var formatOpt = new Option<string>("--format", "Export format: eml, mbox, xml, msg, pst, container") { IsRequired = true };
        formatOpt.AddAlias("-f");
        var outputOpt = new Option<string?>("--output", "Output directory");
        outputOpt.AddAlias("-o");

        cmd.AddOption(projectOpt);
        cmd.AddOption(formatOpt);
        cmd.AddOption(outputOpt);

        cmd.SetHandler(async (string projectId, string format, string? output) =>
        {
            using var db = ForensicDatabase.Create(dbPath);
            var project = db.GetProject(projectId);
            if (project == null) { Console.Error.WriteLine("Project not found"); return; }

            var outDir = output ?? Path.Combine("./exports", projectId, format);
            Console.WriteLine($"\n  SherlockMail — Export");
            Console.WriteLine($"  Project: {project["name"]}");
            Console.WriteLine($"  Format:  {format.ToUpper()}");
            Console.WriteLine($"  Output:  {outDir}\n");

            var exporter = new ForensicExporter(db, projectId);
            exporter.OnMessageExported += (fmt, uid) => Console.Write($"\r  Exporting UID {uid}...".PadRight(60));

            try
            {
                var result = await exporter.ExportAsync(format, outDir);
                Console.WriteLine($"\n  Export Complete");
                Console.WriteLine($"  Messages: {result["count"]}\n");
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"\n  Export failed: {ex.Message}");
            }
        }, projectOpt, formatOpt, outputOpt);

        return cmd;
    }

    private static Command BuildDriveScanCommand(string dbPath)
    {
        var cmd = new Command("drive-scan", "Scan collected emails for cloud drive links");
        var projectOpt = new Option<string>("--project", "Project ID") { IsRequired = true };
        projectOpt.AddAlias("-p");
        cmd.AddOption(projectOpt);

        cmd.SetHandler(async (string projectId) =>
        {
            using var db = ForensicDatabase.Create(dbPath);
            Console.WriteLine("\n  SherlockMail — Drive Link Scan");
            var detector = new DriveAttachmentDetector(db, projectId);
            var (scanned, withLinks, totalLinks, byProvider) = await detector.ScanAllMessagesAsync();
            Console.WriteLine($"\n  Scan Complete");
            Console.WriteLine($"  Messages scanned: {scanned}");
            Console.WriteLine($"  With drive links: {withLinks}");
            Console.WriteLine($"  Total links:      {totalLinks}");
            foreach (var (provider, count) in byProvider)
                Console.WriteLine($"  {provider}: {count}");
            Console.WriteLine();
        }, projectOpt);

        return cmd;
    }

    private static Command BuildAuditCommand(string dbPath)
    {
        var cmd = new Command("audit", "View chain of custody audit log");
        var projectOpt = new Option<string>("--project", "Project ID") { IsRequired = true };
        projectOpt.AddAlias("-p");
        var verifyOpt = new Option<bool>("--verify", "Verify chain integrity");
        var exportOpt = new Option<string?>("--export", "Export audit log to directory");

        cmd.AddOption(projectOpt);
        cmd.AddOption(verifyOpt);
        cmd.AddOption(exportOpt);

        cmd.SetHandler(async (string projectId, bool verify, string? exportDir) =>
        {
            using var db = ForensicDatabase.Create(dbPath);
            if (verify)
            {
                var custody = new ChainOfCustody(db, projectId, "");
                var (valid, checked_, total, _) = custody.VerifyChain();
                Console.WriteLine(valid
                    ? $"\n  Chain integrity verified ({checked_} entries)\n"
                    : "\n  Chain integrity BROKEN\n");
            }
            else if (!string.IsNullOrEmpty(exportDir))
            {
                var custody = new ChainOfCustody(db, projectId, "");
                var (jsonPath, tsvPath) = await custody.ExportLogAsync(exportDir);
                Console.WriteLine($"\n  Audit log exported");
                Console.WriteLine($"  JSON: {jsonPath}");
                Console.WriteLine($"  TSV:  {tsvPath}\n");
            }
            else
            {
                var log = db.GetAuditLog(projectId);
                Console.WriteLine($"\n  Audit Log ({log.Count} entries)\n  ==============");
                foreach (var e in log)
                    Console.WriteLine($"  {e["timestamp"]}  {e["event_type"]?.ToString()?.PadRight(24)}  {e["description"]}");
                Console.WriteLine();
            }
        }, projectOpt, verifyOpt, exportOpt);

        return cmd;
    }

    private static Command BuildProvidersCommand()
    {
        var cmd = new Command("providers", "List supported email providers");
        cmd.SetHandler(() =>
        {
            Console.WriteLine("\n  Supported Providers\n  ===================");
            foreach (var p in ProviderDetect.ListProviders())
            {
                var dict = (dynamic)p;
                Console.WriteLine($"  {dict.name.PadRight(30)}  {dict.type.PadRight(12)}  {(dict.supportsOAuth ? "OAuth" : "Basic")}");
            }
            Console.WriteLine();
        });
        return cmd;
    }

    private static Command BuildServeCommand(string dbPath, string exeDir)
    {
        var cmd = new Command("serve", "Start the web dashboard");
        var portOpt = new Option<int>("--port", () => 3858, "Port number");
        cmd.AddOption(portOpt);

        cmd.SetHandler(async (int port) =>
        {
            var wwwroot = Path.Combine(exeDir, "wwwroot");
            await SherlockMail.Web.WebServer.RunAsync(dbPath, port, wwwroot);
        }, portOpt);

        return cmd;
    }

    private static string FormatBytes(long bytes)
    {
        if (bytes == 0) return "0 B";
        string[] units = ["B", "KB", "MB", "GB"];
        int i = (int)Math.Floor(Math.Log(bytes) / Math.Log(1024));
        return $"{bytes / Math.Pow(1024, i):F1} {units[i]}";
    }
}
