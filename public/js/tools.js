// The Tools tab, and message-level checks opened from Review. Shares api(), esc(), toast() with app.js.

function switchToolsTab(name) {
  document.querySelectorAll('#tools-sub-tabs .sub-tab').forEach(t => t.classList.toggle('active', t.dataset.subtab === name));
  document.querySelectorAll('#view-tools .sub-panel').forEach(p => p.classList.toggle('active', p.id === `tools-${name}`));
  if (name === 'snapshots') loadSnapshots();
  if (name === 'certificates') loadCertificates();
  if (name === 'settings') loadSettings();
  if (name === 'signins') loadSignins();
}

function toolsNeedProject() {
  if (currentProject) return false;
  toast('Open a project first');
  return true;
}

const toolStatus = (id, text, kind) => {
  const el = document.getElementById(id);
  if (el) el.innerHTML = kind ? `<span class="${kind === 'ok' ? 'verify-pass' : 'verify-fail'}">${esc(text)}</span>` : `<span style="color:var(--accent)">${esc(text)}</span>`;
};
const toolValue = id => document.getElementById(id)?.value.trim() || '';

async function toolPickFolder(inputId) {
  try {
    const r = await api('/pick-folder', { method: 'POST' });
    if (r.path) document.getElementById(inputId).value = r.path;
  } catch {
    toast('The folder picker is not available here; type the path instead');
  }
}

function renderTable(rows, columns) {
  if (!rows?.length) return '<p style="color:var(--text-muted);font-size:13px">Nothing to show.</p>';
  return `<div style="overflow-x:auto"><table class="audit-table"><thead><tr>${columns.map(c => `<th>${esc(c.label)}</th>`).join('')}</tr></thead><tbody>
    ${rows.map(r => `<tr>${columns.map(c => `<td>${esc(c.value(r) ?? '')}</td>`).join('')}</tr>`).join('')}
  </tbody></table></div>`;
}

// ── Import ──
async function runImport() {
  if (toolsNeedProject()) return;
  const filePath = toolValue('import-path');
  if (!filePath) { toolStatus('import-status', 'Enter a file or folder', 'fail'); return; }
  toolStatus('import-status', 'Importing...');
  document.getElementById('import-results').innerHTML = '';
  try {
    const body = { filePath };
    const target = toolValue('import-folder');
    if (target) body.targetFolder = target;
    const r = await api(`/projects/${currentProject.id}/import`, { method: 'POST', body });
    toolStatus('import-status', r.failed || r.folderErrors ? `Imported ${r.successful}; ${r.failed || 0} item(s) and ${r.folderErrors || 0} folder(s) could not be read` : `Imported ${r.successful} message(s)`, r.failed || r.folderErrors ? 'fail' : 'ok');
    document.getElementById('import-results').innerHTML = `
      <div class="form-hint" style="margin-bottom:8px">Format: ${esc(r.pstFormat || r.format.toUpperCase())}. Saved to <code>${esc(r.outputDir)}</code></div>
      ${r.sourceSha256 ? `<div class="form-hint">Source SHA-256: <code>${esc(r.sourceSha256)}</code></div>` : ''}
      <div class="form-hint">${r.sourceUnchanged ? 'The source was hashed before and after, and did not change.' : '<span class="verify-fail">The source file changed during the import.</span>'}</div>
      ${r.format === 'pst' ? '<div class="form-hint">A PST keeps properties, not the original message, so each item is rebuilt as an EML and labelled as a reconstruction.</div>' : ''}
      ${r.errors?.length ? `<details style="margin-top:8px"><summary style="cursor:pointer;color:var(--danger);font-size:13px">${r.errors.length} problem(s)</summary><ul style="font-size:12px">${r.errors.map(e => `<li>${esc(e.item || e.folder || e.source || '')}: ${esc(e.error)}</li>`).join('')}</ul></details>` : ''}`;
    refreshCaseTag();
    loadSystemInfo();
  } catch (err) {
    toolStatus('import-status', `Import failed: ${err.message}`, 'fail');
  }
}

// ── Exchange ──
function exchangeConfig() {
  const config = { protocol: 'ews', email: toolValue('ex-email') || currentProject?.target_email };
  const url = toolValue('ex-url');
  if (url) config.ewsUrl = url;
  const password = document.getElementById('ex-password').value;
  if (password) config.password = password;
  if (toolsEnterprise) { config.enterpriseSessionId = toolsEnterprise.sessionId; config.targetUser = config.email; }
  return config;
}

