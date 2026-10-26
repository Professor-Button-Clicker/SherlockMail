import crypto from 'crypto';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import dns from 'dns';
import net from 'net';
import tls from 'tls';
import os from 'os';
import https from 'https';
import http from 'http';

export class RetryPolicy {
  constructor(options = {}) {
    this.maxRetries = options.maxRetries ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 1000;
    this.maxDelayMs = options.maxDelayMs ?? 30000;
    this.backoffMultiplier = options.backoffMultiplier ?? 2;
    this.jitterFactor = options.jitterFactor ?? 0.1;
    this.retryableErrors = options.retryableErrors || ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'EAI_AGAIN'];
    this.retryableStatusCodes = options.retryableStatusCodes || [408, 429, 500, 502, 503, 504];
  }

  async execute(fn) {
    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn(attempt);
      } catch (err) {
        lastError = err;
        if (attempt === this.maxRetries) break;
        if (!this._isRetryable(err)) break;
        const delay = this._computeDelay(attempt);
        await new Promise(r => setTimeout(r, delay));
      }
    }
    throw lastError;
  }

  _isRetryable(err) {
    if (this.retryableErrors.includes(err.code)) return true;
    if (err.statusCode && this.retryableStatusCodes.includes(err.statusCode)) return true;
    if (err.message?.includes('throttl') || err.message?.includes('rate limit')) return true;
    return false;
  }

  _computeDelay(attempt) {
    let delay = this.baseDelayMs * Math.pow(this.backoffMultiplier, attempt);
    delay = Math.min(delay, this.maxDelayMs);
    const jitter = delay * this.jitterFactor * (Math.random() * 2 - 1);
    return Math.max(0, Math.round(delay + jitter));
  }
}

export class CircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 60000;
    this.halfOpenMax = options.halfOpenMax ?? 1;
    this.state = 'closed';
    this.failures = 0;
    this.lastFailure = 0;
    this.successes = 0;
  }

  async execute(fn) {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailure >= this.resetTimeoutMs) {
        this.state = 'half-open';
        this.successes = 0;
      } else {
        throw new Error('Circuit breaker is OPEN — service unavailable');
      }
    }

    try {
      const result = await fn();
      this._onSuccess();
      return result;
    } catch (err) {
      this._onFailure();
      throw err;
    }
  }

  _onSuccess() {
    if (this.state === 'half-open') {
      this.successes++;
      if (this.successes >= this.halfOpenMax) {
        this.state = 'closed';
        this.failures = 0;
      }
    } else {
      this.failures = Math.max(0, this.failures - 1);
    }
  }

  _onFailure() {
    this.failures++;
    this.lastFailure = Date.now();
    if (this.failures >= this.failureThreshold) this.state = 'open';
  }

  getState() {
    if (this.state === 'open' && Date.now() - this.lastFailure >= this.resetTimeoutMs) return 'half-open';
    return this.state;
  }
}

export class RateLimiter {
  constructor(options = {}) {
    this.maxRequests = options.maxRequests ?? 30;
    this.windowMs = options.windowMs ?? 60000;
    this.tokens = this.maxRequests;
    this.lastRefill = Date.now();
  }

  async acquire() {
    this._refill();
    if (this.tokens <= 0) {
      const waitMs = this.windowMs - (Date.now() - this.lastRefill);
      await new Promise(r => setTimeout(r, Math.max(waitMs, 100)));
      this._refill();
    }
    if (this.tokens <= 0) throw new Error('Rate limit exceeded');
    this.tokens--;
  }

  _refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed >= this.windowMs) {
      this.tokens = this.maxRequests;
      this.lastRefill = now;
    } else {
      const refill = Math.floor((elapsed / this.windowMs) * this.maxRequests);
      this.tokens = Math.min(this.maxRequests, this.tokens + refill);
    }
  }

  getStatus() {
    this._refill();
    return { remainingTokens: this.tokens, maxRequests: this.maxRequests, windowMs: this.windowMs };
  }
}

export class EmailValidator {
  static EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

