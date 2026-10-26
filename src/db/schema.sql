-- SherlockMail - Database Schema

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  target_email TEXT NOT NULL,
  provider_type TEXT NOT NULL, -- imap, pop3, ews, graph, gmail_api
  case_name TEXT,
  case_id TEXT,
  examiner_name TEXT,
  agency TEXT,
  evidence_id TEXT,
  custodian_name TEXT,
  evidence_description TEXT,
  client_name TEXT,
  client_matter_no TEXT,
  legal_authority TEXT,
  legal_scope TEXT,
  status TEXT DEFAULT 'created', -- created, collecting, completed, exported, error
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  config TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  delimiter TEXT DEFAULT '/',
  flags TEXT DEFAULT '[]',
  total_messages INTEGER DEFAULT 0,
  unseen_messages INTEGER DEFAULT 0,
  parent_path TEXT,
  selected_for_collection INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  acquisition_id TEXT REFERENCES acquisitions(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  uid INTEGER,
  service_id TEXT,
  folder TEXT,
  subject TEXT,
  from_address TEXT,
  to_addresses TEXT,
  cc_addresses TEXT,
  bcc_addresses TEXT,
  date TEXT,
  message_id TEXT,
  in_reply_to TEXT,
  size INTEGER,
  flags TEXT,
  has_attachments INTEGER DEFAULT 0,
  attachment_count INTEGER DEFAULT 0,
  content_type TEXT,
  hash_md5 TEXT,
  hash_sha256 TEXT,
  hash_sha512 TEXT,
  eml_path TEXT,
  acquired_at TEXT DEFAULT (datetime('now')),
  headers_json TEXT,
  is_encrypted INTEGER DEFAULT 0,
  is_signed INTEGER DEFAULT 0,
  body_text TEXT,
  body_html TEXT
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id),
  filename TEXT,
  content_type TEXT,
  size INTEGER,
  hash_md5 TEXT,
  hash_sha256 TEXT,
  disposition TEXT,
  content_id TEXT,
  is_inline INTEGER DEFAULT 0,
  local_path TEXT
);

CREATE TABLE IF NOT EXISTS acquisitions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  status TEXT DEFAULT 'pending', -- pending, running, completed, completed_with_errors, failed, paused, canceled
  completion_type TEXT, -- completed_without_errors, completed_with_errors_download_complete, completed_with_errors_remaining_items, canceled, no_items_found, fatal_error
  started_at TEXT,
  completed_at TEXT,
  total_messages INTEGER DEFAULT 0,
  acquired_messages INTEGER DEFAULT 0,
  failed_messages INTEGER DEFAULT 0,
  skipped_messages INTEGER DEFAULT 0,
  total_bytes INTEGER DEFAULT 0,
  error_log TEXT,
  protocol_log TEXT,
  folders_json TEXT,
  session_dir TEXT -- path to the session output directory (MIME files + logs)
);

CREATE TABLE IF NOT EXISTS search_queries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  query_type TEXT NOT NULL, -- in_place, in_line, date_range, keyword, sender, recipient, has_attachment
  query_text TEXT,
  criteria_json TEXT, -- structured search criteria
  result_count INTEGER DEFAULT 0,
  executed_at TEXT DEFAULT (datetime('now')),
  applied_to_collection INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS export_records (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  format TEXT NOT NULL, -- pst, eml, msg, mbox, mime
  output_dir TEXT,
  started_at TEXT,
  completed_at TEXT,
  message_count INTEGER DEFAULT 0,
  total_bytes INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending',
  hash_sha256 TEXT,
  details_json TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT REFERENCES projects(id),
  acquisition_id TEXT REFERENCES acquisitions(id),
  timestamp TEXT DEFAULT (datetime('now')),
  event_type TEXT NOT NULL,
  description TEXT,
  details TEXT,
  hash TEXT,
  examiner TEXT,
  prev_hash TEXT
);

CREATE TABLE IF NOT EXISTS qc_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  started_at TEXT,
  completed_at TEXT,
  status TEXT,
  results_json TEXT
);

CREATE TABLE IF NOT EXISTS differential_ids (
  project_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  folder TEXT NOT NULL,
  source_project_id TEXT,
  PRIMARY KEY (project_id, service_id, folder)
);

CREATE TABLE IF NOT EXISTS drive_links (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  message_id TEXT REFERENCES messages(id),
  provider TEXT,
  url TEXT,
  file_id TEXT,
  status TEXT DEFAULT 'detected',
  detected_at TEXT DEFAULT (datetime('now')),
  downloaded_at TEXT,
  local_path TEXT,
  file_size INTEGER,
  hash_sha256 TEXT
);

