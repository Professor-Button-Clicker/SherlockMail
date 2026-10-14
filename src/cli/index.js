#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { v4 as uuid } from 'uuid';
import { ForensicDatabase } from '../core/database.js';
import { AcquisitionEngine } from '../core/acquisition-engine.js';
import { ChainOfCustody } from '../core/chain-of-custody.js';
import { InlineSearch } from '../search/inline-search.js';
import { detectProvider, listProviders } from '../auth/provider-detect.js';
import { hashFile, verifyFileHash } from '../core/hasher.js';
import { QCVerifier } from '../core/qc-verifier.js';
import { ForensicExporter } from '../core/exporter.js';
import { DriveAttachmentDetector } from '../core/drive-attachments.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', '..', 'data', 'fmc.sqlite');

const program = new Command();

program
  .name('fmc')
  .description(chalk.cyan('SherlockMail') + ' — Forensic email acquisition and analysis tool')
  .version('1.0.0');

// --- Create Project ---
program
  .command('create')
  .description('Create a new forensic acquisition project')
  .requiredOption('-n, --name <name>', 'Project name')
  .requiredOption('-e, --email <email>', 'Target email address')
  .option('-t, --type <type>', 'Provider type (imap, gmail_api, graph_api, ews, pop3)', 'imap')
  .option('--case-name <name>', 'Case name')
  .option('--case-id <id>', 'Case/matter ID')
  .option('--examiner <name>', 'Examiner name')
  .option('--agency <name>', 'Agency/firm name')
  .action(async (opts) => {
    const db = await ForensicDatabase.create(DB_PATH);
    const id = uuid();
    db.createProject({
      id,
      name: opts.name,
      targetEmail: opts.email,
      providerType: opts.type,
      caseName: opts.caseName,
      caseId: opts.caseId,
      examinerName: opts.examiner,
      agency: opts.agency
    });

    const custody = new ChainOfCustody(db, id, opts.examiner || 'CLI');
    custody.logProjectCreated({ targetEmail: opts.email, providerType: opts.type, caseName: opts.caseName, caseId: opts.caseId });

    console.log(chalk.green('✓ Project created'));
    console.log(chalk.dim('  ID:    ') + chalk.cyan(id));
    console.log(chalk.dim('  Name:  ') + opts.name);
    console.log(chalk.dim('  Email: ') + opts.email);
    console.log(chalk.dim('  Type:  ') + opts.type);
    db.close();
  });