  static validate(email) {
    const result = { email, valid: false, errors: [] };
    if (!email || typeof email !== 'string') { result.errors.push('Email is required'); return result; }
    const trimmed = email.trim().toLowerCase();
    if (trimmed.length > 254) { result.errors.push('Email exceeds 254 characters'); return result; }
    if (!this.EMAIL_REGEX.test(trimmed)) { result.errors.push('Invalid email format'); return result; }
    const [local, domain] = trimmed.split('@');
    if (local.length > 64) { result.errors.push('Local part exceeds 64 characters'); return result; }
    if (!domain || !domain.includes('.')) { result.errors.push('Domain must contain a dot'); return result; }
    const tld = domain.split('.').pop();
    if (tld.length < 2) { result.errors.push('TLD too short'); return result; }
    result.valid = true;
    result.normalized = trimmed;
    result.local = local;
    result.domain = domain;
    return result;
  }

  static async validateMx(email) {
    const basic = this.validate(email);
    if (!basic.valid) return basic;
    try {
      const mx = await new Promise((resolve, reject) => {
        dns.resolveMx(basic.domain, (err, records) => err ? reject(err) : resolve(records));
      });
      basic.mxRecords = mx.sort((a, b) => a.priority - b.priority).map(r => r.exchange);
      basic.hasMx = mx.length > 0;
    } catch {
      basic.hasMx = false;
      basic.errors.push('No MX records found');
      basic.valid = false;
    }
    return basic;
  }
}

export class AutomationService {

  // ── SMTP Completion Notifications (Feature 24) ──

