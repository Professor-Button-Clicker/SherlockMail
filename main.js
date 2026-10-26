import { app, BrowserWindow, dialog, shell, powerSaveBlocker } from 'electron';
import { dirname, join, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import express from 'express';
import { detectRedirectedAppData } from './src/util/appdata-redirect.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let mainWindow;
let server;
let routes = null;
let quitConfirmed = false;
let closePrompt = null;
let sleepBlockerId = null;

const activeCollections = () => routes?.getActiveCollections() || [];

// Closing the app ends the server process and with it any running collection, so ask first and, if the
// examiner confirms, stop collections cleanly (logs, records and audit entries written) before quitting.
function confirmQuit() {
  if (quitConfirmed || !activeCollections().length) return Promise.resolve(true);
  if (closePrompt) return closePrompt;
  closePrompt = (async () => {
    const running = activeCollections();
    const names = running.map(c => `• ${c.projectName}: ${c.acquired.toLocaleString()} of ${c.total.toLocaleString()} items`).join('\n');
    const { response } = await dialog.showMessageBox(mainWindow || undefined, {
      type: 'warning',
      title: 'Collection in progress',
      message: running.length === 1 ? 'A collection is still running.' : `${running.length} collections are still running.`,
      detail: `${names}\n\nClosing SherlockMail stops the collection. What has been collected so far is kept and logged, and the acquisition is recorded as stopped, so it can be completed later with a differential collection.`,
      buttons: ['Keep SherlockMail Open', 'Stop Collection and Quit'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (response !== 1) return false;
    mainWindow?.setTitle('SherlockMail — stopping collection and writing logs...');
    await routes.cancelAllCollections('SherlockMail was closed by the examiner', 20000);
    quitConfirmed = true;
    return true;
  })().finally(() => { closePrompt = null; });
  return closePrompt;
}

// Keeps the machine awake and shows taskbar progress while anything is being collected.
function watchCollections() {
  setInterval(() => {
    const running = activeCollections();
    if (running.length && sleepBlockerId === null) sleepBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    if (!running.length && sleepBlockerId !== null) {
      powerSaveBlocker.stop(sleepBlockerId);
      sleepBlockerId = null;
    }
    if (!mainWindow) return;
    if (!running.length) return mainWindow.setProgressBar(-1);
    const total = running.reduce((s, c) => s + (c.total || 0), 0);
    const done = running.reduce((s, c) => s + c.acquired + c.failed + c.skipped, 0);
    mainWindow.setProgressBar(total ? Math.min(1, done / total) : 2);
  }, 2000).unref();
}

async function startServer() {
  // Imported here, not statically: routes and services read SHERLOCKMAIL_DATA_DIR at module load,
  // and a static import would evaluate them before it is set, pointing them into the read-only asar.
  routes = await import('./src/api/routes.js');
  const apiRoutes = routes.default;
  return new Promise((resolve) => {
    const expressApp = express();
    expressApp.use(express.json({ limit: '50mb' }));
    expressApp.use(express.static(join(__dirname, 'public')));

    expressApp.post('/api/pick-folder', async (req, res) => {
      if (!mainWindow) return res.status(500).json({ error: 'No window available' });
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        title: 'Select Destination Folder',
      });
      if (result.canceled) return res.json({ canceled: true });
      res.json({ path: result.filePaths[0] });
    });

    expressApp.post('/api/open-folder', async (req, res) => {
      const folderPath = req.body.path;
      if (!folderPath) return res.status(400).json({ error: 'No path provided' });
      const resolved = isAbsolute(folderPath) ? folderPath : join(__dirname, folderPath);
      if (!existsSync(resolved)) return res.status(404).json({ error: 'Folder does not exist yet — run an export first' });
      const result = await shell.openPath(resolved);
      if (result) return res.status(500).json({ error: result });
      res.json({ ok: true });
    });

    expressApp.use('/api', apiRoutes);
    expressApp.get('*', (req, res) => {
      res.sendFile(join(__dirname, 'public', 'index.html'));
    });

    server = expressApp.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      console.log(`SherlockMail server running on port ${port}`);
      resolve(port);
    });
  });
}

async function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'SherlockMail',
    icon: join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    autoHideMenuBar: true,
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}`);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('close', (event) => {
    if (quitConfirmed || !activeCollections().length) return;
    event.preventDefault();
    confirmQuit().then(ok => { if (ok) mainWindow?.close(); });
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.on('before-quit', (event) => {
  if (quitConfirmed || !activeCollections().length) return;
  event.preventDefault();
  confirmQuit().then(ok => { if (ok) app.quit(); });
});

app.whenReady().then(async () => {
  const redirect = detectRedirectedAppData(app.getPath('userData'));
  if (redirect) {
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      title: 'SherlockMail is running inside another app',
      message: 'SherlockMail was started from inside another application\'s sandbox.',
      detail: `Windows is redirecting everything SherlockMail saves into a private folder of the package "${redirect.packageName}":\n\n${redirect.redirectedDir}\n\nCollections, logs and the case database would be stored there instead of your normal SherlockMail data, and would be lost if that application is reset or uninstalled.\n\nClose SherlockMail and start it from the Start menu or a desktop shortcut.`,
      buttons: ['Quit', 'Continue anyway'],
      defaultId: 0,
      cancelId: 0,
    });
    if (choice === 0) {
      app.quit();
      return;
    }
  }
  if (!process.env.SHERLOCKMAIL_DATA_DIR) {
    process.env.SHERLOCKMAIL_DATA_DIR = join(app.getPath('userData'), 'data');
  }
  const port = await startServer();
  await createWindow(port);
  watchCollections();
});

app.on('window-all-closed', () => {
  if (server) server.close();
  app.quit();
});

app.on('activate', async () => {
  if (!mainWindow) {
    const port = server?.address()?.port;
    if (port) await createWindow(port);
  }
});