async function runExchange(kind) {
  if (toolsNeedProject()) return;
  const out = document.getElementById('exchange-results');
  out.innerHTML = '';
  toolStatus('exchange-status', 'Reading from the server...');
  try {
    if (kind === 'version') {
      const v = await api('/exchange/detect-version', { method: 'POST', body: { config: exchangeConfig() } });
      if (v.error) throw new Error(v.error);
      toolStatus('exchange-status', `${v.product} (version ${v.serverVersion})`, 'ok');
      return;
    }
    const r = await api(`/projects/${currentProject.id}/exchange/${kind}`, { method: 'POST', body: { config: exchangeConfig() } });
    if (r.error) throw new Error(r.error);
    toolStatus('exchange-status', 'Done', 'ok');
    if (kind === 'recoverable-items') {
      out.innerHTML = `<p class="form-hint">${r.totalRecoverableItems} item(s). ${esc(r.forensicNote)}</p>` + r.folders.map(f => `
        <h4 style="margin:12px 0 6px;font-size:13px">${esc(f.folder)} ${f.error ? `<span class="verify-fail">could not be read: ${esc(f.error)}</span>` : `(${f.itemCount})`}</h4>
        ${f.error ? '' : renderTable(f.items, [{ label: 'Subject', value: i => i.subject }, { label: 'From', value: i => i.from }, { label: 'Received', value: i => i.received }, { label: 'Size', value: i => formatBytes(i.size) }])}`).join('');
    } else if (kind === 'archive') {
      out.innerHTML = `<p class="form-hint">${r.hasArchive ? 'This mailbox has an online archive.' : 'This mailbox has no online archive.'} ${esc(r.forensicNote || '')}</p>` + renderTable(r.folders, [{ label: 'Folder', value: f => f.name }, { label: 'Messages', value: f => f.totalMessages }]);
    } else if (kind === 'public-folders') {
      out.innerHTML = `<p class="form-hint">${esc(r.forensicNote || '')}</p>` + renderTable(r.folders, [{ label: 'Folder', value: f => f.name }, { label: 'Messages', value: f => f.totalMessages }]);
    } else {
      out.innerHTML = `<p class="form-hint">${r.totalRules} rule(s). ${r.redFlags.length ? `<span class="verify-fail">${r.redFlags.length} forward or delete mail.</span>` : ''} ${esc(r.forensicNote || '')}</p>` + renderTable(r.rules, [{ label: 'Rule', value: x => x.name }, { label: 'Enabled', value: x => (x.enabled ? 'Yes' : 'No') }, { label: 'Actions', value: x => x.actions.map(a => `${a.type}${a.targets.length ? ` (${a.targets.join(', ')})` : ''}`).join('; ') }]);
    }
  } catch (err) {
    toolStatus('exchange-status', err.message, 'fail');
  }
}

// ── Calendar, contacts and drive listings ──
async function runCloud(kind) {
  if (toolsNeedProject()) return;
  const out = document.getElementById('cloud-tool-results');
  out.innerHTML = '';
  toolStatus('cloud-tool-status', 'Reading from the provider...');
  const paths = {
    calendar: '/calendar/events', 'google-contacts': '/contacts/google', 'ms-contacts': '/contacts/microsoft',
    'google-drive': '/drive/google/items', onedrive: '/drive/onedrive/items', sharepoint: '/drive/sharepoint/sites',
  };
  try {
    const r = await api(`/projects/${currentProject.id}${paths[kind]}`, { method: 'POST', body: {} });
    toolStatus('cloud-tool-status', 'Done', 'ok');
    const saved = r.file ? `<p class="form-hint">Raw copy: <code>${esc(r.file)}</code>, SHA-256 <code>${esc(r.sha256)}</code></p>` : '';
    if (kind === 'calendar') out.innerHTML = saved + renderTable(r.events, [{ label: 'Event', value: e => e.summary }, { label: 'Start', value: e => e.startTime }, { label: 'Organizer', value: e => e.organizer }, { label: 'Status', value: e => e.status }]);
    else if (kind.endsWith('contacts')) out.innerHTML = saved + renderTable(r.contacts, [{ label: 'Name', value: c => c.displayName }, { label: 'E-mail', value: c => c.emailAddresses.join(', ') }, { label: 'Phone', value: c => c.phoneNumbers.join(', ') }, { label: 'Organization', value: c => c.organization }]);
    else if (kind === 'sharepoint') out.innerHTML = renderTable(r, [{ label: 'Site', value: s => s.name }, { label: 'Address', value: s => s.webUrl }]);
    else out.innerHTML = renderTable(r.items, [{ label: 'Name', value: i => i.path || i.name }, { label: 'Type', value: i => i.itemType }, { label: 'Size', value: i => formatBytes(i.size) }, { label: 'Modified', value: i => i.modifiedTime }]);
  } catch (err) {
    toolStatus('cloud-tool-status', err.message, 'fail');
  }
}