  static async sendNotification(smtpSettings, notification) {
    const { host, port, secure, username, password, fromAddress, toAddresses } = smtpSettings;
    const recipients = typeof toAddresses === 'string' ? JSON.parse(toAddresses) : toAddresses;

    const boundary = `----=_Part_${uuidv4().substring(0, 8)}`;
    const subject = this._buildSubject(notification);
    const bodyText = this._buildBodyText(notification);
    const bodyHtml = this._buildBodyHtml(notification);

    const message = [
      `From: ${fromAddress}`,
      `To: ${recipients.join(', ')}`,
      `Subject: ${subject}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${uuidv4()}@sherlockmail.local>`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      `X-Mailer: SherlockMail v0.9.0`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      bodyText,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      '',
      bodyHtml,
      '',
      `--${boundary}--`,
    ].join('\r\n');

    try {
      await this._sendSmtp(host, port || 587, secure, username, password, fromAddress, recipients, message);
      return { success: true, recipients: recipients.length, subject };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  static _buildSubject(notification) {
    const prefix = '[SherlockMail]';
    switch (notification.type) {
      case 'acquisition_complete': return `${prefix} Acquisition Complete — ${notification.projectName}`;
      case 'acquisition_error': return `${prefix} Acquisition Error — ${notification.projectName}`;
      case 'export_complete': return `${prefix} Export Complete — ${notification.projectName}`;
      default: return `${prefix} Notification — ${notification.projectName || 'SherlockMail'}`;
    }
  }

  static _buildBodyText(n) {
    let text = `SherlockMail Notification\n${'='.repeat(40)}\n\n`;
    text += `Type: ${n.type}\n`;
    text += `Project: ${n.projectName || 'N/A'}\n`;
    text += `Time: ${new Date().toISOString()}\n\n`;
    if (n.details) text += `Details:\n${JSON.stringify(n.details, null, 2)}\n`;
    return text;
  }

  static _buildBodyHtml(n) {
    return `<html><body style="font-family:Arial,sans-serif"><h2>SherlockMail Notification</h2><table border="1" cellpadding="6" style="border-collapse:collapse"><tr><td><b>Type</b></td><td>${n.type}</td></tr><tr><td><b>Project</b></td><td>${n.projectName || 'N/A'}</td></tr><tr><td><b>Time</b></td><td>${new Date().toISOString()}</td></tr></table>${n.details ? `<pre>${JSON.stringify(n.details, null, 2)}</pre>` : ''}</body></html>`;
  }

  static async _sendSmtp(host, port, secure, username, password, from, to, message) {
    return new Promise((resolve, reject) => {
      const socket = secure ? tls.connect(port, host, { rejectUnauthorized: false }) : net.connect(port, host);
      let response = '';
      const commands = [];
      let step = 0;

      commands.push(`EHLO sherlockmail.local\r\n`);
      if (!secure) commands.push(`STARTTLS\r\n`);
      if (username) commands.push(`AUTH LOGIN\r\n`);
      if (username) commands.push(Buffer.from(username).toString('base64') + '\r\n');
      if (password) commands.push(Buffer.from(password).toString('base64') + '\r\n');
      commands.push(`MAIL FROM:<${from}>\r\n`);
      for (const r of to) commands.push(`RCPT TO:<${r}>\r\n`);
      commands.push(`DATA\r\n`);
      commands.push(message + '\r\n.\r\n');
      commands.push(`QUIT\r\n`);

      socket.on('data', (data) => {
        response += data.toString();
        if (response.includes('5') && response.charAt(0) === '5') {
          socket.destroy(); reject(new Error(`SMTP error: ${response.trim()}`)); return;
        }
        if (step < commands.length) { socket.write(commands[step++]); }
        else { socket.destroy(); resolve(); }
      });
      socket.on('error', reject);
      socket.setTimeout(30000, () => { socket.destroy(); reject(new Error('SMTP timeout')); });
    });
  }

  // ── CLI Automation (Feature 25) ──

  static parseCliArgs(argv) {
    const args = { command: null, options: {} };
    let i = 2;
    if (argv[i] && !argv[i].startsWith('--')) { args.command = argv[i]; i++; }

    while (i < argv.length) {
      const arg = argv[i];
      if (arg.startsWith('--')) {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) { args.options[key] = next; i += 2; }
        else { args.options[key] = true; i++; }
      } else { i++; }
    }
    return args;
  }

  static getCliCommands() {
    return {
      collect: { description: 'Run email acquisition', options: ['--project <id>', '--email <address>', '--provider <type>', '--protocol <name>', '--output <dir>'] },
      export: { description: 'Export collected messages', options: ['--project <id>', '--format <eml|msg|pst|mbox|pdf>', '--output <dir>'] },
      search: { description: 'Search collected messages', options: ['--project <id>', '--query <text>', '--from <address>', '--since <date>'] },
      qc: { description: 'Run quality control checks', options: ['--project <id>'] },
      verify: { description: 'Verify evidence integrity', options: ['--project <id>'] },
      status: { description: 'Show project status', options: ['--project <id>', '--all'] },
      import: { description: 'Import local email files', options: ['--project <id>', '--path <file_or_dir>', '--format <mbox|eml|pst>'] },
      timestamp: { description: 'Request RFC 3161 timestamp', options: ['--project <id>', '--tsa <url>'] },
    };
  }

  // ── Health Monitoring (Feature 26) ──

  static checkHealth() {
    const freeMem = os.freemem();
    const totalMem = os.totalmem();
    const memUsagePercent = ((totalMem - freeMem) / totalMem * 100).toFixed(1);
    const cpuLoad = os.loadavg();

    const events = [];

    if (freeMem < 256 * 1024 * 1024) {
      events.push({ eventType: 'memory', severity: 'critical', message: `Low memory: ${(freeMem / 1024 / 1024).toFixed(0)}MB free` });
    } else if (freeMem < 512 * 1024 * 1024) {
      events.push({ eventType: 'memory', severity: 'warning', message: `Memory getting low: ${(freeMem / 1024 / 1024).toFixed(0)}MB free` });
    }

    return {
      timestamp: new Date().toISOString(),
      system: {
        platform: os.platform(),
        arch: os.arch(),
        hostname: os.hostname(),
        uptime: os.uptime(),
        cpuCores: os.cpus().length,
        cpuLoad: cpuLoad[0],
        totalMemory: totalMem,
        freeMemory: freeMem,
        memoryUsagePercent: parseFloat(memUsagePercent),
      },
      events,
      healthy: events.filter(e => e.severity === 'critical').length === 0,
    };
  }

  static async checkDiskSpace(targetPath) {
    try {
      const stats = fs.statfsSync ? fs.statfsSync(targetPath) : null;
      if (stats) {
        const free = stats.bfree * stats.bsize;
        const total = stats.blocks * stats.bsize;
        const used = total - free;
        return {
          path: targetPath,
          total, free, used,
          usedPercent: ((used / total) * 100).toFixed(1),
          freeGb: (free / 1024 / 1024 / 1024).toFixed(2),
          healthy: free > 1024 * 1024 * 1024,
        };
      }
    } catch {}
    return { path: targetPath, error: 'Unable to check disk space' };
  }

  // ── Acquisition Insights (Feature 27) ──

  static generateInsights(messages, acquisitions, folders) {
    const totalMessages = messages.length;
    const totalSize = messages.reduce((s, m) => s + (m.size || 0), 0);
    const avgSize = totalMessages > 0 ? Math.round(totalSize / totalMessages) : 0;

    const senderCounts = {};
    const folderCounts = {};
    const dateCounts = {};
    const typeCounts = { encrypted: 0, signed: 0, withAttachments: 0, plain: 0 };

    for (const m of messages) {
      const from = m.from_address || m.fromAddress || 'unknown';
      senderCounts[from] = (senderCounts[from] || 0) + 1;

      const folder = m.folder || 'unknown';
      folderCounts[folder] = (folderCounts[folder] || 0) + 1;

      if (m.date) {
        const day = m.date.substring(0, 10);
        dateCounts[day] = (dateCounts[day] || 0) + 1;
      }

      if (m.is_encrypted) typeCounts.encrypted++;
      if (m.is_signed) typeCounts.signed++;
      if (m.has_attachments) typeCounts.withAttachments++;
      else typeCounts.plain++;
    }

    const topSenders = Object.entries(senderCounts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([email, count]) => ({ email, count }));
    const folderDistribution = Object.entries(folderCounts).sort((a, b) => b[1] - a[1]).map(([folder, count]) => ({ folder, count }));

    const dates = Object.keys(dateCounts).sort();
    const dateRange = dates.length > 0 ? { earliest: dates[0], latest: dates[dates.length - 1], span: dates.length } : null;

    const acqDurations = acquisitions.filter(a => a.started_at && a.completed_at).map(a => {
      const start = new Date(a.started_at).getTime();
      const end = new Date(a.completed_at).getTime();
      return { id: a.id, durationMs: end - start, messages: a.acquired_messages || 0 };
    });

    const totalDuration = acqDurations.reduce((s, a) => s + a.durationMs, 0);
    const avgRate = totalDuration > 0 ? Math.round(totalMessages / (totalDuration / 1000)) : 0;

    return {
      timestamp: new Date().toISOString(),
      summary: { totalMessages, totalSize, avgSize, totalAcquisitions: acquisitions.length },
      messageTypes: typeCounts,
      topSenders,
      folderDistribution,
      dateRange,
      performance: { totalDurationMs: totalDuration, avgMessagesPerSecond: avgRate, acquisitions: acqDurations },
      forensicFlags: {
        encryptedMessages: typeCounts.encrypted,
        signedMessages: typeCounts.signed,
        largestMessage: messages.reduce((max, m) => Math.max(max, m.size || 0), 0),
        duplicateSubjects: this._findDuplicateSubjects(messages),
      },
    };
  }

  static _findDuplicateSubjects(messages) {
    const subjects = {};
    for (const m of messages) {
      const s = (m.subject || '').trim().toLowerCase();
      if (s) subjects[s] = (subjects[s] || 0) + 1;
    }
    return Object.entries(subjects).filter(([_, c]) => c > 3).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([subject, count]) => ({ subject, count }));
  }

