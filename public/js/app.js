let currentProject = null;
let currentFolder = null;
let currentTab = 'projects';

// Wizard state
let wizStep = 1;
let wizConnection = {};
let wizFolders = [];
let wizSelectedFolders = [];
let wizOutputDir = '';
let wizSessionDir = '';
let wizPrefilledProjectId = null;
let wizCollecting = null;
let wizLive = null;
let wizLastResult = null;
let wizEstimate = null;
let wizEstimateKey = '';
let wizEstimateCtl = null;
let activeCollectionsList = [];
const wizUnseenResults = new Map();
const IS_ELECTRON = /Electron/i.test(navigator.userAgent);

// --- Init ---
document.addEventListener('DOMContentLoaded', () => {
  loadSystemInfo();
  loadProjectsList();
  initTheme();
  wizBindFormatListeners();
  wizBindQueryListeners();
  pollActiveCollections();
  setInterval(pollActiveCollections, 3000);
});

// Project statuses written before "failed" existed used "error".
function displayStatus(s) {
  return s === 'error' ? 'failed' : (s || 'created');
}

function statusTone(s) {
  return { completed: 'success', exported: 'success', failed: 'danger', error: 'danger', canceled: 'warning', collecting: 'accent' }[s] || 'muted';
}

// --- Icons: one stroke icon set, used instead of emoji ---
const ICON_PATHS = {
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
  draft: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6M9 6V4h6v2"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  archive: '<polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/>',
  clip: '<path d="M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
};
function icon(name, size = 15) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ICON_PATHS.file}</svg>`;
}

// --- Theme ---
function initTheme() {
  try {
    const saved = localStorage.getItem('sherlock-theme');
    if (saved === 'light' || saved === 'dark') applyTheme(saved);
    else applyTheme(window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  } catch { applyTheme('light'); }
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
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

// --- Navigation ---
function switchMainTab(group) {
  const first = document.querySelector(`.nav-sub-tabs[data-group="${group}"] .nav-sub-tab`);
  if (first) first.click();
}

const CASE_TABS = ['collect', 'messages', 'forensics', 'export', 'audit', 'project-detail'];

function switchTab(tab) {
  currentTab = tab;
  // Update sub-tab highlights
  document.querySelectorAll('.nav-sub-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tab);
    if (t.dataset.tab === tab) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  });
  updateCaseChrome(tab);

  // Hide all panel views
  document.querySelectorAll('.panel-view').forEach(p => p.classList.remove('visible'));

  // Handle message-list-panel (always-present flex container) vs panel-view overlays
  const msgPanel = document.getElementById('view-messages');
  const panelViews = ['new-project', 'project-detail', 'search', 'tracker', 'audit', 'collect', 'export', 'forensics', 'guide', 'projects'];

  if (panelViews.includes(tab)) {
    const target = document.getElementById(`view-${tab}`);
    if (target) target.classList.add('visible');
  }

  if (tab === 'projects') loadProjectsList();
  if (tab === 'tracker') loadProjectsTracker();
  if (tab === 'audit' && currentProject) loadAuditLog();
  if (tab === 'search') document.getElementById('adv-search-input')?.focus();
  if (tab === 'collect' && !currentProject) toast('Select a project first to begin collection');
  if (tab === 'collect' && currentProject) wizEnterCollectTab();
  if (tab !== 'collect' && wizCollecting && wizStep === 6) {
    toast('The collection keeps running in the background. Its progress is shown in the status bar.');
  }
  if (tab === 'export' && currentProject) loadExportHistory();
  if (tab === 'forensics' && !currentProject) toast('Select a project first');

  // Expand the correct main tab group
  const tabGroups = { projects: 'projects', tracker: 'projects', audit: 'projects', 'new-project': 'projects', 'project-detail': 'projects',
    collect: 'collection', forensics: 'collection', export: 'collection', messages: 'collection', guide: 'guide' };
  const group = tabGroups[tab];
  if (group) document.querySelectorAll('.nav-main-tab').forEach(t => t.classList.toggle('active', t.dataset.group === group));
}

// The protocol a project was last collected with, in plain words ('' before the first collection).
function connectionLabel(v) {
  const key = String(v || '').toLowerCase();
  return { imap: 'IMAP', pop3: 'POP3', gmail: 'Gmail API', gmail_api: 'Gmail API', graph: 'Microsoft Graph', m365: 'Microsoft Graph', ews: 'Exchange (EWS)', zoho_api: 'Zoho Mail API', jmap: 'JMAP' }[key] || (key ? key.toUpperCase() : '');
}

// --- Case tag: the open project's key fields and how far its custody has got ---
const CUSTODY_STEPS = [
  { key: 'opened', label: 'Opened' },
  { key: 'collected', label: 'Collected', tab: 'collect', action: 'Collect mail', events: ['ACQUISITION_COMPLETED'] },
  { key: 'checked', label: 'Checked', tab: 'forensics', action: 'Run quality check', events: ['QC_COMPLETED', 'INTEGRITY_VERIFIED'] },
  { key: 'exported', label: 'Exported', tab: 'export', action: 'Export', events: ['EXPORT_COMPLETED'] },
];
let caseTagFor = null;

function updateCaseChrome(tab = currentTab) {
  const p = currentProject;
  const label = document.getElementById('case-switch-label');
  if (label) label.innerHTML = p ? `Project <strong>${esc(p.name)}</strong>` : 'No project open';
  const navName = document.getElementById('nav-case-name');
  if (navName) navName.textContent = p ? p.name : 'Open a project';
  document.querySelectorAll('.nav-sub-tabs[data-group="collection"] .nav-sub-tab').forEach(b => b.setAttribute('aria-disabled', String(!p)));
  const tag = document.getElementById('case-tag');
  if (!tag) return;
  const show = !!p && CASE_TABS.includes(tab);
  tag.classList.toggle('visible', show);
  if (show && caseTagFor !== `${p.id}:${p.status}`) renderCaseTag();
  hideNextIfHere(tab);
}

async function renderCaseTag() {
  const p = currentProject;
  if (!p) return;
  caseTagFor = `${p.id}:${p.status}`;
  const config = typeof p.config === 'string' ? (() => { try { return JSON.parse(p.config || '{}'); } catch { return {}; } })() : (p.config || {});
  const set = (id, v) => { const el = document.getElementById(id); if (el) { el.textContent = v || ''; el.title = v || ''; } };
  set('tag-name', p.name);
  set('tag-case-id', p.case_id);
  set('tag-custodian', config.custodianName || p.custodian_name);
  set('tag-evidence-id', config.evidenceId || p.evidence_id);
  set('tag-mailbox', p.target_email);

  let audit = [];
  try { audit = await api(`/projects/${p.id}/audit`); } catch {}
  if (currentProject?.id !== p.id) return;
  const when = {};
  when.opened = p.created_at;
  for (const step of CUSTODY_STEPS.slice(1)) {
    const hit = audit.filter(a => step.events.includes(a.event_type)).map(a => a.timestamp).sort().pop();
    if (hit) when[step.key] = hit;
  }
  const failed = audit.some(a => a.event_type === 'ACQUISITION_FAILED') && !when.collected;
  const next = CUSTODY_STEPS.find(st => !when[st.key]);
  const stampDate = iso => {
    const d = new Date(String(iso).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? '' : 'Z'));
    return isNaN(d) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }).replace(' ', '<br>');
  };
  document.getElementById('custody-steps').innerHTML = CUSTODY_STEPS.map((st, i) => {
    const done = !!when[st.key];
    const cls = done ? 'done' : st === next ? (st.key === 'collected' && failed ? 'next failed' : 'next') : '';
    const mark = done ? stampDate(when[st.key]) : String(i + 1);
    const state = done ? `done ${new Date(String(when[st.key]).replace(' ', 'T')).toLocaleString()}` : st === next ? 'next' : 'not yet';
    return `${i ? '<li class="custody-link" aria-hidden="true"></li>' : ''}<li class="custody-step ${cls}" title="${esc(st.label)}: ${esc(state)}"><span class="stamp">${mark}</span>${esc(st.label)}</li>`;
  }).join('');
  document.querySelectorAll('.nav-sub-tab[data-step]').forEach(b => b.classList.toggle('step-done', !!when[b.dataset.step]));
  const nextEl = document.getElementById('case-next');
  nextEl.innerHTML = next
    ? `<button type="button" class="btn btn-primary btn-sm" data-tab="${next.tab}" onclick="switchTab('${next.tab}')">${esc(next.key === 'collected' && failed ? 'Collect again' : next.action)}</button>`
    : `<button type="button" class="btn btn-secondary btn-sm" data-tab="messages" onclick="switchTab('messages')">Review messages</button>`;
  hideNextIfHere();
}

// The tag's next-step button is hidden on the screen it would open.
function hideNextIfHere(tab = currentTab) {
  document.querySelectorAll('#case-next [data-tab]').forEach(b => { b.hidden = b.dataset.tab === tab; });
}

// --- Projects List (main panel) ---
async function loadProjectsList() {
  const container = document.getElementById('projects-list-content');
  if (!container) return;
  try {
    const projects = await api('/projects');
    if (!projects.length) {
      container.innerHTML = `<div class="empty-state" style="height:auto;padding:56px 24px">
        <h3>No projects yet</h3>
        <p>A project holds one custodian's mailbox: its case details, collections, checks and exports.</p>
        <button type="button" class="btn btn-primary" onclick="switchTab('new-project')">New project</button>
      </div>`;
      return;
    }
    const provider = v => connectionLabel(v) || 'Not collected yet';
    container.innerHTML = `<div class="register">
      <div class="register-head" aria-hidden="true"><span>Project</span><span>Case ID</span><span>Provider</span><span>Status</span></div>
      ${projects.map(p => `<button type="button" class="register-row${currentProject?.id === p.id ? ' current' : ''}" onclick="selectProject('${p.id}')">
        <span class="reg-name">${esc(p.name)}<small>${esc(p.target_email || p.targetEmail || '')}</small></span>
        <span class="reg-id">${esc(p.case_id || p.caseId || '')}</span>
        <span>${esc(provider(p.provider_type || p.providerType))}</span>
        <span><span class="project-status status-${displayStatus(p.status)}">${esc(displayStatus(p.status))}</span></span>
      </button>`).join('')}
    </div>`;
  } catch {
    container.innerHTML = '<p style="color:var(--danger)">Failed to load projects.</p>';
  }
}

// --- Forensics Sub-tabs ---
function switchForensicsTab(subtab) {
  document.querySelectorAll('#forensics-sub-tabs .sub-tab').forEach(t => t.classList.toggle('active', t.dataset.subtab === subtab));
  ['combined', 'cloud', 'timestamps', 'integrity', 'timeline', 'relationships', 'threading', 'dedup'].forEach(s => {
    const el = document.getElementById(`forensics-${s}`);
    if (el) el.classList.toggle('active', s === subtab);
  });
}

// --- System Info ---
async function loadSystemInfo() {
  try {
    const info = await api('/stats');
    const projEl = document.getElementById('status-projects');
    const msgEl = document.getElementById('status-messages');
    const sizeEl = document.getElementById('status-size');
    const nodeEl = document.getElementById('status-node');
    if (projEl) projEl.textContent = `Projects: ${(info.projects || 0).toLocaleString()}`;
    if (msgEl) msgEl.textContent = `Messages: ${(info.messages || 0).toLocaleString()}`;
    if (sizeEl) sizeEl.textContent = `Size: ${formatBytes(info.totalBytes || 0)}`;
    if (nodeEl) nodeEl.textContent = info.nodeVersion ? `Node ${info.nodeVersion}` : '';
  } catch {}
}

// --- Projects ---
async function loadProjects() {
  try {
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
        <div class="project-email">${esc(p.target_email)}</div>
        <span class="project-status status-${displayStatus(p.status)}">${displayStatus(p.status)}</span>
      </div>
    `).join('');
  } catch {}
}

async function loadProjectsTracker() {
  const container = document.getElementById('tracker-content');
  try {
    const projects = await api('/projects-summary');
    if (projects.length === 0) {
      container.innerHTML = '<p style="color:var(--text-muted)">No projects yet. Create a project to get started.</p>';
      return;
    }
    const statusClass = s => `status-${displayStatus(s)}`;
    container.innerHTML = `
      <div style="overflow-x:auto">
        <table class="tracker-table">
          <thead>
            <tr>
              <th>Project</th>
              <th>Target Email</th>
              <th>Status</th>
              <th>Messages</th>
              <th>Attachments</th>
              <th>Size</th>
              <th>Collections</th>
              <th>Exports</th>
              <th>Last Collected</th>
              <th>Last Exported</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            ${projects.map(p => `
              <tr class="tracker-row" onclick="selectProject('${p.id}')" style="cursor:pointer">
                <td><strong>${esc(p.name)}</strong>${p.case_id ? `<br><span style="font-size:11px;color:var(--text-muted)">Case: ${esc(p.case_id)}</span>` : ''}</td>
                <td>${esc(p.target_email)}</td>
                <td><span class="project-status ${statusClass(p.status)}">${displayStatus(p.status)}</span></td>
                <td style="text-align:right">${(p.message_count || 0).toLocaleString()}</td>
                <td style="text-align:right">${(p.attachment_count || 0).toLocaleString()}</td>
                <td style="text-align:right">${formatBytes(p.total_size || 0)}</td>
                <td style="text-align:center">${p.acquisition_count || 0}</td>
                <td style="text-align:center">${p.export_count || 0}</td>
                <td>${p.last_collected ? new Date(p.last_collected).toLocaleDateString() : '—'}</td>
                <td>${p.last_exported ? new Date(p.last_exported).toLocaleDateString() : '—'}</td>
                <td>${new Date(p.created_at).toLocaleDateString()}</td>
              </tr>
            `).join('')}
          </tbody>
          <tfoot>
            <tr style="font-weight:600;border-top:2px solid var(--border)">
              <td>Total: ${projects.length} project${projects.length !== 1 ? 's' : ''}</td>
              <td></td>
              <td></td>
              <td style="text-align:right">${projects.reduce((s, p) => s + (p.message_count || 0), 0).toLocaleString()}</td>
              <td style="text-align:right">${projects.reduce((s, p) => s + (p.attachment_count || 0), 0).toLocaleString()}</td>
              <td style="text-align:right">${formatBytes(projects.reduce((s, p) => s + (p.total_size || 0), 0))}</td>
              <td style="text-align:center">${projects.reduce((s, p) => s + (p.acquisition_count || 0), 0)}</td>
              <td style="text-align:center">${projects.reduce((s, p) => s + (p.export_count || 0), 0)}</td>
              <td></td>
              <td></td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>`;
  } catch (err) {
    container.innerHTML = `<p style="color:var(--danger)">Failed to load projects: ${esc(err.message)}</p>`;
  }
}

async function selectProject(id) {
  currentProject = await api(`/projects/${id}`);
  caseTagFor = null;
  currentFolder = null;
  loadProjects();
  loadSystemInfo();
  showProjectDetail();
}

function showProjectDetail() {
  if (!currentProject) return;
  const p = currentProject;
  const config = typeof p.config === 'string' ? JSON.parse(p.config || '{}') : (p.config || {});
  document.getElementById('project-detail-title').textContent = 'Project details';
  document.getElementById('det-name').value = p.name || '';
  document.getElementById('det-email').value = p.target_email || '';
  const used = connectionLabel(p.provider_type);
  document.getElementById('det-connection').textContent = used
    ? `Connection: chosen in Collect, step 1. Last used: ${used}.`
    : 'Connection: chosen in Collect, step 1. Nothing collected yet.';
  document.getElementById('det-case-id').value = p.case_id || '';
  document.getElementById('det-evidence-id').value = config.evidenceId || p.evidence_id || '';
  document.getElementById('det-custodian').value = config.custodianName || p.custodian_name || '';
  document.getElementById('det-examiner').value = p.examiner_name || '';

  const badge = document.getElementById('det-status-badge');
  badge.textContent = displayStatus(p.status);
  badge.className = `project-status status-${displayStatus(p.status)}`;

  const hasCollected = ['completed', 'exported'].includes(p.status);
  const locked = document.getElementById('project-edit-locked');
  locked.style.display = hasCollected ? '' : 'none';

  switchTab('project-detail');
  document.getElementById('message-list-title').textContent = p.name;
}

async function saveProjectDetails(e) {
  e.preventDefault();
  if (!currentProject) return;
  try {
    const updated = await api(`/projects/${currentProject.id}`, {
      method: 'PUT',
      body: {
        name: document.getElementById('det-name').value,
        target_email: document.getElementById('det-email').value,
        case_id: document.getElementById('det-case-id').value,
        examiner_name: document.getElementById('det-examiner').value,
        evidenceId: document.getElementById('det-evidence-id').value,
        custodianName: document.getElementById('det-custodian').value,
      }
    });
    currentProject = updated;
    toast('Project updated');
    loadProjects();
    document.getElementById('project-detail-title').textContent = updated.name;
    document.getElementById('message-list-title').textContent = updated.name;
  } catch (err) {
    toast('Update failed: ' + err.message);
  }
}

function openProjectReview() {
  if (!currentProject) return;
  switchTab('messages');
  loadFolders();
  loadMessages();
  document.getElementById('message-list-title').textContent = currentProject.name;
}

async function deleteProject(id) {
  if (!confirm('Delete this project and all its data? This cannot be undone.')) return;
  try {
    await api(`/projects/${id}`, { method: 'DELETE' });
    if (currentProject?.id === id) currentProject = null;
    toast('Project deleted');
    loadProjects();
    loadSystemInfo();
  } catch (err) {
    toast('Delete failed: ' + err.message);
  }
}