// --- Acquire ---
program
  .command('acquire')
  .description('Run a forensic email acquisition')
  .requiredOption('-p, --project <id>', 'Project ID')
  .requiredOption('-H, --host <host>', 'IMAP server host')
  .option('--port <port>', 'IMAP server port', '993')
  .option('-u, --user <username>', 'Username (defaults to target email)')
  .option('--password <password>', 'Password')
  .option('--app-password <password>', 'App-specific password (for Gmail, Yahoo, etc.)')
  .option('--no-tls', 'Disable TLS')
  .option('--collect-drive-links', 'Detect drive links in emails during acquisition', true)
  .option('--no-collect-drive-links', 'Disable drive link detection')
  .option('--collect-modern-attachments', 'Collect modern attachments', true)
  .option('--no-collect-modern-attachments', 'Disable modern attachment collection')
  .option('--folders <folders>', 'Comma-separated folder list to acquire')
  .option('--exclude <folders>', 'Comma-separated folder list to exclude')
  .option('-o, --output <dir>', 'Output directory', './projects')
  .option('--throttle <ms>', 'Delay between messages in ms', '0')
  .option('--hash <algorithms>', 'Hash algorithms (comma-separated)', 'md5,sha256')
  .option('--differential', 'Enable differential acquisition')
  .action(async (opts) => {
    const db = await ForensicDatabase.create(DB_PATH);
    const project = db.getProject(opts.project);
    if (!project) {
      console.error(chalk.red('✗ Project not found: ' + opts.project));
      db.close();
      process.exit(1);
    }

    console.log(chalk.cyan('\n  SherlockMail — Acquisition'));
    console.log(chalk.dim('  ═══════════════════════════'));
    console.log(chalk.dim('  Project: ') + project.name);
    console.log(chalk.dim('  Target:  ') + project.target_email);
    console.log(chalk.dim('  Server:  ') + opts.host + ':' + opts.port);
    console.log('');

    const engine = new AcquisitionEngine(db, opts.project, {
      host: opts.host,
      port: parseInt(opts.port),
      tls: opts.tls !== false,
      email: project.target_email,
      username: opts.user || project.target_email,
      password: opts.password,
      appPassword: opts.appPassword,
      outputDir: join(opts.output, project.id || opts.project),
      includeFolders: opts.folders?.split(','),
      excludeFolders: opts.exclude?.split(','),
      throttleDelay: parseInt(opts.throttle),
      hashAlgorithms: opts.hash.split(','),
      differential: opts.differential,
      collectDriveLinks: opts.collectDriveLinks,
      collectModernAttachments: opts.collectModernAttachments,
      examinerName: project.examiner_name,
      providerType: project.provider_type
    });

    engine.on('connected', (e) => console.log(chalk.green('  ✓ Connected to ') + e.host));
    engine.on('folder_start', (e) => console.log(chalk.yellow('\n  ▶ Acquiring folder: ') + e.folder));
    engine.on('folder_status', (e) => console.log(chalk.dim(`    ${e.total} messages to acquire`)));
    engine.on('message_acquired', (e) => {
      process.stdout.write(chalk.dim(`\r    [${e.acquired}/${e.total}] `) + chalk.green('✓ ') + (e.subject || '(no subject)').substring(0, 60).padEnd(60));
    });
    engine.on('message_failed', (e) => {
      console.log(chalk.red(`\n    ✗ UID ${e.uid}: ${e.error}`));
    });
    engine.on('folder_complete', (e) => {
      console.log(chalk.green(`\n    ✓ Folder complete: ${e.acquired} messages acquired`));
    });
    engine.on('drive_links_detected', (e) => {
      console.log(chalk.magenta(`    🔗 ${e.links.length} drive link(s) in: ${(e.subject || '').substring(0, 50)}`));
    });

    try {
      const result = await engine.run();
      console.log(chalk.green('\n  ═══════════════════════════'));
      console.log(chalk.green('  ✓ Acquisition Complete'));
      console.log(chalk.dim('    Acquired:  ') + chalk.green(result.stats.acquiredMessages));
      console.log(chalk.dim('    Failed:    ') + (result.stats.failedMessages > 0 ? chalk.red(result.stats.failedMessages) : '0'));
      console.log(chalk.dim('    Skipped:   ') + result.stats.skippedMessages);
      console.log(chalk.dim('    Total size:') + ' ' + formatBytes(result.stats.totalBytes));
      console.log('');
    } catch (error) {
      console.error(chalk.red('\n  ✗ Acquisition failed: ' + error.message));
      process.exit(1);
    } finally {
      db.close();
    }
  });

// --- List Projects ---
program
  .command('list')
  .description('List all projects')
  .action(async () => {
    const db = await ForensicDatabase.create(DB_PATH);
    const projects = db.listProjects();
    if (projects.length === 0) {
      console.log(chalk.dim('  No projects found. Create one with: fmc create -n "Name" -e target@email.com'));
      db.close();
      return;
    }
    console.log(chalk.cyan('\n  Projects'));
    console.log(chalk.dim('  ════════'));
    for (const p of projects) {
      const statusColor = p.status === 'completed' ? chalk.green : p.status === 'failed' ? chalk.red : chalk.yellow;
      console.log(`  ${chalk.dim(p.id.substring(0, 8))}  ${p.name.padEnd(30)}  ${p.target_email.padEnd(30)}  ${statusColor(p.status.padEnd(12))}  ${p.created_at}`);
    }
    console.log('');
    db.close();
  });

// --- Search ---
program
  .command('search')
  .description('Search messages in a project')
  .requiredOption('-p, --project <id>', 'Project ID')
  .requiredOption('-q, --query <query>', 'Search query')
  .option('--inline', 'Use inline search (supports advanced syntax)')
  .action(async (opts) => {
    const db = await ForensicDatabase.create(DB_PATH);
    let results;
    if (opts.inline) {
      const all = db.prepare('SELECT * FROM messages WHERE project_id = ?').all(opts.project);
      const search = new InlineSearch();
      results = search.search(all, opts.query);
    } else {
      results = db.searchMessages(opts.project, opts.query);
    }

    console.log(chalk.cyan(`\n  Search Results (${results.length})`));
    console.log(chalk.dim('  ══════════════'));
    for (const m of results.slice(0, 50)) {
      console.log(`  ${chalk.dim(m.date?.substring(0, 10) || '??')}  ${(m.from_address || '').padEnd(30).substring(0, 30)}  ${(m.subject || '').substring(0, 50)}`);
    }
    if (results.length > 50) console.log(chalk.dim(`  ... and ${results.length - 50} more`));
    console.log('');
    db.close();
  });