CREATE TABLE IF NOT EXISTS timestamp_records (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  type TEXT NOT NULL,
  target_hash TEXT NOT NULL,
  timestamp_data TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS inline_searches (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  query TEXT NOT NULL,
  result_count INTEGER DEFAULT 0,
  elapsed_ms INTEGER DEFAULT 0,
  executed_at TEXT DEFAULT (datetime('now'))
);

-- ── Feature 1: RFC 3161 Trusted Timestamps ──
CREATE TABLE IF NOT EXISTS rfc3161_timestamps (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  target_type TEXT NOT NULL, -- collection, export, message, snapshot
  target_hash TEXT NOT NULL,
  tsa_url TEXT NOT NULL,
  tsa_name TEXT,
  request_nonce TEXT,
  tst_info TEXT, -- DER-encoded TSTInfo (base64)
  timestamp_token TEXT, -- full RFC 3161 TimeStampToken (base64)
  gen_time TEXT,
  serial_number TEXT,
  hash_algorithm TEXT DEFAULT 'sha256',
  status TEXT DEFAULT 'pending', -- pending, verified, failed
  verification_result TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ── Feature 3: Folder Snapshots ──
CREATE TABLE IF NOT EXISTS folder_snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  acquisition_id TEXT REFERENCES acquisitions(id),
  snapshot_type TEXT NOT NULL, -- pre_acquisition, post_acquisition
  captured_at TEXT DEFAULT (datetime('now')),
  folder_data TEXT NOT NULL, -- JSON array of folder states
  total_folders INTEGER DEFAULT 0,
  total_messages INTEGER DEFAULT 0,
  hash_sha256 TEXT
);

-- ── Feature 10-14: Cloud & Drive Collection ──
CREATE TABLE IF NOT EXISTS drive_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  provider TEXT NOT NULL, -- google_drive, onedrive, sharepoint
  item_type TEXT NOT NULL, -- file, folder, shared_drive, site
  name TEXT,
  mime_type TEXT,
  size INTEGER,
  remote_id TEXT,
  parent_id TEXT,
  path TEXT,
  web_url TEXT,
  created_time TEXT,
  modified_time TEXT,
  owner TEXT,
  shared INTEGER DEFAULT 0,
  revision_count INTEGER DEFAULT 0,
  local_path TEXT,
  hash_md5 TEXT,
  hash_sha256 TEXT,
  status TEXT DEFAULT 'listed', -- listed, downloading, downloaded, failed
  downloaded_at TEXT,
  metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS drive_revisions (
  id TEXT PRIMARY KEY,
  drive_item_id TEXT NOT NULL REFERENCES drive_items(id),
  revision_id TEXT,
  modified_time TEXT,
  modifier TEXT,
  size INTEGER,
  local_path TEXT,
  hash_sha256 TEXT,
  status TEXT DEFAULT 'listed'
);

CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  provider TEXT NOT NULL,
  event_id TEXT,
  summary TEXT,
  description TEXT,
  location TEXT,
  start_time TEXT,
  end_time TEXT,
  organizer TEXT,
  attendees_json TEXT,
  recurrence TEXT,
  status TEXT,
  ical_data TEXT,
  hash_sha256 TEXT,
  collected_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  provider TEXT NOT NULL,
  contact_id TEXT,
  display_name TEXT,
  email_addresses TEXT, -- JSON array
  phone_numbers TEXT, -- JSON array
  organization TEXT,
  title TEXT,
  notes TEXT,
  vcard_data TEXT,
  hash_sha256 TEXT,
  collected_at TEXT DEFAULT (datetime('now'))
);

-- ── Feature 15: Cloud Attachment Download Pipeline ──
CREATE TABLE IF NOT EXISTS cloud_downloads (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  drive_link_id TEXT REFERENCES drive_links(id),
  provider TEXT NOT NULL,
  remote_url TEXT,
  file_name TEXT,
  file_size INTEGER,
  mime_type TEXT,
  stage TEXT DEFAULT 'queued', -- queued, staging, downloading, hashing, packaged, failed
  local_path TEXT,
  hash_md5 TEXT,
  hash_sha1 TEXT,
  hash_sha256 TEXT,
  hash_sha384 TEXT,
  error TEXT,
  started_at TEXT,
  completed_at TEXT
);

-- ── Feature 21: Pre-Acquisition Search ──
CREATE TABLE IF NOT EXISTS pre_acquisition_searches (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  criteria_json TEXT NOT NULL,
  protocol TEXT,
  result_count INTEGER DEFAULT 0,
  selected_count INTEGER DEFAULT 0,
  uids_json TEXT, -- JSON array of UIDs matching search
  executed_at TEXT DEFAULT (datetime('now')),
  applied INTEGER DEFAULT 0
);