  // ── Multi-Target Acquisition (Feature 28) ──

  static createBatch(targets) {
    const batchId = uuidv4();
    return {
      batchId,
      targets: targets.map(t => ({
        id: uuidv4(),
        batchId,
        targetEmail: t.email || t.targetEmail,
        providerType: t.provider || t.providerType,
        config: t.config || {},
        status: 'pending',
      })),
      createdAt: new Date().toISOString(),
    };
  }

  // ── Connectivity Testing (Feature 29) ──

  static async testConnectivity(host, port, protocol, options = {}) {
    const result = {
      id: uuidv4(),
      host, port, protocol,
      status: 'testing',
      tested_at: new Date().toISOString(),
    };

    try {
      const start = Date.now();

      // DNS resolution
      const addresses = await new Promise((resolve, reject) => {
        dns.resolve4(host, (err, addrs) => err ? reject(err) : resolve(addrs));
      });
      result.dnsResolved = addresses.join(', ');

      // TCP connection
      const socket = await new Promise((resolve, reject) => {
        const s = net.connect(port, host, () => resolve(s));
        s.setTimeout(options.timeout || 10000);
        s.on('timeout', () => { s.destroy(); reject(new Error('Connection timeout')); });
        s.on('error', reject);
      });

      result.latencyMs = Date.now() - start;

      // TLS upgrade if applicable
      if (protocol === 'imaps' || protocol === 'pop3s' || port === 993 || port === 995 || port === 465) {
        const tlsSocket = await new Promise((resolve, reject) => {
          const s = tls.connect({ socket, servername: host, rejectUnauthorized: false }, () => resolve(s));
          s.on('error', reject);
        });
        result.tlsVersion = tlsSocket.getProtocol();
        const cert = tlsSocket.getPeerCertificate();
        result.certificateInfo = {
          subject: cert.subject?.CN || null,
          issuer: cert.issuer?.O || null,
          validFrom: cert.valid_from,
          validTo: cert.valid_to,
          fingerprint: cert.fingerprint256,
        };
        tlsSocket.destroy();
      } else {
        // Read banner
        const banner = await new Promise((resolve) => {
          let data = '';
          socket.on('data', (chunk) => { data += chunk.toString(); if (data.includes('\r\n')) resolve(data.trim()); });
          setTimeout(() => resolve(data.trim()), 3000);
        });
        if (banner.includes('CAPABILITY')) result.imapCapabilities = banner;
        socket.destroy();
      }

      result.status = 'success';
    } catch (err) {
      result.status = 'failed';
      result.error = err.message;
    }

    return result;
  }

