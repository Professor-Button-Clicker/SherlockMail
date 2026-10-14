let currentProject = null;
let currentFolder = null;
let currentTab = 'projects';

// Wizard state
let wizStep = 1;
let wizConnection = {};
let wizFolders = [];
let wizSelectedFolders = [];
let wizCollectionId = null;
let wizProgressTimer = null;
let wizOutputDir = '';
let wizSearchResults = [];
let wizSearchSelectedUids = null;

// --- Init ---
document.addEventListener('DOMContentLoaded', () => {
  loadSystemInfo();
  loadProjects();
  initTheme();
  wizBindFormatListeners();
});

// --- Theme ---
function initTheme() {
  try {
    const saved = localStorage.getItem('sherlock-theme');
    if (saved === 'light') applyTheme('light');
    else applyTheme('dark');
  } catch { applyTheme('dark'); }
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'light' ? 'dark' : 'light';
  applyTheme(next);
  try { localStorage.setItem('sherlock-theme', next); } catch {}
}

function applyTheme(theme) {
  if (theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  const darkIcon = document.getElementById('theme-icon-dark');
  const lightIcon = document.getElementById('theme-icon-light');
  const label = document.getElementById('theme-label');
  if (darkIcon && lightIcon && label) {
    darkIcon.style.display = theme === 'light' ? 'none' : 'block';
    lightIcon.style.display = theme === 'light' ? 'block' : 'none';
    label.textContent = theme === 'light' ? 'Light' : 'Dark';
  }
}

// --- API ---
async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  return res.json();
}

// --- Navigation ---
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));

  const views = ['messages', 'new-project', 'search', 'audit', 'stats', 'collect', 'guide'];
  views.forEach(v => {
    const el = document.getElementById(`view-${v}`);
    if (el) {
      if (el.classList.contains('panel-view')) {
        el.classList.toggle('visible', v === tab);
      } else {
        el.style.display = v === tab ? 'flex' : 'none';
      }
    }
  });

  if (tab === 'projects' || tab === 'messages') {
    document.getElementById('view-messages').style.display = 'flex';
    document.querySelectorAll('.panel-view').forEach(p => p.classList.remove('visible'));
  }

  if (tab === 'audit' && currentProject) loadAuditLog();
  if (tab === 'search') document.getElementById('adv-search-input')?.focus();
  if (tab === 'collect' && !currentProject) toast('Select a project first to begin collection');

  updateSidebar();
}

function updateSidebar() {
  const title = document.getElementById('sidebar-title');
  if (currentTab === 'messages' && currentProject) {
    title.textContent = 'Folders';
    loadFolders();
  } else {
    title.textContent = 'Projects';
    loadProjects();
  }
}

// --- System Info ---
async function loadSystemInfo() {
  const info = await api('/system');
  document.getElementById('status-projects').textContent = `Projects: ${info.totalProjects}`;
  document.getElementById('status-messages').textContent = `Messages: ${info.totalMessages}`;
  document.getElementById('status-size').textContent = `Size: ${formatBytes(info.totalSize)}`;
  document.getElementById('status-node').textContent = `Node ${info.nodeVersion}`;
}

// --- Projects ---
async function loadProjects() {
  const projects = await api('/projects');
  const container = document.getElementById('sidebar-content');

  if (projects.length === 0) {
    container.innerHTML = `
      <div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px">
        <p>No projects yet.</p>
        <button class="btn btn-primary btn-sm" style="margin-top:8px" onclick="switchTab('new-project')">Create First Project</button>
      </div>`;
    return;
  }

  container.innerHTML = projects.map(p => `
    <div class="project-item ${currentProject?.id === p.id ? 'active' : ''}" onclick="selectProject('${p.id}')">
      <div class="project-name">${esc(p.name)}</div>
      <div class="project-email">${esc(p.custodian_name || p.target_email || '')}</div>
      <span class="project-status status-${p.status}">${p.status.toUpperCase()}</span>
    </div>
  `).join('');
}

async function selectProject(id) {
  currentProject = await api(`/projects/${id}`);
  currentFolder = null;
  loadProjects();

  switchTab('messages');
  loadFolders();
  loadMessages();

  document.getElementById('message-list-title').textContent = currentProject.name;
  loadSystemInfo();
}

// --- Folders ---
async function loadFolders() {
  if (!currentProject) return;
  const folders = await api(`/projects/${currentProject.id}/folders`);
  const container = document.getElementById('sidebar-content');

  if (folders.length === 0) {
    container.innerHTML = `
      <div class="folder-item active" onclick="selectFolder(null)">
        <span class="folder-icon">&#128193;</span>
        <span>All Messages</span>
        <span class="badge">${currentProject.stats?.messages?.count || 0}</span>
      </div>
      <div style="padding:12px;color:var(--text-muted);font-size:12px">
        No folders enumerated yet. Run a collection to populate folders.
      </div>`;
    return;
  }

  const folderIcons = {
    'INBOX': '&#128229;', 'Sent': '&#128228;', 'Drafts': '&#128221;', 'Trash': '&#128465;',
    'Spam': '&#9888;', 'Junk': '&#9888;', 'Archive': '&#128230;'
  };

  let html = `
    <div class="folder-item ${!currentFolder ? 'active' : ''}" onclick="selectFolder(null)">
      <span class="folder-icon">&#128193;</span>
      <span>All Messages</span>
      <span class="badge">${currentProject.stats?.messages?.count || 0}</span>
    </div>`;

  for (const f of folders) {
    const icon = folderIcons[f.name] || '&#128194;';
    const indent = (f.path.split(f.delimiter || '/').length - 1);
    const indentClass = indent > 0 ? `folder-indent-${Math.min(indent, 2)}` : '';
    html += `
      <div class="folder-item ${currentFolder === f.path ? 'active' : ''} ${indentClass}" onclick="selectFolder('${esc(f.path)}')">
        <span class="folder-icon">${icon}</span>
        <span>${esc(f.name)}</span>
        <span class="badge">${f.total_messages}</span>
      </div>`;
  }

  container.innerHTML = html;
}