-- ── Feature 22: Full-Text Search Index ──
CREATE TABLE IF NOT EXISTS search_index (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES messages(id),
  field TEXT NOT NULL, -- subject, body, from, to, cc, attachment_name
  content TEXT NOT NULL,
  indexed_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_search_index_project ON search_index(project_id);
CREATE INDEX IF NOT EXISTS idx_search_index_content ON search_index(content);

-- ── Feature 24: SMTP Notifications ──
CREATE TABLE IF NOT EXISTS smtp_settings (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id), -- NULL = global default
  host TEXT NOT NULL,
  port INTEGER DEFAULT 587,
  secure INTEGER DEFAULT 1,
  username TEXT,
  password_encrypted TEXT,
  from_address TEXT,
  to_addresses TEXT, -- JSON array
  notify_on_complete INTEGER DEFAULT 1,
  notify_on_error INTEGER DEFAULT 1,
  notify_on_export INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ── Feature 26: Health Monitoring ──
CREATE TABLE IF NOT EXISTS health_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT REFERENCES projects(id),
  acquisition_id TEXT REFERENCES acquisitions(id),
  event_type TEXT NOT NULL, -- disk_space, memory, rate_limit, connection, timeout
  severity TEXT DEFAULT 'info', -- info, warning, critical
  message TEXT,
  details_json TEXT,
  recorded_at TEXT DEFAULT (datetime('now'))
);

-- ── Feature 28: Multi-Target Acquisition ──
CREATE TABLE IF NOT EXISTS acquisition_targets (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id),
  target_email TEXT NOT NULL,
  provider_type TEXT NOT NULL,
  config_json TEXT,
  status TEXT DEFAULT 'pending', -- pending, running, completed, failed
  acquisition_id TEXT REFERENCES acquisitions(id),
  started_at TEXT,
  completed_at TEXT,
  error TEXT
);

-- ── Feature 29: Connectivity Testing ──
CREATE TABLE IF NOT EXISTS connectivity_tests (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  host TEXT NOT NULL,
  port INTEGER,
  protocol TEXT,
  tls_version TEXT,
  certificate_info TEXT, -- JSON
  dns_resolved TEXT,
  latency_ms INTEGER,
  auth_tested INTEGER DEFAULT 0,
  auth_result TEXT,
  imap_capabilities TEXT,
  status TEXT NOT NULL, -- success, failed, timeout, auth_failed
  error TEXT,
  tested_at TEXT DEFAULT (datetime('now'))
);

-- ── Feature 30: Proxy Settings ──
CREATE TABLE IF NOT EXISTS proxy_settings (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  proxy_type TEXT NOT NULL, -- http, socks4, socks5, none
  host TEXT,
  port INTEGER,
  username TEXT,
  password_encrypted TEXT,
  is_default INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ── Feature 31: Server Profile Auto-Detection ──
CREATE TABLE IF NOT EXISTS server_profiles (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL UNIQUE,
  provider_name TEXT,
  imap_host TEXT,
  imap_port INTEGER,
  pop3_host TEXT,
  pop3_port INTEGER,
  smtp_host TEXT,
  smtp_port INTEGER,
  mx_records TEXT, -- JSON
  spf_record TEXT,
  autodiscover_url TEXT,
  oauth_required INTEGER DEFAULT 0,
  detected_protocol TEXT,
  confidence REAL DEFAULT 0.0,
  detected_at TEXT DEFAULT (datetime('now')),
  last_verified TEXT
);

-- ── Feature 32-33: S/MIME & Certificate Store ──
CREATE TABLE IF NOT EXISTS certificates (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  subject TEXT,
  issuer TEXT,
  serial_number TEXT,
  thumbprint_sha256 TEXT,
  not_before TEXT,
  not_after TEXT,
  key_usage TEXT,
  email_address TEXT,
  pem_data TEXT,
  pfx_path TEXT,
  cert_type TEXT NOT NULL, -- smime_encrypt, smime_sign, ca, intermediate
  imported_at TEXT DEFAULT (datetime('now'))
);

-- ── Feature 34: Credential Manager ──
CREATE TABLE IF NOT EXISTS saved_credentials (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  credential_type TEXT NOT NULL, -- password, oauth_token, app_password, certificate
  target_host TEXT,
  username TEXT,
  encrypted_data TEXT, -- AES-256-GCM encrypted
  iv TEXT,
  auth_tag TEXT,
  metadata_json TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- ── Feature 35: Custom IMAP Profiles ──
CREATE TABLE IF NOT EXISTS custom_imap_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER DEFAULT 993,
  tls INTEGER DEFAULT 1,
  auth_method TEXT DEFAULT 'password', -- password, oauth2, xoauth2, app_password
  imap_capabilities TEXT,
  special_folders TEXT, -- JSON mapping
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