// --- Folders ---
async function loadFolders() {
  if (!currentProject) return;
  try {
    const folders = await api(`/projects/${currentProject.id}/folders`);
    const container = document.getElementById('sidebar-content');

    if (folders.length === 0) {
      container.innerHTML = `
        <div class="folder-item active" onclick="selectFolder(null)">
          <span class="folder-icon">${icon('folder')}</span>
          <span>All Messages</span>
          <span class="badge">${currentProject.stats?.messages?.count || 0}</span>
        </div>
        <div style="padding:12px;color:var(--text-muted);font-size:12px">
          No folders enumerated yet. Run a collection to populate folders.
        </div>`;
      return;
    }

    const folderIcons = {
      'INBOX': icon('inbox'), 'Sent': icon('send'), 'Drafts': icon('draft'), 'Trash': icon('trash'),
      'Spam': icon('alert'), 'Junk': icon('alert'), 'Archive': icon('archive')
    };

    let html = `
      <div class="folder-item ${!currentFolder ? 'active' : ''}" onclick="selectFolder(null)">
        <span class="folder-icon">${icon('folder')}</span>
        <span>All Messages</span>
        <span class="badge">${currentProject.stats?.messages?.count || 0}</span>
      </div>`;

    for (const f of folders) {
      const folderIcon = folderIcons[f.name] || icon('folder');
      html += `
        <div class="folder-item ${currentFolder === f.path ? 'active' : ''}" onclick="selectFolder('${esc(f.path)}')">
          <span class="folder-icon">${folderIcon}</span>
          <span>${esc(f.name)}</span>
          <span class="badge">${f.total_messages}</span>
        </div>`;
    }

    container.innerHTML = html;
  } catch {}
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
  try {
    const data = await api(`/projects/${currentProject.id}/messages?${params}`);
    const messages = data.messages || data;

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
          <p>Use the <strong>Collect</strong> tab to run the collection wizard.</p>
        </div>`;
      return;
    }

    list.innerHTML = messages.map(m => `
      <div class="message-row" onclick="viewMessage('${m.id}')" data-id="${m.id}">
        <div class="msg-flags">
          ${m.has_attachments ? `<span class="flag-attachment" title="Has attachments">${icon('clip', 14)}</span>` : ''}
          ${m.is_encrypted ? `<span class="flag-encrypted" title="Encrypted">${icon('lock', 14)}</span>` : ''}
          ${m.is_signed ? '<span class="flag-signed" title="Signed">&#10003;</span>' : ''}
        </div>
        <div class="msg-from" title="${esc(m.from_address)}">${esc(extractName(m.from_address))}</div>
        <div class="msg-subject" title="${esc(m.subject)}">${esc(m.subject || '(no subject)')}</div>
        <div class="msg-date">${formatDate(m.date)}</div>
        <div class="msg-size">${formatBytes(m.size)}</div>
      </div>
    `).join('');
  } catch {}
}

async function viewMessage(msgId) {
  try {
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
              <span>${icon('clip')}</span>
              <span class="att-name">${esc(a.filename)}</span>
              <span class="att-hash" title="SHA-256">${a.hash_sha256?.substring(0, 16)}...</span>
              <span class="att-size">${formatBytes(a.size)}</span>
            </div>
          `).join('')}
        </div>`;
    }

    viewer.innerHTML = `
      <div class="msg-viewer-header">
        <div class="msg-viewer-subject">${esc(data.subject || '(no subject)')}</div>
        <div class="msg-header-row"><span class="msg-header-label">From:</span><span class="msg-header-value">${esc(data.from_address)}</span></div>
        <div class="msg-header-row"><span class="msg-header-label">To:</span><span class="msg-header-value">${esc(data.to_addresses)}</span></div>
        ${data.cc_addresses ? `<div class="msg-header-row"><span class="msg-header-label">Cc:</span><span class="msg-header-value">${esc(data.cc_addresses)}</span></div>` : ''}
        <div class="msg-header-row"><span class="msg-header-label">Date:</span><span class="msg-header-value">${data.date ? new Date(data.date).toLocaleString() : 'Unknown'}</span></div>
        <div class="msg-header-row"><span class="msg-header-label">Message-ID:</span><span class="msg-header-value" style="font-family:var(--font-mono);font-size:12px">${esc(data.message_id)}</span></div>
      </div>
      <div class="msg-forensic-bar">
        <div class="hash-item"><span class="hash-label">MD5:</span><span class="hash-value">${data.hash_md5 || 'N/A'}</span></div>
        <div class="hash-item"><span class="hash-label">SHA-256:</span><span class="hash-value">${data.hash_sha256 || 'N/A'}</span></div>
        <button class="btn btn-sm" onclick="analyzeHeaders('${data.id}')" style="margin-left:auto;font-size:11px;padding:3px 10px;background:var(--bg-surface);border:1px solid var(--border);color:var(--accent);cursor:pointer;border-radius:4px" title="SPF/DKIM/DMARC verification, routing hops, red flags">Analyze Headers</button>
      </div>
      ${attachmentsHtml}
      <div class="msg-viewer-body">
        <p style="color:var(--text-muted);font-size:12px">EML preserved at: <code>${esc(data.eml_path || 'Not available')}</code></p>
        <p style="color:var(--text-muted);font-size:12px;margin-top:4px">Folder: <code>${esc(data.folder)}</code> | UID: ${data.uid} | Flags: ${esc(data.flags)}</p>
      </div>
    `;
    viewer.classList.add('visible');
  } catch (err) {
    toast('Failed to load message: ' + err.message);
  }
}

// --- Create Project ---
async function createProject(e) {
  e.preventDefault();
  const project = {
    name: document.getElementById('proj-name').value,
    targetEmail: document.getElementById('proj-email').value,
    providerType: '',            // set from the connection chosen when collecting
    caseId: document.getElementById('proj-case-id').value,
    evidenceId: document.getElementById('proj-evidence-id').value,
    custodianName: document.getElementById('proj-custodian').value,
    examinerName: document.getElementById('proj-examiner').value
  };

  try {
    const result = await api('/projects', { method: 'POST', body: project });
    toast(`Project "${project.name}" created`);
    document.getElementById('new-project-form').reset();
    await selectProject(result.id);
    loadSystemInfo();

    switchTab('collect');
  } catch (err) {
    toast('Failed to create project: ' + err.message);
  }
}

function prefillCollectWizard(project) {
  if (!project) return;

  const email = project.target_email || project.targetEmail || '';
  document.getElementById('wiz-email').value = email;

  // Never prefill passwords
  const passField = document.getElementById('wiz-password');
  if (passField) passField.value = '';

  // Clear stale folder list
  const foldersEl = document.getElementById('wiz-folders-list');
  if (foldersEl) foldersEl.innerHTML = '<div style="padding:20px;color:var(--text-muted)">Connect and load folders in Step 4.</div>';
  wizFolders = [];

  if (email && email.includes('@')) {
    const domain = email.split('@')[1].toLowerCase();
    const providerId = PROVIDER_MAP[domain] || 'other';
    document.getElementById('wiz-provider').value = providerId;
    wizProviderChanged();
  }
}

// --- Search ---
async function globalSearch() {
  const query = document.getElementById('global-search').value;
  const type = document.getElementById('search-type').value;
  if (!query || !currentProject) {
    toast('Enter a search term and select a project first');
    return;
  }

  switchTab('search');
  document.getElementById('adv-search-input').value = query;

  if (type === 'inline') {
    const results = await api(`/projects/${currentProject.id}/inline-search`, { method: 'POST', body: { query } });
    renderInlineSearchResults(results, query);
  } else {
    const results = await api(`/projects/${currentProject.id}/search`, { method: 'POST', body: { criteria: { keyword: query }, queryType: 'keyword' } });
    renderServerSearchResults(results, query);
  }
}

function buildAdvancedQuery() {
  let parts = [];
  const base = document.getElementById('adv-search-input').value.trim();
  if (base) parts.push(base);

  const from = document.getElementById('adv-from').value.trim();
  if (from) parts.push(`from:${from}`);

  const to = document.getElementById('adv-to').value.trim();
  if (to) parts.push(`to:${to}`);

  const subject = document.getElementById('adv-subject').value.trim();
  if (subject) parts.push(subject.includes(' ') ? `subject:"${subject}"` : `subject:${subject}`);

  const dateFrom = document.getElementById('adv-date-from').value;
  const dateTo = document.getElementById('adv-date-to').value;
  if (dateFrom && dateTo) {
    parts.push(`sent:[${dateFrom.replace(/-/g, '/')} TO ${dateTo.replace(/-/g, '/')}]`);
  } else if (dateFrom) {
    parts.push(`sent:[${dateFrom.replace(/-/g, '/')} TO 2099/12/31]`);
  } else if (dateTo) {
    parts.push(`sent:[2000/01/01 TO ${dateTo.replace(/-/g, '/')}]`);
  }

  const hasAttachments = document.getElementById('adv-has-attachments').checked;
  if (hasAttachments) parts.push('attachmentcount:[1 TO 9999]');

  const minSize = parseInt(document.getElementById('adv-min-size').value);
  if (minSize > 0) parts.push(`size:[${minSize * 1024} TO 999999999]`);

  return parts.join(' ');
}

function clearAdvancedSearch() {
  document.getElementById('adv-search-input').value = '';
  document.getElementById('adv-from').value = '';
  document.getElementById('adv-to').value = '';
  document.getElementById('adv-subject').value = '';
  document.getElementById('adv-date-from').value = '';
  document.getElementById('adv-date-to').value = '';
  document.getElementById('adv-min-size').value = '';
  document.getElementById('adv-has-attachments').checked = false;
  document.getElementById('adv-encrypted').checked = false;
  document.getElementById('search-results').innerHTML = '';
}

function insertBoolOp(op) {
  const input = document.getElementById('adv-search-input');
  const pos = input.selectionStart || input.value.length;
  const before = input.value.substring(0, pos);
  const after = input.value.substring(pos);
  input.value = `${before} ${op} ${after}`;
  input.focus();
  input.setSelectionRange(pos + op.length + 2, pos + op.length + 2);
}

async function runAdvancedSearch() {
  if (!currentProject) { toast('Select a project first'); return; }

  const query = buildAdvancedQuery();
  if (!query) { toast('Enter search criteria'); return; }

  try {
    const results = await api(`/projects/${currentProject.id}/inline-search`, { method: 'POST', body: { query } });
    const encrypted = document.getElementById('adv-encrypted').checked;
    if (encrypted && results.results) {
      results.results = results.results.filter(m => m.is_encrypted || m.is_signed);
      results.stats.matched = results.results.length;
    }
    renderInlineSearchResults(results, query);
  } catch (err) {
    toast('Search failed: ' + err.message);
  }
}

function renderInlineSearchResults(data, query) {
  const container = document.getElementById('search-results');
  const results = data.results || [];

  if (results.length === 0) {
    container.innerHTML = `<div class="empty-state" style="height:200px"><h3>No results for "${esc(query)}"</h3></div>`;
    return;
  }

  const statsHtml = data.stats ? `
    <div style="display:flex;gap:16px;margin-bottom:12px;font-size:12px;color:var(--text-muted)">
      <span>Matched: <strong style="color:var(--accent)">${data.stats.matched}</strong> of ${data.stats.total}</span>
      <span>Elapsed: ${data.stats.elapsed}ms</span>
    </div>` : '';

  container.innerHTML = `
    <div class="message-list-header">Found ${results.length} results for "${esc(query)}"</div>
    ${statsHtml}
    ${results.map(m => `
      <div class="message-row" onclick="viewMessage('${m.id}')" data-id="${m.id}">
        <div class="msg-flags">${m.has_attachments ? icon('clip', 14) : ''}</div>
        <div class="msg-from">${esc(extractName(m.from_address))}</div>
        <div class="msg-subject">${esc(m.subject || '(no subject)')}</div>
        <div class="msg-date">${formatDate(m.date)}</div>
        <div class="msg-size">${formatBytes(m.size)}</div>
      </div>
    `).join('')}`;
}

function renderServerSearchResults(data, query) {
  const container = document.getElementById('search-results');
  const results = data.localResults || [];

  if (results.length === 0) {
    container.innerHTML = `<div class="empty-state" style="height:200px"><h3>No results for "${esc(query)}"</h3></div>`;
    return;
  }

  container.innerHTML = `
    <div class="message-list-header">Found ${results.length} results for "${esc(query)}"</div>
    ${results.map(m => `
      <div class="message-row" onclick="viewMessage('${m.id}')" data-id="${m.id}">
        <div class="msg-flags">${m.has_attachments ? icon('clip', 14) : ''}</div>
        <div class="msg-from">${esc(extractName(m.from_address))}</div>
        <div class="msg-subject">${esc(m.subject || '(no subject)')}</div>
        <div class="msg-date">${formatDate(m.date)}</div>
        <div class="msg-size">${formatBytes(m.size)}</div>
      </div>
    `).join('')}`;
}

// --- Audit Log ---
async function loadAuditLog() {
  if (!currentProject) return;
  try {
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
              <td style="font-family:var(--font-mono);font-size:10px;color:var(--accent);max-width:120px;overflow:hidden;text-overflow:ellipsis" title="${e.hash}">${e.hash?.substring(0, 16) || 'N/A'}...</td>
              <td>${esc(e.examiner || '')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>`;
  } catch {}
}

async function verifyChain() {
  if (!currentProject) return;
  try {
    const result = await api(`/projects/${currentProject.id}/verify`);
    const el = document.getElementById('chain-status');
    const chain = result.auditLogIntegrity;
    if (chain?.chainVerified?.valid) {
      el.innerHTML = `<span class="verify-pass">Chain integrity verified (${chain.totalEntries} entries)</span>`;
    } else {
      el.innerHTML = `<span class="verify-fail">Chain integrity issue detected</span>`;
    }
  } catch (err) {
    document.getElementById('chain-status').innerHTML = `<span class="verify-fail">Verification failed</span>`;
  }
}

// ============================================================
// EXPORT TAB
// ============================================================

function togglePdfSplitMode() {
  const format = document.getElementById('export-format').value;
  const group = document.getElementById('pdf-split-group');
  if (group) group.style.display = format === 'pdf' ? '' : 'none';
  const pst = document.getElementById('pst-size-group');
  if (pst) pst.style.display = format === 'pst' ? '' : 'none';
}

function toggleWizPdfSplit() {
  const checked = document.querySelector('input[name="wiz-format"][value="pdf"]')?.checked;
  const el = document.getElementById('wiz-pdf-options');
  if (el) el.style.display = checked ? '' : 'none';
}

async function runExport() {
  if (!currentProject) { toast('Select a project first'); return; }
  const format = document.getElementById('export-format').value;
  const statusEl = document.getElementById('export-status');
  statusEl.innerHTML = '<span style="color:var(--accent)">Exporting...</span>';

  const body = { format };
  if (format === 'pdf') {
    body.pdfSplitMode = document.getElementById('pdf-split-mode').value;
  }
  if (format === 'pst') body.pstMaxGb = Number(document.getElementById('pst-size')?.value) || 10;

  try {
    const result = await api(`/projects/${currentProject.id}/export`, { method: 'POST', body });
    statusEl.innerHTML = '<span class="verify-pass">Export complete</span>';
    renderExportResult(result);
    loadExportHistory();
    loadSystemInfo();
  } catch (err) {
    statusEl.innerHTML = `<span class="verify-fail">Export failed: ${esc(err.message)}</span>`;
  }
}

async function pickConvertPath(inputId) {
  try {
    const r = await api('/pick-folder', { method: 'POST' });
    if (r.path) document.getElementById(inputId).value = r.path;
  } catch {
    toast('The folder picker is only available in the desktop app; type the path instead');
  }
}

async function runPstConvert() {
  const input = document.getElementById('convert-input').value.trim();
  const outputDir = document.getElementById('convert-output').value.trim();
  const statusEl = document.getElementById('convert-status');
  if (!input) { statusEl.innerHTML = '<span class="verify-fail">Choose a source folder or file</span>'; return; }
  statusEl.innerHTML = '<span style="color:var(--accent)">Converting...</span>';
  try {
    const body = { inputs: [input], pstMaxGb: Number(document.getElementById('pst-size')?.value) || 10 };
    if (outputDir) body.outputDir = outputDir;
    if (currentProject) body.projectId = currentProject.id;
    const r = await api('/convert/pst', { method: 'POST', body });
    statusEl.innerHTML = r.failedCount
      ? `<span class="verify-fail">Converted ${r.messageCount} messages; ${r.failedCount} could not be converted (listed in pst_failed_items.txt)</span>`
      : `<span class="verify-pass">Converted ${r.messageCount} messages</span>`;
    document.getElementById('convert-results').innerHTML = `
      <div class="form-hint" style="margin-bottom:8px">Saved to ${esc(r.outputDir)}</div>
      ${r.files.map(f => `
        <div class="attachment-item">
          <span>${icon('file')}</span>
          <span class="att-name">${esc(f.filename)}</span>
          <span class="att-hash" title="SHA-256">${esc(f.hash?.substring(0, 16) || '')}...</span>
          <span class="att-size">${formatBytes(f.size)}</span>
        </div>`).join('')}`;
  } catch (err) {
    statusEl.innerHTML = `<span class="verify-fail">Conversion failed: ${esc(err.message)}</span>`;
  }
}