// --- Detect Provider ---
program
  .command('detect')
  .description('Detect email provider from email address')
  .argument('<email>', 'Email address')
  .action(async (email) => {
    const result = await detectProvider(email);
    console.log(chalk.cyan('\n  Provider Detection'));
    console.log(chalk.dim('  ══════════════════'));
    console.log(chalk.dim('  Provider: ') + chalk.green(result.profile?.name || 'Unknown'));
    console.log(chalk.dim('  Type:     ') + (result.profile?.type || 'unknown'));
    console.log(chalk.dim('  Method:   ') + result.method);
    if (result.profile?.imap) {
      console.log(chalk.dim('  IMAP:     ') + `${result.profile.imap.host}:${result.profile.imap.port}`);
    }
    if (result.profile?.supportsOAuth) console.log(chalk.green('  ✓ Supports OAuth 2.0'));
    if (result.profile?.requiresAppPassword) console.log(chalk.yellow('  ⚠ Requires app-specific password'));
    console.log('');
  });

// --- Verify ---
program
  .command('verify')
  .description('Verify hash integrity of an EML file')
  .argument('<file>', 'EML file path')
  .option('-a, --algorithm <alg>', 'Hash algorithm', 'sha256')
  .option('-e, --expected <hash>', 'Expected hash value')
  .action(async (file, opts) => {
    try {
      const hash = await hashFile(file, opts.algorithm);
      console.log(chalk.dim(`\n  ${opts.algorithm.toUpperCase()}: `) + chalk.cyan(hash));
      if (opts.expected) {
        const result = await verifyFileHash(file, opts.expected, opts.algorithm);
        console.log(result.valid ? chalk.green('  ✓ Hash verified') : chalk.red('  ✗ Hash mismatch'));
      }
    } catch (err) {
      console.error(chalk.red('  ✗ ' + err.message));
    }
    console.log('');
  });

// --- Audit ---
program
  .command('audit')
  .description('View chain of custody audit log')
  .requiredOption('-p, --project <id>', 'Project ID')
  .option('--verify', 'Verify chain integrity')
  .option('--export <dir>', 'Export audit log to directory')
  .action(async (opts) => {
    const db = await ForensicDatabase.create(DB_PATH);
    if (opts.verify) {
      const custody = new ChainOfCustody(db, opts.project, '');
      const result = custody.verifyChain();
      if (result.valid) {
        console.log(chalk.green(`\n  ✓ Chain integrity verified (${result.checked} entries)\n`));
      } else {
        console.log(chalk.red(`\n  ✗ Chain integrity BROKEN\n`));
      }
    } else if (opts.export) {
      const custody = new ChainOfCustody(db, opts.project, '');
      const paths = await custody.exportLog(opts.export);
      console.log(chalk.green('\n  ✓ Audit log exported'));
      console.log(chalk.dim('  JSON: ') + paths.jsonPath);
      console.log(chalk.dim('  TSV:  ') + paths.tsvPath);
      console.log('');
    } else {
      const log = db.getAuditLog(opts.project);
      console.log(chalk.cyan(`\n  Audit Log (${log.length} entries)`));
      console.log(chalk.dim('  ══════════════'));
      for (const e of log) {
        const color = e.event_type.includes('FAIL') ? chalk.red : e.event_type.includes('COMPLETE') ? chalk.green : chalk.dim;
        console.log(`  ${chalk.dim(e.timestamp)}  ${color(e.event_type.padEnd(24))}  ${e.description}`);
      }
      console.log('');
    }
    db.close();
  });

// --- Providers ---
program
  .command('providers')
  .description('List supported email providers')
  .action(() => {
    const providers = listProviders();
    console.log(chalk.cyan('\n  Supported Providers'));
    console.log(chalk.dim('  ═══════════════════'));
    for (const p of providers) {
      console.log(`  ${p.name.padEnd(30)}  ${chalk.dim(p.type.padEnd(12))}  ${p.supportsOAuth ? chalk.green('OAuth') : chalk.dim('Basic')}`);
    }
    console.log('');
  });

