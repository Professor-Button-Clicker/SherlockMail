# SherlockMail*

**v0.9.0** | Desktop forensic email collection for digital forensic and incident response (DFIR) investigations.

SherlockMail is a standalone desktop application that collects, preserves, and exports email evidence with forensic integrity. It connects to mailboxes over 7 protocols, downloads messages in their original MIME format, hashes every item on acquisition, and maintains a tamper-evident chain of custody from collection through export. Built for legal, compliance, and investigative professionals who need defensible email evidence.

---

## Installation

### Windows Installer (Recommended)

1. Download **SherlockMail.Setup.0.9.0.exe** from the [latest release](../../releases/latest)
2. Run the installer — it handles everything automatically
3. Launch SherlockMail from the Start Menu or desktop shortcut

The installer is fully self-contained. No additional software is required.

### From Source

For development or running on other platforms:

1. Install [Node.js](https://nodejs.org/) v18 or later
2. Clone this repository
3. Install dependencies:
   - **Windows**: Double-click `install.bat` (auto-installs Node.js via winget if missing)
   - **All platforms**: Run `npm install`
4. Launch:
   - **Windows**: Double-click `start.bat`
   - **All platforms**: Run `npm start`

### Building Installers

```bash
npm run build:win     # Windows NSIS installer (.exe)
npm run build:mac     # macOS disk image (.dmg)
npm run build:linux   # Linux AppImage (.AppImage)
```

Outputs go to the `release/` directory.

---

## How It Works

SherlockMail follows a structured evidence collection workflow designed around DFIR best practices.

### 1. Create a Project

Every collection begins with a project. A project ties together case metadata (case name, case ID, examiner, agency, legal authority, scope) with a target email address and the collected evidence. This metadata flows through the entire chain of custody.

### 2. Collect Email (9-Step Wizard)

The collection wizard walks through each step of a defensible acquisition:

| Step | What Happens |
|------|-------------|
| **Connect** | Choose a protocol, enter credentials, and test the connection. SherlockMail verifies access before proceeding. |
| **Workflow** | Select output formats (EML, MBOX, MSG, PST, MIME, etc.), attachment handling, and where to save collected data. |
| **Query** | Optionally narrow the collection by date range, sender, subject, or keywords. |
| **Folders** | Browse the mailbox folder tree and select which folders to collect, or collect everything. |
| **Preview** | Review all settings and estimated item counts before acquisition begins. |
| **Collecting** | Live progress tracker. Each message is downloaded, hashed (MD5 + SHA-256 + SHA-512), and saved. |
| **Results** | Summary of what was collected, any errors encountered, and the acquisition log. |
| **QC Verify** | Automatic quality control checks run against the collected data. |
| **Transfer** | Optionally copy the collected evidence to external storage. |

During collection, SherlockMail connects in **read-only mode** (IMAP EXAMINE, Graph API read scopes, etc.) so the source mailbox is never modified, per ISO 27037.

### 3. Review and Search

After collection, the Review tab provides:

- **Message browser** with subject, sender, date, folder, and attachment indicators
- **Full header analysis** for any message
- **Inline search engine** supporting boolean operators, regex, wildcards, fuzzy matching, proximity search, field-specific queries (`from:`, `to:`, `subject:`, `sent:`), and date ranges
- **Email threading** reconstructed from In-Reply-To and References headers
- **Signature checks and decryption**: S/MIME signatures are verified against the collected bytes and the signer's certificate chain; encrypted S/MIME messages can be decrypted to a separate copy with the recipient's key. PGP messages are flagged but not verified or decrypted, which needs the keys in a PGP tool
- **Cloud attachment detection** identifying links to Google Drive, OneDrive, SharePoint, Dropbox, and Box

### 4. Quality Control

The Quality check screen runs these checks and reports what it actually found:

1. **Collection Completeness** — Every enumerated item was collected, skipped or recorded as failed
2. **Hash Integrity** — Every collected file is re-read and matched to its recorded SHA-256
3. **Duplicate Detection** — Messages with identical hashes or Message-IDs flagged
4. **Date Consistency** — Missing or future-dated messages flagged
5. **Required Fields** — Messages missing a sender or subject flagged
6. **Folder Coverage** — Every selected folder could be read
7. **Export Completeness** — At least one export covers every message
8. **Audit Trail** — The hash chain is recomputed and every link checked
9. **Encryption & Signing Detection** — S/MIME and PGP messages counted
10. **Write Protection (ISO 27037)** — Judged from each acquisition's protocol log (IMAP `EXAMINE`, confirmed read-only by the server)
11. **DFIR Standards Compliance** — Case metadata, examiner, legal authority and hashes present
12. **Attachment Completeness** — Every attachment recorded with its hash
13. **Timestamp Verification** — Each message's Date header still matches what was recorded
14. **Protocol Log Completeness** — Each acquisition has a protocol log and any errors are surfaced
15. **Cloud Attachment Coverage** — Links to cloud files found, and whether they were preserved
16. **Drive File Verification** — Downloaded drive files re-hashed
17. **Export Integrity** — Every file each export's manifest lists is re-hashed
18. **Collection Resumability** — Interrupted acquisitions flagged, with how to complete them

### 5. Export

Export collected evidence to any combination of 8 formats:

| Format | Use Case |
|--------|----------|
| **EML** (RFC 5322) | Gold standard — one file per message with full headers, MIME structure, attachments |
| **MSG** (Outlook) | Genuine MS-OXMSG files converted from the original message, with an item map to its SHA-256 |
| **PST** (Personal Storage) | Single container with folder hierarchy |
| **MBOX** (Unix Mailbox) | Concatenated messages for batch processing tools |
| **MIME** (Raw) | Exact server response for maximum forensic integrity |
| **PDF Report** | Printable report with metadata, routing headers, the full body, attachment names and hashes. Western European text; other characters print as "?" and the report counts them, so keep the EML export as the evidence |
| **Concordance DAT** | eDiscovery load file with Bates numbering (SM-0000001) and Concordance's default delimiters (ASCII 20, 254, 174) |
| **XML** (Structured) | Structured export for case management systems, XSLT, and database imports |

Every export includes a SHA-256 hash manifest. RFC 3161 timestamps are generated automatically at export time.

---

## Supported Providers and Protocols

### Email Providers (11)

| Provider | Recommended Protocol | Auth Methods |
|----------|---------------------|--------------|
| Gmail / Google Workspace | Gmail API | OAuth 2.0, App Password |
| Outlook / Microsoft 365 | Microsoft Graph API | OAuth 2.0, Basic Auth |
| Exchange On-Premises | EWS | Password, OAuth |
| Zoho Mail | Zoho Mail API | OAuth 2.0, Password |
| Fastmail | JMAP (RFC 8621) | API Token, App Password |
| Yahoo Mail | IMAP | App Password |
| AOL Mail | IMAP | App Password |
| iCloud Mail | IMAP | App-Specific Password |
| ProtonMail | IMAP via Proton Bridge | Bridge Password |
| Yandex Mail | IMAP | App Password |
| Custom IMAP/POP3 | IMAP or POP3 | Password |

Each provider has multiple collection profiles ranked by priority. If the primary profile fails, SherlockMail suggests the next fallback automatically.

### Protocols (7)

| Protocol | Description |
|----------|-------------|
| **IMAP** | EXAMINE mode (read-only). Full folder support, UID tracking, server-side search. Ports 993 (TLS) / 143 (STARTTLS). |
| **POP3** | Inbox-only access. Fallback protocol. Ports 995 (TLS) / 110. |
| **EWS** | Exchange Web Services over SOAP/HTTPS. Autodiscover, KQL mailbox search, paginated FindItem, Recoverable Items access. |
| **Microsoft Graph API** | REST API for Microsoft 365 / Exchange Online. OAuth 2.0, paginated message download, MIME export via `$value`. |
| **Gmail API** | Google REST API. OAuth 2.0, label-based collection, raw MIME download (`format=raw`). When Google refuses requests for its per-minute quota, every download pauses for one quota window (60 s, or the server's Retry-After) and resumes at a slower pace. Messages that still fail are tried again after the rest of the mailbox, up to 50 more times each (a message the server reports as gone is not retried). |
| **Zoho Mail API** | Zoho REST API with automatic regional endpoint detection (US/EU/IN/AU/JP). |
| **JMAP** | RFC 8621 JSON protocol. Batch method calls, state-based sync. Used by Fastmail. |

### OAuth 2.0 Setup

SherlockMail includes built-in OAuth flows for three providers. Each uses a localhost callback — no public server needed:

| Provider | Callback Port | Scopes |
|----------|--------------|--------|
| Google | `localhost:3847` | `gmail.readonly`, `drive.readonly` |
| Microsoft | `localhost:3848` | `Mail.Read`, `Files.Read`, `Files.Read.All`, `offline_access` |
| Zoho | `localhost:3849` | `ZohoMail.messages.READ`, `ZohoMail.folders.READ`, `ZohoMail.accounts.READ`, `ZohoMail.attachments.READ` |

Place your OAuth credentials in the `data/` directory:
- **Google**: `data/google-credentials.json` (download from Google Cloud Console, "Desktop app" type)
- **Microsoft**: `data/microsoft-credentials.json` (`{ "client_id": "...", "client_secret": "..." }`)
- **Zoho**: `data/zoho-credentials.json`

---

## Forensic Integrity Features

### Triple Hashing
Every collected message is hashed with MD5, SHA-256, and SHA-512 at acquisition time (NIST FIPS 180-4). Hashes are stored in the database and included in exports for independent verification.

### Chain of Custody
The audit log records every action — project creation, connection tests, acquisitions, searches, QC runs, exports, and integrity checks. Each entry is linked to the previous by a SHA-256 hash chain: `hash = SHA-256(previousHash | timestamp | eventType | description)`. Modifying any entry breaks the chain, which QC check #8 detects.

### RFC 3161 Timestamps
After each collection and export, a SHA-256 hash is sent to an external Timestamp Authority (DigiCert, Sectigo, GlobalSign or FreeTSA, tried in that order), and its signed token is verified on receipt: signature, hash, nonce and timestamping certificate. The token is saved beside the file it covers (`Logs/collection_hashes_*.txt.tsr`, `manifest.txt.tsr`), so anyone can check it independently:

```
openssl ts -verify -data manifest.txt -in manifest.txt.tsr -token_in -CAfile <authority's root certificate>
```

Only the hash leaves the computer. If no authority can be reached, the collection or export still finishes and the record says no trusted timestamp was issued; nothing stands in for it. Set `SHERLOCKMAIL_TSA_URLS` to use your own authority, or to `off` to contact none. Whether a given authority meets a jurisdiction's rules (for example eIDAS qualified status) is for the examiner to confirm.

### Write Protection
IMAP connections use EXAMINE mode, and a collection stops if the server does not confirm read-only. API-based protocols request read-only scopes and send only read requests. POP3 has no read-only mode: SherlockMail never sends DELE, but some servers delete mail after retrieval, so QC check #10 warns about it.

### Differential Collection
Subsequent collections against the same mailbox skip previously acquired messages (matched by Message-ID and SHA-256 hash), collecting only new items.

### Folder Snapshots
Each collection reads the server's folder list and counts before the first message and after the last, and records whether the mailbox changed in between.

### Forensic Containers
A folder of evidence can be packaged into a VHDX disk image (exFAT in an MBR partition) that Windows and forensic tools can mount. Every file is read back through the image and matched by SHA-256 before it is finished.

---

## Standards Alignment

| Standard | How SherlockMail Applies It |
|----------|---------------------------|
| **ISO/IEC 27037:2012** | Read-only collection, evidence preservation, chain of custody documentation |
| **NIST SP 800-86** | Hash-chained audit trail, examiner attribution, incident response integration |
| **NIST FIPS 180-4** | SHA-256 and SHA-512 hashing on all collected messages |
| **SWGDE Best Practices (2025)** | Documented collection process, quality control verification |
| **SWGDE Cloud Evidence (23-F-004)** | Cloud provider API collection with OAuth, cloud attachment detection |
| **ACPO Principles v5** | Principle 1: no alteration of source data (read-only access) |
| **EDRM Collection Standards** | Repeatable processes with documented risks and defensible methodology |
| **FRE 901(b)(9) / 902(14)** | Process producing accurate results; certified data from electronic process |
| **RFC 3161** | Trusted timestamps from an external authority for collection and export events |

---

## Application Overview

### Interface

SherlockMail uses a tab-based interface:

| Tab | Purpose |
|-----|---------|
| **Projects** | Create and manage cases. Each project stores case metadata, target email, and all associated evidence. |
| **Tracker** | Dashboard showing acquisition status across projects. |
| **Collect** | 9-step collection wizard for running acquisitions. |
| **Quality check** | Run and review the quality control suite, trusted timestamps, integrity verification and analytics. |
| **Export** | Export evidence in up to 8 formats with hash manifests. |
| **Review** | Browse collected messages by folder, read them, analyze headers, check signatures, search. |
| **Tools** | Import EML/MBOX/PST, inspect Exchange (Recoverable Items, archive, inbox rules, public folders), calendar and contacts, folder snapshots, collecting several mailboxes, reports, certificates, enterprise and Yahoo sign-ins, diagnostics, proxy, e-mail notifications. |
| **Guide** | Built-in 13-section reference covering all features, protocols, and standards. |

### Technology

- **Desktop runtime**: Electron (Chromium + Node.js)
- **Backend**: Express.js REST API running locally
- **Database**: Node.js built-in SQLite (`node:sqlite`, DatabaseSync) with WAL mode
- **All data stored locally** in the `data/` directory. Besides the configured mail server, the only outside contact is a hash sent to a Timestamp Authority (see above), plus a notification e-mail or proxy if you set those up
- **Command line**: `node server.js <status|collect|import|search|qc|verify|export|timestamp> ...` prints JSON and exits non-zero when the evidence or the operation has a problem. Run `node server.js --help`. The installed app takes the same commands; Windows only shows a desktop app's output when it is redirected, so use `SherlockMail.exe status > status.json`

---

## Project Structure

```
SherlockMail/
  main.js                  Electron entry point (BrowserWindow)
  server.js                Express server (port 3000)
  install.bat / start.bat  Windows setup and launch scripts
  public/
    index.html             Single-page application
    css/styles.css         Application styles
    js/app.js              Frontend logic
  src/
    api/routes.js          REST API endpoints
    db/
      database.js          SQLite operations
      schema.sql           Database schema
    protocols/
      imap-handler.js      IMAP (ImapFlow, EXAMINE mode)
      pop3-handler.js      POP3
      ews-handler.js       Exchange Web Services (SOAP/HTTPS)
      graph-handler.js     Microsoft Graph API
      gmail-handler.js     Gmail API
      zoho-handler.js      Zoho Mail API
      jmap-handler.js      JMAP (RFC 8621)
    services/
      export-service.js    8-format export engine
      quality-control.js   QC suite
      inline-search.js     Search engine
      rfc3161-timestamp.js RFC 3161 requests and token verification
      timestamp-service.js Timestamps for collections and exports
      cms.js               CMS (RFC 5652): signature verification and decryption
      crypto-service.js    S/MIME
      container-service.js VHDX forensic containers
      local-import.js      EML, MBOX and PST import
      exchange-advanced.js Recoverable Items, archive, inbox rules, public folders
      hash-manager.js      MD5 / SHA-256 / SHA-512
      google-oauth.js      Google OAuth 2.0 flow
      microsoft-oauth.js   Microsoft OAuth 2.0 flow
      zoho-oauth.js        Zoho OAuth 2.0 flow
  data/                    Database, credentials, and exports (created at runtime)
  assets/                  Application icon
```

---

## License

Proprietary — For authorized forensic use only.
