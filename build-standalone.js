import { cpSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, 'dist', 'SherlockMail');

console.log('');
console.log('  Building SherlockMail standalone distribution...');
console.log('');

// ── Step 1: Clean previous build ──
if (existsSync(DIST)) {
  rmSync(DIST, { recursive: true });
  console.log('  [1/5] Cleaned previous build');
} else {
  console.log('  [1/5] No previous build to clean');
}
mkdirSync(DIST, { recursive: true });

// ── Step 2: Copy application files ──
console.log('  [2/5] Copying application files...');

const fileCopies = [
  ['server.js', 'server.js'],
  ['public', 'public'],
  ['src', 'src'],
];

for (const [src, dest] of fileCopies) {
  cpSync(join(__dirname, src), join(DIST, dest), { recursive: true });
  console.log(`         ${src}`);
}

mkdirSync(join(DIST, 'data'), { recursive: true });
console.log('         data/ (created)');

// Write a trimmed package.json for the distribution (no devDependencies, no electron-builder config)
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'));
const distPkg = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  main: 'server.js',
  type: 'module',
  scripts: {
    start: 'node server.js',
  },
  dependencies: pkg.dependencies,
};
writeFileSync(join(DIST, 'package.json'), JSON.stringify(distPkg, null, 2) + '\n');
console.log('         package.json (trimmed)');

// ── Step 3: Copy Node.js binary ──
console.log('  [3/5] Copying Node.js runtime...');
const nodeExe = process.execPath;
cpSync(nodeExe, join(DIST, 'node.exe'));
console.log(`         ${nodeExe}`);

// ── Step 4: Install production dependencies ──
console.log('  [4/5] Installing production dependencies...');
execSync('npm install --omit=dev --no-audit --no-fund', { cwd: DIST, stdio: 'inherit' });

// ── Step 5: Create launcher executable ──
console.log('  [5/5] Creating launcher...');

const launcherSource = `
using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Threading;

class SherlockMailLauncher {
    static Process nodeProcess;

    static int Main(string[] args) {
        string exeDir = Path.GetDirectoryName(
            System.Reflection.Assembly.GetExecutingAssembly().Location);
        string node = Path.Combine(exeDir, "node.exe");
        string server = Path.Combine(exeDir, "server.js");

        if (!File.Exists(node)) {
            System.Windows.Forms.MessageBox.Show(
                "node.exe not found in " + exeDir +
                "\\n\\nEnsure node.exe is in the same directory as SherlockMail.exe",
                "SherlockMail", System.Windows.Forms.MessageBoxButtons.OK,
                System.Windows.Forms.MessageBoxIcon.Error);
            return 1;
        }

        int port = 3000;
        for (int i = 0; i < args.Length - 1; i++) {
            if (args[i] == "--port") int.TryParse(args[i + 1], out port);
        }

        string serverArgs = "\\"" + server + "\\" --no-browser";
        if (args.Length > 0) serverArgs += " " + String.Join(" ", args);

        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = node;
        psi.Arguments = serverArgs;
        psi.WorkingDirectory = exeDir;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;

        try {
            nodeProcess = Process.Start(psi);
        } catch (Exception ex) {
            System.Windows.Forms.MessageBox.Show(
                "Failed to start server: " + ex.Message,
                "SherlockMail", System.Windows.Forms.MessageBoxButtons.OK,
                System.Windows.Forms.MessageBoxIcon.Error);
            return 1;
        }

        string url = "http://localhost:" + port;
        bool ready = false;
        for (int i = 0; i < 60; i++) {
            try {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url + "/api/stats");
                req.Timeout = 1000;
                using (req.GetResponse()) { ready = true; break; }
            } catch { Thread.Sleep(500); }
        }

        if (!ready) {
            Shutdown();
            System.Windows.Forms.MessageBox.Show(
                "Server failed to start within 30 seconds.",
                "SherlockMail", System.Windows.Forms.MessageBoxButtons.OK,
                System.Windows.Forms.MessageBoxIcon.Error);
            return 1;
        }

        string edgePath = FindEdge();
        if (edgePath != null) {
            string profileDir = Path.Combine(exeDir, ".sherlockmail-profile");
            ProcessStartInfo edgePsi = new ProcessStartInfo();
            edgePsi.FileName = edgePath;
            edgePsi.Arguments = "--app=" + url
                + " \\"--user-data-dir=" + profileDir + "\\""
                + " --no-first-run --disable-default-apps"
                + " --window-size=1280,800";
            edgePsi.UseShellExecute = false;

            try {
                Process edgeProc = Process.Start(edgePsi);
                edgeProc.WaitForExit();
            } catch {
                FallbackBrowser(url);
            }
        } else {
            FallbackBrowser(url);
        }

        Shutdown();
        return 0;
    }

    static void FallbackBrowser(string url) {
        try {
            string chromePath = FindChrome();
            if (chromePath != null) {
                string profileDir = Path.Combine(
                    Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location),
                    ".sherlockmail-profile");
                ProcessStartInfo pi = new ProcessStartInfo();
                pi.FileName = chromePath;
                pi.Arguments = "--app=" + url
                    + " \\"--user-data-dir=" + profileDir + "\\""
                    + " --no-first-run --disable-default-apps"
                    + " --window-size=1280,800";
                pi.UseShellExecute = false;
                Process p = Process.Start(pi);
                p.WaitForExit();
                return;
            }
        } catch {}

        Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
        if (nodeProcess != null) nodeProcess.WaitForExit();
    }

    static void Shutdown() {
        try {
            if (nodeProcess != null && !nodeProcess.HasExited) nodeProcess.Kill();
        } catch {}
    }

    static string FindEdge() {
        string[] paths = new string[] {
            @"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
            @"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
            Path.Combine(Environment.GetFolderPath(
                Environment.SpecialFolder.LocalApplicationData),
                @"Microsoft\\Edge\\Application\\msedge.exe"),
        };
        foreach (string p in paths) { if (File.Exists(p)) return p; }
        return null;
    }

    static string FindChrome() {
        string[] paths = new string[] {
            @"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            @"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
            Path.Combine(Environment.GetFolderPath(
                Environment.SpecialFolder.LocalApplicationData),
                @"Google\\Chrome\\Application\\chrome.exe"),
        };
        foreach (string p in paths) { if (File.Exists(p)) return p; }
        return null;
    }
}
`;