  // ── Proxy Support (Feature 30) ──

  static createProxyAgent(proxyConfig) {
    const { proxyType, host, port, username, password } = proxyConfig;

    if (proxyType === 'none' || !host) return null;

    return {
      type: proxyType,
      host, port,
      auth: username ? { username, password } : null,
      getConnectionOptions(targetHost, targetPort) {
        return {
          proxy: { host, port, type: proxyType },
          target: { host: targetHost, port: targetPort },
          auth: username ? `${username}:${password}` : null,
        };
      },
    };
  }

  // ── Server Profile Auto-Detection (Feature 31) ──

  static async detectServerProfile(email) {
    const domain = email.split('@')[1];
    if (!domain) throw new Error('Invalid email address');

    const profile = {
      id: uuidv4(),
      domain,
      providerName: null,
      mxRecords: [],
      spfRecord: null,
      imapHost: null, imapPort: 993,
      pop3Host: null, pop3Port: 995,
      smtpHost: null, smtpPort: 587,
      autodiscoverUrl: null,
      oauthRequired: false,
      detectedProtocol: null,
      confidence: 0,
    };

    try {
      // MX lookup
      const mx = await new Promise((resolve, reject) => {
        dns.resolveMx(domain, (err, records) => err ? resolve([]) : resolve(records.sort((a, b) => a.priority - b.priority)));
      });
      profile.mxRecords = mx.map(r => ({ priority: r.priority, exchange: r.exchange }));

      // Known provider detection from MX
      const mxStr = mx.map(r => r.exchange.toLowerCase()).join(' ');
      if (mxStr.includes('google') || mxStr.includes('gmail')) {
        profile.providerName = 'Google Workspace';
        profile.imapHost = 'imap.gmail.com';
        profile.smtpHost = 'smtp.gmail.com';
        profile.oauthRequired = true;
        profile.detectedProtocol = 'gmail_api';
        profile.confidence = 0.95;
      } else if (mxStr.includes('outlook') || mxStr.includes('microsoft') || mxStr.includes('protection.outlook')) {
        profile.providerName = 'Microsoft 365';
        profile.imapHost = 'outlook.office365.com';
        profile.smtpHost = 'smtp.office365.com';
        profile.oauthRequired = true;
        profile.detectedProtocol = 'graph';
        profile.confidence = 0.95;
      } else if (mxStr.includes('yahoo')) {
        profile.providerName = 'Yahoo Mail';
        profile.imapHost = 'imap.mail.yahoo.com';
        profile.smtpHost = 'smtp.mail.yahoo.com';
        profile.oauthRequired = true;
        profile.detectedProtocol = 'imap';
        profile.confidence = 0.9;
      } else if (mxStr.includes('zoho')) {
        profile.providerName = 'Zoho Mail';
        profile.imapHost = 'imap.zoho.com';
        profile.smtpHost = 'smtp.zoho.com';
        profile.detectedProtocol = 'imap';
        profile.confidence = 0.9;
      } else if (mxStr.includes('fastmail')) {
        profile.providerName = 'Fastmail';
        profile.imapHost = 'imap.fastmail.com';
        profile.smtpHost = 'smtp.fastmail.com';
        profile.detectedProtocol = 'jmap';
        profile.confidence = 0.9;
      } else if (mx.length > 0) {
        profile.imapHost = `imap.${domain}`;
        profile.pop3Host = `pop3.${domain}`;
        profile.smtpHost = `smtp.${domain}`;
        profile.detectedProtocol = 'imap';
        profile.confidence = 0.3;
      }

      // SPF lookup
      try {
        const txt = await new Promise((resolve, reject) => {
          dns.resolveTxt(domain, (err, records) => err ? resolve([]) : resolve(records));
        });
        const spf = txt.flat().find(r => r.startsWith('v=spf1'));
        if (spf) profile.spfRecord = spf;
      } catch {}

      // Autodiscover for Exchange
      profile.autodiscoverUrl = `https://autodiscover.${domain}/autodiscover/autodiscover.xml`;

    } catch (err) {
      profile.error = err.message;
    }

    return profile;
  }