function renderExportResult(result) {
  const el = document.getElementById('export-results');
  el.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-label">Format</div><div class="stat-value" style="font-size:20px">${result.format?.toUpperCase()}</div></div>
      <div class="stat-card"><div class="stat-label">Messages</div><div class="stat-value">${result.messageCount}</div></div>
      <div class="stat-card"><div class="stat-label">Total Size</div><div class="stat-value" style="font-size:20px">${formatBytes(result.totalBytes)}</div></div>
      <div class="stat-card"><div class="stat-label">Files</div><div class="stat-value">${result.files?.length || 0}</div></div>
    </div>
    ${result.files?.length ? `
      <h3 style="margin-bottom:12px;font-size:14px">Exported Files</h3>
      ${result.files.map(f => `
        <div class="attachment-item">
          <span>${icon('file')}</span>
          <span class="att-name">${esc(f.filename)}</span>
          <span class="att-hash" title="SHA-256">${f.hash?.substring(0, 16)}...</span>
          <span class="att-size">${formatBytes(f.size)}</span>
        </div>
      `).join('')}
    ` : ''}
    ${result.timestamp ? `
      <div style="margin-top:16px;padding:12px;background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--radius)">
        <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">RFC 3161 Timestamp</div>
        <div style="font-family:var(--font-mono);font-size:12px;color:var(--accent)">${result.timestamp.genTime}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px">Serial: ${result.timestamp.serialNumber}</div>
      </div>
    ` : ''}
  `;
}

async function loadExportHistory() {
  if (!currentProject) return;
  try {
    const exports = await api(`/projects/${currentProject.id}/exports`);
    const el = document.getElementById('export-history');

    if (exports.length === 0) {
      el.innerHTML = '<p style="color:var(--text-muted)">No exports yet.</p>';
      return;
    }

    el.innerHTML = `
      <h3 style="margin-bottom:12px;font-size:14px">Export History</h3>
      <table class="audit-table">
        <thead><tr><th>Date</th><th>Format</th><th>Messages</th><th>Size</th><th>Hash</th></tr></thead>
        <tbody>
          ${exports.map(e => `
            <tr>
              <td style="font-family:var(--font-mono);font-size:11px">${formatTimestamp(e.created_at)}</td>
              <td><span class="event-badge event-EXPORT_COMPLETED">${(e.format || '').toUpperCase()}</span></td>
              <td>${e.message_count}</td>
              <td style="font-family:var(--font-mono)">${formatBytes(e.total_bytes)}</td>
              <td style="font-family:var(--font-mono);font-size:10px;color:var(--accent)" title="${e.hash_sha256}">${e.hash_sha256?.substring(0, 16)}...</td>
            </tr>
          `).join('')}
        </tbody>
      </table>`;
  } catch {}
}

// ============================================================
// FORENSICS: Combined QC
// ============================================================

// Opens the Quality check screen with the scope chosen, and runs the checks.
function openQualityCheck(scope = 'collection') {
  switchTab('forensics');
  switchForensicsTab('combined');
  const sel = document.getElementById('qc-scope');
  if (sel) sel.value = scope;
  runCombinedQC();
}

async function runCombinedQC() {
  if (!currentProject) { toast('Select a project first'); return; }
  const statusEl = document.getElementById('combined-qc-status');
  const resultsEl = document.getElementById('combined-qc-results');
  resultsEl.innerHTML = '';

  // "The latest collection" means the one the wizard just finished, else the project's newest acquisition.
  let qcBody;
  if (document.getElementById('qc-scope')?.value === 'collection') {
    let acquisitionId = wizLastResult?.acquisitionId && wizPrefilledProjectId === currentProject.id ? wizLastResult.acquisitionId : null;
    if (!acquisitionId) {
      try { acquisitionId = (await api(`/projects/${currentProject.id}/acquisitions`))[0]?.id || null; } catch {}
    }
    if (!acquisitionId) { statusEl.innerHTML = '<span class="verify-fail">This project has no collection yet. Collect first, or choose every message in this project.</span>'; return; }
    qcBody = { scope: 'collection', acquisitionId };
  }
  statusEl.innerHTML = `<span style="color:var(--accent)">Running all checks${qcBody ? ' on the latest collection' : ''}: re-hashing every collected file…</span>`;

  const sections = [];
  let totalPass = 0, totalWarn = 0, totalFail = 0;

  try {
    const qc = await api(`/projects/${currentProject.id}/qc`, { method: 'POST', body: qcBody });
    const s = qc.summary || {};
    totalPass += s.passed || 0;
    totalWarn += s.warnings || 0;
    totalFail += s.failed || 0;
    sections.push({ title: `Quality control (11 checks${qcBody ? ', latest collection' : ''})`, status: qc.overallStatus, checks: qc.checks || [] });
  } catch (e) {
    sections.push({ title: 'Quality Control', status: 'fail', checks: [{ name: 'Quality Control', status: 'fail', detail: e.message }] });
    totalFail++;
  }

  statusEl.innerHTML = '<span style="color:var(--accent)">Running cloud scan...</span>';
  try {
    const cloud = await api(`/projects/${currentProject.id}/cloud-scan`, { method: 'POST' });
    const linkCount = cloud.totalLinks || 0;
    const status = linkCount > 0 ? 'warning' : 'pass';
    if (status === 'pass') totalPass++; else totalWarn++;
    sections.push({ title: 'Cloud Attachment Scan', status, checks: [
      { name: 'Cloud Links Detected', status, detail: linkCount > 0 ? `${linkCount} cloud link(s) found across ${cloud.messagesWithLinks || 0} message(s) — review for completeness` : 'No cloud attachment links detected' }
    ]});
  } catch (e) {
    sections.push({ title: 'Cloud Attachment Scan', status: 'fail', checks: [{ name: 'Cloud Scan', status: 'fail', detail: e.message }] });
    totalFail++;
  }

  statusEl.innerHTML = '<span style="color:var(--accent)">Verifying evidence integrity...</span>';
  try {
    const integrity = await api(`/projects/${currentProject.id}/verify`);
    const hv = integrity.hashVerification || {};
    const chain = integrity.auditLogIntegrity || {};
    const chainValid = chain.chainVerified?.valid;
    const hashOk = hv.preserved === hv.total;
    const checks = [];
    checks.push({ name: `Hash Integrity (${hv.algorithm || 'SHA-256'})`, status: hashOk ? 'pass' : 'warning', detail: `${hv.preserved}/${hv.total} hashes preserved` });
    checks.push({ name: 'Audit Chain Integrity', status: chainValid ? 'pass' : 'fail', detail: `${chain.totalEntries || 0} entries verified` });
    if (integrity.exportIntegrity?.length) {
      for (const exp of integrity.exportIntegrity) {
        const valid = exp.valid !== false;
        checks.push({ name: `Export: ${exp.format?.toUpperCase() || 'Unknown'}`, status: valid ? 'pass' : 'fail', detail: exp.error || 'Files verified' });
      }
    }
    for (const c of checks) { if (c.status === 'pass') totalPass++; else if (c.status === 'warning') totalWarn++; else totalFail++; }
    const worstStatus = checks.some(c => c.status === 'fail') ? 'fail' : checks.some(c => c.status === 'warning') ? 'warning' : 'pass';
    sections.push({ title: 'Evidence Integrity', status: worstStatus, checks });
  } catch (e) {
    sections.push({ title: 'Evidence Integrity', status: 'fail', checks: [{ name: 'Integrity Verification', status: 'fail', detail: e.message }] });
    totalFail++;
  }

  statusEl.innerHTML = '<span style="color:var(--accent)">Analyzing threads...</span>';
  try {
    const threads = await api(`/projects/${currentProject.id}/analytics/threading`);
    const threadStatus = threads.totalMessages === 0 ? 'warning' : 'pass';
    if (threadStatus === 'pass') totalPass++; else totalWarn++;
    sections.push({ title: 'Email Threading', status: threadStatus, checks: [
      { name: 'Thread Analysis', status: threadStatus, detail: threads.totalMessages === 0 ? 'No messages to thread' : `${threads.threadCount} conversation(s) from ${threads.totalMessages} messages, ${threads.threadedMessages} threaded, ${threads.singleMessages} standalone` }
    ]});
  } catch (e) {
    sections.push({ title: 'Email Threading', status: 'fail', checks: [{ name: 'Thread Analysis', status: 'fail', detail: e.message }] });
    totalFail++;
  }

  statusEl.innerHTML = '<span style="color:var(--accent)">Scanning for duplicates...</span>';
  try {
    const dedup = await api(`/projects/${currentProject.id}/analytics/dedup`);
    const dupStatus = dedup.totalMessages === 0 ? 'warning' : (dedup.exactDuplicates || 0) > 0 ? 'warning' : 'pass';
    if (dupStatus === 'pass') totalPass++; else totalWarn++;
    sections.push({ title: 'Deduplication', status: dupStatus, checks: [
      { name: 'Duplicate Detection', status: dupStatus, detail: dedup.totalMessages === 0 ? 'No messages to analyze' : `${dedup.uniqueMessages} unique, ${dedup.exactDuplicates} exact duplicate(s), ${dedup.nearDuplicates} near duplicate(s) — ${dedup.dedupSavingsPercent}% savings` }
    ]});
  } catch (e) {
    sections.push({ title: 'Deduplication', status: 'fail', checks: [{ name: 'Duplicate Detection', status: 'fail', detail: e.message }] });
    totalFail++;
  }

  const overallStatus = totalFail > 0 ? 'fail' : totalWarn > 0 ? 'warning' : 'pass';
  const statusColor = overallStatus === 'pass' ? 'var(--success)' : overallStatus === 'warning' ? 'var(--warning)' : 'var(--danger)';
  const statusText = overallStatus === 'pass' ? 'All checks passed' : overallStatus === 'warning' ? 'Passed with warnings' : 'Issues found';

  let html = `
    <div style="margin-bottom:24px">
      <h3 style="margin-bottom:12px">Result: <span style="color:${statusColor};font-weight:700">${statusText}</span></h3>
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-label">Passed</div><div class="stat-value" style="color:var(--success)">${totalPass}</div></div>
        <div class="stat-card"><div class="stat-label">Warnings</div><div class="stat-value" style="color:var(--warning)">${totalWarn}</div></div>
        <div class="stat-card"><div class="stat-label">Failed</div><div class="stat-value" style="color:var(--danger)">${totalFail}</div></div>
        <div class="stat-card"><div class="stat-label">Sections</div><div class="stat-value">${sections.length}</div></div>
      </div>
    </div>`;

  for (const section of sections) {
    const sColor = section.status === 'pass' ? 'var(--success)' : section.status === 'warning' ? 'var(--warning)' : 'var(--danger)';
    const sIcon = section.status === 'pass' ? '&#10003;' : section.status === 'warning' ? '!' : '&#10007;';
    html += `<div style="margin-bottom:20px">
      <h3 style="font-size:14px;margin-bottom:10px;display:flex;align-items:center;gap:8px">
        <span style="color:${sColor}">${sIcon}</span> ${esc(section.title)}
      </h3>`;
    for (const check of section.checks) {
      const cls = check.status === 'pass' ? 'qc-pass' : check.status === 'warning' ? 'qc-warning' : 'qc-fail';
      const icon = check.status === 'pass' ? '&#10003;' : check.status === 'warning' ? '!' : '&#10007;';
      html += `
        <div class="qc-check ${cls}">
          <div class="qc-icon">${icon}</div>
          <div>
            <div class="qc-name">${esc(check.name)}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${esc(check.detail || '')}</div>
          </div>
          <div class="qc-detail">${{ pass: 'Passed', warning: 'Warning', fail: 'Failed' }[check.status] || check.status}</div>
        </div>`;
    }
    html += '</div>';
  }

  html += `<div style="margin-top:24px;padding:16px;background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--radius)">
    <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">Combined QC Summary</div>
    <div style="font-size:12px;color:var(--text-secondary);line-height:1.8">
      <div>Sections Run: <strong style="color:var(--text-primary)">QC &bull; Cloud Scan &bull; Integrity &bull; Threading &bull; Dedup</strong></div>
      <div>Total Checks: <strong style="color:var(--text-primary)">${totalPass + totalWarn + totalFail}</strong></div>
      <div>Standards: <strong style="color:var(--text-primary)">ISO 27037, NIST SP 800-86, SWGDE, ACPO, FRE 901/902</strong></div>
    </div>
  </div>`;

  resultsEl.innerHTML = html;
  statusEl.innerHTML = `<span style="color:${statusColor}">${statusText}</span>`;
}

// ============================================================
// FORENSICS: Quality Control
// ============================================================

function renderQCResults(results, containerId) {
  const el = document.getElementById(containerId);
  const checks = results.checks || [];
  const summary = results.summary || {};

  const statusColor = results.overallStatus === 'pass' ? 'var(--success)' : results.overallStatus === 'warning' ? 'var(--warning)' : 'var(--danger)';
  const statusText = results.overallStatus === 'pass' ? 'All checks passed' : results.overallStatus === 'warning' ? 'Passed with warnings' : 'Issues found';

  let html = `
    <div style="margin-bottom:24px">
      <h3 style="margin-bottom:12px">Result: <span style="color:${statusColor};font-weight:700">${statusText}</span></h3>
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-label">Passed</div><div class="stat-value" style="color:var(--success)">${summary.passed || 0}</div></div>
        <div class="stat-card"><div class="stat-label">Warnings</div><div class="stat-value" style="color:var(--warning)">${summary.warnings || 0}</div></div>
        <div class="stat-card"><div class="stat-label">Failed</div><div class="stat-value" style="color:var(--danger)">${summary.failed || 0}</div></div>
      </div>
    </div>`;

  for (const check of checks) {
    const cls = check.status === 'pass' ? 'qc-pass' : check.status === 'warning' ? 'qc-warning' : 'qc-fail';
    const icon = check.status === 'pass' ? '&#10003;' : check.status === 'warning' ? '!' : '&#10007;';
    html += `
      <div class="qc-check ${cls}">
        <div class="qc-icon">${icon}</div>
        <div>
          <div class="qc-name">${esc(check.name)}</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${esc(check.message || check.detail || '')}</div>
        </div>
        <div class="qc-detail">${{ pass: 'Passed', warning: 'Warning', fail: 'Failed' }[check.status] || check.status}</div>
      </div>`;
    const flagged = check.mismatches || check.unverifiable;
    if (flagged?.length) html += renderQCFlaggedMessages(flagged);
  }

  el.innerHTML = html;
}

function renderQCFlaggedMessages(rows) {
  const fmt = v => v ? esc(new Date(v).toLocaleString()) : '<span style="color:var(--text-muted)">none</span>';
  return `
    <details style="margin:-4px 0 12px 40px;font-size:12px">
      <summary style="cursor:pointer;color:var(--text-secondary)">Show ${rows.length} affected message(s)</summary>
      <table style="width:100%;border-collapse:collapse;margin-top:8px">
        <tr style="color:var(--text-muted);text-align:left">
          <th style="padding:4px">Message</th><th style="padding:4px">Date header in email</th>
          <th style="padding:4px">Recorded at collection</th><th style="padding:4px">Problem</th>
        </tr>
        ${rows.map(r => `
          <tr style="border-top:1px solid var(--border)">
            <td style="padding:4px">${esc(r.folder || '')} #${esc(String(r.uid ?? ''))} ${esc(r.subject || '')}</td>
            <td style="padding:4px;font-family:var(--font-mono)">${fmt(r.emailDateHeader)}</td>
            <td style="padding:4px;font-family:var(--font-mono)">${fmt(r.recordedValue || r.recordedHeaderDate || r.recordedDate)}</td>
            <td style="padding:4px;color:var(--danger)">${esc(r.problem || '')}</td>
          </tr>`).join('')}
      </table>
    </details>`;
}

// ============================================================
// FORENSICS: Cloud Attachments
// ============================================================

async function runCloudScan() {
  if (!currentProject) { toast('Select a project first'); return; }
  const statusEl = document.getElementById('cloud-status');
  statusEl.innerHTML = '<span style="color:var(--accent)">Scanning...</span>';

  try {
    const result = await api(`/projects/${currentProject.id}/cloud-scan`, { method: 'POST' });
    statusEl.innerHTML = '<span class="verify-pass">Scan complete</span>';
    renderCloudResults(result);
  } catch (err) {
    statusEl.innerHTML = `<span class="verify-fail">Scan failed: ${esc(err.message)}</span>`;
  }
}

function renderCloudResults(result) {
  const el = document.getElementById('cloud-results');
  const links = result.links || [];

  let html = `
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-label">Total Links Found</div><div class="stat-value">${result.totalLinks || 0}</div></div>
      <div class="stat-card"><div class="stat-label">Providers</div><div class="stat-value">${result.totalProviders || 0}</div></div>
      <div class="stat-card"><div class="stat-label">Messages with Links</div><div class="stat-value">${result.messagesWithLinks || 0}</div></div>
    </div>`;

  if (result.byProvider && Object.keys(result.byProvider).length > 0) {
    html += '<h3 style="margin:16px 0 12px;font-size:14px">By Provider</h3>';
    for (const [provider, count] of Object.entries(result.byProvider)) {
      html += `
        <div class="qc-check qc-pass" style="border-left:3px solid var(--accent)">
          <div class="qc-name">${esc(provider)}</div>
          <div class="qc-detail">${count} link(s)</div>
        </div>`;
    }
  }

  if (links.length > 0) {
    html += '<h3 style="margin:16px 0 12px;font-size:14px">Detected Links</h3>';
    for (const link of links.slice(0, 50)) {
      html += `
        <div class="attachment-item">
          <span>${icon('link')}</span>
          <span class="att-name" style="word-break:break-all">${esc(link.url?.substring(0, 80) || '')}</span>
          <span class="att-hash">${esc(link.provider || link.providerLabel || '')}</span>
        </div>`;
    }
  }

  el.innerHTML = html;
}

// ============================================================
// FORENSICS: Timestamps
// ============================================================

async function createTimestamp(type) {
  if (!currentProject) { toast('Select a project first'); return; }
  const statusEl = document.getElementById('ts-status');
  statusEl.innerHTML = '<span style="color:var(--accent)">Creating timestamp...</span>';

  try {
    const result = await api(`/projects/${currentProject.id}/timestamp`, { method: 'POST', body: { type } });
    statusEl.innerHTML = '<span class="verify-pass">Timestamp created</span>';
    renderTimestampResult(result);
  } catch (err) {
    statusEl.innerHTML = `<span class="verify-fail">Failed: ${esc(err.message)}</span>`;
  }
}

function renderTimestampResult(result) {
  const el = document.getElementById('ts-results');
  const ts = result.timestamp || {};

  el.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-label">Type</div><div class="stat-value" style="font-size:18px">${esc(result.type || '')}</div></div>
      <div class="stat-card"><div class="stat-label">Time</div><div class="stat-value" style="font-size:14px;font-family:var(--font-mono)">${esc(ts.genTime || '')}</div></div>
      <div class="stat-card"><div class="stat-label">Serial Number</div><div class="stat-value" style="font-size:12px;font-family:var(--font-mono)">${esc(ts.serialNumber || '')}</div></div>
    </div>
    <div style="margin-top:16px;padding:16px;background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--radius)">
      <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">Timestamp Details</div>
      <div style="font-size:12px;color:var(--text-secondary);line-height:1.8">
        <div>Hash Algorithm: <strong style="color:var(--accent)">${esc(ts.hashAlgorithm || 'SHA-256')}</strong></div>
        <div>Message Digest: <span style="font-family:var(--font-mono);color:var(--accent);font-size:11px">${esc(result.collectionDigest || result.manifestHash || '')}</span></div>
        <div>Standard: <strong>RFC 3161</strong></div>
      </div>
    </div>`;
}

// ============================================================
// FORENSICS: Evidence Integrity
// ============================================================

async function verifyIntegrity() {
  if (!currentProject) { toast('Select a project first'); return; }
  const statusEl = document.getElementById('integrity-status');
  statusEl.innerHTML = '<span style="color:var(--accent)">Verifying...</span>';

  try {
    const result = await api(`/projects/${currentProject.id}/verify`);
    statusEl.innerHTML = '<span class="verify-pass">Verification complete</span>';
    renderIntegrityResults(result);
  } catch (err) {
    statusEl.innerHTML = `<span class="verify-fail">Verification failed: ${esc(err.message)}</span>`;
  }
}

function renderIntegrityResults(result) {
  const el = document.getElementById('integrity-results');
  const hv = result.hashVerification || {};
  const chain = result.auditLogIntegrity || {};
  const chainValid = chain.chainVerified?.valid;

  let html = `
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-label">Messages Verified</div><div class="stat-value">${hv.total || 0}</div></div>
      <div class="stat-card"><div class="stat-label">Hashes Preserved</div><div class="stat-value" style="color:var(--success)">${hv.preserved || 0}</div></div>
      <div class="stat-card"><div class="stat-label">Audit Entries</div><div class="stat-value">${chain.totalEntries || 0}</div></div>
      <div class="stat-card"><div class="stat-label">Chain Valid</div><div class="stat-value" style="color:${chainValid ? 'var(--success)' : 'var(--danger)'}">${chainValid ? 'YES' : 'NO'}</div></div>
      <div class="stat-card"><div class="stat-label">Exports Verified</div><div class="stat-value">${result.exportIntegrity?.length || 0}</div></div>
      <div class="stat-card"><div class="stat-label">RFC 3161 Timestamps</div><div class="stat-value">${result.timestampRecords || 0}</div></div>
    </div>

    <h3 style="margin:16px 0 12px;font-size:14px">Verification Checks</h3>
    <div class="qc-check ${hv.preserved === hv.total ? 'qc-pass' : 'qc-warning'}">
      <div class="qc-icon">${hv.preserved === hv.total ? '&#10003;' : '!'}</div>
      <div>
        <div class="qc-name">Message Hash Integrity (${hv.algorithm || 'SHA-256'})</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${hv.preserved}/${hv.total} hashes preserved</div>
      </div>
      <div class="qc-detail">${hv.preserved === hv.total ? 'PASS' : 'WARNING'}</div>
    </div>

    <div class="qc-check ${chainValid ? 'qc-pass' : 'qc-fail'}">
      <div class="qc-icon">${chainValid ? '&#10003;' : '&#10007;'}</div>
      <div>
        <div class="qc-name">Audit Chain Integrity</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${chain.totalEntries} entries verified</div>
      </div>
      <div class="qc-detail">${chainValid ? 'PASS' : 'FAIL'}</div>
    </div>`;

  if (result.exportIntegrity?.length) {
    for (const exp of result.exportIntegrity) {
      const valid = exp.valid !== false;
      html += `
        <div class="qc-check ${valid ? 'qc-pass' : 'qc-fail'}">
          <div class="qc-icon">${valid ? '&#10003;' : '&#10007;'}</div>
          <div>
            <div class="qc-name">Export: ${esc(exp.format?.toUpperCase() || 'Unknown')}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${exp.error ? esc(exp.error) : 'Files verified'}</div>
          </div>
          <div class="qc-detail">${valid ? 'PASS' : 'FAIL'}</div>
        </div>`;
    }
  }

  if (result.standards) {
    html += `
      <div style="margin-top:24px;padding:16px;background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--radius)">
        <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">Compliance Standards</div>
        <div style="font-size:12px;color:var(--text-secondary);line-height:1.8">
          <div>Hash: <strong style="color:var(--text-primary)">${esc(result.standards.hashAlgorithm)}</strong></div>
          <div>Audit: <strong style="color:var(--text-primary)">${esc(result.standards.auditStandard)}</strong></div>
          <div>Legal: <strong style="color:var(--text-primary)">${esc(result.standards.legalStandard)}</strong></div>
          <div>Timestamp: <strong style="color:var(--text-primary)">${esc(result.standards.timestampStandard)}</strong></div>
        </div>
      </div>`;
  }

  el.innerHTML = html;
}

// ============================================================
// FORENSICS: Timeline Analysis
// ============================================================

async function loadTimeline() {
  if (!currentProject) { toast('Select a project first'); return; }
  const statusEl = document.getElementById('timeline-status');
  statusEl.innerHTML = '<span style="color:var(--accent)">Loading timeline...</span>';

  try {
    const data = await api(`/projects/${currentProject.id}/analytics/timeline`);
    statusEl.innerHTML = '';
    renderTimeline(data);
  } catch (err) {
    statusEl.innerHTML = `<span class="verify-fail">Failed: ${esc(err.message)}</span>`;
  }
}