// --- QC Verify ---
program
  .command('qc')
  .description('Run QC verification against the mail server')
  .requiredOption('-p, --project <id>', 'Project ID')
  .requiredOption('-H, --host <host>', 'IMAP server host')
  .option('--port <port>', 'IMAP server port', '993')
  .option('-u, --user <username>', 'Username')
  .option('--password <password>', 'Password')
  .option('--app-password <password>', 'App-specific password')
  .option('--no-verify-hashes', 'Skip hash verification')
  .option('--sample-size <n>', 'Verify a sample of N messages per folder (0=all)', '0')
  .action(async (opts) => {
    const db = await ForensicDatabase.create(DB_PATH);
    const project = db.getProject(opts.project);
    if (!project) { console.error(chalk.red('✗ Project not found')); db.close(); process.exit(1); }

    console.log(chalk.cyan('\n  SherlockMail — QC Verification'));
    console.log(chalk.dim('  ═══════════════════════════════'));
    console.log(chalk.dim('  Project: ') + project.name);
    console.log(chalk.dim('  Server:  ') + opts.host + ':' + opts.port);
    console.log('');

    const verifier = new QCVerifier(db, opts.project, {
      host: opts.host,
      port: parseInt(opts.port),
      email: project.target_email,
      username: opts.user || project.target_email,
      password: opts.password,
      appPassword: opts.appPassword
    });

    verifier.on('connected', () => console.log(chalk.green('  ✓ Connected to server')));
    verifier.on('folder_start', (e) => console.log(chalk.yellow(`\n  ▶ Verifying folder: ${e.folder}`)));
    verifier.on('message_verified', (e) => {
      const icon = e.status === 'VERIFIED' ? chalk.green('✓') : chalk.red('✗');
      process.stdout.write(`\r    ${icon} UID ${e.uid}: ${e.status}`.padEnd(60));
    });

    try {
      const results = await verifier.verify({
        verifyHashes: opts.verifyHashes,
        sampleSize: parseInt(opts.sampleSize)
      });

      const s = results.summary;
      console.log(chalk.green('\n\n  ═══════════════════════════════'));
      console.log(s.overallVerdict === 'PASS'
        ? chalk.green('  ✓ QC VERIFICATION PASSED')
        : chalk.red('  ✗ QC ISSUES FOUND'));
      console.log(chalk.dim('    Folders checked:  ') + s.totalFoldersChecked);
      console.log(chalk.dim('    Messages checked: ') + s.totalMessagesChecked);
      console.log(chalk.dim('    Hash matches:     ') + chalk.green(s.hashMatches));
      console.log(chalk.dim('    Hash mismatches:  ') + (s.hashMismatches > 0 ? chalk.red(s.hashMismatches) : '0'));
      console.log(chalk.dim('    Count mismatches: ') + (s.folderCountMismatches > 0 ? chalk.yellow(s.folderCountMismatches) : '0'));
      console.log('');
    } catch (err) {
      console.error(chalk.red('\n  ✗ QC verification failed: ' + err.message));
      process.exit(1);
    } finally {
      db.close();
    }
  });

// --- Export ---
program
  .command('export')
  .description('Export collected mail to various formats')
  .requiredOption('-p, --project <id>', 'Project ID')
  .requiredOption('-f, --format <format>', 'Export format: eml, mbox, xml, msg, pst, container')
  .option('-o, --output <dir>', 'Output directory')
  .option('--pst-size <gb>', 'PST file size limit in GB (1-100)', '10')
  .option('--container-type <type>', 'Container type: mime or msg', 'mime')
  .action(async (opts) => {
    const db = await ForensicDatabase.create(DB_PATH);
    const project = db.getProject(opts.project);
    if (!project) { console.error(chalk.red('✗ Project not found')); db.close(); process.exit(1); }

    const outDir = opts.output || join('./exports', opts.project, opts.format);

    console.log(chalk.cyan('\n  SherlockMail — Export'));
    console.log(chalk.dim('  ═════════════════════'));
    console.log(chalk.dim('  Project: ') + project.name);
    console.log(chalk.dim('  Format:  ') + opts.format.toUpperCase());
    console.log(chalk.dim('  Output:  ') + outDir);
    console.log('');

    const exporter = new ForensicExporter(db, opts.project);
    exporter.on('message_exported', (e) => {
      process.stdout.write(chalk.dim(`\r  Exporting UID ${e.uid}...`.padEnd(60)));
    });
    exporter.on('pst_set_created', (e) => {
      console.log(chalk.green(`  ✓ PST set ${e.setIndex}/${e.totalSets} created (${e.messageCount} messages)`));
    });

    try {
      const result = await exporter.export(opts.format, outDir, {
        pstSizeGB: parseInt(opts.pstSize),
        containerType: opts.containerType
      });
      console.log(chalk.green('\n  ═════════════════════'));
      console.log(chalk.green('  ✓ Export Complete'));
      console.log(chalk.dim('    Messages: ') + result.count);
      if (result.totalSets) console.log(chalk.dim('    PST sets: ') + result.totalSets);
      console.log('');
    } catch (err) {
      console.error(chalk.red('\n  ✗ Export failed: ' + err.message));
      process.exit(1);
    } finally {
      db.close();
    }
  });

