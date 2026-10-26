import express from 'express';
import { dirname, join, isAbsolute, resolve } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync } from 'fs';
import { exec, execFile, spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── CLI Argument Parsing ──
const args = process.argv.slice(2);

function getArg(name, defaultValue) {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  return defaultValue;
}

const PORT = parseInt(getArg('port', process.env.PORT || '3000'), 10);
// Loopback only by default: the API has no authentication and exposes case data and stored credentials.
const HOST = getArg('host', '127.0.0.1');
const NO_BROWSER = args.includes('--no-browser');
const DATA_DIR = getArg('data-dir', null);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
SherlockMail v0.9.0 — Forensic Email Collection Tool

Usage: SherlockMail [options]
       node server.js [options]

Options:
  --port <number>      HTTP port (default: 3000)
  --host <address>     Interface to listen on (default: 127.0.0.1, this computer only).
                       Any other address exposes the unauthenticated API to the network.
  --data-dir <path>    Custom data directory for database and exports
  --no-browser         Don't auto-open the browser on startup
  --help, -h           Show this help message

Examples:
  SherlockMail.exe
  SherlockMail.exe --port 8080
  SherlockMail.exe --data-dir "C:\\Cases\\Evidence" --no-browser
  node server.js --port 8080 --no-browser
`);
  process.exit(0);
}

if (DATA_DIR) {
  process.env.SHERLOCKMAIL_DATA_DIR = resolve(DATA_DIR);
}

const dataDir = process.env.SHERLOCKMAIL_DATA_DIR || join(__dirname, 'data');
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}

// Loaded after --data-dir is applied: routes and services read SHERLOCKMAIL_DATA_DIR at module load.
const { default: apiRoutes, getActiveCollections, cancelAllCollections } = await import('./src/api/routes.js');

const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.static(join(__dirname, 'public')));

// ── Folder Picker (cross-platform, no Electron required) ──
app.post('/api/pick-folder', (req, res) => {
  const platform = process.platform;
  let cmd;

  if (platform === 'win32') {
    cmd = 'powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::EnableVisualStyles(); $owner = New-Object System.Windows.Forms.Form -Property @{TopMost=$true; ShowInTaskbar=$false; StartPosition=\'CenterScreen\'; WindowState=\'Minimized\'}; $owner.Show(); $owner.Hide(); $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = \'Select Destination Folder\'; $f.ShowNewFolderButton = $true; if ($f.ShowDialog($owner) -eq \'OK\') { Write-Output $f.SelectedPath } else { Write-Output \'__CANCELLED__\' }; $owner.Dispose()"';
  } else if (platform === 'darwin') {
    cmd = 'osascript -e \'POSIX path of (choose folder with prompt "Select Destination Folder")\'';
  } else {
    cmd = 'zenity --file-selection --directory --title="Select Destination Folder" 2>/dev/null';
  }

  exec(cmd, { timeout: 120000 }, (err, stdout) => {
    const result = (stdout || '').trim();
    if (err || !result || result === '__CANCELLED__') {
      return res.json({ canceled: true });
    }
    res.json({ path: result });
  });
});

// ── Folder Opener (cross-platform, no Electron required) ──
app.post('/api/open-folder', (req, res) => {
  const folderPath = req.body.path;
  if (!folderPath) return res.status(400).json({ error: 'No path provided' });

  const resolved = isAbsolute(folderPath) ? folderPath : join(__dirname, folderPath);
  if (!existsSync(resolved)) {
    return res.status(404).json({ error: 'Folder does not exist yet — run an export first' });
  }

  // The path is passed as an argument, never through a shell, so no folder name can run a command.
  if (process.platform === 'win32') {
    // explorer.exe exits with code 1 even after opening the folder, so its exit code is not checked.
    const child = spawn('explorer.exe', [resolved], { detached: true, stdio: 'ignore' });
    child.on('error', (err) => { if (!res.headersSent) res.status(500).json({ error: err.message }); });
    child.unref();
    return setTimeout(() => { if (!res.headersSent) res.json({ ok: true }); }, 100);
  }
  execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [resolved], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

app.use('/api', apiRoutes);

app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

const server = app.listen(PORT, HOST, () => {
  const url = `http://${HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST}:${PORT}`;
  console.log('');
  console.log('  SherlockMail v0.9.0 — Forensic Email Collection');
  console.log(`  Running at ${url}`);
  console.log(`  Data directory: ${dataDir}`);
  console.log('  Press Ctrl+C to stop');
  console.log('');

  if (!NO_BROWSER) {
    const platform = process.platform;
    if (platform === 'win32') exec(`start "" "${url}"`);
    else if (platform === 'darwin') exec(`open "${url}"`);
    else exec(`xdg-open "${url}"`);
  }
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nShutting down SherlockMail...');
  const running = getActiveCollections();
  if (running.length) {
    console.log(`Stopping ${running.length} running collection(s) and writing their logs...`);
    await cancelAllCollections('SherlockMail server was stopped', 20000);
  }
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
  server.closeAllConnections?.();
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
