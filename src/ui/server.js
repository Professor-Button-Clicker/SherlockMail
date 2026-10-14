import express from 'express';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, stat, cp } from 'node:fs/promises';
import { ForensicDatabase } from '../core/database.js';
import { ChainOfCustody } from '../core/chain-of-custody.js';
import { InlineSearch } from '../search/inline-search.js';
import { detectProvider, listProviders } from '../auth/provider-detect.js';
import { hashFile } from '../core/hasher.js';
import { QCVerifier } from '../core/qc-verifier.js';
import { ForensicExporter } from '../core/exporter.js';
import { DriveAttachmentDetector } from '../core/drive-attachments.js';
import { AcquisitionEngine } from '../core/acquisition-engine.js';
import { ForensicImapClient } from '../protocols/imap-client.js';
import { v4 as uuid } from 'uuid';

const activeCollections = new Map();

const __dirname = dirname(fileURLToPath(import.meta.url));
const isBundled = (() => { try { return require('node:sea').isSea(); } catch { return false; } })();
const exeDir = isBundled ? dirname(process.execPath) : join(__dirname, '..', '..');
const PORT = process.env.FMC_PORT || 3847;

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

const dbPath = join(exeDir, 'data', 'fmc.sqlite');

async function start() {
  const db = await ForensicDatabase.create(dbPath);

  app.get('/api/projects', (req, res) => {
    const projects = db.listProjects();
    res.json(projects.map(p => ({ ...p, config: tryParse(p.config) })));
  });

  app.post('/api/projects', (req, res) => {
    const { name, targetEmail, providerType, caseName, caseId, examinerName, agency } = req.body;
    const id = uuid();
    const project = db.createProject({
      id, name, targetEmail, providerType, caseName, caseId, examinerName, agency, config: req.body.config || {}
    });
    const custody = new ChainOfCustody(db, id, examinerName || 'Unknown');
    custody.logProjectCreated({ targetEmail, providerType, caseName, caseId });
    res.json({ id, ...project });
  });

  app.get('/api/projects/:id', (req, res) => {
    const project = db.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const stats = db.getProjectStats(req.params.id);
    res.json({ ...project, config: tryParse(project.config), stats });
  });

  app.get('/api/projects/:id/folders', (req, res) => {
    const folders = db.getFolders(req.params.id);
    res.json(folders);
  });

  app.get('/api/projects/:id/messages', (req, res) => {
    const { folder, limit = 100, offset = 0 } = req.query;
    if (folder) {
      const messages = db.getMessagesByFolder(req.params.id, folder, parseInt(limit), parseInt(offset));
      res.json(messages);
    } else {
      const messages = db.prepare(
        'SELECT * FROM messages WHERE project_id = ? ORDER BY date DESC LIMIT ? OFFSET ?'
      ).all(req.params.id, parseInt(limit), parseInt(offset));
      res.json(messages);
    }
  });

  app.get('/api/projects/:id/messages/:msgId', (req, res) => {
    const msg = db.getMessage(req.params.msgId);
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    const attachments = db.prepare('SELECT * FROM attachments WHERE message_id = ?').all(req.params.msgId);
    res.json({ ...msg, attachments, headers: tryParse(msg.headers_json) });
  });

  app.get('/api/projects/:id/search', (req, res) => {
    const { q, type = 'basic' } = req.query;
    if (!q) return res.json([]);

    if (type === 'inline') {
      const allMessages = db.prepare('SELECT * FROM messages WHERE project_id = ?').all(req.params.id);
      const search = new InlineSearch();
      const results = search.search(allMessages, q);
      res.json(results);
    } else {
      const results = db.searchMessages(req.params.id, q);
      res.json(results);
    }
  });

  app.get('/api/projects/:id/audit', (req, res) => {
    const log = db.getAuditLog(req.params.id);
    res.json(log);
  });

  app.get('/api/projects/:id/audit/verify', (req, res) => {
    const custody = new ChainOfCustody(db, req.params.id, '');
    const result = custody.verifyChain();
    res.json(result);
  });

  app.get('/api/projects/:id/stats', (req, res) => {
    const stats = db.getProjectStats(req.params.id);
    res.json(stats);
  });

  app.get('/api/projects/:id/acquisitions', (req, res) => {
    const acquisitions = db.listAcquisitions(req.params.id);
    res.json(acquisitions);
  });

  app.post('/api/projects/:id/verify/:msgId', async (req, res) => {
    const msg = db.getMessage(req.params.msgId);
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    if (!msg.eml_path) return res.status(400).json({ error: 'No EML file path' });

    try {
      const fileExists = await stat(msg.eml_path).catch(() => null);
      if (!fileExists) return res.status(404).json({ error: 'EML file not found on disk' });

      const hash = await hashFile(msg.eml_path, 'sha256');
      const valid = hash === msg.hash_sha256;
      res.json({ valid, expected: msg.hash_sha256, actual: hash, algorithm: 'sha256', emlPath: msg.eml_path });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/projects/:id/eml/:msgId', async (req, res) => {
    const msg = db.getMessage(req.params.msgId);
    if (!msg?.eml_path) return res.status(404).json({ error: 'EML not found' });
    try {
      const content = await readFile(msg.eml_path, 'utf8');
      res.type('message/rfc822').send(content);
    } catch {
      res.status(404).json({ error: 'EML file not found on disk' });
    }
  });

  app.post('/api/detect-provider', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const result = await detectProvider(email);
    res.json(result);
  });

  app.get('/api/providers', (req, res) => {
    res.json(listProviders());
  });

  // --- QC Verification ---
  app.post('/api/projects/:id/qc', async (req, res) => {
    const project = db.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { host, port, username, password, appPassword, tls, verifyHashes, sampleSize } = req.body;
    if (!host) return res.status(400).json({ error: 'IMAP host is required for QC verification' });

    const connectionConfig = {
      host,
      port: port || 993,
      tls: tls !== false,
      email: project.target_email,
      username: username || project.target_email,
      password,
      appPassword
    };

    try {
      const verifier = new QCVerifier(db, req.params.id, connectionConfig);
      const results = await verifier.verify({ verifyHashes, sampleSize });
      res.json(results);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/projects/:id/qc', (req, res) => {
    const results = db.getQCResults(req.params.id);
    res.json(results.map(r => ({ ...r, results: tryParse(r.results_json) })));
  });

  // --- Export ---
  app.post('/api/projects/:id/export', async (req, res) => {
    const project = db.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { format, outputDir, pstSizeGB, containerType } = req.body;
    if (!format) return res.status(400).json({ error: 'Export format is required' });

    const outDir = outputDir || join(exeDir, 'exports', req.params.id, format);

    try {
      const exporter = new ForensicExporter(db, req.params.id);
      const result = await exporter.export(format, outDir, { pstSizeGB, containerType });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/projects/:id/exports', (req, res) => {
    const records = db.getExportRecords(req.params.id);
    res.json(records.map(r => ({ ...r, details: tryParse(r.details_json) })));
  });

  // --- Drive Links ---
  app.post('/api/projects/:id/scan-drive-links', async (req, res) => {
    try {
      const detector = new DriveAttachmentDetector(db, req.params.id);
      const results = await detector.scanAllMessages();
      res.json(results);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/projects/:id/drive-links', (req, res) => {
    const links = db.getDriveLinks(req.params.id, req.query.messageId);
    res.json(links);
  });

  app.get('/api/projects/:id/drive-link-stats', (req, res) => {
    const detector = new DriveAttachmentDetector(db, req.params.id);
    const stats = detector.getDriveLinkStats();
    res.json(stats);
  });

  app.post('/api/projects/:id/drive-packages', async (req, res) => {
    const outDir = req.body.outputDir || join(exeDir, 'exports', req.params.id, 'drive_packages');
    try {
      const detector = new DriveAttachmentDetector(db, req.params.id);
      const result = await detector.createDrivePackages(outDir);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/projects/:id/staged-output', async (req, res) => {
    const outDir = req.body.outputDir || join(exeDir, 'exports', req.params.id, 'staged');
    try {
      const detector = new DriveAttachmentDetector(db, req.params.id);
      const result = await detector.createStagedOutput(outDir);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Wizard: Test Connection ---
  app.post('/api/test-connection', async (req, res) => {
    const { host, port, email, username, password, appPassword, tls } = req.body;
    if (!host || !email) return res.status(400).json({ error: 'Host and email are required' });

    const client = new ForensicImapClient({
      host, port: port || 993, tls: tls !== false,
      email, username: username || email, password, appPassword
    });

    try {
      await client.connect();
      await client.disconnect();
      res.json({ success: true, message: 'Connection successful' });
    } catch (err) {
      res.json({ success: false, message: err.message });
    }
  });

  // --- Wizard: List Remote Folders ---
  app.post('/api/list-remote-folders', async (req, res) => {
    const { host, port, email, username, password, appPassword, tls } = req.body;

    const client = new ForensicImapClient({
      host, port: port || 993, tls: tls !== false,
      email, username: username || email, password, appPassword
    });

    try {
      await client.connect();
      const folders = await client.listFolders();
      const details = [];
      for (const f of folders) {
        try {
          const status = await client.getFolderStatus(f.path);
          details.push({ ...f, messages: status.messages || 0, unseen: status.unseen || 0 });
        } catch {
          details.push({ ...f, messages: 0, unseen: 0 });
        }
      }
      await client.disconnect();
      res.json(details);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Wizard: Start Collection ---
  app.post('/api/start-collection', async (req, res) => {
    const { projectId, connection, selectedFolders, query, outputFormats, pstSizeGB,
            containerType, collectDriveLinks, collectModernAttachments, outputDir } = req.body;

    const project = db.getProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const collectionId = uuid();
    const config = {
      host: connection.host,
      port: connection.port || 993,
      tls: connection.tls !== false,
      email: connection.email,
      username: connection.username || connection.email,
      password: connection.password,
      appPassword: connection.appPassword,
      folders: selectedFolders || [],
      query: query || null,
      outputDir: outputDir || join(exeDir, 'output', projectId),
      collectDriveLinks: collectDriveLinks !== false,
      collectModernAttachments: collectModernAttachments !== false,
      examinerName: project.examiner_name || 'Unknown'
    };

    const progress = {
      id: collectionId,
      projectId,
      status: 'running',
      phase: 'connecting',
      totalMessages: 0,
      acquiredMessages: 0,
      failedMessages: 0,
      skippedMessages: 0,
      totalBytes: 0,
      driveLinksDetected: 0,
      currentFolder: '',
      errors: [],
      logs: ['Starting collection...'],
      startTime: new Date().toISOString(),
      endTime: null
    };

    activeCollections.set(collectionId, progress);

    const engine = new AcquisitionEngine(db, projectId, config);

    engine.on('connected', () => {
      progress.phase = 'connected';
      progress.logs.push('Connected to mail server');
    });
    engine.on('folder_start', (data) => {
      progress.currentFolder = data.path;
      progress.logs.push(`Processing folder: ${data.path}`);
    });
    engine.on('message_acquired', () => {
      progress.acquiredMessages++;
      progress.totalBytes = engine.stats.totalBytes;
    });
    engine.on('message_failed', (data) => {
      progress.failedMessages++;
      progress.errors.push(data.error || 'Message acquisition failed');
    });
    engine.on('message_skipped', () => {
      progress.skippedMessages++;
    });
    engine.on('drive_links_detected', (data) => {
      progress.driveLinksDetected += data.count;
    });
    engine.on('progress', (data) => {
      progress.totalMessages = data.total;
      progress.phase = 'collecting';
    });

    engine.run().then(() => {
      progress.status = 'completed';
      progress.phase = 'completed';
      progress.endTime = new Date().toISOString();
      progress.totalMessages = engine.stats.totalMessages;
      progress.acquiredMessages = engine.stats.acquiredMessages;
      progress.totalBytes = engine.stats.totalBytes;
      progress.logs.push('Collection completed successfully');
    }).catch(err => {
      progress.status = 'failed';
      progress.phase = 'failed';
      progress.endTime = new Date().toISOString();
      progress.errors.push(err.message);
      progress.logs.push(`Collection failed: ${err.message}`);
    });

    res.json({ collectionId, status: 'started' });
  });

  // --- Wizard: Collection Progress ---
  app.get('/api/collection-progress/:collectionId', (req, res) => {
    const progress = activeCollections.get(req.params.collectionId);
    if (!progress) return res.status(404).json({ error: 'Collection not found' });
    res.json(progress);
  });

  // --- Wizard: Transfer ---
  app.post('/api/transfer', async (req, res) => {
    const { sourceDir, destDir } = req.body;
    if (!sourceDir || !destDir) return res.status(400).json({ error: 'Source and destination directories required' });

    try {
      await cp(sourceDir, destDir, { recursive: true });
      res.json({ success: true, source: sourceDir, destination: destDir });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/system', (req, res) => {
    const totalProjects = db.prepare('SELECT COUNT(*) as c FROM projects').get().c;
    const totalMessages = db.prepare('SELECT COUNT(*) as c FROM messages').get().c;
    const totalSize = db.prepare('SELECT COALESCE(SUM(size), 0) as s FROM messages').get().s;
    res.json({
      version: '1.0.0',
      name: 'SherlockMail',
      totalProjects,
      totalMessages,
      totalSize,
      uptime: process.uptime(),
      nodeVersion: process.version
    });
  });

  app.get('*', (req, res) => {
    res.sendFile(join(__dirname, 'public', 'index.html'));
  });

  app.listen(PORT, () => {
    console.log(`\n  SherlockMail Dashboard`);
    console.log(`  ========================`);
    console.log(`  Running at: http://localhost:${PORT}`);
    console.log(`  Database:   ${dbPath}\n`);
  });
}

function tryParse(json) {
  try { return JSON.parse(json); } catch { return json; }
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