// --- Drive Links ---
program
  .command('drive-scan')
  .description('Scan collected emails for cloud drive links')
  .requiredOption('-p, --project <id>', 'Project ID')
  .action(async (opts) => {
    const db = await ForensicDatabase.create(DB_PATH);
    const detector = new DriveAttachmentDetector(db, opts.project);

    console.log(chalk.cyan('\n  SherlockMail — Drive Link Scan'));
    console.log(chalk.dim('  ═════════════════════════════'));

    detector.on('links_found', (e) => {
      console.log(chalk.magenta(`  🔗 ${e.linkCount} link(s) in: `) + (e.subject || '').substring(0, 50));
    });
    detector.on('progress', (e) => {
      process.stdout.write(chalk.dim(`\r  Scanning ${e.scanned}/${e.total}...`.padEnd(50)));
    });

    const results = await detector.scanAllMessages();
    console.log(chalk.green('\n\n  ✓ Scan Complete'));
    console.log(chalk.dim('    Messages scanned: ') + results.scanned);
    console.log(chalk.dim('    With drive links: ') + results.withLinks);
    console.log(chalk.dim('    Total links:      ') + results.totalLinks);
    for (const [provider, count] of Object.entries(results.byProvider)) {
      console.log(chalk.dim(`    ${provider}: `) + count);
    }
    console.log('');
    db.close();
  });

program
  .command('drive-package')
  .description('Create drive attachment packages for emails with cloud links')
  .requiredOption('-p, --project <id>', 'Project ID')
  .option('-o, --output <dir>', 'Output directory', './exports')
  .action(async (opts) => {
    const db = await ForensicDatabase.create(DB_PATH);
    const detector = new DriveAttachmentDetector(db, opts.project);

    detector.on('package_created', (e) => {
      console.log(chalk.green(`  ✓ Package: `) + (e.subject || '').substring(0, 50) + chalk.dim(` (${e.linkCount} links)`));
    });

    const result = await detector.createDrivePackages(join(opts.output, opts.project));
    console.log(chalk.green(`\n  ✓ Created ${result.packages} package(s) with ${result.totalLinks} drive link(s)\n`));
    db.close();
  });

program
  .command('stage')
  .description('Create staged output with drive attachment packages')
  .requiredOption('-p, --project <id>', 'Project ID')
  .option('-o, --output <dir>', 'Output directory', './exports')
  .action(async (opts) => {
    const db = await ForensicDatabase.create(DB_PATH);
    const detector = new DriveAttachmentDetector(db, opts.project);

    const result = await detector.createStagedOutput(join(opts.output, opts.project));
    console.log(chalk.cyan('\n  Staged Output'));
    console.log(chalk.dim('  ═══════════════'));
    console.log(chalk.dim('    Total messages:       ') + result.totalMessages);
    console.log(chalk.dim('    With drive packages:   ') + result.withDrivePackages);
    console.log(chalk.dim('    Without packages:      ') + result.withoutDrivePackages);
    if (result.failed > 0) console.log(chalk.red('    Failed: ') + result.failed);
    console.log(chalk.dim('    Output: ') + result.stagedDir);
    console.log('');
    db.close();
  });

// --- Dashboard ---
program
  .command('dashboard')
  .description('Start the web dashboard')
  .option('--port <port>', 'Port number', '3847')
  .action(async (opts) => {
    process.env.FMC_PORT = opts.port;
    await import('../ui/server.js');
  });

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

program.parse();