function selectFolder(path) {
  currentFolder = path;
  loadFolders();
  loadMessages();
}

// --- Messages ---
async function loadMessages() {
  if (!currentProject) return;
  const params = new URLSearchParams({ limit: '200' });
  if (currentFolder) params.set('folder', currentFolder);
  const messages = await api(`/projects/${currentProject.id}/messages?${params}`);

  const list = document.getElementById('message-list');
  document.getElementById('message-count').textContent = `${messages.length} messages`;

  if (messages.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
          <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
          <polyline points="22,6 12,13 2,6"/>
        </svg>
        <h3>${currentFolder ? 'No messages in this folder' : 'No messages acquired yet'}</h3>
        <p>Use the <strong>Collect</strong> tab to run the collection wizard, or run via CLI.</p>
      </div>`;
    return;
  }

  list.innerHTML = messages.map(m => `
    <div class="message-row" onclick="viewMessage('${m.id}')" data-id="${m.id}">
      <div class="msg-flags">
        ${m.has_attachments ? '<span class="flag-attachment" title="Has attachments">&#128206;</span>' : ''}
        ${m.is_encrypted ? '<span class="flag-encrypted" title="Encrypted">&#128274;</span>' : ''}
        ${m.is_signed ? '<span class="flag-encrypted" title="Signed">&#10003;</span>' : ''}
      </div>
      <div class="msg-from" title="${esc(m.from_address)}">${esc(extractName(m.from_address))}</div>
      <div class="msg-subject" title="${esc(m.subject)}">${esc(m.subject || '(no subject)')}</div>
      <div class="msg-date">${formatDate(m.date)}</div>
      <div class="msg-size">${formatBytes(m.size)}</div>
    </div>
  `).join('');
}

async function viewMessage(msgId) {
  const data = await api(`/projects/${currentProject.id}/messages/${msgId}`);
  const viewer = document.getElementById('message-viewer');

  document.querySelectorAll('.message-row').forEach(r => r.classList.toggle('active', r.dataset.id === msgId));

  let attachmentsHtml = '';
  if (data.attachments?.length) {
    attachmentsHtml = `
      <div class="msg-attachments">
        <h4>Attachments (${data.attachments.length})</h4>
        ${data.attachments.map(a => `
          <div class="attachment-item">
            <span>&#128206;</span>
            <span class="att-name">${esc(a.filename)}</span>
            <span class="att-hash" title="SHA-256">${a.hash_sha256?.substring(0, 16)}...</span>
            <span class="att-size">${formatBytes(a.size)}</span>
          </div>
        `).join('')}
      </div>`;
  }

  const headers = data.headers || {};
  const receivedHeaders = headers.received
    ? `<div class="msg-header-row"><span class="msg-header-label">Received:</span><span class="msg-header-value" style="font-family:var(--font-mono);font-size:11px;word-break:break-all">${esc(String(headers.received).substring(0, 200))}</span></div>`
    : '';

  viewer.innerHTML = `
    <div class="msg-viewer-header">
      <div class="msg-viewer-subject">${esc(data.subject || '(no subject)')}</div>
      <div class="msg-header-row"><span class="msg-header-label">From:</span><span class="msg-header-value">${esc(data.from_address)}</span></div>
      <div class="msg-header-row"><span class="msg-header-label">To:</span><span class="msg-header-value">${esc(data.to_addresses)}</span></div>
      ${data.cc_addresses ? `<div class="msg-header-row"><span class="msg-header-label">Cc:</span><span class="msg-header-value">${esc(data.cc_addresses)}</span></div>` : ''}
      <div class="msg-header-row"><span class="msg-header-label">Date:</span><span class="msg-header-value">${data.date ? new Date(data.date).toLocaleString() : 'Unknown'}</span></div>
      <div class="msg-header-row"><span class="msg-header-label">Message-ID:</span><span class="msg-header-value" style="font-family:var(--font-mono);font-size:12px">${esc(data.message_id)}</span></div>
      ${receivedHeaders}
    </div>
    <div class="msg-forensic-bar">
      <div class="hash-item"><span class="hash-label">MD5:</span><span class="hash-value">${data.hash_md5 || 'N/A'}</span></div>
      <div class="hash-item"><span class="hash-label">SHA-256:</span><span class="hash-value">${data.hash_sha256 || 'N/A'}</span></div>
      <button class="btn btn-sm btn-secondary" onclick="verifyMessageHash('${msgId}')" style="margin-left:auto">Verify Hash</button>
      <span id="verify-result-${msgId}"></span>
    </div>
    ${attachmentsHtml}
    <div class="msg-viewer-body">
      <p style="color:var(--text-muted);font-size:12px">EML preserved at: <code>${esc(data.eml_path || 'Not available')}</code></p>
      <p style="color:var(--text-muted);font-size:12px;margin-top:4px">Folder: <code>${esc(data.folder)}</code> | UID: ${data.uid} | Flags: ${esc(data.flags)}</p>
    </div>
  `;
  viewer.classList.add('visible');
}

async function verifyMessageHash(msgId) {
  const el = document.getElementById(`verify-result-${msgId}`);
  el.textContent = 'Verifying...';
  try {
    const result = await api(`/projects/${currentProject.id}/verify/${msgId}`, { method: 'POST' });
    el.innerHTML = result.valid
      ? '<span class="verify-pass">HASH VERIFIED</span>'
      : `<span class="verify-fail">HASH MISMATCH (expected ${result.expected?.substring(0,16)}... got ${result.actual?.substring(0,16)}...)</span>`;
  } catch {
    el.innerHTML = '<span class="verify-fail">Verification error</span>';
  }
}

// --- Create Project ---
async function createProject(e) {
  e.preventDefault();
  const project = {
    name: document.getElementById('proj-name').value,
    caseId: document.getElementById('proj-case-id').value,
    custodianName: document.getElementById('proj-custodian').value,
    examinerId: document.getElementById('proj-examiner-id').value,
    examinerName: document.getElementById('proj-examiner').value
  };

  const result = await api('/projects', { method: 'POST', body: project });
  toast(`Project "${project.name}" created`);
  document.getElementById('new-project-form').reset();
  await selectProject(result.id);
  loadSystemInfo();
}

// --- Search ---
async function globalSearch() {
  const query = document.getElementById('global-search').value;
  const type = document.getElementById('search-type').value;
  if (!query || !currentProject) return;

  switchTab('search');
  document.getElementById('adv-search-input').value = query;
  const results = await api(`/projects/${currentProject.id}/search?q=${encodeURIComponent(query)}&type=${type}`);
  renderSearchResults(results, query);
}

async function runAdvancedSearch() {
  const query = document.getElementById('adv-search-input').value;
  if (!query || !currentProject) {
    toast('Select a project first');
    return;
  }

  const results = await api(`/projects/${currentProject.id}/search?q=${encodeURIComponent(query)}&type=inline`);
  renderSearchResults(results, query);
}

function renderSearchResults(results, query) {
  const container = document.getElementById('search-results');

  if (results.length === 0) {
    container.innerHTML = `<div class="empty-state" style="height:200px"><h3>No results found for "${esc(query)}"</h3></div>`;
    return;
  }

  container.innerHTML = `
    <div class="message-list-header">Found ${results.length} results for "${esc(query)}"</div>
    ${results.map(m => `
      <div class="message-row" onclick="viewMessage('${m.id}')" data-id="${m.id}" style="grid-template-columns: 32px 180px 1fr 120px 100px 80px">
        <div class="msg-flags">${m.has_attachments ? '&#128206;' : ''}</div>
        <div class="msg-from">${esc(extractName(m.from_address))}</div>
        <div class="msg-subject">${esc(m.subject || '(no subject)')}</div>
        <div style="font-size:11px;color:var(--text-muted)">${esc(m.folder)}</div>
        <div class="msg-date">${formatDate(m.date)}</div>
        <div class="msg-size">${formatBytes(m.size)}</div>
      </div>
    `).join('')}`;
}

// --- Audit Log ---
async function loadAuditLog() {
  if (!currentProject) return;
  const log = await api(`/projects/${currentProject.id}/audit`);
  const container = document.getElementById('audit-content');

  if (log.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted)">No audit entries yet.</p>';
    return;
  }

  container.innerHTML = `
    <table class="audit-table">
      <thead><tr>
        <th>Timestamp</th><th>Event</th><th>Description</th><th>Hash</th><th>Examiner</th>
      </tr></thead>
      <tbody>
        ${log.map(e => `
          <tr>
            <td style="white-space:nowrap;font-family:var(--font-mono);font-size:11px">${formatTimestamp(e.timestamp)}</td>
            <td><span class="event-badge event-${e.event_type}">${e.event_type}</span></td>
            <td>${esc(e.description)}</td>
            <td style="font-family:var(--font-mono);font-size:10px;color:var(--accent);max-width:120px;overflow:hidden;text-overflow:ellipsis" title="${e.hash}">${e.hash?.substring(0, 16)}...</td>
            <td>${esc(e.examiner || '')}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;
}

async function verifyChain() {
  if (!currentProject) return;
  const result = await api(`/projects/${currentProject.id}/audit/verify`);
  const el = document.getElementById('chain-status');
  if (result.valid) {
    el.innerHTML = `<span class="verify-pass">Chain integrity verified (${result.checked} entries)</span>`;
  } else {
    el.innerHTML = `<span class="verify-fail">Chain integrity BROKEN at entry ${result.results.findIndex(r => !r.valid) + 1}</span>`;
  }
}

// ============================================================
// WIZARD LOGIC
// ============================================================

function wizGoToStep(step) {
  if (step < 1 || step > 10) return;
  wizStep = step;

  document.querySelectorAll('.wizard-step').forEach(el => {
    const s = parseInt(el.dataset.step);
    el.classList.toggle('active', s === step);
    el.classList.toggle('completed', s < step);
  });

  document.querySelectorAll('.wizard-content').forEach(el => el.classList.remove('active'));
  const target = document.getElementById(`wiz-step-${step}`);
  if (target) target.classList.add('active');

  const backBtn = document.getElementById('wiz-btn-back');
  const nextBtn = document.getElementById('wiz-btn-next');
  backBtn.style.visibility = step === 1 ? 'hidden' : 'visible';

  if (step === 7) {
    nextBtn.style.display = 'none';
    backBtn.style.display = 'none';
  } else if (step === 10) {
    nextBtn.textContent = 'Finish';
    nextBtn.style.display = '';
    backBtn.style.display = '';
  } else {
    nextBtn.textContent = step === 6 ? 'Start Collection' : 'Next';
    nextBtn.style.display = '';
    backBtn.style.display = '';
  }

  document.getElementById('wiz-step-indicator').textContent = `Step ${step} of 10`;

  if (step === 6) wizBuildPreview();
}

function wizNext() {
  if (wizStep === 1) {
    const host = document.getElementById('wiz-host').value;
    const email = document.getElementById('wiz-email').value;
    if (!host || !email) { toast('Email and IMAP host are required'); return; }
    wizSaveConnection();
  }

  if (wizStep === 6) {
    wizStartCollection();
    return;
  }

  if (wizStep === 10) {
    toast('Workflow complete');
    wizGoToStep(1);
    wizResetState();
    return;
  }

  wizGoToStep(wizStep + 1);
}

function wizBack() {
  if (wizStep === 8) {
    wizGoToStep(6);
    return;
  }
  wizGoToStep(wizStep - 1);
}

function wizSaveConnection() {
  const authMethod = document.getElementById('wiz-auth-method').value;
  const password = document.getElementById('wiz-password').value;
  wizConnection = {
    host: document.getElementById('wiz-host').value,
    port: parseInt(document.getElementById('wiz-port').value) || 993,
    email: document.getElementById('wiz-email').value,
    username: document.getElementById('wiz-username').value || undefined,
    tls: document.getElementById('wiz-tls').checked
  };
  if (authMethod === 'app-password') {
    wizConnection.appPassword = password;
  } else {
    wizConnection.password = password;
  }
}

function wizUpdateAuthLabel() {
  const method = document.getElementById('wiz-auth-method').value;
  const label = document.getElementById('wiz-pass-label');
  if (method === 'app-password') {
    label.textContent = 'App-Specific Password';
  } else if (method === 'oauth2') {
    label.textContent = 'Access Token';
  } else {
    label.textContent = 'Password';
  }
}

async function wizTestConnection() {
  wizSaveConnection();
  const el = document.getElementById('wiz-conn-status');
  el.innerHTML = '<span style="color:var(--accent)">Testing connection...</span>';

  try {
    const result = await api('/test-connection', { method: 'POST', body: wizConnection });
    if (result.success) {
      el.innerHTML = '<span class="verify-pass">Connection successful</span>';
    } else {
      el.innerHTML = `<span class="verify-fail">Failed: ${esc(result.message)}</span>`;
    }
  } catch (err) {
    el.innerHTML = `<span class="verify-fail">Error: ${esc(err.message)}</span>`;
  }
}

async function wizDetectProvider() {
  const email = document.getElementById('wiz-email').value;
  if (!email) { toast('Enter an email address first'); return; }

  const el = document.getElementById('wiz-conn-status');
  el.innerHTML = '<span style="color:var(--accent)">Detecting provider...</span>';

  const result = await api('/detect-provider', { method: 'POST', body: { email } });
  if (result.profile?.imap) {
    document.getElementById('wiz-host').value = result.profile.imap.host || '';
    document.getElementById('wiz-port').value = result.profile.imap.port || 993;
    if (result.profile.requiresAppPassword) {
      document.getElementById('wiz-auth-method').value = 'app-password';
      wizUpdateAuthLabel();
    }
    el.innerHTML = `<span class="verify-pass">Detected: ${esc(result.profile.name)}</span>`;
  } else {
    el.innerHTML = '<span style="color:var(--warning)">Could not auto-detect provider</span>';
  }
}

// Format checkbox listeners
function wizBindFormatListeners() {
  document.querySelectorAll('input[name="wiz-format"]').forEach(cb => {
    cb.addEventListener('change', () => {
      const pstChecked = document.querySelector('input[name="wiz-format"][value="pst"]')?.checked;
      const containerChecked = document.querySelector('input[name="wiz-format"][value="container"]')?.checked;
      document.getElementById('wiz-pst-options').style.display = pstChecked ? 'block' : 'none';
      document.getElementById('wiz-container-options').style.display = containerChecked ? 'block' : 'none';
    });
  });
}

// --- Step 5: Load folders ---
async function wizLoadFolders() {
  wizSaveConnection();
  const el = document.getElementById('wiz-folders-list');
  el.innerHTML = '<div style="padding:20px;color:var(--accent)">Loading folders from server...</div>';

  try {
    const folders = await api('/list-remote-folders', { method: 'POST', body: wizConnection });
    wizFolders = folders;

    if (!folders.length) {
      el.innerHTML = '<div class="empty-state" style="height:150px"><p>No folders found on the server.</p></div>';
      return;
    }

    el.innerHTML = folders.map((f, i) => {
      const indent = (f.path.split(f.delimiter || '/').length - 1);
      const pad = indent * 20;
      return `
        <label class="wiz-folder-item" style="padding-left:${16 + pad}px">
          <input type="checkbox" class="wiz-folder-cb" data-path="${esc(f.path)}" checked>
          <span class="wiz-folder-name">${esc(f.name)}</span>
          <span class="wiz-folder-count">${f.messages} messages</span>
        </label>`;
    }).join('');
  } catch (err) {
    el.innerHTML = `<div style="padding:20px;color:var(--danger)">Failed to load folders: ${esc(err.message || 'Connection error')}</div>`;
  }
}

function wizSelectAllFolders() {
  document.querySelectorAll('.wiz-folder-cb').forEach(cb => cb.checked = true);
}

function wizDeselectAllFolders() {
  document.querySelectorAll('.wiz-folder-cb').forEach(cb => cb.checked = false);
}

function wizGetSelectedFolders() {
  const cbs = document.querySelectorAll('.wiz-folder-cb:checked');
  return Array.from(cbs).map(cb => cb.dataset.path);
}

// --- Step 4: Pre-Collection Search ---
async function wizRunSearch() {
  wizSaveConnection();

  const criteria = {};
  const sf = document.getElementById('wiz-search-from').value.trim();
  const st = document.getElementById('wiz-search-to').value.trim();
  const ss = document.getElementById('wiz-search-subject').value.trim();
  const sb = document.getElementById('wiz-search-body').value.trim();
  const sdf = document.getElementById('wiz-search-date-from').value;
  const sdt = document.getElementById('wiz-search-date-to').value;
  const sunread = document.getElementById('wiz-search-unread').checked;
  const sflagged = document.getElementById('wiz-search-flagged').checked;

  if (sf) criteria.from = sf;
  if (st) criteria.to = st;
  if (ss) criteria.subject = ss;
  if (sb) criteria.body = sb;
  if (sdf) criteria.since = sdf;
  if (sdt) criteria.before = sdt;
  if (sunread) criteria.seen = false;
  if (sflagged) criteria.flagged = true;

  if (!Object.keys(criteria).length) { toast('Enter at least one search criterion'); return; }

  const statusEl = document.getElementById('wiz-search-status');
  const resultsEl = document.getElementById('wiz-search-results');
  statusEl.innerHTML = '<span style="color:var(--accent)">Loading folders &amp; searching...</span>';
  resultsEl.innerHTML = '<div style="padding:20px;color:var(--accent)">Connecting to server and searching all folders...</div>';

  try {
    if (!wizFolders.length) {
      const folders = await api('/list-remote-folders', { method: 'POST', body: wizConnection });
      wizFolders = folders;
    }
    const allFolderPaths = wizFolders.filter(f => !f.flags?.includes('\\Noselect')).map(f => f.path);
    if (!allFolderPaths.length) { toast('No searchable folders found on server'); return; }

    statusEl.innerHTML = '<span style="color:var(--accent)">Searching ' + allFolderPaths.length + ' folder(s)...</span>';

    const data = await api('/search-remote', {
      method: 'POST',
      body: { connection: wizConnection, folders: allFolderPaths, criteria }
    });

    wizSearchResults = data.results || [];
    statusEl.innerHTML = `<span style="color:var(--success)">${wizSearchResults.length} message(s) found</span>`;
    wizRenderSearchResults();
  } catch (err) {
    statusEl.innerHTML = `<span style="color:var(--danger)">Search failed: ${esc(err.message || 'Error')}</span>`;
    resultsEl.innerHTML = '';
  }
}

function wizRenderSearchResults() {
  const el = document.getElementById('wiz-search-results');
  if (!wizSearchResults.length) {
    el.innerHTML = '<div class="empty-state" style="height:120px"><p>No messages matched your search criteria.</p></div>';
    wizSearchSelectedUids = null;
    return;
  }

  const rows = wizSearchResults.map((m, i) => {
    const d = m.date ? new Date(m.date).toLocaleDateString() : '';
    const sizeKB = (m.size / 1024).toFixed(1);
    const fromDisplay = m.fromName ? `${esc(m.fromName)} &lt;${esc(m.from)}&gt;` : esc(m.from);
    return `<tr>
      <td><input type="checkbox" class="wiz-sr-cb" data-idx="${i}" checked></td>
      <td title="${esc(m.from)}">${fromDisplay}</td>
      <td title="${esc(m.to)}">${esc(m.to)}</td>
      <td>${esc(m.subject)}</td>
      <td>${d}</td>
      <td>${sizeKB} KB</td>
      <td title="${esc(m.folder)}">${esc(m.folder.split('/').pop() || m.folder)}</td>
    </tr>`;
  }).join('');

  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px">
      <div style="font-weight:600;color:var(--text-primary)">${wizSearchResults.length} message(s) found</div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-secondary btn-sm" onclick="wizSearchSelectAll()">Select All</button>
        <button class="btn btn-secondary btn-sm" onclick="wizSearchDeselectAll()">Deselect All</button>
        <button class="btn btn-primary btn-sm" onclick="wizApplySearchSelection()">Use Selected (${wizSearchResults.length})</button>
      </div>
    </div>
    <div style="overflow-x:auto;max-height:400px;overflow-y:auto;border:1px solid var(--border);border-radius:8px">
      <table class="guide-table" style="margin:0;font-size:12px">
        <thead><tr>
          <th style="width:30px"><input type="checkbox" id="wiz-sr-all" checked onchange="wizSearchToggleAll(this.checked)"></th>
          <th>From</th><th>To</th><th>Subject</th><th>Date</th><th>Size</th><th>Folder</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div style="margin-top:8px;font-size:12px;color:var(--text-muted)" id="wiz-sr-count">
      ${wizSearchResults.length} of ${wizSearchResults.length} selected for collection
    </div>`;

  el.querySelectorAll('.wiz-sr-cb').forEach(cb => {
    cb.addEventListener('change', wizUpdateSearchCount);
  });
}

function wizSearchSelectAll() {
  document.querySelectorAll('.wiz-sr-cb').forEach(cb => cb.checked = true);
  const allCb = document.getElementById('wiz-sr-all');
  if (allCb) allCb.checked = true;
  wizUpdateSearchCount();
}

function wizSearchDeselectAll() {
  document.querySelectorAll('.wiz-sr-cb').forEach(cb => cb.checked = false);
  const allCb = document.getElementById('wiz-sr-all');
  if (allCb) allCb.checked = false;
  wizUpdateSearchCount();
}

function wizSearchToggleAll(checked) {
  document.querySelectorAll('.wiz-sr-cb').forEach(cb => cb.checked = checked);
  wizUpdateSearchCount();
}

function wizUpdateSearchCount() {
  const total = document.querySelectorAll('.wiz-sr-cb').length;
  const selected = document.querySelectorAll('.wiz-sr-cb:checked').length;
  const countEl = document.getElementById('wiz-sr-count');
  if (countEl) countEl.textContent = `${selected} of ${total} selected for collection`;
  const applyBtn = document.querySelector('#wiz-search-results .btn-primary');
  if (applyBtn) applyBtn.textContent = `Use Selected (${selected})`;
}

function wizApplySearchSelection() {
  const selected = document.querySelectorAll('.wiz-sr-cb:checked');
  if (!selected.length) { toast('Select at least one message'); return; }

  const uidsByFolder = {};
  selected.forEach(cb => {
    const msg = wizSearchResults[parseInt(cb.dataset.idx)];
    if (!uidsByFolder[msg.folder]) uidsByFolder[msg.folder] = [];
    uidsByFolder[msg.folder].push(msg.uid);
  });

  wizSearchSelectedUids = uidsByFolder;
  toast(`${selected.length} message(s) selected for collection`);
  wizGoToStep(5);
}

function wizClearSearch() {
  document.getElementById('wiz-search-from').value = '';
  document.getElementById('wiz-search-to').value = '';
  document.getElementById('wiz-search-subject').value = '';
  document.getElementById('wiz-search-body').value = '';
  document.getElementById('wiz-search-date-from').value = '';
  document.getElementById('wiz-search-date-to').value = '';
  document.getElementById('wiz-search-unread').checked = false;
  document.getElementById('wiz-search-flagged').checked = false;
  document.getElementById('wiz-search-status').innerHTML = '';
  document.getElementById('wiz-search-results').innerHTML =
    '<div class="empty-state" style="height:150px"><p>Enter search criteria and click "Search Server" to find messages before collection.<br>Or click "Skip" to collect all messages from all folders.</p></div>';
  wizSearchResults = [];
  wizSearchSelectedUids = null;
}

function wizSkipSearch() {
  wizSearchSelectedUids = null;
  wizSearchResults = [];
  toast('Search skipped — all messages in selected folders will be collected');
  wizGoToStep(5);
}

// --- Step 6: Preview ---
function wizBuildPreview() {
  wizSelectedFolders = wizGetSelectedFolders();

  const formats = Array.from(document.querySelectorAll('input[name="wiz-format"]:checked')).map(cb => cb.value);
  const driveLinks = document.getElementById('wiz-collect-drive').checked;
  const modernAtt = document.getElementById('wiz-collect-modern').checked;
  const outputDir = document.getElementById('wiz-output-dir').value || `./output/${currentProject?.id || 'unknown'}`;

  let totalMessages = 0;
  wizSelectedFolders.forEach(path => {
    const folder = wizFolders.find(f => f.path === path);
    if (folder) totalMessages += folder.messages;
  });

  const queryParts = [];
  const df = document.getElementById('wiz-date-from').value;
  const dt = document.getElementById('wiz-date-to').value;
  if (df) queryParts.push(`From: ${df}`);
  if (dt) queryParts.push(`To: ${dt}`);
  const qf = document.getElementById('wiz-query-from').value;
  const qt = document.getElementById('wiz-query-to').value;
  const qs = document.getElementById('wiz-query-subject').value;
  const qk = document.getElementById('wiz-query-keywords').value;
  if (qf) queryParts.push(`From: ${qf}`);
  if (qt) queryParts.push(`To: ${qt}`);
  if (qs) queryParts.push(`Subject: ${qs}`);
  if (qk) queryParts.push(`Keywords: ${qk}`);

  const el = document.getElementById('wiz-preview-summary');
  el.innerHTML = `
    <div class="wiz-preview-card">
      <div class="wiz-preview-title">Project</div>
      <div class="wiz-preview-value">${esc(currentProject?.name || 'No project selected')}</div>
      <div class="wiz-preview-sub">${esc(currentProject?.custodian_name || '')}</div>
    </div>
    <div class="wiz-preview-card">
      <div class="wiz-preview-title">Connection</div>
      <div class="wiz-preview-value">${esc(wizConnection.host || 'Not configured')}</div>
      <div class="wiz-preview-sub">Port ${wizConnection.port || 993} | TLS: ${wizConnection.tls !== false ? 'Yes' : 'No'}</div>
    </div>
    <div class="wiz-preview-card highlight">
      <div class="wiz-preview-title">Estimated Items</div>
      <div class="wiz-preview-value" style="font-size:32px;color:var(--accent)">${wizSearchSelectedUids ? Object.values(wizSearchSelectedUids).reduce((s, a) => s + a.length, 0).toLocaleString() : totalMessages.toLocaleString()}</div>
      <div class="wiz-preview-sub">${wizSearchSelectedUids ? 'Targeted via pre-collection search' : wizSelectedFolders.length + ' folder(s) — all messages'}</div>
    </div>
    <div class="wiz-preview-card">
      <div class="wiz-preview-title">Output Formats</div>
      <div class="wiz-preview-value">${formats.map(f => f.toUpperCase()).join(', ') || 'None'}</div>
      <div class="wiz-preview-sub">${driveLinks ? 'Drive links: ON' : 'Drive links: OFF'} | ${modernAtt ? 'Attachments: ON' : 'Attachments: OFF'}</div>
    </div>
    <div class="wiz-preview-card">
      <div class="wiz-preview-title">Output Location</div>
      <div class="wiz-preview-value" style="font-size:13px;font-family:var(--font-mono);word-break:break-all">${esc(outputDir)}</div>
    </div>
    ${queryParts.length ? `
    <div class="wiz-preview-card">
      <div class="wiz-preview-title">Query Filters</div>
      <div class="wiz-preview-value" style="font-size:13px">${queryParts.join(' | ')}</div>
    </div>` : `
    <div class="wiz-preview-card">
      <div class="wiz-preview-title">Query Filters</div>
      <div class="wiz-preview-value" style="font-size:13px;color:var(--text-muted)">None (collecting all mail)</div>
    </div>`}
  `;
}

// --- Step 7: Start collection ---
async function wizStartCollection() {
  if (!currentProject) { toast('Select a project first'); return; }

  wizSaveConnection();
  wizSelectedFolders = wizGetSelectedFolders();
  wizOutputDir = document.getElementById('wiz-output-dir').value || '';

  const formats = Array.from(document.querySelectorAll('input[name="wiz-format"]:checked')).map(cb => cb.value);

  const body = {
    projectId: currentProject.id,
    connection: wizConnection,
    selectedFolders: wizSelectedFolders,
    outputFormats: formats,
    pstSizeGB: parseInt(document.getElementById('wiz-pst-size').value) || 10,
    containerType: document.getElementById('wiz-container-type').value,
    collectDriveLinks: document.getElementById('wiz-collect-drive').checked,
    collectModernAttachments: document.getElementById('wiz-collect-modern').checked,
    outputDir: wizOutputDir || undefined,
    query: wizBuildQuery(),
    targetedUids: wizSearchSelectedUids || null
  };

  wizGoToStep(7);

  try {
    const result = await api('/start-collection', { method: 'POST', body });
    wizCollectionId = result.collectionId;
    wizPollProgress();
  } catch (err) {
    document.getElementById('wiz-progress-label').innerHTML =
      `<span class="verify-fail">Failed to start: ${esc(err.message)}</span>`;
  }
}

function wizBuildQuery() {
  const parts = {};
  const df = document.getElementById('wiz-date-from').value;
  const dt = document.getElementById('wiz-date-to').value;
  const qf = document.getElementById('wiz-query-from').value;
  const qt = document.getElementById('wiz-query-to').value;
  const qs = document.getElementById('wiz-query-subject').value;
  const qk = document.getElementById('wiz-query-keywords').value;
  const att = document.getElementById('wiz-query-attachments').checked;
  const unread = document.getElementById('wiz-query-unread').checked;

  if (df) parts.dateFrom = df;
  if (dt) parts.dateTo = dt;
  if (qf) parts.from = qf;
  if (qt) parts.to = qt;
  if (qs) parts.subject = qs;
  if (qk) parts.keywords = qk;
  if (att) parts.hasAttachments = true;
  if (unread) parts.unread = true;

  return Object.keys(parts).length ? parts : null;
}

function wizPollProgress() {
  if (wizProgressTimer) clearInterval(wizProgressTimer);

  wizProgressTimer = setInterval(async () => {
    if (!wizCollectionId) return;

    try {
      const p = await api(`/collection-progress/${wizCollectionId}`);

      const pct = p.totalMessages > 0
        ? Math.round((p.acquiredMessages / p.totalMessages) * 100)
        : 0;

      document.getElementById('wiz-progress-fill').style.width = `${pct}%`;
      document.getElementById('wiz-progress-label').textContent =
        p.phase === 'collecting' ? `Collecting... ${pct}% (${p.acquiredMessages}/${p.totalMessages})`
        : p.phase === 'connecting' ? 'Connecting to mail server...'
        : p.phase === 'connected' ? 'Connected, enumerating folders...'
        : p.phase;

      document.getElementById('wiz-progress-stats').innerHTML = `
        <div class="wiz-stat"><span>Acquired</span><strong>${p.acquiredMessages}</strong></div>
        <div class="wiz-stat"><span>Failed</span><strong style="color:${p.failedMessages > 0 ? 'var(--danger)' : 'inherit'}">${p.failedMessages}</strong></div>
        <div class="wiz-stat"><span>Skipped</span><strong>${p.skippedMessages}</strong></div>
        <div class="wiz-stat"><span>Size</span><strong>${formatBytes(p.totalBytes)}</strong></div>
        <div class="wiz-stat"><span>Drive Links</span><strong>${p.driveLinksDetected}</strong></div>
        <div class="wiz-stat"><span>Current</span><strong style="font-size:11px">${esc(p.currentFolder || '-')}</strong></div>
      `;

      const logEl = document.getElementById('wiz-log-output');
      logEl.innerHTML = (p.logs || []).slice(-20).map(l => `<div class="log-line">${esc(l)}</div>`).join('');
      logEl.scrollTop = logEl.scrollHeight;

      if (p.status === 'completed' || p.status === 'failed') {
        clearInterval(wizProgressTimer);
        wizProgressTimer = null;

        document.getElementById('wiz-progress-fill').style.width = p.status === 'completed' ? '100%' : `${pct}%`;
        document.getElementById('wiz-progress-label').textContent =
          p.status === 'completed' ? 'Collection complete!' : 'Collection failed';

        if (p.status === 'completed') {
          document.getElementById('wiz-progress-fill').classList.add('complete');
        }

        setTimeout(() => {
          wizShowResults(p);
          wizGoToStep(8);
        }, 1500);
      }
    } catch {
      // Retry silently
    }
  }, 1000);
}

function wizShowResults(progress) {
  const el = document.getElementById('wiz-results-content');
  const elapsed = progress.endTime && progress.startTime
    ? Math.round((new Date(progress.endTime) - new Date(progress.startTime)) / 1000)
    : 0;

  el.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-label">Status</div><div class="stat-value" style="color:${progress.status === 'completed' ? 'var(--success)' : 'var(--danger)'};font-size:20px">${progress.status.toUpperCase()}</div></div>
      <div class="stat-card"><div class="stat-label">Messages Acquired</div><div class="stat-value">${progress.acquiredMessages}</div></div>
      <div class="stat-card"><div class="stat-label">Failed</div><div class="stat-value" style="color:${progress.failedMessages > 0 ? 'var(--danger)' : 'var(--success)'}">${progress.failedMessages}</div></div>
      <div class="stat-card"><div class="stat-label">Total Size</div><div class="stat-value" style="font-size:20px">${formatBytes(progress.totalBytes)}</div></div>
      <div class="stat-card"><div class="stat-label">Drive Links Found</div><div class="stat-value">${progress.driveLinksDetected}</div></div>
      <div class="stat-card"><div class="stat-label">Duration</div><div class="stat-value" style="font-size:20px">${formatDuration(elapsed)}</div></div>
    </div>`;

  // Pre-fill transfer source
  const srcDir = wizOutputDir || `./output/${currentProject?.id || ''}`;
  document.getElementById('wiz-transfer-source').value = srcDir;

  // Errors
  const errEl = document.getElementById('wiz-results-errors');
  if (progress.errors?.length) {
    errEl.innerHTML = `
      <h3 style="color:var(--danger);margin-bottom:8px">Errors (${progress.errors.length})</h3>
      <div class="wiz-log-output">${progress.errors.map(e => `<div class="log-line log-error">${esc(e)}</div>`).join('')}</div>`;
  } else {
    errEl.innerHTML = '<p style="color:var(--success);font-weight:600">No errors during collection.</p>';
  }

  // Logs
  const logEl = document.getElementById('wiz-results-logs');
  if (progress.logs?.length) {
    logEl.innerHTML = `
      <h3 style="margin-bottom:8px">Collection Log</h3>
      <div class="wiz-log-output">${progress.logs.map(l => `<div class="log-line">${esc(l)}</div>`).join('')}</div>`;
  }

  loadSystemInfo();
}

// --- Step 8: QC Verification ---
async function wizRunQC() {
  if (!currentProject) { toast('No project selected'); return; }

  const statusEl = document.getElementById('wiz-qc-status');
  statusEl.innerHTML = '<span style="color:var(--accent)">Running QC verification...</span>';

  const body = {
    host: wizConnection.host,
    port: wizConnection.port,
    username: wizConnection.username,
    password: wizConnection.password,
    appPassword: wizConnection.appPassword,
    tls: wizConnection.tls,
    verifyHashes: document.getElementById('wiz-qc-hashes').checked,
    sampleSize: parseInt(document.getElementById('wiz-qc-sample').value) || 0
  };

  try {
    const results = await api(`/projects/${currentProject.id}/qc`, { method: 'POST', body });
    statusEl.innerHTML = '';
    wizRenderQCResults(results);
  } catch (err) {
    statusEl.innerHTML = `<span class="verify-fail">QC failed: ${esc(err.message || 'Unknown error')}</span>`;
  }
}

function wizRenderQCResults(results) {
  const el = document.getElementById('wiz-qc-results');
  const s = results.summary;
  const verdictClass = s.overallVerdict === 'PASS' ? 'verify-pass' : 'verify-fail';

  let html = `
    <div style="margin-bottom:24px">
      <h3 style="margin-bottom:12px">
        QC Result: <span class="${verdictClass}">${s.overallVerdict === 'PASS' ? 'PASS -- All checks verified' : 'ISSUES FOUND'}</span>
      </h3>
      <p style="color:var(--text-muted);font-size:13px;margin-bottom:16px">${esc(s.verdictNote || '')}</p>
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-label">Folders Checked</div><div class="stat-value">${s.totalFoldersChecked}</div></div>
        <div class="stat-card"><div class="stat-label">Messages Checked</div><div class="stat-value">${s.totalMessagesChecked}</div></div>
        <div class="stat-card"><div class="stat-label">Hash Matches</div><div class="stat-value" style="color:var(--success)">${s.hashMatches}</div></div>
        <div class="stat-card"><div class="stat-label">Hash Mismatches</div><div class="stat-value" style="color:${s.hashMismatches > 0 ? 'var(--danger)' : 'var(--success)'}">${s.hashMismatches}</div></div>
      </div>
    </div>`;

  if (results.folderResults?.length) {
    html += `<table class="audit-table"><thead><tr>
      <th>Folder</th><th>Status</th><th>Server</th><th>Collected</th><th>Diff</th>
    </tr></thead><tbody>`;
    for (const f of results.folderResults) {
      const statusColor = f.status === 'COUNT_MATCH' ? 'var(--success)' : 'var(--warning)';
      html += `<tr>
        <td>${esc(f.folder)}</td>
        <td><span style="color:${statusColor};font-weight:600">${f.status}</span></td>
        <td>${f.serverMessageCount ?? 'N/A'}</td>
        <td>${f.dbMessageCount ?? 'N/A'}</td>
        <td>${f.difference != null ? (f.difference > 0 ? '+' : '') + f.difference : 'N/A'}</td>
      </tr>`;
    }
    html += '</tbody></table>';
  }

  el.innerHTML = html;
}

// --- Step 9: Transfer ---
async function wizTransfer() {
  const source = document.getElementById('wiz-transfer-source').value;
  const dest = document.getElementById('wiz-transfer-dest').value;
  if (!dest) { toast('Enter a destination directory'); return; }

  const statusEl = document.getElementById('wiz-transfer-status');
  statusEl.innerHTML = '<span style="color:var(--accent)">Transferring files...</span>';

  try {
    const result = await api('/transfer', { method: 'POST', body: { sourceDir: source, destDir: dest } });
    if (result.success) {
      statusEl.innerHTML = '<span class="verify-pass">Transfer complete</span>';
      document.getElementById('wiz-transfer-result').innerHTML = `
        <div class="stat-card" style="max-width:600px">
          <div class="stat-label">Transfer Successful</div>
          <div style="margin-top:8px;font-size:13px;color:var(--text-secondary)">
            <div>Source: <code style="font-size:11px">${esc(result.source)}</code></div>
            <div>Destination: <code style="font-size:11px">${esc(result.destination)}</code></div>
          </div>
        </div>`;
    } else {
      statusEl.innerHTML = `<span class="verify-fail">Transfer failed: ${esc(result.error)}</span>`;
    }
  } catch (err) {
    statusEl.innerHTML = `<span class="verify-fail">Transfer error: ${esc(err.message)}</span>`;
  }
}

function wizResetState() {
  wizCollectionId = null;
  wizFolders = [];
  wizSelectedFolders = [];
  wizOutputDir = '';
  wizSearchResults = [];
  wizSearchSelectedUids = null;
  if (wizProgressTimer) { clearInterval(wizProgressTimer); wizProgressTimer = null; }
  document.getElementById('wiz-progress-fill').style.width = '0%';
  document.getElementById('wiz-progress-fill').classList.remove('complete');
}

// --- Guide ---
function guideScroll(id) {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// --- Utilities ---
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatTimestamp(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString();
}

function formatDuration(seconds) {
  if (!seconds) return '0s';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

function extractName(address) {
  if (!address) return '';
  const match = address.match(/^"?(.+?)"?\s*<.+>$/);
  return match ? match[1] : address.split('@')[0];
}

function esc(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}