  // ── Exchange AutoDiscover ──

  static async exchangeAutoDiscover(email) {
    const domain = email.split('@')[1];
    if (!domain) throw new Error('Invalid email');

    const urls = [
      `https://${domain}/autodiscover/autodiscover.xml`,
      `https://autodiscover.${domain}/autodiscover/autodiscover.xml`,
      `http://autodiscover.${domain}/autodiscover/autodiscover.xml`,
    ];

    const autoDiscoverXml = `<?xml version="1.0" encoding="utf-8"?><Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/requestschema/2006"><Request><EMailAddress>${email}</EMailAddress><AcceptableResponseSchema>http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a</AcceptableResponseSchema></Request></Autodiscover>`;

    for (const url of urls) {
      try {
        const body = await this._httpPost(url, autoDiscoverXml, { 'Content-Type': 'text/xml' }, 10000);
        const ewsMatch = body.match(/<EwsUrl>(.*?)<\/EwsUrl>/);
        const oabMatch = body.match(/<OABUrl>(.*?)<\/OABUrl>/);
        const asMatch = body.match(/<ASUrl>(.*?)<\/ASUrl>/);
        const serverMatch = body.match(/<Server>(.*?)<\/Server>/);

        if (ewsMatch || serverMatch) {
          return {
            email, domain,
            discovered: true,
            ewsUrl: ewsMatch?.[1] || null,
            oabUrl: oabMatch?.[1] || null,
            activeSyncUrl: asMatch?.[1] || null,
            server: serverMatch?.[1] || null,
            discoveredFrom: url,
          };
        }
      } catch {}
    }

    // SRV record fallback
    try {
      const srv = await new Promise((resolve, reject) => {
        dns.resolveSrv(`_autodiscover._tcp.${domain}`, (err, records) => err ? reject(err) : resolve(records));
      });
      if (srv.length > 0) {
        return {
          email, domain, discovered: true,
          server: srv[0].name,
          port: srv[0].port,
          discoveredFrom: 'SRV',
        };
      }
    } catch {}

    return { email, domain, discovered: false };
  }

  static _httpPost(url, body, headers = {}, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const transport = parsed.protocol === 'https:' ? https : http;
      const req = transport.request({
        hostname: parsed.hostname, port: parsed.port, path: parsed.pathname,
        method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
        timeout, rejectUnauthorized: false,
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 400) resolve(Buffer.concat(chunks).toString());
          else reject(new Error(`HTTP ${res.statusCode}`));
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.write(body);
      req.end();
    });
  }

  // ── Session/Output Naming ──

  static createSessionName(projectName, targetEmail, options = {}) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const sanitized = (projectName || 'SherlockMail').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
    const emailPart = targetEmail ? targetEmail.split('@')[0].replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 30) : '';
    const counter = options.counter ? `_${String(options.counter).padStart(3, '0')}` : '';
    return `${sanitized}_${emailPart}_${timestamp}${counter}`;
  }

  static createOutputFolder(baseDir, projectName, targetEmail, options = {}) {
    const sessionName = this.createSessionName(projectName, targetEmail, options);
    const outputPath = `${baseDir}/${sessionName}`;
    fs.mkdirSync(outputPath, { recursive: true });

    const subfolders = ['eml', 'attachments', 'metadata', 'logs', 'reports', 'containers'];
    for (const sub of subfolders) fs.mkdirSync(`${outputPath}/${sub}`, { recursive: true });

    return { sessionName, outputPath, subfolders: subfolders.map(s => `${outputPath}/${s}`) };
  }
}