const csPath = join(DIST, '_launcher.cs');
const exePath = join(DIST, 'SherlockMail.exe');
writeFileSync(csPath, launcherSource);

let launcherCreated = false;

// Try .NET Framework csc (available on virtually all Windows installations)
const cscPaths = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
];

for (const cscPath of cscPaths) {
  if (!existsSync(cscPath)) continue;
  try {
    execSync(`"${cscPath}" /nologo /out:"${exePath}" /target:winexe /optimize+ /reference:System.Windows.Forms.dll "${csPath}"`, { stdio: 'pipe' });
    launcherCreated = true;
    console.log('         SherlockMail.exe (compiled)');
    break;
  } catch { /* try next */ }
}

if (!launcherCreated) {
  // Try dotnet csc
  try {
    execSync(`dotnet csc /nologo /out:"${exePath}" /target:winexe /optimize+ /reference:System.Windows.Forms.dll "${csPath}"`, { stdio: 'pipe' });
    launcherCreated = true;
    console.log('         SherlockMail.exe (compiled via dotnet)');
  } catch { /* fallback below */ }
}

if (!launcherCreated) {
  // Fallback: create a batch launcher
  writeFileSync(join(DIST, 'SherlockMail.cmd'), '@echo off\r\ncd /d "%~dp0"\r\nnode.exe server.js %*\r\n');
  console.log('         SherlockMail.cmd (batch fallback — C# compiler not found)');
  console.log('');
  console.log('  Note: Install .NET Framework SDK or .NET SDK to get a proper .exe launcher.');
  console.log('  You can also run the app directly with: node server.js');
}

// Clean up temp C# source
rmSync(csPath, { force: true });

// ── Summary ──
console.log('');
console.log('  Build complete!');
console.log(`  Distribution: ${DIST}`);
console.log('');
console.log('  To run:');
if (launcherCreated) {
  console.log('    SherlockMail.exe                    — opens as a native desktop window');
  console.log('    SherlockMail.exe --port 8080        — custom port');
  console.log('    SherlockMail.exe --data-dir "C:\\Cases"');
} else {
  console.log('    SherlockMail.cmd');
  console.log('    node server.js --port 8080');
}
console.log('');
console.log('  To distribute: zip the SherlockMail folder and share.');
console.log('  No Node.js or Electron installation required on the target machine.');
console.log('  The app opens in a native window (via Edge/Chrome app mode).');
console.log('');
