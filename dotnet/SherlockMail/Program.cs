using System.CommandLine;
using SherlockMail.Cli;
using SherlockMail.Licensing;

var exeDir = Path.GetDirectoryName(Environment.ProcessPath) ?? AppContext.BaseDirectory;
var dbPath = Path.Combine(exeDir, "data", "fmc.sqlite");
var port = 3858;

if (int.TryParse(Environment.GetEnvironmentVariable("FMC_PORT"), out var envPort))
    port = envPort;

var license = CertificateLicensing.ValidateLicense(
    Path.Combine(exeDir, "license.pfx"));

if (args.Length == 0 || args[0] == "serve" || args[0] == "dashboard")
{
    Console.WriteLine($"  SherlockMail v1.2.0 ({license.Edition})");
    if (!string.IsNullOrEmpty(license.Message))
        Console.WriteLine($"  {license.Message}");

    var wwwroot = Path.Combine(exeDir, "wwwroot");

    Console.WriteLine();
    Console.WriteLine("  SherlockMail Dashboard");
    Console.WriteLine("  ========================");
    Console.WriteLine($"  Running at: http://localhost:{port}");
    Console.WriteLine($"  Database:   {dbPath}");
    Console.WriteLine($"  Runtime:    .NET {Environment.Version}");
    Console.WriteLine();

    try
    {
        System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
        {
            FileName = $"http://localhost:{port}",
            UseShellExecute = true
        });
    }
    catch { }

    await SherlockMail.Web.WebServer.RunAsync(dbPath, port, wwwroot);
    return 0;
}
else
{
    var root = CliCommands.BuildRootCommand(dbPath, exeDir);
    return await root.InvokeAsync(args);
}