function renderTimeline(data) {
  const el = document.getElementById('timeline-results');
  const tl = data.timeline || [];
  const range = data.dateRange;

  if (tl.length === 0) {
    el.innerHTML = '<div class="empty-state" style="height:200px"><h3>No dated messages to chart</h3><p>Collect messages first.</p></div>';
    return;
  }

  const maxCount = Math.max(...tl.map(d => d.count));
  const barChart = tl.map(d => {
    const pct = maxCount > 0 ? (d.count / maxCount * 100) : 0;
    return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:2px" title="${d.date}: ${d.count} messages (${formatBytes(d.totalSize)})">
      <span style="min-width:80px;font-size:11px;font-family:var(--font-mono);color:var(--text-muted)">${d.date}</span>
      <div style="flex:1;height:18px;background:var(--bg-surface);border-radius:3px;overflow:hidden">
        <div style="height:100%;border-radius:3px;display:flex;align-items:center">
          <div style="height:100%;background:var(--accent);border-radius:3px;width:${pct}%;min-width:${d.count > 0 ? 2 : 0}px"></div>
          ${d.sent > 0 ? `<div style="height:100%;background:var(--success);border-radius:0 3px 3px 0;width:${d.sent / d.count * pct}%;min-width:1px" title="${d.sent} sent"></div>` : ''}
        </div>
      </div>
      <span style="min-width:35px;text-align:right;font-size:12px;font-weight:500;color:var(--text-primary)">${d.count}</span>
    </div>`;
  }).join('');

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const maxDay = Math.max(...data.dayOfWeekDistribution);
  const dowChart = data.dayOfWeekDistribution.map((count, i) => {
    const pct = maxDay > 0 ? (count / maxDay * 100) : 0;
    return `<div style="text-align:center;flex:1">
      <div style="height:60px;display:flex;align-items:flex-end;justify-content:center">
        <div style="width:24px;background:var(--accent);border-radius:3px 3px 0 0;height:${pct}%;min-height:${count > 0 ? 2 : 0}px"></div>
      </div>
      <div style="font-size:11px;margin-top:4px;color:var(--text-muted)">${dayNames[i]}</div>
      <div style="font-size:10px;color:var(--text-secondary)">${count}</div>
    </div>`;
  }).join('');

  const maxHour = Math.max(...data.hourDistribution);
  const hourChart = data.hourDistribution.map((count, i) => {
    const pct = maxHour > 0 ? (count / maxHour * 100) : 0;
    return `<div style="text-align:center;flex:1;min-width:0">
      <div style="height:50px;display:flex;align-items:flex-end;justify-content:center">
        <div style="width:100%;max-width:16px;background:var(--accent);border-radius:2px 2px 0 0;height:${pct}%;min-height:${count > 0 ? 1 : 0}px"></div>
      </div>
      <div style="font-size:9px;color:var(--text-muted)">${i}</div>
    </div>`;
  }).join('');

  el.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-label">Total Messages</div><div class="stat-value">${data.totalMessages}</div></div>
      <div class="stat-card"><div class="stat-label">Date Range</div><div class="stat-value" style="font-size:14px;font-family:var(--font-mono)">${range ? `${range.from} — ${range.to}` : 'N/A'}</div></div>
      <div class="stat-card"><div class="stat-label">Active Days</div><div class="stat-value">${tl.length}</div></div>
      <div class="stat-card"><div class="stat-label">Avg/Day</div><div class="stat-value">${tl.length > 0 ? (data.totalMessages / tl.length).toFixed(1) : 0}</div></div>
    </div>

    <h3 style="margin:20px 0 12px;font-size:14px">Daily Volume</h3>
    <div style="max-height:400px;overflow-y:auto;padding-right:8px">${barChart}</div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:24px">
      <div>
        <h3 style="margin:0 0 12px;font-size:14px">Day of Week</h3>
        <div style="display:flex;gap:4px;padding:8px;background:var(--bg-surface);border-radius:var(--radius)">${dowChart}</div>
      </div>
      <div>
        <h3 style="margin:0 0 12px;font-size:14px">Hour of Day (0-23)</h3>
        <div style="display:flex;gap:1px;padding:8px;background:var(--bg-surface);border-radius:var(--radius)">${hourChart}</div>
      </div>
    </div>
  `;
}

// ============================================================
// FORENSICS: Relationship Analysis
// ============================================================

async function loadRelationships() {
  if (!currentProject) { toast('Select a project first'); return; }
  const statusEl = document.getElementById('relationships-status');
  statusEl.innerHTML = '<span style="color:var(--accent)">Analyzing...</span>';

  try {
    const data = await api(`/projects/${currentProject.id}/analytics/relationships`);
    statusEl.innerHTML = '';
    renderRelationships(data);
  } catch (err) {
    statusEl.innerHTML = `<span class="verify-fail">Failed: ${esc(err.message)}</span>`;
  }
}

function renderRelationships(data) {
  const el = document.getElementById('relationships-results');
  const contacts = data.contacts || [];
  const pairs = data.pairs || [];

  if (contacts.length === 0) {
    el.innerHTML = '<div class="empty-state" style="height:200px"><h3>No contacts found</h3><p>Collect messages first.</p></div>';
    return;
  }

  const maxMsgs = Math.max(...contacts.slice(0, 20).map(c => c.totalMessages));

  const contactRows = contacts.slice(0, 20).map(c => {
    const pct = maxMsgs > 0 ? (c.totalMessages / maxMsgs * 100) : 0;
    const sentPct = c.totalMessages > 0 ? (c.sent / c.totalMessages * 100) : 0;
    return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
      <span style="min-width:200px;max-width:200px;font-size:12px;font-family:var(--font-mono);color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(c.address)}">${esc(c.address)}</span>
      <div style="flex:1;height:20px;background:var(--bg-surface);border-radius:3px;overflow:hidden;display:flex">
        <div style="height:100%;background:var(--accent);width:${sentPct * pct / 100}%;min-width:${c.sent > 0 ? 1 : 0}px" title="${c.sent} sent"></div>
        <div style="height:100%;background:var(--success);width:${(100 - sentPct) * pct / 100}%;min-width:${c.received > 0 ? 1 : 0}px" title="${c.received} received"></div>
      </div>
      <span style="min-width:80px;text-align:right;font-size:11px;color:var(--text-muted)">${c.sent}s / ${c.received}r</span>
      <span style="min-width:35px;text-align:right;font-size:12px;font-weight:500;color:var(--text-primary)">${c.totalMessages}</span>
    </div>`;
  }).join('');

  const pairRows = pairs.slice(0, 30).map(p => `
    <tr>
      <td style="font-family:var(--font-mono);font-size:11px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(p.source)}">${esc(p.source)}</td>
      <td style="text-align:center;color:var(--accent)">&#8596;</td>
      <td style="font-family:var(--font-mono);font-size:11px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(p.target)}">${esc(p.target)}</td>
      <td style="text-align:center;font-weight:600;color:var(--text-primary)">${p.count}</td>
      <td style="font-size:11px;color:var(--text-muted);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc((p.subjects || []).join(', '))}">${esc((p.subjects || [])[0] || '')}</td>
    </tr>
  `).join('');

  el.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-label">Unique Contacts</div><div class="stat-value">${data.totalContacts}</div></div>
      <div class="stat-card"><div class="stat-label">Communication Pairs</div><div class="stat-value">${data.totalPairs}</div></div>
      <div class="stat-card"><div class="stat-label">Top Contact</div><div class="stat-value" style="font-size:13px;font-family:var(--font-mono)">${esc(contacts[0]?.address || 'N/A')}</div></div>
      <div class="stat-card"><div class="stat-label">Busiest Pair</div><div class="stat-value">${pairs[0]?.count || 0} msgs</div></div>
    </div>

    <h3 style="margin:20px 0 12px;font-size:14px">Top Contacts</h3>
    <div style="display:flex;gap:8px;margin-bottom:8px;font-size:11px;color:var(--text-muted)">
      <span style="display:flex;align-items:center;gap:4px"><span style="width:10px;height:10px;border-radius:2px;background:var(--accent)"></span>Sent</span>
      <span style="display:flex;align-items:center;gap:4px"><span style="width:10px;height:10px;border-radius:2px;background:var(--success)"></span>Received</span>
    </div>
    <div style="max-height:350px;overflow-y:auto">${contactRows}</div>

    <h3 style="margin:24px 0 12px;font-size:14px">Top Communication Pairs</h3>
    <table class="audit-table">
      <thead><tr><th>Contact A</th><th></th><th>Contact B</th><th>Count</th><th>Sample Subject</th></tr></thead>
      <tbody>${pairRows}</tbody>
    </table>
  `;
}

// ============================================================
// FORENSICS: Email Threading
// ============================================================

async function loadThreading() {
  if (!currentProject) { toast('Select a project first'); return; }
  const statusEl = document.getElementById('threading-status');
  statusEl.innerHTML = '<span style="color:var(--accent)">Analyzing threads...</span>';

  try {
    const data = await api(`/projects/${currentProject.id}/analytics/threading`);
    statusEl.innerHTML = '';
    renderThreading(data);
  } catch (err) {
    statusEl.innerHTML = `<span class="verify-fail">Failed: ${esc(err.message)}</span>`;
  }
}

function renderThreading(data) {
  const el = document.getElementById('threading-results');
  if (data.totalMessages === 0) {
    el.innerHTML = '<div class="empty-state" style="height:200px"><h3>No messages to thread</h3><p>Collect messages first.</p></div>';
    return;
  }

  const threadRows = (data.threads || []).slice(0, 50).map((t, i) => `
    <tr>
      <td style="font-weight:500;color:var(--text-primary)">${i + 1}</td>
      <td style="max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(t.rootSubject || '')}">${esc(t.rootSubject || '(no subject)')}</td>
      <td style="font-family:var(--font-mono);font-size:11px">${esc(t.rootFrom || '')}</td>
      <td style="text-align:center;font-weight:600;color:var(--accent)">${t.messageCount}</td>
      <td style="font-size:11px;color:var(--text-muted)">${t.participants?.length || 0}</td>
      <td style="font-family:var(--font-mono);font-size:10px;color:var(--text-muted)">${t.dateRange?.from?.substring(0, 10) || ''} — ${t.dateRange?.to?.substring(0, 10) || ''}</td>
      <td>${t.threadedBy === 'subject' ? '<span style="font-size:10px;padding:2px 6px;background:var(--warning);color:#000;border-radius:3px">Subject</span>' : '<span style="font-size:10px;padding:2px 6px;background:var(--success);color:#fff;border-radius:3px">Headers</span>'}</td>
    </tr>
  `).join('');

  el.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-label">Total Messages</div><div class="stat-value">${data.totalMessages}</div></div>
      <div class="stat-card"><div class="stat-label">Conversations</div><div class="stat-value">${data.threadCount}</div></div>
      <div class="stat-card"><div class="stat-label">Threaded</div><div class="stat-value">${data.threadedMessages}</div></div>
      <div class="stat-card"><div class="stat-label">Standalone</div><div class="stat-value">${data.singleMessages}</div></div>
    </div>
    <h3 style="margin:20px 0 12px;font-size:14px">Conversations (by size)</h3>
    <div style="max-height:500px;overflow-y:auto">
      <table class="audit-table">
        <thead><tr><th>#</th><th>Subject</th><th>Started By</th><th>Msgs</th><th>People</th><th>Date Range</th><th>Method</th></tr></thead>
        <tbody>${threadRows || '<tr><td colspan="7" style="text-align:center;color:var(--text-muted)">No multi-message threads found</td></tr>'}</tbody>
      </table>
    </div>
  `;
}

// ============================================================
// FORENSICS: Deduplication
// ============================================================

async function loadDedup() {
  if (!currentProject) { toast('Select a project first'); return; }
  const statusEl = document.getElementById('dedup-status');
  statusEl.innerHTML = '<span style="color:var(--accent)">Scanning for duplicates...</span>';

  try {
    const data = await api(`/projects/${currentProject.id}/analytics/dedup`);
    statusEl.innerHTML = '';
    renderDedup(data);
  } catch (err) {
    statusEl.innerHTML = `<span class="verify-fail">Failed: ${esc(err.message)}</span>`;
  }
}

function renderDedup(data) {
  const el = document.getElementById('dedup-results');
  if (data.totalMessages === 0) {
    el.innerHTML = '<div class="empty-state" style="height:200px"><h3>No messages to analyze</h3><p>Collect messages first.</p></div>';
    return;
  }

  const exactRows = (data.exactGroups || []).slice(0, 30).map(d => `
    <tr>
      <td style="max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(d.subject || '')}">${esc(d.subject || '(no subject)')}</td>
      <td style="font-family:var(--font-mono);font-size:11px">${esc(d.from || '')}</td>
      <td style="text-align:center;font-weight:600;color:var(--warning)">${d.count}</td>
      <td style="font-size:11px;color:var(--text-muted)">${esc((d.folders || []).join(', '))}</td>
      <td style="font-family:var(--font-mono);font-size:10px;color:var(--text-muted)">${d.hash?.substring(0, 12)}...</td>
    </tr>
  `).join('');

  const savingsPct = parseFloat(data.dedupSavingsPercent) || 0;
  const barColor = savingsPct > 20 ? 'var(--warning)' : 'var(--success)';

  el.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-label">Total Messages</div><div class="stat-value">${data.totalMessages}</div></div>
      <div class="stat-card"><div class="stat-label">Unique</div><div class="stat-value" style="color:var(--success)">${data.uniqueMessages}</div></div>
      <div class="stat-card"><div class="stat-label">Exact Duplicates</div><div class="stat-value" style="color:var(--warning)">${data.exactDuplicates}</div></div>
      <div class="stat-card"><div class="stat-label">Near Duplicates</div><div class="stat-value" style="color:var(--text-muted)">${data.nearDuplicates}</div></div>
    </div>

    <div style="margin:20px 0;padding:16px;background:var(--bg-surface);border-radius:var(--radius);border:1px solid var(--border)">
      <div style="display:flex;justify-content:space-between;margin-bottom:8px">
        <span style="font-size:13px;font-weight:500">Dedup Savings</span>
        <span style="font-weight:600;color:${barColor}">${data.dedupSavingsPercent}%</span>
      </div>
      <div style="height:20px;background:var(--bg-main);border-radius:10px;overflow:hidden">
        <div style="height:100%;background:${barColor};border-radius:10px;width:${savingsPct}%;transition:width 0.3s"></div>
      </div>
      <div style="display:flex;justify-content:space-between;margin-top:6px;font-size:11px;color:var(--text-muted)">
        <span>Algorithm: ${esc(data.hashAlgorithm)}</span>
        <span>${data.exactDuplicates} removable duplicates</span>
      </div>
    </div>

    <h3 style="margin:20px 0 12px;font-size:14px">Exact Duplicate Groups</h3>
    <div style="max-height:400px;overflow-y:auto">
      <table class="audit-table">
        <thead><tr><th>Subject</th><th>From</th><th>Copies</th><th>Folders</th><th>Hash</th></tr></thead>
        <tbody>${exactRows || '<tr><td colspan="5" style="text-align:center;color:var(--text-muted)">No exact duplicates found</td></tr>'}</tbody>
      </table>
    </div>
  `;
}

// ============================================================
// FORENSICS: Chain of Custody
// ============================================================

async function loadCustody() {
  if (!currentProject) { toast('Select a project first'); return; }
  const statusEl = document.getElementById('custody-status');
  statusEl.innerHTML = '<span style="color:var(--accent)">Generating report...</span>';

  try {
    const data = await api(`/projects/${currentProject.id}/chain-of-custody`);
    statusEl.innerHTML = '';
    renderCustody(data);
  } catch (err) {
    statusEl.innerHTML = `<span class="verify-fail">Failed: ${esc(err.message)}</span>`;
  }
}

function renderCustody(data) {
  const el = document.getElementById('custody-results');
  const ci = data.caseInfo || {};
  const es = data.evidenceSummary || {};
  const ai = data.auditIntegrity || {};
  const chain = data.custodyChain || [];
  const stds = data.standards || {};

  const chainRows = chain.map(e => `
    <tr>
      <td style="font-family:var(--font-mono);font-size:11px;white-space:nowrap">${esc(e.timestamp?.substring(0, 19).replace('T', ' ') || '')}</td>
      <td><span style="padding:2px 8px;border-radius:3px;font-size:11px;font-weight:500;background:${e.event.includes('ERROR') || e.event.includes('FAIL') ? 'var(--error)' : 'var(--bg-surface)'};color:${e.event.includes('ERROR') ? '#fff' : 'var(--text-primary)'}">${esc(e.event)}</span></td>
      <td style="font-size:12px">${esc(e.description)}</td>
      <td style="font-size:11px;color:var(--text-muted)">${esc(e.handler)}</td>
      <td style="font-family:var(--font-mono);font-size:10px;color:var(--text-muted)">${esc((e.hashChain || '').substring(0, 12))}...</td>
    </tr>
  `).join('');

  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <h3 style="margin:0;font-size:16px">Chain of Custody Report</h3>
      <span style="font-size:11px;color:var(--text-muted)">Generated: ${data.reportGenerated?.substring(0, 19).replace('T', ' ')}</span>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px">
      <div style="padding:16px;background:var(--bg-surface);border-radius:var(--radius);border:1px solid var(--border)">
        <h4 style="margin:0 0 12px;font-size:13px;color:var(--accent)">Case Information</h4>
        <div style="font-size:12px;line-height:2">
          <div><span style="color:var(--text-muted);min-width:100px;display:inline-block">Project:</span> <strong>${esc(ci.projectName || '')}</strong></div>
          <div><span style="color:var(--text-muted)">Case ID:</span> <strong>${esc(ci.caseId || 'N/A')}</strong></div>
          <div><span style="color:var(--text-muted)">Evidence ID:</span> <strong>${esc(ci.evidenceId || 'N/A')}</strong></div>
          <div><span style="color:var(--text-muted)">Custodian:</span> <strong>${esc(ci.custodian || 'N/A')}</strong></div>
          <div><span style="color:var(--text-muted)">Examiner:</span> <strong>${esc(ci.examiner || 'N/A')}</strong></div>
          <div><span style="color:var(--text-muted)">Target:</span> <strong>${esc(ci.targetEmail || '')}</strong></div>
          <div><span style="color:var(--text-muted)">Legal Authority:</span> <strong>${esc(ci.legalAuthority || 'N/A')}</strong></div>
        </div>
      </div>
      <div style="padding:16px;background:var(--bg-surface);border-radius:var(--radius);border:1px solid var(--border)">
        <h4 style="margin:0 0 12px;font-size:13px;color:var(--accent)">Evidence Summary</h4>
        <div style="font-size:12px;line-height:2">
          <div><span style="color:var(--text-muted)">Total Messages:</span> <strong>${es.totalMessages || 0}</strong></div>
          <div><span style="color:var(--text-muted)">Total Attachments:</span> <strong>${es.totalAttachments || 0}</strong></div>
          <div><span style="color:var(--text-muted)">Total Size:</span> <strong>${formatBytes(es.totalSize || 0)}</strong></div>
          <div><span style="color:var(--text-muted)">Date Range:</span> <strong>${es.dateRange ? esc(es.dateRange.earliest?.substring(0, 10) + ' — ' + es.dateRange.latest?.substring(0, 10)) : 'N/A'}</strong></div>
          <div><span style="color:var(--text-muted)">Hash Algorithms:</span> <strong>${(es.hashAlgorithms || []).join(', ')}</strong></div>
          <div><span style="color:var(--text-muted)">Hashed Messages:</span> <strong>${es.messagesWithHash || 0} / ${es.totalMessages || 0}</strong></div>
        </div>
      </div>
    </div>

    <div style="padding:12px 16px;margin-bottom:16px;border-radius:var(--radius);background:${ai.chainValid ? 'rgba(46,160,67,0.1)' : 'rgba(248,81,73,0.1)'};border:1px solid ${ai.chainValid ? 'var(--success)' : 'var(--error)'}">
      <strong style="color:${ai.chainValid ? 'var(--success)' : 'var(--error)'}">Audit Chain: ${ai.chainValid ? 'verified' : 'BROKEN'}</strong>
      <span style="margin-left:12px;font-size:12px;color:var(--text-muted)">${ai.totalEntries} entries | ${ai.hashAlgorithm} hash chain | ${ai.standard}</span>
    </div>

    <h4 style="margin:20px 0 8px;font-size:13px">Custody Events</h4>
    <div style="max-height:350px;overflow-y:auto">
      <table class="audit-table">
        <thead><tr><th>Timestamp</th><th>Event</th><th>Description</th><th>Handler</th><th>Hash</th></tr></thead>
        <tbody>${chainRows || '<tr><td colspan="5" style="text-align:center;color:var(--text-muted)">No custody events recorded</td></tr>'}</tbody>
      </table>
    </div>

    <div style="margin-top:20px;padding:16px;background:var(--bg-surface);border-radius:var(--radius);border:1px solid var(--border)">
      <h4 style="margin:0 0 8px;font-size:13px;color:var(--accent)">Applicable Standards</h4>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:11px">
        <div><span style="color:var(--text-muted)">Collection:</span> ${esc(stds.collection || '')}</div>
        <div><span style="color:var(--text-muted)">Hashing:</span> ${esc(stds.hashing || '')}</div>
        <div><span style="color:var(--text-muted)">Audit:</span> ${esc(stds.auditTrail || '')}</div>
        <div><span style="color:var(--text-muted)">Timestamp:</span> ${esc(stds.timestamping || '')}</div>
        <div><span style="color:var(--text-muted)">Admissibility:</span> ${esc(stds.admissibility || '')}</div>
        <div><span style="color:var(--text-muted)">Authentication:</span> ${esc(stds.authentication || '')}</div>
      </div>
    </div>

    <div style="margin-top:20px;padding:16px;background:var(--bg-surface);border-radius:var(--radius);border:1px solid var(--border);border-left:3px solid var(--accent)">
      <p style="font-style:italic;font-size:12px;margin:0 0 8px;color:var(--text-secondary)">${esc(data.certification?.statement || '')}</p>
      <div style="font-size:12px;color:var(--text-muted)">
        <strong>${esc(data.certification?.examiner || 'Examiner')}</strong> — ${data.certification?.date?.substring(0, 10) || ''}
      </div>
    </div>
  `;
}

// ============================================================
// MESSAGE: Header Analysis
// ============================================================

async function analyzeHeaders(msgId) {
  if (!currentProject) return;
  try {
    const data = await api(`/projects/${currentProject.id}/messages/${msgId}/headers`);
    showHeaderAnalysis(data);
  } catch (err) {
    toast(`Header analysis failed: ${err.message}`);
  }
}

function showHeaderAnalysis(data) {
  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:1000;display:flex;align-items:center;justify-content:center';
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

  const authBadge = (result) => {
    const colors = { pass: 'var(--success)', fail: 'var(--error)', softfail: 'var(--warning)', none: 'var(--text-muted)', neutral: 'var(--text-muted)' };
    return `<span style="padding:2px 8px;border-radius:3px;font-size:11px;font-weight:600;background:${colors[result] || 'var(--text-muted)'};color:#fff">${result.toUpperCase()}</span>`;
  };

  const hops = (data.receivedHops || []).map((h, i) => `
    <div style="display:flex;gap:12px;padding:8px 0;border-bottom:1px solid var(--border);font-size:12px">
      <span style="min-width:24px;font-weight:600;color:var(--accent)">#${i + 1}</span>
      <div style="flex:1">
        <div><span style="color:var(--text-muted)">From:</span> <span style="font-family:var(--font-mono)">${esc(h.from || 'unknown')}</span></div>
        <div><span style="color:var(--text-muted)">By:</span> <span style="font-family:var(--font-mono)">${esc(h.by || 'unknown')}</span></div>
        ${h.ip ? `<div><span style="color:var(--text-muted)">IP:</span> <span style="font-family:var(--font-mono);color:var(--accent)">${esc(h.ip)}</span></div>` : ''}
        ${h.date ? `<div><span style="color:var(--text-muted)">Time:</span> ${esc(h.date)}</div>` : ''}
      </div>
    </div>
  `).join('');

  const flags = (data.redFlags || []).map(f => {
    const sev = { critical: 'var(--error)', warning: 'var(--warning)', info: 'var(--accent)' };
    return `<div style="padding:8px 12px;margin-bottom:6px;border-radius:var(--radius);background:${f.severity === 'critical' ? 'rgba(248,81,73,0.15)' : f.severity === 'warning' ? 'rgba(210,153,34,0.15)' : 'rgba(88,166,255,0.1)'};border-left:3px solid ${sev[f.severity] || 'var(--text-muted)'}">
      <strong style="font-size:11px;color:${sev[f.severity]}">${esc(f.type)}</strong>
      <div style="font-size:12px;margin-top:2px">${esc(f.description)}</div>
    </div>`;
  }).join('');

  const xHeaders = (data.xHeaders || []).slice(0, 15).map(h =>
    `<div style="font-size:11px;padding:2px 0;border-bottom:1px solid var(--border)"><span style="color:var(--accent);font-family:var(--font-mono)">${esc(h.name)}</span>: <span style="color:var(--text-secondary)">${esc(String(h.value).substring(0, 100))}</span></div>`
  ).join('');

  modal.innerHTML = `
    <div style="background:var(--bg-main);border:1px solid var(--border);border-radius:8px;width:700px;max-height:85vh;overflow-y:auto;padding:24px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <h3 style="margin:0;font-size:16px">Email Header Analysis</h3>
        <button onclick="this.closest('div[style*=fixed]').remove()" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:18px">✕</button>
      </div>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:16px">
        <strong>${esc(data.subject || '')}</strong><br>From: ${esc(data.from || '')} | ${esc(data.date || '')}
      </div>

      <h4 style="margin:0 0 8px;font-size:13px">Authentication Results</h4>
      <div style="display:flex;gap:16px;margin-bottom:16px;padding:12px;background:var(--bg-surface);border-radius:var(--radius)">
        <div style="text-align:center"><div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">SPF</div>${authBadge(data.authentication?.spf || 'none')}</div>
        <div style="text-align:center"><div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">DKIM</div>${authBadge(data.authentication?.dkim || 'none')}</div>
        <div style="text-align:center"><div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">DMARC</div>${authBadge(data.authentication?.dmarc || 'none')}</div>
        ${data.dkimDomain ? `<div style="margin-left:auto;font-size:11px;color:var(--text-muted)">Signed by: <strong style="color:var(--text-primary)">${esc(data.dkimDomain)}</strong></div>` : ''}
      </div>

      ${flags ? `<h4 style="margin:0 0 8px;font-size:13px">Red Flags (${data.redFlags?.length || 0})</h4><div style="margin-bottom:16px">${flags}</div>` : ''}

      <h4 style="margin:0 0 8px;font-size:13px">Routing Hops (${data.receivedHops?.length || 0})</h4>
      <div style="margin-bottom:16px;padding:0 8px">${hops || '<div style="color:var(--text-muted);font-size:12px">No Received headers found</div>'}</div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
        <div>
          <h4 style="margin:0 0 4px;font-size:12px;color:var(--text-muted)">Return-Path</h4>
          <div style="font-family:var(--font-mono);font-size:11px">${esc(data.returnPath || 'N/A')}</div>
        </div>
        <div>
          <h4 style="margin:0 0 4px;font-size:12px;color:var(--text-muted)">Reply-To</h4>
          <div style="font-family:var(--font-mono);font-size:11px">${esc(data.replyTo || 'N/A')}</div>
        </div>
      </div>

      ${xHeaders ? `<h4 style="margin:0 0 8px;font-size:13px">X-Headers</h4><div style="max-height:200px;overflow-y:auto">${xHeaders}</div>` : ''}
    </div>
  `;
  document.body.appendChild(modal);
}

// ============================================================
// WIZARD LOGIC
// ============================================================

function wizGoToStep(step) {
  if (step < 1 || step > 9) return;
  wizStep = step;

  document.querySelectorAll('.wizard-step').forEach(el => {
    const s = parseInt(el.dataset.step);
    el.classList.toggle('active', s === step);
    el.classList.toggle('completed', s < step);
  });

  document.querySelectorAll('.wizard-content').forEach(el => el.classList.remove('active'));
  const target = document.getElementById(`wiz-step-${step}`);
  if (target) target.classList.add('active');
  document.querySelector('.wizard-body')?.scrollTo(0, 0);

  const backBtn = document.getElementById('wiz-btn-back');
  const nextBtn = document.getElementById('wiz-btn-next');
  backBtn.style.visibility = step === 1 ? 'hidden' : 'visible';

  if (step === 6) {
    nextBtn.style.display = 'none';
    backBtn.style.display = 'none';
  } else if (step === 9) {
    nextBtn.textContent = 'Finish';
    nextBtn.style.display = '';
    backBtn.style.display = '';
  } else {
    nextBtn.textContent = step === 5 ? 'Start Collection' : 'Next';
    nextBtn.style.display = '';
    backBtn.style.display = '';
  }

  document.getElementById('wiz-step-indicator').textContent = `Step ${step} of 9`;

  if (step === 2) wizScopeChanged();
  if (step === 3) wizUpdateQuerySummary();
  if (step === 4) {
    wizUpdateFolderSummary();
    // The connection was set up in step 1, so the folder list is fetched on arrival.
    if (!wizFolders.length && wizScope() !== 'drive') wizLoadFolders();
  }
  if (step === 7 || step === 8) caseTagFor = null;
  if (step === 5) {
    wizBuildPreview();
    wizRunEstimate({ auto: true });
  }
}

function wizNext() {
  if (wizStep === 1) {
    const protocol = document.getElementById('wiz-protocol').value;
    const email = document.getElementById('wiz-email').value;
    if (!email) { fieldError('wiz-email', 'Enter the mailbox address to collect.'); return; }
    if ((protocol === 'imap' || protocol === 'pop3') && !document.getElementById('wiz-host').value) {
      fieldError('wiz-host', 'Enter the server address, for example imap.example.com.'); return;
    }
    wizSaveConnection();
  }

  if (wizStep === 2 && !wizCheckScope()) return;

  if (wizStep === 3) {
    const q = wizReadQuery();
    if (q.error) { wizShowQueryError(q.error); return; }
  }

  if (wizStep === 4 && wizScope() !== 'drive' && wizFolders.length && !wizGetSelectedFolders().length) {
    toast('Select at least one folder (or choose Drive / Cloud only in Step 2)');
    return;
  }

  if (wizStep === 5) {
    wizStartCollection();
    return;
  }

  if (wizStep === 9) {
    toast('Collection workflow complete');
    wizGoToStep(1);
    wizResetState({ keepConnection: true });
    caseTagFor = null;
    switchTab('messages');
    return;
  }

  wizGoToStep(wizStep + 1);
}

// Going back from the results and starting again re-runs the collection: into the same destination it
// becomes a differential acquisition in its own "Differential Acquisition" folder.
function wizBack() {
  if (wizStep === 6) return;
  if (wizStep === 7) { wizGoToStep(5); return; }
  wizGoToStep(wizStep - 1);
}

// Entering the Collect tab never discards a wizard in progress; it only starts fresh for a different
// project, and it re-attaches to a collection that is running (or finished while away).
async function wizEnterCollectTab() {
  const project = currentProject;
  if (!project) return;
  if (wizPrefilledProjectId !== project.id && !(wizCollecting && wizCollecting.projectId === project.id)) {
    wizResetState();
    prefillCollectWizard(project);
    wizGoToStep(1);
    wizPrefilledProjectId = project.id;
  }
  if (wizCollecting && wizCollecting.projectId === project.id) {
    if (wizStep !== 6) wizGoToStep(6);
    return;
  }
  const unseen = wizUnseenResults.get(project.id);
  if (unseen) {
    wizUnseenResults.delete(project.id);
    wizShowResults(unseen);
    wizGoToStep(7);
    return;
  }
  try {
    const progress = await api(`/projects/${project.id}/collect/progress`);
    if (currentProject?.id !== project.id) return;
    if (progress.active) {
      wizAttachToCollection(project, { progress });
    } else if (progress.result && wizStep === 1) {
      const note = document.getElementById('wiz-last-result');
      note.innerHTML = `Last collection for this project: <strong>${esc(wizCompletionLabel(progress.result))}</strong>
        <button type="button" class="btn btn-secondary btn-sm" style="margin-left:8px" onclick="wizViewLastResult()">View Results</button>`;
      note.style.display = '';
      note._result = progress.result;
    }
  } catch { /* progress is informational */ }
}

function wizViewLastResult() {
  const result = document.getElementById('wiz-last-result')._result;
  if (!result) return;
  wizShowResults(result);
  wizGoToStep(7);
}

// ── Background collection indicator (status bar) ──
async function pollActiveCollections() {
  try {
    activeCollectionsList = await api('/collections/active');
  } catch {
    return;
  }
  const el = document.getElementById('status-collection');
  if (el) {
    if (!activeCollectionsList.length) {
      el.style.display = 'none';
    } else {
      const c = activeCollectionsList[0];
      const done = c.acquired + c.failed + c.skipped;
      const pct = c.total ? `${Math.floor((done / c.total) * 100)}%` : (c.drive ? `${c.drive.done}/${c.drive.total} files` : c.phase);
      el.textContent = `● ${c.canceling ? 'Stopping' : 'Collecting'}: ${c.projectName} (${pct})${activeCollectionsList.length > 1 ? ` +${activeCollectionsList.length - 1} more` : ''}`;
      el.style.display = '';
    }
  }
  wizUpdateUnloadGuard();
}

async function openActiveCollection() {
  const c = activeCollectionsList[0];
  if (!c) return;
  if (currentProject?.id !== c.projectId) await selectProject(c.projectId);
  switchTab('collect');
}

// In a browser tab, warn before the page is closed while collecting (the server keeps collecting, but the
// examiner loses the live view). The desktop app asks through its own dialog instead.
function wizUpdateUnloadGuard() {
  if (IS_ELECTRON) return;
  const busy = !!wizCollecting || activeCollectionsList.length > 0;
  window.onbeforeunload = busy ? (e) => { e.preventDefault(); e.returnValue = ''; return ''; } : null;
}

const PROVIDER_MAP = {
  'gmail.com': 'gmail', 'googlemail.com': 'gmail',
  'outlook.com': 'microsoft', 'hotmail.com': 'microsoft', 'live.com': 'microsoft', 'msn.com': 'microsoft',
  'outlook.co.uk': 'microsoft', 'hotmail.co.uk': 'microsoft', 'live.co.uk': 'microsoft',
  'zoho.com': 'zoho', 'zohomail.com': 'zoho', 'zohomail.eu': 'zoho', 'zohomail.in': 'zoho',
  'fastmail.com': 'fastmail', 'fastmail.fm': 'fastmail', 'messagingengine.com': 'fastmail',
  'yahoo.com': 'yahoo', 'ymail.com': 'yahoo', 'rocketmail.com': 'yahoo',
  'yahoo.co.uk': 'yahoo', 'yahoo.co.jp': 'yahoo', 'yahoo.ca': 'yahoo',
  'yahoo.com.au': 'yahoo', 'yahoo.fr': 'yahoo', 'yahoo.de': 'yahoo', 'yahoo.it': 'yahoo',
  'aol.com': 'aol', 'aim.com': 'aol', 'verizon.net': 'aol',
  'icloud.com': 'icloud', 'me.com': 'icloud', 'mac.com': 'icloud',
  'protonmail.com': 'protonmail', 'proton.me': 'protonmail', 'pm.me': 'protonmail', 'protonmail.ch': 'protonmail',
  'yandex.com': 'yandex', 'yandex.ru': 'yandex', 'yandex.ua': 'yandex', 'ya.ru': 'yandex',
};

const PROVIDER_PROTOCOLS = {
  gmail:      { best: 'gmail_api', options: ['gmail_api', 'imap', 'pop3'] },
  microsoft:  { best: 'graph',    options: ['graph', 'ews', 'imap', 'pop3'] },
  zoho:       { best: 'zoho_api', options: ['zoho_api', 'imap', 'pop3'] },
  fastmail:   { best: 'jmap',     options: ['jmap', 'imap', 'pop3'] },
  yahoo:      { best: 'imap',     options: ['imap', 'pop3'] },
  aol:        { best: 'imap',     options: ['imap', 'pop3'] },
  icloud:     { best: 'imap',     options: ['imap'] },
  protonmail: { best: 'imap',     options: ['imap'] },
  yandex:     { best: 'imap',     options: ['imap', 'pop3'] },
  other:      { best: 'imap',     options: ['imap', 'pop3', 'ews', 'graph', 'gmail_api', 'zoho_api', 'jmap'] },
};

const PROVIDER_PRESETS = {
  gmail:      { imap: { host: 'imap.gmail.com', port: 993 }, pop3: { host: 'pop.gmail.com', port: 995 } },
  microsoft:  { imap: { host: 'outlook.office365.com', port: 993 }, pop3: { host: 'outlook.office365.com', port: 995 } },
  zoho:       { imap: { host: 'imap.zoho.com', port: 993 }, pop3: { host: 'pop.zoho.com', port: 995 } },
  fastmail:   { imap: { host: 'imap.fastmail.com', port: 993 }, pop3: { host: 'pop.fastmail.com', port: 995 } },
  yahoo:      { imap: { host: 'imap.mail.yahoo.com', port: 993 }, pop3: { host: 'pop.mail.yahoo.com', port: 995 } },
  aol:        { imap: { host: 'imap.aol.com', port: 993 }, pop3: { host: 'pop.aol.com', port: 995 } },
  icloud:     { imap: { host: 'imap.mail.me.com', port: 993 } },
  protonmail: { imap: { host: '127.0.0.1', port: 1143 } },
  yandex:     { imap: { host: 'imap.yandex.com', port: 993 }, pop3: { host: 'pop.yandex.com', port: 995 } },
};

const PROVIDER_NOTES = {
  gmail: 'Gmail API provides the most complete collection with label support and raw MIME download. Requires one-time Google Cloud OAuth setup.',
  microsoft: 'Graph API is the modern replacement for EWS. Free Azure AD app registration. Supports mail, OneDrive, SharePoint.',
  zoho: 'Zoho Mail API provides full REST access. Register at api-console.zoho.com (free). Select your region.',
  fastmail: 'JMAP is an open standard (RFC 8621). Generate an API token in Fastmail Settings > Privacy & Security > API tokens.',
  yahoo: 'No REST API available. Use IMAP with an app-specific password from Yahoo Account Security settings.',
  aol: 'No REST API available. Same infrastructure as Yahoo. Generate app-specific password in AOL settings.',
  icloud: 'No REST API. Requires an app-specific password from appleid.apple.com. POP3 not supported.',
  protonmail: 'Requires Proton Mail Bridge running locally (paid plans only). Bridge runs local IMAP on port 1143.',
  yandex: 'No public REST API. Use IMAP with app password from Yandex account settings.',
  other: 'Enter server details manually. IMAP is the most widely supported protocol for forensic collection.',
};

let cachedProfiles = {};

async function loadCollectionProfiles(providerId) {
  if (cachedProfiles[providerId]) return cachedProfiles[providerId];
  try {
    const profiles = await api(`/collection-profiles/${providerId}`);
    cachedProfiles[providerId] = profiles;
    return profiles;
  } catch {
    return [];
  }
}

function wizAutoDetectProvider() {
  const email = document.getElementById('wiz-email').value.trim();
  const providerSelect = document.getElementById('wiz-provider');
  if (!email || !email.includes('@') || providerSelect.value) return;

  const domain = email.split('@')[1].toLowerCase();
  const provider = PROVIDER_MAP[domain] || 'other';
  providerSelect.value = provider;
  wizProviderChanged();
}

async function wizProviderChanged() {
  const providerId = document.getElementById('wiz-provider').value || 'other';
  const noteEl = document.getElementById('wiz-provider-note');
  const profileSelect = document.getElementById('wiz-collection-profile');

  if (PROVIDER_NOTES[providerId]) {
    noteEl.textContent = PROVIDER_NOTES[providerId];
    noteEl.style.display = '';
  } else {
    noteEl.style.display = 'none';
  }

  const profiles = await loadCollectionProfiles(providerId);

  profileSelect.innerHTML = '';
  for (const p of profiles) {
    const opt = document.createElement('option');
    opt.value = p.id;
    const tag = p.priority === 1 ? ' (Primary)' : ` (Fallback ${p.priority - 1})`;
    const fv = { HIGH: 'high', MEDIUM: 'medium', LOW: 'low' }[p.forensicValue] || 'unrated';
    opt.textContent = `${p.name}${tag} (${fv} forensic value)`;
    opt.dataset.profileId = p.id;
    profileSelect.appendChild(opt);
  }

  if (profiles.length > 0) {
    profileSelect.value = profiles[0].id;
    wizProfileChanged();
  }
}

function wizProfileChanged() {
  const providerId = document.getElementById('wiz-provider').value || 'other';
  const profileSelect = document.getElementById('wiz-collection-profile');
  const profileId = profileSelect.value;
  const profiles = cachedProfiles[providerId] || [];
  const profile = profiles.find(p => p.id === profileId);
  if (!profile) return;

  document.getElementById('wiz-protocol').value = profile.protocol;

  const infoEl = document.getElementById('wiz-profile-info');
  const descEl = document.getElementById('wiz-profile-desc');
  const forensicEl = document.getElementById('wiz-profile-forensic');
  const authEl = document.getElementById('wiz-profile-auth');
  const setupEl = document.getElementById('wiz-profile-setup');
  const limitsEl = document.getElementById('wiz-profile-limits');

  descEl.textContent = profile.description;
  const fvColors = { HIGH: 'var(--success)', MEDIUM: 'var(--warning)', LOW: 'var(--text-muted)' };
  forensicEl.textContent = `Forensic Value: ${profile.forensicValue}`;
  forensicEl.style.color = fvColors[profile.forensicValue] || 'var(--text-muted)';
  authEl.textContent = `Auth: ${profile.auth}`;
  setupEl.textContent = profile.setup ? `Setup: ${profile.setup}` : '';
  if (profile.limitations && profile.limitations.length > 0) {
    limitsEl.textContent = `Limitations: ${profile.limitations.join('; ')}`;
    limitsEl.style.display = '';
  } else {
    limitsEl.style.display = 'none';
  }
  infoEl.style.display = '';

  if (profile.preset) {
    if (profile.preset.host) document.getElementById('wiz-host').value = profile.preset.host;
    if (profile.preset.port) document.getElementById('wiz-port').value = profile.preset.port;
    if (profile.preset.tls === false) {
      document.getElementById('wiz-tls').checked = false;
    } else {
      document.getElementById('wiz-tls').checked = true;
    }
  }

  const authMethodSelect = document.getElementById('wiz-auth-method');
  if (authMethodSelect) {
    if (profile.auth === 'app-password') authMethodSelect.value = 'app-password';
    else if (profile.auth === 'oauth2') authMethodSelect.value = 'oauth2';
    else if (profile.auth === 'api-token') authMethodSelect.value = 'app-password';
    else authMethodSelect.value = 'password';
    wizUpdateAuthLabel();
  }

  wizUpdateProtocolFields();
}

function wizUpdateProtocolFields() {
  const protocol = document.getElementById('wiz-protocol').value;
  const fields = document.getElementById('wiz-protocol-fields');
  const gmailOAuth = document.getElementById('wiz-gmail-oauth');
  const msOAuth = document.getElementById('wiz-microsoft-oauth');
  const zohoOAuth = document.getElementById('wiz-zoho-oauth');
  const fmAuth = document.getElementById('wiz-fastmail-auth');

  const apiProtocols = ['graph', 'gmail_api', 'zoho_api', 'jmap'];
  if (apiProtocols.includes(protocol)) {
    fields.style.display = 'none';
  } else if (protocol === 'ews') {
    fields.style.display = '';
  } else {
    fields.style.display = '';
  }

  const ewsSection = document.getElementById('wiz-ews-section');
  if (ewsSection) ewsSection.style.display = protocol === 'ews' ? '' : 'none';

  gmailOAuth.style.display = protocol === 'gmail_api' ? '' : 'none';
  msOAuth.style.display = (protocol === 'graph' || protocol === 'ews') ? '' : 'none';
  zohoOAuth.style.display = protocol === 'zoho_api' ? '' : 'none';
  fmAuth.style.display = protocol === 'jmap' ? '' : 'none';

  if (protocol === 'gmail_api') gmailCheckStatus();
  if (protocol === 'graph' || protocol === 'ews') msCheckStatus();
  if (protocol === 'zoho_api') zohoCheckStatus();
  if (protocol === 'jmap') fmCheckStatus();
  wizScopeChanged();
}

// ── Collection scope (Step 2) ──
const DRIVE_BY_PROTOCOL = { gmail_api: 'Google Drive', graph: 'OneDrive', ews: 'OneDrive' };

function wizScope() {
  return document.querySelector('input[name="wiz-scope"]:checked')?.value || 'email';
}

function wizScopeChanged() {
  const note = document.getElementById('wiz-scope-note');
  if (!note) return;
  const scope = wizScope();
  if (scope === 'email') { note.style.display = 'none'; return; }
  const protocol = document.getElementById('wiz-protocol').value;
  const drive = DRIVE_BY_PROTOCOL[protocol];
  note.style.display = '';
  note.className = drive ? 'wiz-note' : 'wiz-note wiz-note-error';
  note.textContent = drive
    ? `${drive} files owned by the account will be collected${scope === 'both' ? ' after the mailbox' : ''}. Google Docs, Sheets and Slides are exported as Word, Excel and PowerPoint files. Every file is hashed and checked against the provider's own checksum. Drive collection uses the date and keyword criteria of the query (keywords on Google Drive only).`
    : `Drive / Cloud collection needs the Gmail API (Google Drive) or Microsoft Graph / EWS with Microsoft sign-in (OneDrive). The current collection profile uses ${protocol.toUpperCase()}: choose one of those profiles in Step 1, or collect Email only.`;
}

function wizCheckScope() {
  if (wizScope() === 'email') return true;
  if (DRIVE_BY_PROTOCOL[document.getElementById('wiz-protocol').value]) return true;
  wizScopeChanged();
  toast('Drive / Cloud collection is not available with this collection profile');
  return false;
}

// ── Query (Step 3) ──
const WIZ_QUERY_FIELDS = ['wiz-date-from', 'wiz-date-to', 'wiz-query-from', 'wiz-query-to', 'wiz-query-subject', 'wiz-query-keywords', 'wiz-query-attachments', 'wiz-query-unread'];

function wizBindQueryListeners() {
  for (const id of WIZ_QUERY_FIELDS) {
    document.getElementById(id)?.addEventListener('input', wizUpdateQuerySummary);
    document.getElementById(id)?.addEventListener('change', wizUpdateQuerySummary);
  }
  document.querySelectorAll('input[name="wiz-query-type"]').forEach(r => r.addEventListener('change', wizUpdateQuerySummary));
  document.getElementById('wiz-folders-list')?.addEventListener('change', wizUpdateFolderSummary);
}

const splitTerms = s => s.split(',').map(t => t.trim()).filter(Boolean);

function wizReadQuery() {
  const val = id => (document.getElementById(id)?.value || '').trim();
  const q = {
    type: document.querySelector('input[name="wiz-query-type"]:checked')?.value || 'in-place',
    dateFrom: val('wiz-date-from'),
    dateTo: val('wiz-date-to'),
    from: val('wiz-query-from'),
    to: val('wiz-query-to'),
    subject: val('wiz-query-subject'),
    keywords: val('wiz-query-keywords'),
    hasAttachments: !!document.getElementById('wiz-query-attachments')?.checked,
    unreadOnly: !!document.getElementById('wiz-query-unread')?.checked,
  };
  q.active = !!(q.dateFrom || q.dateTo || splitTerms(q.from).length || splitTerms(q.to).length
    || splitTerms(q.subject).length || splitTerms(q.keywords).length || q.hasAttachments || q.unreadOnly);
  if (q.dateFrom && q.dateTo && q.dateFrom > q.dateTo) q.error = '"Date From" is after "Date To".';
  return q;
}

function wizQueryPayload() {
  const q = wizReadQuery();
  if (!q.active) return null;
  const { active, error, ...payload } = q;
  return payload;
}

function wizDescribeQuery(q) {
  if (!q.active) return 'None: every message in the selected folders';
  const parts = [];
  if (q.dateFrom || q.dateTo) parts.push(`Date ${q.dateFrom || 'any'} to ${q.dateTo || 'any'}`);
  const list = (label, s) => { const t = splitTerms(s); if (t.length) parts.push(`${label} ${t.length > 1 ? 'any of ' : ''}${t.map(x => `"${x}"`).join(', ')}`); };
  list('From', q.from);
  list('To/Cc', q.to);
  list('Subject', q.subject);
  list('Body', q.keywords);
  if (q.hasAttachments) parts.push('Has attachments');
  if (q.unreadOnly) parts.push('Unread only');
  return `${q.type === 'in-line' ? 'In-line' : 'In-place'}: ${parts.join('; ')}`;
}

function wizShowQueryError(message) {
  const el = document.getElementById('wiz-query-error');
  if (!el) return;
  el.textContent = message || '';
  el.style.display = message ? '' : 'none';
}

function wizUpdateQuerySummary() {
  const q = wizReadQuery();
  wizShowQueryError(q.error || '');
  const el = document.getElementById('wiz-query-summary');
  if (!el) return;
  const how = q.type === 'in-line'
    ? 'Everything in the selected folders is collected; messages that match are listed in the results and in query_matches_*.csv.'
    : 'Only matching messages are collected. Criteria the server cannot apply are checked on each downloaded message; non-matching messages are logged with their hashes, not kept.';
  el.innerHTML = `<strong>Query:</strong> ${esc(wizDescribeQuery(q))}${q.active ? `<br><span style="color:var(--text-muted)">${how}</span>` : ''}`;
}

function wizClearQuery() {
  for (const id of WIZ_QUERY_FIELDS) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = false;
    else el.value = '';
  }
  const inPlace = document.querySelector('input[name="wiz-query-type"][value="in-place"]');
  if (inPlace) inPlace.checked = true;
  wizUpdateQuerySummary();
}

function wizSaveConnection() {
  const protocol = document.getElementById('wiz-protocol').value;
  const authMethod = document.getElementById('wiz-auth-method')?.value || 'password';
  const password = document.getElementById('wiz-password')?.value || '';
  const profileId = document.getElementById('wiz-collection-profile')?.value || '';

  wizConnection = {
    email: document.getElementById('wiz-email').value,
    protocol,
    profileId,
  };

  if (protocol === 'imap' || protocol === 'pop3') {
    wizConnection.host = document.getElementById('wiz-host').value;
    wizConnection.port = parseInt(document.getElementById('wiz-port').value) || 993;
    wizConnection.username = document.getElementById('wiz-username')?.value || wizConnection.email;
    wizConnection.tls = document.getElementById('wiz-tls')?.checked !== false;
    wizConnection.password = password;
  }

  if (protocol === 'ews') {
    const ewsUrl = document.getElementById('wiz-ews-url')?.value;
    if (ewsUrl) wizConnection.ewsUrl = ewsUrl;
    wizConnection.authType = authMethod;
    if (authMethod === 'password' && password) wizConnection.password = password;
  }
}

function wizUpdateAuthLabel() {
  const method = document.getElementById('wiz-auth-method').value;
  const label = document.getElementById('wiz-pass-label');
  if (method === 'app-password') label.textContent = 'App-Specific Password';
  else if (method === 'oauth2') label.textContent = 'Access Token';
  else label.textContent = 'Password';
}

async function wizPickFolder() {
  try {
    const result = await api('/pick-folder', { method: 'POST' });
    if (result.path) document.getElementById('wiz-output-dir').value = result.path;
  } catch { /* user cancelled or not in Electron */ }
}

async function wizPickTransferDest() {
  try {
    const result = await api('/pick-folder', { method: 'POST' });
    if (result.path) document.getElementById('wiz-transfer-dest').value = result.path;
  } catch { /* user cancelled or not in Electron */ }
}

async function wizTestConnection() {
  wizSaveConnection();
  const el = document.getElementById('wiz-conn-status');
  el.innerHTML = '<span style="color:var(--accent)">Testing connection...</span>';

  try {
    const result = await api('/connect/test', { method: 'POST', body: { protocol: wizConnection.protocol, config: wizConnection } });
    if (result.success !== false && !result.error) {
      el.innerHTML = `<span class="verify-pass">Connection successful${result.folders ? ` (${result.folders.length} folders)` : ''}</span>`;
    } else {
      el.innerHTML = `<span class="verify-fail">Failed: ${esc(result.error || result.message || 'Unknown error')}</span>` + buildFallbackHint();
    }
  } catch (err) {
    el.innerHTML = `<span class="verify-fail">Error: ${esc(err.message)}</span>` + buildFallbackHint();
  }
}

function buildFallbackHint() {
  const providerId = document.getElementById('wiz-provider').value || 'other';
  const currentProfileId = document.getElementById('wiz-collection-profile').value;
  const profiles = cachedProfiles[providerId] || [];
  const currentIdx = profiles.findIndex(p => p.id === currentProfileId);
  const fallbacks = profiles.filter((p, i) => i > currentIdx);
  if (fallbacks.length === 0) return '';
  const links = fallbacks.map(p =>
    `<a href="#" onclick="event.preventDefault();document.getElementById('wiz-collection-profile').value='${p.id}';wizProfileChanged()" style="color:var(--accent);text-decoration:underline">${esc(p.name)}</a>`
  ).join(', ');
  return `<div style="margin-top:8px;font-size:12px;color:var(--text-muted)">Try a fallback profile: ${links}</div>`;
}

async function wizDetectProvider() {
  const email = document.getElementById('wiz-email').value;
  if (!email) { toast('Enter an email address first'); return; }

  const el = document.getElementById('wiz-conn-status');
  el.innerHTML = '<span style="color:var(--accent)">Detecting provider...</span>';

  try {
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
  } catch {
    el.innerHTML = '<span class="verify-fail">Detection failed</span>';
  }
}

function wizBindFormatListeners() {
  document.querySelectorAll('input[name="wiz-format"]').forEach(cb => {
    cb.addEventListener('change', () => {
      const pstChecked = document.querySelector('input[name="wiz-format"][value="pst"]')?.checked;
      const pstOpts = document.getElementById('wiz-pst-options');
      if (pstOpts) pstOpts.style.display = pstChecked ? 'block' : 'none';
    });
  });
}

async function wizLoadFolders() {
  wizSaveConnection();
  const el = document.getElementById('wiz-folders-list');
  el.innerHTML = '<div style="padding:20px;color:var(--accent)">Loading folders from server...</div>';

  try {
    const result = await api('/connect/test', { method: 'POST', body: { protocol: wizConnection.protocol, config: wizConnection } });
    const folders = result.folders || [];
    wizFolders = folders;
    wizEstimate = null;

    if (!folders.length) {
      el.innerHTML = '<div class="empty-state" style="height:150px"><p>No folders found on the server.</p></div>';
      wizUpdateFolderSummary();
      return;
    }

    el.innerHTML = folders.map(f => {
      const name = f.name || f.path || f;
      const path = f.path || f.name || f;
      const messages = f.messages || f.totalMessages || 0;
      return `
        <label class="wiz-folder-item" data-filter="${esc(String(path).toLowerCase())}">
          <input type="checkbox" class="wiz-folder-cb" data-path="${esc(path)}" data-count="${messages}" checked>
          <span class="wiz-folder-name" title="${esc(path)}">${esc(path !== name ? path : name)}</span>
          <span class="wiz-folder-count">${Number(messages).toLocaleString()} messages</span>
        </label>`;
    }).join('');
    wizFilterFolders();
  } catch (err) {
    el.innerHTML = `<div style="padding:20px;color:var(--danger)">Failed to load folders: ${esc(err.message || 'Connection error')}</div>`;
  }
  wizUpdateFolderSummary();
}

function wizVisibleFolderBoxes() {
  return Array.from(document.querySelectorAll('.wiz-folder-item')).filter(el => el.style.display !== 'none').map(el => el.querySelector('.wiz-folder-cb'));
}

function wizSelectAllFolders() { wizVisibleFolderBoxes().forEach(cb => { cb.checked = true; }); wizUpdateFolderSummary(); }
function wizDeselectAllFolders() { wizVisibleFolderBoxes().forEach(cb => { cb.checked = false; }); wizUpdateFolderSummary(); }

function wizFilterFolders() {
  const term = (document.getElementById('wiz-folder-filter')?.value || '').trim().toLowerCase();
  document.querySelectorAll('.wiz-folder-item').forEach(el => {
    el.style.display = !term || el.dataset.filter.includes(term) ? '' : 'none';
  });
}

function wizGetSelectedFolders() {
  return Array.from(document.querySelectorAll('.wiz-folder-cb:checked')).map(cb => cb.dataset.path);
}

function wizUpdateFolderSummary() {
  const el = document.getElementById('wiz-folder-summary');
  if (!el) return;
  const all = document.querySelectorAll('.wiz-folder-cb');
  if (!all.length) { el.textContent = ''; return; }
  const checked = Array.from(all).filter(cb => cb.checked);
  const count = checked.reduce((s, cb) => s + (parseInt(cb.dataset.count, 10) || 0), 0);
  el.textContent = `${checked.length} of ${all.length} folders selected · ${count.toLocaleString()} messages (folder totals, before de-duplication)`;
}

function wizSelectedFormats() {
  return Array.from(document.querySelectorAll('input[name="wiz-format"]:checked')).map(cb => cb.value);
}

// The same settings the collection will use, so the estimate counts exactly what would be collected.
function wizCollectBody() {
  return {
    folders: wizSelectedFolders.length > 0 ? wizSelectedFolders : undefined,
    config: wizConnection,
    scope: wizScope(),
    query: wizQueryPayload(),
    differential: !!document.getElementById('wiz-differential')?.checked,
    outputDir: (document.getElementById('wiz-output-dir').value || '').trim() || undefined,
    collectAttachmentFiles: !!document.getElementById('wiz-collect-modern')?.checked,
    collectLinkedFiles: !!document.getElementById('wiz-collect-drive')?.checked,
  };
}

function wizBuildPreview() {
  wizSaveConnection();
  wizSelectedFolders = wizGetSelectedFolders();
  const formats = wizSelectedFormats();
  const scope = wizScope();
  const driveLinks = document.getElementById('wiz-collect-drive').checked;
  const modernAtt = document.getElementById('wiz-collect-modern').checked;
  const differential = document.getElementById('wiz-differential')?.checked;
  const outputDir = document.getElementById('wiz-output-dir').value || 'SherlockMail data folder (no destination chosen)';
  const q = wizReadQuery();

  let folderTotal = 0;
  wizSelectedFolders.forEach(path => {
    const folder = wizFolders.find(f => (f.path || f.name || f) === path);
    if (folder) folderTotal += folder.messages || folder.totalMessages || 0;
  });
  const scopeLabel = { email: 'Email', drive: 'Drive / Cloud', both: 'Email + Drive / Cloud' }[scope];
  const folderLabel = scope === 'drive' ? 'Drive files only' : wizSelectedFolders.length ? `${wizSelectedFolders.length} folder(s) selected` : 'INBOX (folders not loaded in Step 4)';

  document.getElementById('wiz-preview-notice').innerHTML = '';
  document.getElementById('wiz-estimate-detail').innerHTML = '';
  document.getElementById('wiz-preview-summary').innerHTML = `
    <div class="wiz-preview-card">
      <div class="wiz-preview-title">Project</div>
      <div class="wiz-preview-value">${esc(currentProject?.name || 'No project selected')}</div>
      <div class="wiz-preview-sub">${esc(currentProject?.target_email || '')}</div>
    </div>
    <div class="wiz-preview-card">
      <div class="wiz-preview-title">Protocol &amp; Scope</div>
      <div class="wiz-preview-value">${esc((wizConnection.protocol || 'imap').toUpperCase())} · ${esc(scopeLabel)}</div>
      <div class="wiz-preview-sub">${esc(wizConnection.host || 'API-based')}${wizConnection.port ? ':' + wizConnection.port : ''}</div>
    </div>
    <div class="wiz-preview-card highlight">
      <div class="wiz-preview-title">Estimated Items (de-duplicated)</div>
      <div class="wiz-preview-value wiz-preview-big" id="wiz-est-items">${scope === 'drive' ? '…' : folderTotal.toLocaleString()}</div>
      <div class="wiz-preview-sub" id="wiz-est-items-sub">${esc(folderLabel)}${scope !== 'drive' ? ' · folder totals, counting unique items…' : ''}</div>
    </div>
    <div class="wiz-preview-card highlight">
      <div class="wiz-preview-title">Estimated Size</div>
      <div class="wiz-preview-value wiz-preview-big" id="wiz-est-size">…</div>
      <div class="wiz-preview-sub" id="wiz-est-size-sub">Calculating…</div>
    </div>
    <div class="wiz-preview-card wiz-preview-card-wide">
      <div class="wiz-preview-title">Query in Use</div>
      <div class="wiz-preview-value" style="font-size:14px;font-weight:600">${esc(wizDescribeQuery(q))}</div>
      <div class="wiz-preview-sub" id="wiz-est-query-notes"></div>
    </div>
    <div class="wiz-preview-card">
      <div class="wiz-preview-title">Output Formats</div>
      <div class="wiz-preview-value">${formats.map(f => f.toUpperCase()).join(', ') || 'None'}</div>
      <div class="wiz-preview-sub">Attachments ${modernAtt ? 'also saved as separate files' : 'kept inside each email'}; linked cloud files ${driveLinks ? 'downloaded' : 'not downloaded'}</div>
    </div>
    <div class="wiz-preview-card">
      <div class="wiz-preview-title">Acquisition Mode</div>
      <div class="wiz-preview-value" style="font-size:14px" id="wiz-est-mode">${differential ? 'Differential (skips items already collected)' : 'Full collection'}</div>
    </div>
    <div class="wiz-preview-card wiz-preview-card-wide">
      <div class="wiz-preview-title">Destination Folder</div>
      <div class="wiz-preview-value" style="font-size:13px;font-family:var(--font-mono);word-break:break-all" id="wiz-est-dest">${esc(outputDir)}</div>
    </div>
  `;
}

async function wizRunEstimate({ auto = false } = {}) {
  if (!currentProject) return;
  wizSaveConnection();
  wizSelectedFolders = wizGetSelectedFolders();
  const body = wizCollectBody();
  const key = JSON.stringify({ project: currentProject.id, ...body, config: { ...body.config, password: undefined } });
  if (auto && wizEstimate && wizEstimateKey === key) { wizRenderEstimate(wizEstimate); return; }

  wizEstimateCtl?.abort();
  const ctl = new AbortController();
  wizEstimateCtl = ctl;
  const status = document.getElementById('wiz-estimate-status');
  const btn = document.getElementById('wiz-estimate-btn');
  status.innerHTML = '<span style="color:var(--accent)">Listing the selected folders on the server (nothing is downloaded)…</span>';
  btn.disabled = true;
  try {
    const res = await fetch(`/api/projects/${currentProject.id}/collect/estimate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal,
    });
    const data = await res.json().catch(() => ({ error: res.statusText }));
    if (!res.ok) throw new Error(data.error || 'Estimate failed');
    if (wizEstimateCtl !== ctl) return;
    wizEstimate = data;
    wizEstimateKey = key;
    wizRenderEstimate(data);
  } catch (err) {
    if (err.name === 'AbortError' || wizEstimateCtl !== ctl) return;
    status.innerHTML = `<span class="verify-fail">Could not calculate the estimate: ${esc(err.message)}</span>`;
    const items = document.getElementById('wiz-est-items-sub');
    if (items) items.textContent += ' (exact count unavailable)';
    const size = document.getElementById('wiz-est-size');
    if (size) size.textContent = 'Unavailable';
    const sizeSub = document.getElementById('wiz-est-size-sub');
    if (sizeSub) sizeSub.textContent = 'The server could not be listed';
  } finally {
    if (wizEstimateCtl === ctl) { wizEstimateCtl = null; btn.disabled = false; }
  }
}

function wizRenderEstimate(d) {
  const set = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
  const email = d.email;
  const drive = d.drive;
  let items = 0;
  let bytes = 0;
  let sizeKnown = true;
  const itemSub = [];
  const sizeSub = [];

  if (email) {
    if (email.items == null) {
      itemSub.push(esc(email.note || 'Exact count unavailable for this protocol'));
      sizeKnown = false;
    } else {
      items += email.items;
      itemSub.push(`${email.items.toLocaleString()} unique message(s)`);
      if (email.duplicatesMerged) itemSub.push(`${email.itemsBeforeDedup.toLocaleString()} listed across folders, ${email.duplicatesMerged.toLocaleString()} label/folder duplicate(s) merged`);
      else itemSub.push('no duplicate copies across the selected folders');
      if (email.totalBytes == null) sizeKnown = false;
      else {
        bytes += email.totalBytes;
        sizeSub.push(`Email: ${formatBytes(email.totalBytes)} (${esc(email.sizeBasis === 'exact' ? 'server-reported sizes' : email.sizeBasis)})`);
      }
    }
  }
  if (drive) {
    if (drive.error) {
      itemSub.push(`<span style="color:var(--danger)">Drive: ${esc(drive.error)}</span>`);
    } else {
      items += drive.downloadable;
      bytes += drive.totalBytes;
      itemSub.push(`${drive.downloadable.toLocaleString()} drive file(s)${drive.notDownloadable ? ` (+${drive.notDownloadable} not downloadable, metadata only)` : ''}`);
      sizeSub.push(`Drive: ${formatBytes(drive.totalBytes)}${drive.exportCount ? ` (+ ${drive.exportCount} Google file(s) exported; size known after export)` : ''}`);
    }
  }
  const upTo = d.query?.checkedAfterDownload ? 'up to ' : '';
  set('wiz-est-items', `${upTo ? '<small>up to</small> ' : ''}${items.toLocaleString()}`);
  set('wiz-est-items-sub', itemSub.join(' · '));
  set('wiz-est-size', sizeKnown ? formatBytes(bytes) : (bytes ? `≥ ${formatBytes(bytes)}` : 'Unknown'));
  set('wiz-est-size-sub', sizeSub.join(' · ') || 'Sizes are not reported by this protocol before download');

  const notes = [...(d.query?.notes || [])];
  if (d.query?.unsupported?.length) notes.push(`<span style="color:var(--warning)">Not supported by ${esc(String(d.protocol).toUpperCase())} and will NOT be applied: ${esc(d.query.unsupported.join(', '))}.</span>`);
  if (d.query?.checkedAfterDownload) notes.push('Some criteria are checked after download, so the final count can be lower than this estimate.');
  set('wiz-est-query-notes', notes.map(n => (n.startsWith('<span') ? n : esc(n))).join('<br>'));

  const notice = [];
  const diffBox = document.getElementById('wiz-differential');
  if (d.rerun) {
    if (diffBox) { diffBox.checked = true; diffBox.disabled = true; }
    set('wiz-est-mode', 'Differential acquisition (required: this destination already holds this project\'s collection)');
    set('wiz-est-dest', esc(d.differentialFolder || ''));
    notice.push(`<div class="wiz-note wiz-note-info"><strong>Differential acquisition.</strong> This destination already holds a collection of this project, so this run collects only items that were not collected before (${d.previouslyCollected.toLocaleString()} already collected) and saves them in <code>${esc(d.differentialFolder || 'Differential Acquisition')}</code>. Choose a different destination in Step 2 for a separate full collection.</div>`);
  } else {
    if (diffBox) diffBox.disabled = false;
    if (d.previouslyCollected && !diffBox?.checked) {
      notice.push(`<div class="wiz-note">${d.previouslyCollected.toLocaleString()} message(s) were already collected for this project. Tick <em>Differential collection</em> in Step 2 to skip them.</div>`);
    }
  }
  if (email?.folderErrors?.length) {
    notice.push(`<div class="wiz-note wiz-note-error">${email.folderErrors.length} folder(s) could not be listed: ${email.folderErrors.map(f => `${esc(f.folder)} (${esc(f.error)})`).join('; ')}</div>`);
  }
  set('wiz-preview-notice', notice.join(''));

  if (email?.folders?.length > 1) {
    set('wiz-estimate-detail', `<details class="wiz-estimate-folders"><summary>Per-folder counts (${email.folders.length} folders)</summary>
      <table class="tracker-table"><thead><tr><th>Folder</th><th style="text-align:right">Items</th><th style="text-align:right">Size</th></tr></thead><tbody>
      ${email.folders.map(f => `<tr><td>${esc(f.folder)}</td><td style="text-align:right">${f.items.toLocaleString()}</td><td style="text-align:right">${f.bytes ? formatBytes(f.bytes) : '—'}</td></tr>`).join('')}
      </tbody></table><p class="form-hint">Per-folder counts are after de-duplication: a message filed under several Gmail labels is counted once, in its primary folder.</p></details>`);
  }
  document.getElementById('wiz-estimate-status').innerHTML = `<span style="color:var(--text-muted)">Counted ${new Date().toLocaleTimeString()}</span>`;
}

function wizFormatDuration(ms) {
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${String(secs % 60).padStart(2, '0')}s`;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}

const WIZ_FEED_MAX = 150;
const STALL_WARNING_MS = 30000;

// Live collection view: the server pushes one event per collected item (plus a snapshot each second);
// polling is a fallback. Rendering is batched to one paint per frame so fast collections stay smooth.
// `done` resolves with the final result whichever channel reports it first.
function wizStartLiveProgress(projectId, { acquisitionId, startedAt } = {}) {
  const $ = id => document.getElementById(id);
  const clientStart = startedAt || Date.now();
  const state = { p: {}, done: 0, total: 0, etaMs: null, etaAt: 0, queue: [], changeKey: '', changedAt: Date.now() };
  let frame = 0;
  let stopped = false;
  let lastRenderAt = 0;
  let resolveDone;
  const done = new Promise(r => { resolveDone = r; });
  const noteChange = () => {
    const key = `${state.done}|${state.total}|${state.p.phase}|${state.p.statusDetail || ''}|${state.p.drive?.done || 0}`;
    if (key !== state.changeKey) { state.changeKey = key; state.changedAt = Date.now(); }
  };

  $('wiz-log-output').innerHTML = '';
  $('wiz-progress-fill').classList.remove('complete');
  $('wiz-progress-fill').style.width = '0%';
  $('wiz-progress-drive').style.display = 'none';

  const schedule = () => { if (!frame && !stopped) frame = requestAnimationFrame(render); };
  const finished = (result) => {
    if (stopped) return;
    render();
    stop();
    resolveDone(result || null);
  };

  function applyProgress(p) {
    if (!p) return;
    if (acquisitionId && p.acquisitionId && p.acquisitionId !== acquisitionId) return;
    const doneNow = (p.acquired || 0) + (p.failed || 0) + (p.skipped || 0);
    if (doneNow < state.done) p = { ...p, acquired: state.p.acquired, failed: state.p.failed, skipped: state.p.skipped };
    state.p = { ...state.p, ...p };
    state.done = Math.max(state.done, doneNow);
    state.total = p.total || state.total;
    if (typeof p.estimateMs === 'number') { state.etaMs = p.estimateMs; state.etaAt = Date.now(); }
    noteChange();
    schedule();
    if (p.active === false && p.result) finished(p.result);
  }

  function feed(row) {
    state.queue.push(row);
    if (state.queue.length > WIZ_FEED_MAX) state.queue.splice(0, state.queue.length - WIZ_FEED_MAX);
    noteChange();
    schedule();
  }

  function applyItem(e) {
    const doneNow = e.acquired + e.failed + e.skipped;
    if (doneNow >= state.done) {
      Object.assign(state.p, { acquired: e.acquired, failed: e.failed, skipped: e.skipped, total: e.total, bytesDone: e.bytesDone, currentFolder: e.folder });
      if (!state.p.phase || state.p.phase === 'connecting' || state.p.phase === 'enumerating') state.p.phase = 'collecting';
      state.done = doneNow;
      state.total = e.total;
    }
    feed({ ...e, n: doneNow });
  }

  function applyDriveItem(e) {
    const status = e.status === 'downloaded' ? 'acquired' : e.status === 'failed' || e.status === 'hash_mismatch' ? 'failed' : 'skipped';
    feed({ ...e, status, label: e.status === 'hash_mismatch' ? 'HASH' : null, n: ((e.folder === 'Linked file' ? state.p.linkedFiles?.done : state.p.drive?.done) || 0) + 1 });
  }

  function phaseText(p) {
    switch (p.phase) {
      case 'connecting': return p.statusDetail || 'Connecting to mail server...';
      case 'enumerating': return `${p.statusDetail || `Counting items${p.currentFolder ? ' in ' + p.currentFolder : ''}`}... ${state.total.toLocaleString()} found`;
      case 'collecting': return p.retrying ? `Retrying ${p.retryItem || 'a failed item'}` : (p.statusDetail || `Collecting from ${p.currentFolder || 'mailbox'}`);
      case 'retrying_failed': return `Final retry pass: ${p.retryItem || p.statusDetail || 'retrying items that failed'}`;
      case 'drive': return p.statusDetail || `Collecting ${p.drive?.provider === 'onedrive' ? 'OneDrive' : 'Google Drive'} files`;
      case 'linked-files': return p.statusDetail || 'Downloading linked cloud files';
      case 'finalizing': return 'Finalizing: writing logs, hashes and timestamps...';
      case 'exporting': return p.statusDetail || 'Exporting the selected formats...';
      case 'complete': return 'Collection complete';
      case 'canceled': return 'Collection stopped';
      case 'error': return 'Collection failed';
      default: return 'Connecting to mail server...';
    }
  }

  function render() {
    frame = 0;
    lastRenderAt = Date.now();
    const p = state.p;
    const driveOnly = p.scope === 'drive' && p.drive;
    const total = driveOnly ? p.drive.total : state.total;
    const doneRaw = driveOnly ? p.drive.done : state.done;
    const doneNow = total ? Math.min(doneRaw, total) : doneRaw;
    const pct = total ? (doneNow / total) * 100 : 0;
    $('wiz-progress-fill').style.width = `${pct.toFixed(2)}%`;
    $('wiz-progress-done').textContent = doneNow.toLocaleString();
    $('wiz-progress-total').textContent = total.toLocaleString();
    $('wiz-progress-pct').textContent = total ? `${pct < 10 ? pct.toFixed(1) : Math.floor(pct)}%` : '';
    $('wiz-progress-rate').textContent = p.itemsPerSec ? `${p.itemsPerSec.toLocaleString()} items/s · ${formatBytes(p.bytesPerSec || 0)}/s` : '';
    $('wiz-progress-label').textContent = phaseText(p);

    if (p.drive) {
      const d = p.drive;
      const driveName = d.provider === 'onedrive' ? 'OneDrive' : 'Google Drive';
      $('wiz-progress-drive').style.display = '';
      $('wiz-progress-drive').textContent = d.phase === 'listing'
        ? `${driveName}: listing files…`
        : `${driveName}: ${d.done.toLocaleString()} of ${d.total.toLocaleString()} files · ${formatBytes(d.bytes || 0)}${d.totalBytes ? ` of ~${formatBytes(d.totalBytes)}` : ''} · ${d.verified} verified against the provider checksum${d.mismatched ? ` · ${d.mismatched} MISMATCHED` : ''}${d.failed ? ` · ${d.failed} failed` : ''}`;
    }

    const ofTotal = p.totalBytesEstimate ? ` <small>of ~${formatBytes(p.totalBytesEstimate)}</small>` : '';
    $('wiz-progress-stats').innerHTML = `
      <div class="wiz-stat"><span>Acquired</span><strong>${(p.acquired || 0).toLocaleString()}</strong></div>
      <div class="wiz-stat"><span>Failed</span><strong style="${p.failed > 0 ? 'color:var(--danger)' : ''}">${(p.failed || 0).toLocaleString()}</strong></div>
      <div class="wiz-stat"><span>Skipped</span><strong>${(p.skipped || 0).toLocaleString()}</strong>${p.excluded ? `<small>${p.excluded.toLocaleString()} by query</small>` : ''}</div>
      <div class="wiz-stat"><span>Downloaded</span><strong>${formatBytes(p.bytesDone || 0)}${ofTotal}</strong></div>
      <div class="wiz-stat"><span>Connections</span><strong>${p.connections || '-'}${p.workers > p.connections ? ` × ${p.workers}` : ''}</strong></div>
      <div class="wiz-stat"><span>Elapsed</span><strong id="wiz-elapsed">${wizFormatDuration(Date.now() - (p.startedAt || clientStart))}</strong></div>`;

    if (state.queue.length) {
      const feedEl = $('wiz-log-output');
      const frag = document.createDocumentFragment();
      for (let i = state.queue.length - 1; i >= 0; i--) {
        const e = state.queue[i];
        const row = document.createElement('div');
        row.className = `wiz-feed-row ${e.status === 'excluded' ? 'skipped' : e.status}`;
        const status = e.label || (e.status === 'acquired' ? 'OK' : e.status === 'skipped' ? 'SKIP' : e.status === 'excluded' ? 'EXCL' : 'FAIL');
        const text = e.status === 'failed' ? `${e.uid != null ? `#${e.uid}: ` : `${e.subject || ''}: `}${e.error || 'failed'}` : (e.subject || '(no subject)');
        row.innerHTML = `<span class="n">${e.n.toLocaleString()}</span><span class="st">${status}</span><span class="fd">${esc(e.folder)}</span><span class="sj">${esc(text)}</span><span class="sz">${e.size ? formatBytes(e.size) : ''}</span>`;
        frag.appendChild(row);
      }
      state.queue = [];
      feedEl.prepend(frag);
      while (feedEl.childElementCount > WIZ_FEED_MAX) feedEl.lastElementChild.remove();
    }
    tick();
  }

  function tick() {
    // Chromium suspends requestAnimationFrame when it thinks the window is hidden or covered
    // (seen on some remote-desktop and multi-monitor setups); paint from the timer instead.
    if (frame && Date.now() - lastRenderAt > 500) {
      cancelAnimationFrame(frame);
      render();
      return;
    }
    const p = state.p;
    const hintEl = $('wiz-progress-hint');
    const stalledMs = Date.now() - state.changedAt;
    if (hintEl) {
      const active = !p.phase || ['connecting', 'enumerating', 'collecting', 'drive', 'linked-files'].includes(p.phase);
      hintEl.textContent = active && stalledMs > STALL_WARNING_MS
        ? `No progress for ${wizFormatDuration(stalledMs)}. ${p.statusDetail || 'Still waiting for the server'}.`
          + (p.lastError ? ` Last error: ${p.lastError}.` : '')
          + (p.liveLogFile ? ` Details are being written to ${p.liveLogFile}` : '')
        : '';
    }
    const etaEl = $('wiz-progress-eta');
    const finishEl = $('wiz-progress-finish');
    if (p.phase === 'collecting' && state.etaMs != null) {
      const left = Math.max(0, state.etaMs - (Date.now() - state.etaAt));
      etaEl.textContent = `${wizFormatDuration(left)} remaining`;
      finishEl.textContent = `Finishes around ${new Date(Date.now() + left).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    } else if (['finalizing', 'exporting', 'retrying_failed'].includes(p.phase)) {
      etaEl.textContent = 'Almost done';
      finishEl.textContent = '';
    } else if (!p.phase || ['connecting', 'enumerating', 'collecting', 'drive', 'linked-files'].includes(p.phase)) {
      etaEl.textContent = 'Estimating time remaining...';
      finishEl.textContent = '';
    }
    const elapsedEl = $('wiz-elapsed');
    if (elapsedEl) elapsedEl.textContent = wizFormatDuration(Date.now() - (p.startedAt || clientStart));
  }

  let es = null;
  try {
    es = new EventSource(`/api/projects/${projectId}/collect/events`);
    es.onmessage = ev => {
      try {
        const d = JSON.parse(ev.data);
        if (d.type === 'item') applyItem(d);
        else if (d.type === 'drive-item') applyDriveItem(d);
        else if (d.type === 'complete' || d.type === 'failed') {
          if (!acquisitionId || !d.result?.acquisitionId || d.result.acquisitionId === acquisitionId) finished(d.result);
        } else applyProgress(d.progress);
      } catch (_) {}
    };
  } catch (_) {}
  const poll = setInterval(async () => {
    try {
      const p = await api(`/projects/${projectId}/collect/progress`);
      if (p && p.active !== undefined) applyProgress(p);
    } catch (_) {}
  }, 1000);
  const ticker = setInterval(tick, 250);
  render();

  function stop() {
    stopped = true;
    es?.close();
    clearInterval(poll);
    clearInterval(ticker);
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    const hintEl = $('wiz-progress-hint');
    if (hintEl) hintEl.textContent = '';
  }

  return { done, stop, state };
}

function wizCompletionLabel(result) {
  const labels = {
    completed_without_errors: 'Completed Without Errors',
    completed_with_errors_download_complete: 'Completed With Errors (Download Complete)',
    completed_with_errors_remaining_items: 'Completed With Errors (Remaining Items)',
    completed_with_verification_warnings: 'Completed (Drive verification warnings)',
    no_items_found: 'No Items Found',
    canceled: 'Stopped Before Completion',
    fatal_error: 'Failed',
    interrupted: 'Interrupted',
  };
  return labels[result?.completionType] || result?.status || 'Completed';
}

async function wizStartCollection() {
  if (!currentProject) { toast('Select a project first'); return; }
  if (wizCollecting) { toast('A collection is already running for this project'); return; }

  wizSaveConnection();
  wizSelectedFolders = wizGetSelectedFolders();
  const q = wizReadQuery();
  if (q.error) { toast(q.error); return; }
  if (!wizCheckScope()) return;
  wizEstimateCtl?.abort();

  const project = currentProject;
  wizOutputDir = (document.getElementById('wiz-output-dir').value || '').trim();
  const body = {
    ...wizCollectBody(),
    exportFormats: wizSelectedFormats(),
    pdfSplitMode: document.getElementById('wiz-pdf-split-mode')?.value || 'thread',
    pstMaxGb: Number(document.getElementById('wiz-pst-size')?.value) || 10,
  };
  const status = document.getElementById('wiz-estimate-status');
  const nextBtn = document.getElementById('wiz-btn-next');
  nextBtn.disabled = true;
  status.innerHTML = '<span style="color:var(--accent)">Starting collection…</span>';

  try {
    if (wizConnection.protocol && project.provider_type !== wizConnection.protocol) {
      await api(`/projects/${project.id}`, { method: 'PUT', body: { provider_type: wizConnection.protocol } });
      project.provider_type = wizConnection.protocol;
    }
    const started = await api(`/projects/${project.id}/collect`, { method: 'POST', body });
    status.innerHTML = '';
    wizAttachToCollection(project, { started });
    pollActiveCollections();
  } catch (err) {
    status.innerHTML = `<span class="verify-fail">Could not start the collection: ${esc(err.message)}</span>`;
    toast(`Could not start the collection: ${err.message}`);
  } finally {
    nextBtn.disabled = false;
  }
}

function wizAttachToCollection(project, { started, progress } = {}) {
  const acquisitionId = started?.acquisitionId || progress?.acquisitionId || null;
  wizCollecting = { projectId: project.id, projectName: project.name, acquisitionId };
  wizPrefilledProjectId = project.id;
  wizGoToStep(6);
  const stopBtn = document.getElementById('wiz-stop-btn');
  stopBtn.disabled = false;
  stopBtn.textContent = 'Stop Collection';
  document.getElementById('wiz-progress-errors').innerHTML = '';
  const where = started?.sessionDir || progress?.sessionDir || '';
  const diff = started?.differentialFolder || progress?.differentialFolder;
  const scope = started?.scope || progress?.scope || 'email';
  document.getElementById('wiz-progress-target').innerHTML = `
    <strong>${esc(project.name)}</strong> · ${esc({ email: 'Email', drive: 'Drive / Cloud', both: 'Email + Drive / Cloud' }[scope] || scope)}
    ${(started?.differential || progress?.differential) ? ' · <span class="wiz-badge">Differential</span>' : ''}
    ${where ? `<div class="wiz-progress-path">Saving to <code>${esc(where)}</code>${diff ? ' (Differential Acquisition folder)' : ''}</div>` : ''}
    ${started?.query?.unsupported?.length ? `<div class="wiz-note wiz-note-error" style="margin-top:6px">Not supported by this protocol and not applied: ${esc(started.query.unsupported.join(', '))}</div>` : ''}`;

  wizLive?.stop();
  const live = wizStartLiveProgress(project.id, { acquisitionId, startedAt: progress?.startedAt });
  wizLive = live;
  wizUpdateUnloadGuard();
  live.done.then(result => wizCollectionFinished(project, result, live));
}

function wizCollectionFinished(project, result, live) {
  if (wizLive === live) wizLive = null;
  if (wizCollecting?.projectId === project.id) wizCollecting = null;
  wizUpdateUnloadGuard();
  pollActiveCollections();
  loadSystemInfo();
  if (!result) return;
  wizLastResult = result;

  const label = wizCompletionLabel(result);
  const viewing = currentProject?.id === project.id && wizStep === 6;
  if (!viewing) {
    wizUnseenResults.set(project.id, result);
    toast(`Collection for "${project.name}" finished: ${label}`);
    return;
  }

  const fill = document.getElementById('wiz-progress-fill');
  if (!result.canceled && !result.error) {
    fill.style.width = '100%';
    fill.classList.add('complete');
  }
  document.getElementById('wiz-progress-eta').textContent = result.error ? 'Failed' : result.canceled ? 'Stopped' : 'Done';
  document.getElementById('wiz-progress-finish').textContent = '';
  document.getElementById('wiz-progress-label').innerHTML = result.error
    ? `<span class="verify-fail">Collection failed: ${esc(result.error)}</span>`
    : esc(label + (result.failedCount ? ` — ${result.failedCount} failed` : ''));
  document.getElementById('wiz-stop-btn').disabled = true;

  setTimeout(() => {
    if (currentProject?.id !== project.id) { wizUnseenResults.set(project.id, result); return; }
    wizShowResults(result);
    wizGoToStep(7);
    loadMessages();
    loadFolders();
  }, 1200);
}

async function wizStopCollection() {
  if (!wizCollecting) return;
  if (!confirm('Stop this collection?\n\nWhat has been collected so far is kept, hashed and logged, and the acquisition is recorded as stopped. The remaining items can be collected later by starting again into the same destination (a differential acquisition).')) return;
  const btn = document.getElementById('wiz-stop-btn');
  btn.disabled = true;
  btn.textContent = 'Stopping…';
  try {
    await api(`/projects/${wizCollecting.projectId}/collect/cancel`, { method: 'POST' });
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Stop Collection';
    toast(`Could not stop the collection: ${err.message}`);
  }
}

function wizShowResults(result) {
  wizLastResult = result;
  wizSessionDir = result.sessionDir || '';
  const el = document.getElementById('wiz-results-content');
  const completionLabel = wizCompletionLabel(result);
  const stat = (label, value, style = '') => `<div class="stat-card"><div class="stat-label">${label}</div><div class="stat-value" style="${style}">${value}</div></div>`;
  const drive = result.drive;

  el.innerHTML = `
    ${result.error ? `<div class="wiz-note wiz-note-error"><strong>Collection failed:</strong> ${esc(result.error)}</div>` : ''}
    ${result.canceled ? `<div class="wiz-note wiz-note-error"><strong>Stopped before completion</strong>${result.cancelReason ? ` (${esc(result.cancelReason)})` : ''}. ${Number(result.remainingCount || 0).toLocaleString()} item(s) were not collected. Use Back, then Start Collection, to collect them as a differential acquisition into the same destination.</div>` : ''}
    ${result.differentialFolder ? `<div class="wiz-note wiz-note-info">Differential acquisition: only items not collected before were downloaded, into <code>${esc(result.differentialFolder)}</code>.</div>` : ''}
    <div class="stats-grid">
      ${stat('Messages Acquired', Number(result.messageCount || 0).toLocaleString())}
      ${stat('Skipped (already collected)', Number(result.skippedCount || 0).toLocaleString())}
      ${result.excludedCount ? stat('Excluded by Query', Number(result.excludedCount).toLocaleString()) : ''}
      ${stat('Failed', Number(result.failedCount || 0).toLocaleString(), result.failedCount ? 'color:var(--danger)' : '')}
      ${stat('Total Size', formatBytes(result.totalBytes || 0), 'font-size:20px')}
      ${stat('Status', esc(completionLabel), 'font-size:14px')}
    </div>
    ${result.recoveredOnRetry ? `<div class="wiz-note" style="margin-top:12px">${result.recoveredOnRetry} item(s) that failed during the run were recovered by the final retry pass.</div>` : ''}
    ${result.duplicatesMerged ? `
      <div style="margin-top:12px;font-size:12px;color:var(--text-secondary)">
        ${result.duplicatesMerged} copies of messages that appear under more than one Gmail label or folder were merged:
        each message was collected once, and every folder and label it belongs to is recorded with it.
      </div>` : ''}
    ${result.query ? `
      <div class="wiz-result-block">
        <div class="wiz-result-title">Query</div>
        <div>${esc(result.query.description)}</div>
        ${result.query.inlineMatchCount != null ? `<div style="margin-top:4px"><strong>${result.query.inlineMatchCount.toLocaleString()}</strong> of ${Number(result.messageCount || 0).toLocaleString()} collected message(s) match (listed in <code>query_matches_*.csv</code>).</div>` : ''}
        ${result.excludedCount ? `<div style="margin-top:4px">${result.excludedCount.toLocaleString()} downloaded message(s) did not match and were not kept; each is listed with its hash in <code>query_excluded_items_*.csv</code>.</div>` : ''}
        ${result.query.unsupported?.length ? `<div style="margin-top:4px;color:var(--warning)">Not applied (not supported by this protocol): ${esc(result.query.unsupported.join(', '))}</div>` : ''}
      </div>` : ''}
    ${drive ? `
      <div class="wiz-result-block">
        <div class="wiz-result-title">${esc(drive.label)}</div>
        <div>${drive.stats.downloaded.toLocaleString()} of ${drive.stats.total.toLocaleString()} file(s) downloaded (${formatBytes(drive.stats.bytes)}): ${drive.stats.verified.toLocaleString()} verified against the provider's checksum${drive.stats.mismatched ? `, <span style="color:var(--danger)">${drive.stats.mismatched} did not match</span>` : ''}${drive.stats.failed ? `, <span style="color:var(--danger)">${drive.stats.failed} failed</span>` : ''}${drive.stats.skipped ? `, ${drive.stats.skipped} skipped` : ''}.</div>
        <div style="margin-top:4px"><code>${esc(drive.root)}</code></div>
      </div>` : ''}
    ${result.attachmentFiles ? `
      <div class="wiz-result-block">
        <div class="wiz-result-title">Attachment files</div>
        <div>${result.attachmentFiles.saved.toLocaleString()} attachment(s) saved as separate files beside their emails, each read back and matched to the hash recorded from the email${result.attachmentFiles.mismatched ? `; <span style="color:var(--danger)">${result.attachmentFiles.mismatched} did not match</span>` : ''}${result.attachmentFiles.failed ? `; <span style="color:var(--danger)">${result.attachmentFiles.failed} could not be saved</span>` : ''}.</div>
        ${result.attachmentFiles.manifest ? `<div style="margin-top:4px">Listed in <code>${esc(result.attachmentFiles.manifest)}</code></div>` : ''}
      </div>` : ''}
    ${result.linkedFiles ? wizLinkedFilesBlock(result.linkedFiles) : ''}
    ${result.exports?.length ? `
      <div class="wiz-result-block">
        <div class="wiz-result-title">Automatic Export</div>
        ${result.exports.map(x => x.success
          ? `<div><span class="verify-pass">${esc(x.format.toUpperCase())}</span> ${x.files} file(s), ${formatBytes(x.totalBytes)} → <code>${esc(x.outputDir)}</code>${x.reconstructed ? ` <span style="color:var(--warning)">(${x.reconstructed} reconstructed: original file missing or altered)</span>` : ''}</div>`
          : `<div><span class="verify-fail">${esc(x.format.toUpperCase())} failed</span> ${esc(x.error)}</div>`).join('')}
      </div>` : ''}
    ${result.sessionDir ? `
      <div class="wiz-result-block">
        <div class="wiz-result-title">Session Output</div>
        ${result.mimeOutputDir ? `<div><span style="color:var(--text-muted)">MIME:</span> <code>${esc(result.mimeOutputDir)}</code></div>` : ''}
        ${result.logsDir ? `<div><span style="color:var(--text-muted)">Logs:</span> <code>${esc(result.logsDir)}</code></div>` : ''}
        ${result.logFiles?.length ? `<div style="font-size:11px;color:var(--text-secondary);margin-top:4px">${result.logFiles.map(esc).join(', ')}</div>` : ''}
      </div>` : ''}
    ${result.timestamp ? `
      <div class="wiz-result-block">
        <div class="wiz-result-title">Collection Timestamp</div>
        <div style="font-family:var(--font-mono);font-size:12px;color:var(--accent)">${esc(result.timestamp)}</div>
      </div>` : ''}
  `;

  const transferSrc = document.getElementById('wiz-transfer-source');
  if (transferSrc) transferSrc.value = result.destinationDir || result.sessionDir || '';

  const errEl = document.getElementById('wiz-results-errors');
  const statusColor = result.error || result.canceled ? 'var(--danger)' : result.failedCount > 0 ? 'var(--warning)' : 'var(--success)';
  errEl.innerHTML = `<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
    <p style="color:${statusColor};font-weight:600;margin:0">${esc(completionLabel)}</p>
    ${result.sessionDir ? `<button class="btn btn-secondary" onclick="wizOpenOutputFolder()" style="white-space:nowrap;padding:6px 14px;font-size:13px">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;vertical-align:middle;margin-right:4px"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
      Open Session Folder
    </button>` : ''}
  </div>
  ${result.errors?.length ? `<details style="margin-top:8px"><summary style="cursor:pointer;color:var(--danger);font-size:13px">${result.errors.length} error(s) during collection</summary>
    <ul style="font-size:12px;margin:8px 0;max-height:200px;overflow:auto">${result.errors.map(e => `<li>${esc(e.folder || e.type || '')} — ${esc(e.error)}</li>`).join('')}</ul>
  </details>` : ''}`;
}

function wizLinkedFilesBlock(lf) {
  if (lf.error) return `<div class="wiz-result-block"><div class="wiz-result-title">Linked cloud files</div><div style="color:var(--danger)">Could not be processed: ${esc(lf.error)}</div></div>`;
  const s = lf.stats;
  if (!s.found) return `<div class="wiz-result-block"><div class="wiz-result-title">Linked cloud files</div><div>No Google Drive, OneDrive, SharePoint, Dropbox or Box links in the collected messages.</div></div>`;
  const accounts = Object.entries(s.accounts || {}).map(([k, v]) => `${k === 'google' ? 'Google' : 'Microsoft'}: ${esc(v)}`).join('; ');
  return `<div class="wiz-result-block">
    <div class="wiz-result-title">Linked cloud files</div>
    <div>${s.found.toLocaleString()} linked file(s) found. ${s.downloaded.toLocaleString()} downloaded (${formatBytes(s.bytes || 0)}), ${s.verified.toLocaleString()} verified against the provider's checksum${s.mismatched ? `, <span style="color:var(--danger)">${s.mismatched} did not match</span>` : ''}${s.failed ? `, <span style="color:var(--danger)">${s.failed} failed</span>` : ''}; ${s.notDownloaded.toLocaleString()} not downloaded.</div>
    ${accounts ? `<div style="margin-top:4px;color:var(--text-secondary)">Opened with ${accounts}</div>` : ''}
    ${lf.folder ? `<div style="margin-top:4px"><code>${esc(lf.folder)}</code></div>` : ''}
    ${lf.notDownloaded?.length ? `<details style="margin-top:8px"><summary style="cursor:pointer">Why ${lf.notDownloaded.length === 1 ? 'one link was' : `${lf.notDownloaded.length} links were`} not downloaded</summary>
      <ul style="font-size:13px;margin:8px 0 0 18px">${lf.notDownloaded.map(n => `<li><strong>${esc(n.provider)}</strong> <code>${esc(n.url)}</code>: ${esc(n.reason)}</li>`).join('')}</ul>
    </details>` : ''}
    ${lf.manifest ? `<div style="margin-top:4px">Every link, with the messages it came from: <code>${esc(lf.manifest)}</code></div>` : ''}
  </div>`;
}

async function wizOpenOutputFolder() {
  const folderPath = wizSessionDir || wizOutputDir;
  if (!folderPath) { toast('No output folder yet'); return; }
  try {
    await api('/open-folder', { method: 'POST', body: { path: folderPath } });
  } catch (err) {
    toast('Could not open folder: ' + err.message);
  }
}

async function wizExport() {
  if (!currentProject) { toast('Select a project first'); return; }
  const format = document.getElementById('wiz-export-format')?.value;
  if (!format) return;
  const statusEl = document.getElementById('wiz-export-status');
  if (statusEl) statusEl.innerHTML = '<span style="color:var(--accent)">Exporting...</span>';
  const outputDir = wizOutputDir || '';

  try {
    const body = { format };
    if (outputDir) body.outputDir = outputDir;
    if (format === 'pdf') body.pdfSplitMode = document.getElementById('wiz-pdf-split-mode')?.value || 'thread';
    if (format === 'pst') body.pstMaxGb = Number(document.getElementById('wiz-pst-size')?.value) || 10;
    const result = await api(`/projects/${currentProject.id}/export`, { method: 'POST', body });
    if (statusEl) statusEl.innerHTML = '<span class="verify-pass">Export complete</span>';
    const el = document.getElementById('wiz-export-result');
    if (el) el.innerHTML = `
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-label">Format</div><div class="stat-value" style="font-size:18px">${result.format?.toUpperCase()}</div></div>
        <div class="stat-card"><div class="stat-label">Files</div><div class="stat-value">${result.files?.length || 0}</div></div>
        <div class="stat-card"><div class="stat-label">Size</div><div class="stat-value" style="font-size:18px">${formatBytes(result.totalBytes)}</div></div>
      </div>`;
    loadSystemInfo();
    return result;
  } catch (err) {
    if (statusEl) statusEl.innerHTML = `<span class="verify-fail">Export failed: ${esc(err.message)}</span>`;
    return null;
  }
}

function wizToggleZipOptions() {
  const mode = document.getElementById('wiz-transfer-mode').value;
  document.getElementById('wiz-zip-options').style.display = mode === 'zipped' ? '' : 'none';
}

async function wizTransfer() {
  const src = document.getElementById('wiz-transfer-source').value;
  const dest = document.getElementById('wiz-transfer-dest').value;
  if (!dest) { toast('Enter a destination directory'); return; }
  if (!src) { toast('No source directory — run collection first'); return; }

  const mode = document.getElementById('wiz-transfer-mode').value;
  const zipPassword = document.getElementById('wiz-zip-password')?.value || '';
  const statusEl = document.getElementById('wiz-transfer-status');
  const resultEl = document.getElementById('wiz-transfer-result');
  statusEl.innerHTML = `<span style="color:var(--accent)">${mode === 'zipped' ? 'Creating and testing the archive…' : 'Copying, then verifying every file by SHA-256…'}</span>`;
  resultEl.innerHTML = '';

  const renderLog = (log) => log?.length
    ? `<details style="margin-top:12px"><summary style="cursor:pointer;font-size:13px">Transfer Log</summary><pre style="font-size:11px;max-height:200px;overflow:auto;margin:8px 0;padding:8px;background:var(--bg-raised);border-radius:var(--radius)">${esc(log.join('\n'))}</pre></details>`
    : '';

  try {
    const res = await fetch(`/api/projects/${currentProject.id}/transfer`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: src, destination: dest, mode, zipPassword: mode === 'zipped' ? zipPassword : undefined }),
    });
    const result = await res.json().catch(() => ({ error: res.statusText }));
    if (!res.ok) {
      statusEl.innerHTML = `<span class="verify-fail">Transfer failed: ${esc(result.error || 'Unknown error')}</span>`;
      resultEl.innerHTML = renderLog(result.log);
      return;
    }

    statusEl.innerHTML = `<span class="verify-pass">${result.verification ? 'Transfer complete and verified' : 'Archive created and tested'}</span>`;
    let html = '<div class="stats-grid">';
    if (result.filesCopied !== undefined) html += `<div class="stat-card"><div class="stat-label">Files Copied</div><div class="stat-value">${result.filesCopied}</div></div>`;
    if (result.verification) html += `<div class="stat-card"><div class="stat-label">Verified (SHA-256)</div><div class="stat-value">${result.verification.verified} / ${result.verification.files}</div></div>`;
    if (result.totalBytes !== undefined) html += `<div class="stat-card"><div class="stat-label">Size</div><div class="stat-value" style="font-size:18px">${formatBytes(result.totalBytes)}</div></div>`;
    if (result.archivePath) html += `<div class="stat-card"><div class="stat-label">Archive</div><div class="stat-value" style="font-size:13px;word-break:break-all">${esc(result.archivePath)}</div></div>`;
    if (result.encrypted) html += `<div class="stat-card"><div class="stat-label">Encrypted</div><div class="stat-value">AES-256</div></div>`;
    html += '</div>';
    if (result.verification?.reportPath) html += `<p class="form-hint" style="margin-top:8px">Verification report: <code>${esc(result.verification.reportPath)}</code></p>`;
    if (result.archiveSha256) html += `<p class="form-hint" style="margin-top:8px">Archive SHA-256: <code>${esc(result.archiveSha256)}</code></p>`;
    resultEl.innerHTML = html + renderLog(result.log);
  } catch (err) {
    statusEl.innerHTML = `<span class="verify-fail">Transfer failed: ${esc(err.message)}</span>`;
  }
}

// keepConnection: finishing the wizard keeps the connection settings for another run on the same project.
function wizResetState({ keepConnection = false } = {}) {
  wizEstimateCtl?.abort();
  wizEstimate = null;
  wizEstimateKey = '';
  wizFolders = [];
  wizSelectedFolders = [];
  wizOutputDir = '';
  wizSessionDir = '';
  wizLastResult = null;
  const fill = document.getElementById('wiz-progress-fill');
  if (fill) { fill.style.width = '0%'; fill.classList.remove('complete'); }
  const lastResult = document.getElementById('wiz-last-result');
  if (lastResult) { lastResult.style.display = 'none'; lastResult.innerHTML = ''; lastResult._result = null; }
  for (const id of ['wiz-results-content', 'wiz-results-errors', 'wiz-transfer-result', 'wiz-transfer-status', 'wiz-preview-notice', 'wiz-estimate-detail', 'wiz-estimate-status']) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '';
  }
  const diffBox = document.getElementById('wiz-differential');
  if (diffBox) diffBox.disabled = false;
  if (keepConnection) return;
  const foldersEl = document.getElementById('wiz-folders-list');
  if (foldersEl) foldersEl.innerHTML = '<div style="padding:20px;color:var(--text-muted)">Connect and load folders in Step 4.</div>';
  const filter = document.getElementById('wiz-folder-filter');
  if (filter) filter.value = '';
  wizUpdateFolderSummary();
  for (const id of ['wiz-output-dir', 'wiz-transfer-dest', 'wiz-transfer-source']) {
    const el = document.getElementById(id);
    if (el) el.value = '';
  }
  if (diffBox) diffBox.checked = false;
  wizClearQuery();
}

// --- Guide ---
function guideScroll(id) {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function guideSearch(query) {
  const resultsDiv = document.getElementById('guide-search-results');
  const container = document.querySelector('.guide-container');
  const sections = container.querySelectorAll('.guide-section');
  const toc = container.querySelector('.guide-toc');

  container.querySelectorAll('.guide-search-highlight').forEach(el => {
    el.replaceWith(el.textContent);
  });
  sections.forEach(s => s.style.display = '');

  if (!query || query.trim().length < 2) {
    resultsDiv.style.display = 'none';
    if (toc) toc.style.display = '';
    return;
  }

  const term = query.trim().toLowerCase();
  const matches = [];

  sections.forEach(sec => {
    const text = sec.textContent.toLowerCase();
    if (text.includes(term)) {
      matches.push(sec);
      sec.style.display = '';
      highlightText(sec, query.trim());
    } else {
      sec.style.display = 'none';
    }
  });

  if (toc) toc.style.display = matches.length < sections.length ? 'none' : '';

  if (matches.length === 0) {
    resultsDiv.innerHTML = `No results for "<strong>${escapeHtml(query)}</strong>"`;
    resultsDiv.style.display = 'block';
  } else {
    resultsDiv.innerHTML = `${matches.length} section${matches.length !== 1 ? 's' : ''} matching "<strong>${escapeHtml(query)}</strong>"`;
    resultsDiv.style.display = 'block';
  }
}

function highlightText(node, term) {
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  const regex = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  textNodes.forEach(tn => {
    if (regex.test(tn.textContent)) {
      const span = document.createElement('span');
      span.innerHTML = tn.textContent.replace(regex, '<mark class="guide-search-highlight" style="background:#fbbf24;color:#000;padding:0 2px;border-radius:2px">$1</mark>');
      tn.replaceWith(span);
    }
  });
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
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

function toast(msg, { error = /fail|error|required|could not|cannot|invalid/i.test(String(msg)) } = {}) {
  const el = document.createElement('div');
  el.className = error ? 'toast toast-error' : 'toast';
  el.setAttribute('role', error ? 'alert' : 'status');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), error ? 6000 : 3500);
}

// An inline error under a field, announced to screen readers; cleared when the field changes.
function fieldError(inputId, message) {
  const input = document.getElementById(inputId);
  if (!input) { toast(message, { error: true }); return; }
  const group = input.closest('.form-group') || input.parentElement;
  let el = group.querySelector('.field-error');
  if (!el) {
    el = document.createElement('div');
    el.className = 'field-error';
    el.id = `${inputId}-error`;
    el.setAttribute('aria-live', 'polite');
    group.appendChild(el);
  }
  el.textContent = message;
  input.setAttribute('aria-invalid', 'true');
  input.setAttribute('aria-describedby', el.id);
  input.focus();
  input.addEventListener('input', () => { el.textContent = ''; input.removeAttribute('aria-invalid'); }, { once: true });
}

// --- Gmail OAuth ---
async function gmailCheckStatus() {
  const el = document.getElementById('gmail-oauth-status');
  try {
    const status = await api('/oauth/google/status');
    if (!status.configured) {
      el.innerHTML = '<span style="color:var(--warning)">Not configured — upload client_secret JSON below</span>';
    } else if (!status.authorized) {
      el.innerHTML = '<span style="color:var(--warning)">Credentials loaded. Click "Authorize with Google" to connect.</span>';
    } else {
      el.innerHTML = '<span class="verify-pass">Authorized with Google</span>';
    }
  } catch {
    el.innerHTML = '<span class="verify-fail">Could not check OAuth status</span>';
  }
}

async function gmailAuthorize() {
  const el = document.getElementById('gmail-oauth-status');
  el.innerHTML = '<span style="color:var(--accent)">Opening Google authorization...</span>';

  try {
    const { url } = await api('/oauth/google/authorize');
    if (!url) { el.innerHTML = '<span class="verify-fail">Upload credentials first</span>'; return; }

    window.open(url, '_blank');
    el.innerHTML = '<span style="color:var(--accent)">Waiting for authorization in browser...</span>';

    const result = await api('/oauth/google/wait');
    if (result.success) {
      el.innerHTML = '<span class="verify-pass">Authorized with Google</span>';
      toast('Google account authorized successfully');
    } else {
      el.innerHTML = `<span class="verify-fail">Authorization failed: ${esc(result.error || 'Unknown')}</span>`;
    }
  } catch (err) {
    el.innerHTML = `<span class="verify-fail">Error: ${esc(err.message)}</span>`;
  }
}

async function gmailRevoke() {
  try {
    await api('/oauth/google/revoke', { method: 'POST' });
    toast('Google access revoked');
    gmailCheckStatus();
  } catch (err) {
    toast('Failed to revoke: ' + err.message);
  }
}

async function gmailUploadCredentials(input) {
  const file = input.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    const json = JSON.parse(text);
    await api('/oauth/google/credentials', { method: 'POST', body: json });
    toast('Google credentials uploaded');
    gmailCheckStatus();
  } catch (err) {
    toast('Failed to upload credentials: ' + err.message);
  }
  input.value = '';
}

// --- Microsoft OAuth ---
async function msCheckStatus() {
  const el = document.getElementById('ms-oauth-status');
  try {
    const status = await api('/oauth/microsoft/status');
    if (!status.configured) {
      el.innerHTML = '<span style="color:var(--warning)">Not configured — enter Client ID and Secret below</span>';
    } else if (!status.authorized) {
      el.innerHTML = '<span style="color:var(--warning)">Credentials saved. Click "Authorize with Microsoft" to connect.</span>';
    } else {
      el.innerHTML = '<span class="verify-pass">Authorized with Microsoft</span>';
    }
  } catch {
    el.innerHTML = '<span class="verify-fail">Could not check OAuth status</span>';
  }
}

async function msAuthorize() {
  const el = document.getElementById('ms-oauth-status');
  el.innerHTML = '<span style="color:var(--accent)">Opening Microsoft authorization...</span>';

  try {
    const { url } = await api('/oauth/microsoft/authorize');
    if (!url) { el.innerHTML = '<span class="verify-fail">Save credentials first</span>'; return; }

    window.open(url, '_blank');
    el.innerHTML = '<span style="color:var(--accent)">Waiting for authorization in browser...</span>';

    const result = await api('/oauth/microsoft/wait');
    if (result.success) {
      el.innerHTML = '<span class="verify-pass">Authorized with Microsoft</span>';
      toast('Microsoft account authorized successfully');
    } else {
      el.innerHTML = `<span class="verify-fail">Authorization failed: ${esc(result.error || 'Unknown')}</span>`;
    }
  } catch (err) {
    el.innerHTML = `<span class="verify-fail">Error: ${esc(err.message)}</span>`;
  }
}

async function msRevoke() {
  try {
    await api('/oauth/microsoft/revoke', { method: 'POST' });
    toast('Microsoft access revoked');
    msCheckStatus();
  } catch (err) {
    toast('Failed to revoke: ' + err.message);
  }
}

async function msSaveCredentials() {
  const clientId = document.getElementById('ms-client-id').value.trim();
  const clientSecret = document.getElementById('ms-client-secret').value.trim();
  if (!clientId || !clientSecret) { toast('Enter both Client ID and Client Secret'); return; }

  try {
    await api('/oauth/microsoft/credentials', {
      method: 'POST',
      body: { client_id: clientId, client_secret: clientSecret },
    });
    toast('Microsoft credentials saved');
    msCheckStatus();
  } catch (err) {
    toast('Failed to save credentials: ' + err.message);
  }
}

// --- Zoho OAuth ---
async function zohoCheckStatus() {
  const el = document.getElementById('zoho-oauth-status');
  try {
    const status = await api('/oauth/zoho/status');
    if (!status.configured) {
      el.innerHTML = '<span style="color:var(--warning)">Not configured — enter Client ID and Secret below</span>';
    } else if (!status.authorized) {
      el.innerHTML = '<span style="color:var(--warning)">Credentials saved. Click "Authorize with Zoho" to connect.</span>';
    } else {
      el.innerHTML = '<span class="verify-pass">Authorized with Zoho</span>';
    }
  } catch {
    el.innerHTML = '<span class="verify-fail">Could not check OAuth status</span>';
  }
}

async function zohoAuthorize() {
  const el = document.getElementById('zoho-oauth-status');
  el.innerHTML = '<span style="color:var(--accent)">Opening Zoho authorization...</span>';

  try {
    const { url } = await api('/oauth/zoho/authorize');
    if (!url) { el.innerHTML = '<span class="verify-fail">Save credentials first</span>'; return; }

    window.open(url, '_blank');
    el.innerHTML = '<span style="color:var(--accent)">Waiting for authorization in browser...</span>';

    const result = await api('/oauth/zoho/wait');
    if (result.success) {
      el.innerHTML = '<span class="verify-pass">Authorized with Zoho</span>';
      toast('Zoho account authorized successfully');
    } else {
      el.innerHTML = `<span class="verify-fail">Authorization failed: ${esc(result.error || 'Unknown')}</span>`;
    }
  } catch (err) {
    el.innerHTML = `<span class="verify-fail">Error: ${esc(err.message)}</span>`;
  }
}

async function zohoRevoke() {
  try {
    await api('/oauth/zoho/revoke', { method: 'POST' });
    toast('Zoho access revoked');
    zohoCheckStatus();
  } catch (err) {
    toast('Failed to revoke: ' + err.message);
  }
}

async function zohoSaveCredentials() {
  const clientId = document.getElementById('zoho-client-id').value.trim();
  const clientSecret = document.getElementById('zoho-client-secret').value.trim();
  const region = document.getElementById('zoho-region').value;
  if (!clientId || !clientSecret) { toast('Enter both Client ID and Client Secret'); return; }

  try {
    await api('/oauth/zoho/credentials', {
      method: 'POST',
      body: { client_id: clientId, client_secret: clientSecret, region },
    });
    toast('Zoho credentials saved');
    zohoCheckStatus();
  } catch (err) {
    toast('Failed to save credentials: ' + err.message);
  }
}

// --- Fastmail Auth ---
async function fmCheckStatus() {
  const el = document.getElementById('fm-auth-status');
  try {
    const status = await api('/oauth/fastmail/status');
    if (!status.configured) {
      el.innerHTML = '<span style="color:var(--warning)">No API token configured — enter your token below</span>';
    } else {
      el.innerHTML = `<span class="verify-pass">API token configured (${esc(status.tokenPrefix)})</span>`;
    }
  } catch {
    el.innerHTML = '<span class="verify-fail">Could not check auth status</span>';
  }
}

async function fmSaveToken() {
  const token = document.getElementById('fm-api-token').value.trim();
  if (!token) { toast('Enter your Fastmail API token'); return; }

  try {
    await api('/oauth/fastmail/credentials', {
      method: 'POST',
      body: { api_token: token },
    });
    toast('Fastmail API token saved');
    document.getElementById('fm-api-token').value = '';
    fmCheckStatus();
  } catch (err) {
    toast('Failed to save token: ' + err.message);
  }
}

async function fmRevoke() {
  try {
    await api('/oauth/fastmail/revoke', { method: 'POST' });
    toast('Fastmail token removed');
    fmCheckStatus();
  } catch (err) {
    toast('Failed to remove: ' + err.message);
  }
}