async function grantCloudPermission(provider, features) {
  try {
    const { url } = await api(`/oauth/${provider}/authorize?features=${features}`);
    window.open(url, '_blank');
    toolStatus('cloud-tool-status', 'Finish the sign-in in the browser window...');
    const r = await api(`/oauth/${provider}/wait`);
    toolStatus('cloud-tool-status', r.error ? r.error : 'Permission granted', r.error ? 'fail' : 'ok');
  } catch (err) {
    toolStatus('cloud-tool-status', err.message, 'fail');
  }
}

// ── Folder snapshots ──
async function loadSnapshots() {
  if (!currentProject) return;
  try {
    const rows = await api(`/projects/${currentProject.id}/snapshots`);
    document.getElementById('snapshots-list').innerHTML = renderTable(rows, [
      { label: 'Taken', value: s => s.captured_at }, { label: 'Type', value: s => s.snapshot_type }, { label: 'Folders', value: s => s.total_folders },
      { label: 'Messages', value: s => s.total_messages }, { label: 'SHA-256', value: s => (s.hash_sha256 || '').slice(0, 16) },
    ]);
  } catch (err) {
    toolStatus('snapshots-status', err.message, 'fail');
  }
}

async function takeSnapshot() {
  if (toolsNeedProject()) return;
  wizSaveConnection();
  toolStatus('snapshots-status', 'Reading the folder list from the server...');
  try {
    const s = await api(`/projects/${currentProject.id}/snapshots`, { method: 'POST', body: { config: wizConnection, snapshotType: 'manual' } });
    toolStatus('snapshots-status', `Snapshot taken: ${s.totalFolders} folders, ${s.totalMessages} messages`, 'ok');
    loadSnapshots();
  } catch (err) {
    toolStatus('snapshots-status', err.message, 'fail');
  }
}

