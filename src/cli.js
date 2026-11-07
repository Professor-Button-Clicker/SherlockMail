import fs from 'fs';

// Command-line use of a running SherlockMail server, in the same process. Results go to stdout as JSON and
// the exit code says whether the evidence checks out, so scripts can act on it. Passwords never go on the
// command line: a collection's connection comes from a JSON file.

export const CLI_COMMAND_NAMES = ['status', 'collect', 'import', 'search', 'qc', 'verify', 'export', 'timestamp'];

function parseOptions(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { options[argv[i].slice(2)] = next; i++; }
    else options[argv[i].slice(2)] = true;
  }
  return options;
}

export async function runCli(baseUrl, argv, out = console.log) {
  const [command, ...rest] = argv;
  const options = parseOptions(rest);
  const call = async (path, body) => {
    const res = await fetch(`${baseUrl}/api${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  };
  const project = () => {
    if (!options.project) throw new Error(`${command} needs --project <id>. List projects with: status`);
    return options.project;
  };
  const print = data => out(JSON.stringify(data, null, 2));

  switch (command) {
    case 'status': {
      if (!options.project) {
        print((await call('/projects-summary')).map(p => ({ id: p.id, name: p.name, mailbox: p.target_email, status: p.status, messages: p.message_count, collections: p.acquisition_count, exports: p.export_count })));
        return 0;
      }
      const p = await call(`/projects/${project()}`);
      print({ id: p.id, name: p.name, mailbox: p.target_email, status: p.status, caseId: p.case_id, examiner: p.examiner_name, acquisitions: await call(`/projects/${p.id}/acquisitions`).then(rows => rows.map(a => ({ id: a.id, status: a.status, completion: a.completion_type, acquired: a.acquired_messages, failed: a.failed_messages }))) });
      return 0;
    }
    case 'collect': {
      if (!options.connection) throw new Error('collect needs --connection <file.json> (protocol, host, port, username, password...)');
      const config = JSON.parse(fs.readFileSync(options.connection, 'utf8'));
      const id = project();
      await call(`/projects/${id}/collect`, { config, folders: options.folders ? String(options.folders).split(',').map(f => f.trim()) : undefined, outputDir: options.output, scope: options.scope || 'email' });
      let progress;
      do {
        await new Promise(r => setTimeout(r, 500));
        progress = await call(`/projects/${id}/collect/progress`);
      } while (progress.active !== false);
      const { status, completionType, messageCount, failedCount, skippedCount, sessionDir, error } = progress.result || {};
      print({ status, completionType, messageCount, failedCount, skippedCount, sessionDir, error });
      return status === 'completed' ? 0 : 1;
    }
    case 'import': {
      if (!options.path) throw new Error('import needs --path <file or folder>');
      const r = await call(`/projects/${project()}/import`, { filePath: options.path, format: options.format });
      print(r);
      return r.failed || r.folderErrors ? 1 : 0;
    }
    case 'search': {
      if (!options.query) throw new Error('search needs --query <text>');
      const r = await call(`/projects/${project()}/inline-search`, { query: options.query });
      print({ matched: r.stats.matched, total: r.stats.total, results: r.results });
      return 0;
    }
    case 'qc': {
      const r = await call(`/projects/${project()}/qc`, { scope: 'full' });
      print({ overallStatus: r.overallStatus, summary: r.summary, checks: r.checks.map(c => ({ name: c.name, status: c.status, detail: c.detail })) });
      return r.overallStatus === 'fail' ? 1 : 0;
    }
    case 'verify': {
      const r = await call(`/projects/${project()}/verify`);
      const { details, ...hashes } = r.hashVerification;
      const exportsOk = r.exportIntegrity.every(e => e.valid);
      print({ hashes, problems: details.filter(d => !['verified', 'no_file', 'no_hash'].includes(d.status)), auditChainValid: r.auditLogIntegrity.chainVerified.valid, exports: r.exportIntegrity.map(e => ({ format: e.format, valid: e.valid, verified: e.verified, failed: e.failed })), trustedTimestamps: r.timestampRecords });
      return hashes.modified || hashes.missing || !r.auditLogIntegrity.chainVerified.valid || !exportsOk ? 1 : 0;
    }
    case 'export': {
      if (!options.format) throw new Error('export needs --format <eml|msg|pst|mbox|mime|pdf|concordance|xml>');
      const r = await call(`/projects/${project()}/export`, { format: options.format, outputDir: options.output });
      print({ format: r.format, outputDir: r.outputDir, messages: r.messageCount, files: r.files.length, totalBytes: r.totalBytes, failed: r.failedCount, verificationFailures: r.verificationFailures.length, timestamp: r.timestamp });
      return r.failedCount || r.verificationFailures.length ? 1 : 0;
    }
    case 'timestamp': {
      const r = await call(`/projects/${project()}/timestamp`, { type: options.type || 'collection', tsaUrl: options.tsa });
      print(r);
      return r.status === 'verified' ? 0 : 1;
    }
    default:
      throw new Error(`Unknown command: ${command}. Commands: ${CLI_COMMAND_NAMES.join(', ')}`);
  }
}
