# SherlockMail

Forensic email collection tool for legal, compliance, and investigative professionals. Connects to mail servers via IMAP, acquires emails with full cryptographic verification, maintains a tamper-evident chain of custody, and exports to industry-standard formats.

Built for court-admissible evidence collection following NIST SP 800-86, ISO/IEC 27037, and Federal Rules of Evidence (FRE 901/902).

---

## Quick Start

### Download (Recommended)

Download the latest release from [Releases](https://github.com/Professor-Button-Clicker/SherlockMail/releases):

1. Download and extract `SherlockMail-v1.1.0-win-x64.zip`
2. Run `SherlockMail.exe` to launch the dashboard at `http://localhost:3858`
3. No .NET runtime or installation required — fully self-contained

### Build from Source

Requires [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0).

```bash
git clone https://github.com/Professor-Button-Clicker/SherlockMail.git
cd SherlockMail/dotnet
dotnet run --project SherlockMail
```

The dashboard opens at `http://localhost:3858`.

#### Publish Self-Contained Executable

```bash
dotnet publish SherlockMail/SherlockMail.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o ./publish
```

---

## Features

### Forensic-Grade Collection
- SHA-256 and MD5 hashing of every message at acquisition time
- Original MIME source preservation — no modification of email content
- Differential acquisition — only collect new messages on subsequent runs
- Server-side pre-collection search to target specific messages by sender, date, subject, or keywords

### Chain of Custody
- Hash-chained audit trail using SHA-256
- Each log entry: `hash = SHA-256(previousHash | timestamp | eventType | description)`
- Tamper-evident — any modification to an entry breaks the chain
- Events logged: project creation, acquisition start/complete, message acquired/failed, searches, QC results, exports

### QC Verification
- Post-acquisition reconnection to the mail server
- Folder message count comparison (server vs. collected)
- SHA-256 hash verification of re-fetched messages against stored hashes
- EML file integrity checks
- All verifications report honest results — no false positives under any circumstances

### Export Formats

| Format | Description |
|--------|-------------|
| EML | Original MIME format, one file per message |
| MBOX | RFC 4155 Unix mailbox, one file per folder |
| XML | Structured metadata with all forensic data |
| MSG | SherlockMail-MSG-Container wrapping MIME source |
| PST | Split output sets with configurable size limit |
| Container | Containerized MIME/MSG packages |

### Cloud Drive Link Detection
Detects and catalogs cloud storage links embedded in emails:
- Google Drive / Google Docs
- Microsoft OneDrive / SharePoint
- Dropbox
- Box
- Apple iCloud

### Dashboard UI
- 10-step collection wizard (Connect, Workflow, Query, Search, Folders, Preview, Collecting, Results, QC Verify, Transfer)
- Project management with case/matter tracking
- Chain of custody tracker with integrity verification
- QC verification panel with acquisition, collection, error, and custody logs
- Inline and basic search across collected data
- Built-in user guide with searchable documentation

---

## Dashboard Tabs

| Tab | Purpose |
|-----|---------|
| **Projects** | Create and manage forensic collection projects |
| **Tracker** | View and verify the chain of custody log |
| **Collect** | 10-step wizard for email acquisition |
| **QC** | Run verification, review all logs and error reports |
| **Review** | Browse and inspect collected data |
| **Search** | Search collected emails with basic or inline query syntax |
| **Guide** | Built-in documentation with searchable navigation |

---

## CLI Reference

```
SherlockMail.exe <command> [options]
```

| Command | Description |
|---------|-------------|
| `serve` | Start the web dashboard (default) |
| `create` | Create a new forensic project |
| `acquire` | Run email acquisition |
| `list` | List all projects |
| `search` | Search messages in a project |
| `qc` | Run QC verification |
| `export` | Export collected data |
| `detect` | Detect email provider from address |
| `drive-scan` | Scan collected emails for drive links |
| `audit` | View chain of custody audit log |
| `providers` | List supported email providers |

### Examples

```bash
# Create a project
SherlockMail.exe create -n "Case_2024_Email" -e target@example.com --case-id C1234567

# Run acquisition
SherlockMail.exe acquire -p <project-id> -H imap.gmail.com --app-password <password>

# Run QC verification
SherlockMail.exe qc -p <project-id> -H imap.gmail.com --app-password <password>

# Export to EML and MBOX
SherlockMail.exe export -p <project-id> -f eml,mbox -o ./export

# Search collected messages
SherlockMail.exe search -p <project-id> -q "from:john subject:contract" --inline
```

---

## Search Syntax

### Basic Search
Simple text matching across subjects and addresses.

### Inline Search
Lucene-style query syntax with field-specific searches:

| Syntax | Example | Description |
|--------|---------|-------------|
| `field:value` | `from:john@example.com` | Search specific field |
| `"exact phrase"` | `subject:"quarterly report"` | Exact phrase match |
| `AND / OR / NOT` | `from:john NOT subject:draft` | Boolean operators |
| `[date TO date]` | `sent:[2024/01/01 TO 2024/06/30]` | Date range |
| `*` and `?` | `subject:contract*` | Wildcards |
| `/pattern/` | `/invoice-\d{4}/` | Regex search |

Available fields: `from`, `to`, `cc`, `bcc`, `subject`, `messageid`, `sent`, `attachmentcount`

---

## Technology Stack

| Component | Library |
|-----------|---------|
| Runtime | .NET 8 (C#) |
| IMAP | MailKit / MimeKit |
| Database | Microsoft.Data.Sqlite (WAL mode) |
| Web Server | ASP.NET Minimal API (Kestrel) |
| CLI | System.CommandLine |
| Hashing | System.Security.Cryptography |
| Licensing | X509Certificate2 (optional) |

---

## Project Structure

```
SherlockMail/
├── dotnet/
│   ├── SherlockMail.sln
│   └── SherlockMail/
│       ├── Program.cs                      # Entry point
│       ├── SherlockMail.csproj             # .NET 8 project
│       ├── Core/
│       │   ├── AcquisitionEngine.cs        # IMAP email acquisition
│       │   ├── ChainOfCustody.cs           # Hash-chained audit trail
│       │   ├── ForensicDatabase.cs         # SQLite forensic database
│       │   ├── DriveAttachmentDetector.cs  # Cloud drive link detection
│       │   ├── ForensicExporter.cs         # Multi-format export
│       │   ├── Hasher.cs                   # SHA-256/MD5 hashing
│       │   └── QCVerifier.cs              # QC verification engine
│       ├── Protocols/
│       │   └── ForensicImapClient.cs       # Forensic IMAP client (MailKit)
│       ├── Auth/
│       │   └── ProviderDetect.cs           # Email provider detection
│       ├── Search/
│       │   └── InlineSearch.cs             # Lucene-style search engine
│       ├── Cli/
│       │   └── CliCommands.cs              # CLI interface
│       ├── Web/
│       │   └── WebServer.cs                # ASP.NET dashboard server
│       ├── Licensing/
│       │   └── CertificateLicensing.cs     # Certificate licensing (optional)
│       └── wwwroot/                        # Dashboard frontend
├── src/                                    # Original Node.js source (legacy)
└── README.md
```

---

## Forensic Standards

SherlockMail follows established digital forensics and incident response (DFIR) standards:

- **NIST SP 800-86** — Guide to Integrating Forensic Techniques into Incident Response
- **ISO/IEC 27037** — Guidelines for identification, collection, acquisition and preservation of digital evidence
- **ACPO/NPCC Principles** — Good practice guide for digital evidence
- **FRE 901/902** — Federal Rules of Evidence for authentication and self-authentication
- **FRE 702** — Expert testimony and scientific methodology
- **Daubert Standard** — Scientific validity and reliability of forensic methods

### Integrity Guarantees
- All collections produce verifiable, court-admissible output
- Hash verification uses cryptographic SHA-256 (collision-resistant)
- QC verification provides honest results — PASS or ISSUES_FOUND with detailed reports
- No false positives or fabricated verification results under any circumstances
- Original MIME source data is preserved without modification

---

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `FMC_PORT` | `3858` | Dashboard server port |

Data is stored in `data/fmc.sqlite` relative to the executable.

### Licensing

SherlockMail runs as **Community Edition** by default with all features enabled. No certificate is required.

To activate Professional Edition, place a valid `license.pfx` certificate file next to the executable.

---

## License

MIT