async function compareSnapshots() {
  if (toolsNeedProject()) return;
  try {
    const c = await api(`/projects/${currentProject.id}/snapshots/compare`, { method: 'POST', body: {} });
    const changes = [
      ...c.foldersAdded.map(f => `Added: ${f.path}`), ...c.foldersRemoved.map(f => `Removed: ${f}`),
      ...c.foldersChanged.map(f => `${f.path}: ${f.before} to ${f.after} messages`),
    ];
    document.getElementById('snapshots-compare').innerHTML = `<p class="form-hint">Latest against the one before it: ${c.messageDelta >= 0 ? '+' : ''}${c.messageDelta} messages.</p>${changes.length ? `<ul style="font-size:13px">${changes.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="form-hint">No folder changed.</p>'}`;
  } catch (err) {
    toolStatus('snapshots-status', err.message, 'fail');
  }
}

// ── Reports ──
function showReport(text) {
  document.getElementById('reports-output').innerHTML = `<pre style="white-space:pre-wrap;font-size:11px;font-family:var(--font-mono);max-height:420px;overflow:auto;background:var(--bg-raised);border:1px solid var(--border);padding:12px;border-radius:var(--radius)">${esc(text)}</pre>`;
}

async function runReport(kind) {
  if (toolsNeedProject()) return;
  toolStatus('reports-status', 'Working...');
  try {
    if (kind === 'logs') {
      const r = await api(`/projects/${currentProject.id}/logs/compress`, { method: 'POST', body: {} });
      if (!r.compressed) { toolStatus('reports-status', r.reason, 'fail'); return; }
      toolStatus('reports-status', `${r.fileCount} log file(s) archived`, 'ok');
      showReport(`${r.outputPath}\nSHA-256: ${r.hash}\nSize: ${r.size} bytes (${r.compressionRatio} smaller)`);
      return;
    }
    const r = await api(`/projects/${currentProject.id}/reports/${kind}?save=true`);
    toolStatus('reports-status', `Saved to ${r.savedTo}`, 'ok');
    showReport(r.content);
  } catch (err) {
    toolStatus('reports-status', err.message, 'fail');
  }
}

// ── Certificates ──
async function readPemInto(inputId, fileInput) {
  const file = fileInput.files?.[0];
  if (file) document.getElementById(inputId).value = await file.text();
}

async function importCertificate() {
  const certificatePem = toolValue('cert-pem');
  if (!certificatePem) { toolStatus('cert-status', 'Choose or paste a certificate', 'fail'); return; }
  const body = { certificatePem, projectId: currentProject?.id || null };
  const privateKeyPem = toolValue('cert-key');
  if (privateKeyPem) { body.privateKeyPem = privateKeyPem; body.passphrase = document.getElementById('cert-pass').value || undefined; }
  try {
    const r = await api('/certificates', { method: 'POST', body });
    toolStatus('cert-status', `Imported ${r.subject}${r.hasPrivateKey ? ', with its private key' : ''}`, 'ok');
    ['cert-pem', 'cert-key', 'cert-pass'].forEach(id => { document.getElementById(id).value = ''; });
    loadCertificates();
  } catch (err) {
    toolStatus('cert-status', err.message, 'fail');
  }
}

async function loadCertificates() {
  try {
    const rows = await api(`/certificates${currentProject ? `?projectId=${currentProject.id}` : ''}`);
    document.getElementById('cert-list').innerHTML = renderTable(rows, [
      { label: 'Subject', value: c => c.subject }, { label: 'Issuer', value: c => c.issuer }, { label: 'Use', value: c => (c.cert_type === 'ca' ? 'Trusted issuer' : 'Decrypt') }, { label: 'Valid to', value: c => c.not_after },
    ]);
  } catch (err) {
    toolStatus('cert-status', err.message, 'fail');
  }
}

async function checkMessageSignature(msgId) {
  const el = document.getElementById('msg-crypto-result');
  el.innerHTML = '<span style="color:var(--accent)">Checking the signature...</span>';
  try {
    const r = await api(`/projects/${currentProject.id}/crypto/verify-signature`, { method: 'POST', body: { messageId: msgId } });
    if (!r.signed) { el.innerHTML = 'This message is not signed.'; return; }
    if (r.signatureValid === null) { el.innerHTML = `<span style="color:var(--warning)">${esc(r.note || 'Signature found, not verified.')}</span>`; return; }
    const who = (r.signerInfo?.subject || '').replace(/\n/g, ', ');
    el.innerHTML = r.signatureValid
      ? `<span class="verify-pass">Signature valid: the message has not changed since it was signed.</span>
         <div>Signer: ${esc(who)}. ${esc(r.algorithm || '')}${r.signingTime ? `, signed ${esc(r.signingTime)}` : ''}.</div>
         <div>${r.chainTrusted ? `Certificate chains to ${esc((r.trustedRoot || '').replace(/\n/g, ', '))}.` : `<span style="color:var(--warning)">The signer's certificate does not chain to a trusted root: ${esc((r.chainProblems || []).join('; '))}. Import the issuer in Tools, Certificates, if you trust it.</span>`}</div>`
      : `<span class="verify-fail">Signature NOT valid: ${esc((r.problems || []).join('; '))}</span>${who ? `<div>Claimed signer: ${esc(who)}</div>` : ''}`;
  } catch (err) {
    el.innerHTML = `<span class="verify-fail">${esc(err.message)}</span>`;
  }
}

async function decryptMessageCopy(msgId) {
  const el = document.getElementById('msg-crypto-result');
  el.innerHTML = '<span style="color:var(--accent)">Decrypting a copy...</span>';
  try {
    const r = await api(`/projects/${currentProject.id}/crypto/decrypt`, { method: 'POST', body: { messageId: msgId } });
    if (!r.decrypted) {
      el.innerHTML = `<span class="verify-fail">${esc(r.error)}</span>${r.encryptionAlgorithm ? `<div>Cipher: ${esc(r.encryptionAlgorithm)}, ${r.recipientCount} recipient(s). Import the recipient's certificate and key in Tools, Certificates.</div>` : ''}`;
      return;
    }
    el.innerHTML = `<span class="verify-pass">Decrypted with ${esc((r.certificateUsed?.subject || '').replace(/\n/g, ', '))} (${esc(r.encryptionAlgorithm)}). The evidence file was not changed.</span>
      <div>Copy: <code>${esc(r.outputPath)}</code></div><div>SHA-256: <code>${esc(r.sha256)}</code></div>
      <pre style="white-space:pre-wrap;margin-top:8px;font-size:13px">${esc(r.preview?.text || '')}</pre>`;
  } catch (err) {
    el.innerHTML = `<span class="verify-fail">${esc(err.message)}</span>`;
  }
}

// ── Diagnostics ──
async function runConnectivity() {
  const host = toolValue('diag-host');
  if (!host) { toolStatus('diag-status', 'Enter a host', 'fail'); return; }
  toolStatus('diag-status', 'Testing...');
  try {
    const r = await api('/connectivity/test', { method: 'POST', body: { host, port: Number(toolValue('diag-port')) || 993, projectId: currentProject?.id } });
    toolStatus('diag-status', r.status === 'success' ? `Reachable in ${r.latencyMs} ms` : r.error, r.status === 'success' ? 'ok' : 'fail');
    document.getElementById('diag-results').innerHTML = `<div class="form-hint">Address: ${esc(r.dnsResolved || 'not resolved')}</div>
      ${r.tlsVersion ? `<div class="form-hint">${esc(r.tlsVersion)}. Certificate ${r.certificateValid ? 'verified' : `<span class="verify-fail">did not verify: ${esc(r.certificateError)}</span>`}: ${esc(r.certificateInfo?.subject || '')}, issued by ${esc(r.certificateInfo?.issuer || '')}, valid to ${esc(r.certificateInfo?.validTo || '')}</div>` : ''}
      ${r.banner ? `<div class="form-hint">Server says: <code>${esc(r.banner)}</code></div>` : ''}`;
  } catch (err) {
    toolStatus('diag-status', err.message, 'fail');
  }
}

async function runServerProfile() {
  const email = toolValue('diag-email');
  if (!email) { toolStatus('diag-status', 'Enter an e-mail address', 'fail'); return; }
  toolStatus('diag-status', 'Looking up DNS...');
  try {
    const r = await api('/server-profiles/detect', { method: 'POST', body: { email } });
    toolStatus('diag-status', r.providerName ? `${r.providerName} (MX records)` : (r.mxRecords?.length ? 'No known provider: the addresses below are guesses' : 'No mail servers found for this domain'), r.mxRecords?.length ? 'ok' : 'fail');
    document.getElementById('diag-results').innerHTML = `<div class="form-hint">MX: ${esc((r.mxRecords || []).map(m => m.exchange).join(', ') || 'none')}</div>
      <div class="form-hint">SPF: ${esc(r.spfRecord || 'none')}</div><div class="form-hint">Suggested IMAP host: ${esc(r.imapHost || 'none')}</div>`;
  } catch (err) {
    toolStatus('diag-status', err.message, 'fail');
  }
}

async function runAutodiscover() {
  const email = toolValue('diag-email');
  if (!email) { toolStatus('diag-status', 'Enter an e-mail address', 'fail'); return; }
  toolStatus('diag-status', 'Trying Autodiscover...');
  try {
    const r = await api('/exchange/autodiscover', { method: 'POST', body: { email, password: document.getElementById('diag-password').value || undefined } });
    toolStatus('diag-status', r.discovered ? `Found ${r.ewsUrl || r.server}` : (r.needsPassword ? 'The server wants the mailbox password to answer' : 'Not found'), r.discovered ? 'ok' : 'fail');
    document.getElementById('diag-results').innerHTML = renderTable(r.attempts, [{ label: 'Tried', value: a => a.url }, { label: 'Result', value: a => a.status || a.error }]);
  } catch (err) {
    toolStatus('diag-status', err.message, 'fail');
  }
}

async function runHealth() {
  try {
    const [h, d] = await Promise.all([api('/health'), api('/health/disk')]);
    const events = currentProject ? await api(`/projects/${currentProject.id}/health/events`) : [];
    toolStatus('diag-status', h.healthy ? 'Healthy' : 'Problems found', h.healthy ? 'ok' : 'fail');
    document.getElementById('diag-results').innerHTML = `<div class="form-hint">${formatBytes(h.system.freeMemory)} of ${formatBytes(h.system.totalMemory)} memory free, ${h.system.cpuCores} CPU cores</div>
      <div class="form-hint">Data folder disk: ${d.error ? esc(d.error) : `${d.freeGb} GB free (${d.usedPercent}% used)`}</div>
      ${renderTable(events, [{ label: 'When', value: e => e.recorded_at }, { label: 'Severity', value: e => e.severity }, { label: 'Event', value: e => e.message }])}`;
  } catch (err) {
    toolStatus('diag-status', err.message, 'fail');
  }
}

// ── Settings: proxy and notifications ──
async function loadSettings() {
  try {
    const p = await api('/proxy/default');
    document.getElementById('proxy-current').textContent = p.configured === false || p.proxy_type === 'none' ? 'Connections are direct.' : `Using ${p.proxy_type}://${p.host}:${p.port}${p.username ? ` as ${p.username}` : ''}.`;
    if (currentProject) {
      const s = await api(`/notifications/smtp/settings/${currentProject.id}`);
      document.getElementById('smtp-current').textContent = s.configured === false ? 'No e-mail notifications are set up.' : `Sending through ${s.host}:${s.port} to ${(JSON.parse(s.to_addresses || '[]')).join(', ')}.`;
    }
  } catch (err) {
    toolStatus('proxy-status', err.message, 'fail');
  }
}

async function saveProxy() {
  try {
    const r = await api('/proxy/settings', { method: 'POST', body: {
      name: 'Default', proxyType: document.getElementById('proxy-type').value, host: toolValue('proxy-host'), port: Number(toolValue('proxy-port')),
      username: toolValue('proxy-user'), password: document.getElementById('proxy-pass').value,
    } });
    toolStatus('proxy-status', `Now: ${r.active}`, 'ok');
    document.getElementById('proxy-pass').value = '';
    loadSettings();
  } catch (err) {
    toolStatus('proxy-status', err.message, 'fail');
  }
}

function smtpForm() {
  return {
    projectId: currentProject?.id || null, host: toolValue('smtp-host'), port: Number(toolValue('smtp-port')) || 587, secure: document.getElementById('smtp-secure').checked,
    username: toolValue('smtp-user'), password: document.getElementById('smtp-pass').value, fromAddress: toolValue('smtp-from'), toAddresses: toolValue('smtp-to'),
    notifyOnComplete: true, notifyOnError: true, notifyOnExport: document.getElementById('smtp-on-export').checked,
  };
}

async function testSmtp() {
  toolStatus('smtp-status', 'Sending a test message...');
  try {
    const r = await api('/notifications/smtp/test', { method: 'POST', body: smtpForm() });
    toolStatus('smtp-status', `Test message accepted for ${r.recipients} recipient(s)`, 'ok');
  } catch (err) {
    toolStatus('smtp-status', err.message, 'fail');
  }
}

async function saveSmtp() {
  try {
    await api('/notifications/smtp/settings', { method: 'POST', body: smtpForm() });
    toolStatus('smtp-status', 'Saved', 'ok');
    document.getElementById('smtp-pass').value = '';
    loadSettings();
  } catch (err) {
    toolStatus('smtp-status', err.message, 'fail');
  }
}

// ── Other sign-ins ──
let toolsEnterprise = null;

function loadSignins() {
  const el = document.getElementById('enterprise-current');
  el.textContent = toolsEnterprise
    ? `Signed in (${toolsEnterprise.authMethod}, ${toolsEnterprise.environmentName || toolsEnterprise.environment}). Microsoft Graph and EWS collections in Collect now use this sign-in, for the mailbox named there. It ends when SherlockMail closes.`
    : 'Not signed in. Collect uses the normal Microsoft sign-in.';
  api('/oauth/yahoo/status').then((s) => {
    document.getElementById('yahoo-current').textContent = s.authenticated ? `Signed in${s.email ? ` as ${s.email}` : ''}. In Collect, choose IMAP with the auth method "Yahoo sign-in".` : (s.configured ? 'Client details saved. Not signed in.' : 'Not set up.');
  }).catch(() => {});
}

async function enterpriseSignIn() {
  toolStatus('enterprise-status', 'Signing in...');
  try {
    toolsEnterprise = await api('/enterprise/authenticate', { method: 'POST', body: {
      tenantId: toolValue('ent-tenant'), clientId: toolValue('ent-client'), clientSecret: document.getElementById('ent-secret').value, azureEnvironment: document.getElementById('ent-env').value,
    } });
    document.getElementById('ent-secret').value = '';
    toolStatus('enterprise-status', 'Signed in', 'ok');
    loadSignins();
  } catch (err) {
    toolStatus('enterprise-status', err.message, 'fail');
  }
}

async function enterpriseImportToken() {
  toolStatus('enterprise-status', 'Importing...');
  try {
    toolsEnterprise = await api('/enterprise/import-token', { method: 'POST', body: { access_token: document.getElementById('ent-token').value.trim(), expires_in: Number(toolValue('ent-token-minutes')) * 60 || undefined, azureEnvironment: document.getElementById('ent-env').value } });
    document.getElementById('ent-token').value = '';
    toolStatus('enterprise-status', 'Token imported', 'ok');
    loadSignins();
  } catch (err) {
    toolStatus('enterprise-status', err.message, 'fail');
  }
}

function enterpriseSignOut() {
  toolsEnterprise = null;
  toolStatus('enterprise-status', 'Signed out', 'ok');
  loadSignins();
}

async function yahooSignIn() {
  toolStatus('yahoo-status', 'Starting...');
  try {
    if (toolValue('yahoo-client')) await api('/oauth/yahoo/credentials', { method: 'POST', body: { clientId: toolValue('yahoo-client'), clientSecret: document.getElementById('yahoo-secret').value } });
    const { url } = await api('/oauth/yahoo/authorize');
    window.open(url, '_blank');
    toolStatus('yahoo-status', 'Finish the sign-in in the browser window...');
    const r = await api('/oauth/yahoo/wait');
    toolStatus('yahoo-status', r.success ? 'Signed in' : 'Sign-in failed', r.success ? 'ok' : 'fail');
    loadSignins();
  } catch (err) {
    toolStatus('yahoo-status', err.message, 'fail');
  }
}

// ── Several mailboxes ──
let batchPoll = null;

async function startBatch() {
  const emails = document.getElementById('batch-emails').value.split(/[\s,;]+/).filter(Boolean);
  if (!emails.length) { toolStatus('batch-status', 'List at least one mailbox', 'fail'); return; }
  const root = toolValue('batch-output');
  if (!root) { toolStatus('batch-status', 'Choose a destination folder', 'fail'); return; }
  wizSaveConnection();
  const { email: _ignored, ...shared } = wizConnection;
  try {
    const b = await api('/acquisitions/batch', { method: 'POST', body: {
      start: true, caseId: currentProject?.case_id, examinerName: currentProject?.examiner_name,
      targets: emails.map(email => ({ email, provider: shared.protocol, config: { ...shared, email, targetUser: email, username: shared.username && emails.length === 1 ? shared.username : email }, folders: document.getElementById('batch-folders').value.split(',').map(f => f.trim()).filter(Boolean), outputDir: `${root.replace(/[\\/]+$/, '')}/${email.replace(/[<>:"/\\|?*]/g, '_')}` })),
    } });
    toolStatus('batch-status', 'Running, one mailbox at a time...');
    clearInterval(batchPoll);
    const refresh = async () => {
      const rows = await api(`/acquisitions/batch/${b.batchId}`);
      document.getElementById('batch-results').innerHTML = renderTable(rows, [{ label: 'Mailbox', value: r => r.target_email }, { label: 'Status', value: r => r.status }, { label: 'Finished', value: r => r.completed_at }, { label: 'Error', value: r => r.error }]);
      if (rows.every(r => !['pending', 'running'].includes(r.status))) {
        clearInterval(batchPoll);
        toolStatus('batch-status', `Finished: ${rows.filter(r => r.status === 'completed').length} of ${rows.length} completed without errors`, rows.every(r => r.status === 'completed') ? 'ok' : 'fail');
      }
    };
    batchPoll = setInterval(refresh, 2000);
    refresh();
  } catch (err) {
    toolStatus('batch-status', err.message, 'fail');
  }
}

// ── Export tab extras ──
async function packageVhdx() {
  if (toolsNeedProject()) return;
  toolStatus('vhdx-status', 'Packaging, then reading every file back...');
  try {
    const body = {};
    if (toolValue('vhdx-source')) body.sourceDir = toolValue('vhdx-source');
    if (toolValue('vhdx-output')) body.outputDir = toolValue('vhdx-output');
    const r = await api(`/projects/${currentProject.id}/export/vhdx`, { method: 'POST', body });
    toolStatus('vhdx-status', `${r.fileCount} file(s) packaged and verified`, 'ok');
    document.getElementById('vhdx-results').innerHTML = `<div class="form-hint"><code>${esc(r.outputPath)}</code> (${formatBytes(r.size)}, ${esc(r.fileSystem)})</div>
      <div class="form-hint">SHA-256: <code>${esc(r.hashes.sha256)}</code></div><div class="form-hint">${esc(r.note)}</div>`;
  } catch (err) {
    toolStatus('vhdx-status', err.message, 'fail');
  }
}

async function downloadMetadata() {
  if (toolsNeedProject()) return;
  const type = document.getElementById('metadata-type').value;
  const format = document.getElementById('metadata-format').value;
  toolStatus('metadata-status', 'Preparing...');
  try {
    const res = await fetch(`/api/projects/${currentProject.id}/metadata-export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, format }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Export failed');
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${currentProject.name}_${type}.${format}`.replace(/[<>:"/\\|?*]/g, '_');
    a.click();
    URL.revokeObjectURL(a.href);
    toolStatus('metadata-status', `${formatBytes(blob.size)} saved to your downloads`, 'ok');
  } catch (err) {
    toolStatus('metadata-status', err.message, 'fail');
  }
}

async function downloadCloudLinks() {
  if (toolsNeedProject()) return;
  toolStatus('cloud-status', 'Downloading what this sign-in can open...');
  try {
    const r = await api(`/projects/${currentProject.id}/cloud-attachments/download`, { method: 'POST', body: {} });
    const s = r.stats;
    toolStatus('cloud-status', `${s.found} link(s): ${s.downloaded} downloaded (${s.verified} matched the provider's checksum), ${s.notDownloaded} not downloaded, ${s.failed} failed`, s.failed || s.mismatched ? 'fail' : 'ok');
    document.getElementById('cloud-results').insertAdjacentHTML('afterbegin', `<div class="form-hint" style="margin-bottom:8px">Saved to <code>${esc(r.outputDir)}</code></div>${renderTable(r.notDownloaded, [{ label: 'Not downloaded', value: x => x.url }, { label: 'Reason', value: x => x.reason }])}`);
  } catch (err) {
    toolStatus('cloud-status', err.message, 'fail');
  }
}

async function loadTimestampHistory() {
  if (!currentProject) return;
  const el = document.getElementById('ts-history');
  if (!el) return;
  try {
    const { timestamps, legacyInternalRecords } = await api(`/projects/${currentProject.id}/timestamps`);
    el.innerHTML = `<h4 style="margin:16px 0 8px;font-size:13px">Timestamps of this project</h4>
      ${renderTable(timestamps, [
        { label: 'For', value: t => t.targetType }, { label: 'Authority', value: t => t.tsaName || t.tsaUrl }, { label: 'Time (UTC)', value: t => t.genTime },
        { label: 'Result', value: t => (t.status !== 'verified' ? `Failed: ${t.error || ''}` : t.verifiedNow === false ? `Does not verify now: ${(t.errors || []).join('; ')}` : t.chainTrusted ? 'Verified' : 'Signature verified; issuer not chained to a trusted root') },
      ])}
      ${legacyInternalRecords ? `<p class="form-hint" style="margin-top:8px">This project also has ${legacyInternalRecords} older record(s) made by earlier versions. Those were SherlockMail's own records, not signed by any authority, and prove nothing about time; they are not counted.</p>` : ''}`;
  } catch (err) {
    el.innerHTML = `<span class="verify-fail">${esc(err.message)}</span>`;
  }
}
