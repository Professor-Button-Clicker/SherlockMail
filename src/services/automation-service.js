import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import dns from 'dns';
import net from 'net';
import tls from 'tls';
import os from 'os';
import nodemailer from 'nodemailer';

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
    const { host, port, secure, username, password, fromAddress, toAddresses, allowUnverifiedCertificate } = smtpSettings;
    const recipients = typeof toAddresses === 'string' ? JSON.parse(toAddresses) : toAddresses;
    if (!host) return { success: false, error: 'SMTP host is required' };
    if (!recipients?.length) return { success: false, error: 'At least one recipient is required' };
    const subject = this._buildSubject(notification);
    try {
      const transport = nodemailer.createTransport({
        host,
        port: Number(port) || (secure ? 465 : 587),
        secure: !!secure,
        // Not implicit TLS: STARTTLS is used, and required unless the server is on this computer.
        requireTLS: !secure && !/^(localhost|127\.\d+\.\d+\.\d+|::1)$/.test(host),
        auth: username ? { user: username, pass: password } : undefined,
        tls: { rejectUnauthorized: !allowUnverifiedCertificate },
        connectionTimeout: 30000,
        socketTimeout: 60000,
      });
      const info = await transport.sendMail({
        from: fromAddress,
        to: recipients,
        subject,
        text: this._buildBodyText(notification),
        html: this._buildBodyHtml(notification),
        headers: { 'X-Mailer': 'SherlockMail v0.10.0' },
      });
      transport.close();
      if (info.rejected?.length) return { success: false, error: `Rejected: ${info.rejected.join(', ')}`, accepted: info.accepted };
      return { success: true, recipients: info.accepted.length, subject, messageId: info.messageId };
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
    const h = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<html><body style="font-family:Arial,sans-serif"><h2>SherlockMail Notification</h2><table border="1" cellpadding="6" style="border-collapse:collapse"><tr><td><b>Type</b></td><td>${h(n.type)}</td></tr><tr><td><b>Project</b></td><td>${h(n.projectName || 'N/A')}</td></tr><tr><td><b>Time</b></td><td>${new Date().toISOString()}</td></tr></table>${n.details ? `<pre>${h(JSON.stringify(n.details, null, 2))}</pre>` : ''}</body></html>`;
  }

  // ── Health Monitoring (Feature 26) ──

  static checkHealth() {
    const freeMem = os.freemem();
    const totalMem = os.totalmem();
    const memUsagePercent = ((totalMem - freeMem) / totalMem * 100).toFixed(1);
    // Windows has no load average; os.loadavg() reports 0 there, which would read as an idle machine.
    const cpuLoad = process.platform === 'win32' ? null : os.loadavg()[0];

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
        cpuLoad,
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
    const result = { id: uuidv4(), host, port, protocol, status: 'testing', tested_at: new Date().toISOString() };
    const timeout = options.timeout || 10000;
    let socket = null;
    try {
      const start = Date.now();
      // The operating system's resolver, as a real connection would use: hosts files and IPv6 count.
      const addresses = await dns.promises.lookup(host, { all: true });
      result.dnsResolved = addresses.map(a => a.address).join(', ');

      socket = await new Promise((resolve, reject) => {
        const s = net.connect(port, host, () => resolve(s));
        s.setTimeout(timeout);
        s.on('timeout', () => { s.destroy(); reject(new Error('Connection timed out')); });
        s.on('error', reject);
      });
      result.latencyMs = Date.now() - start;

      const implicitTls = ['imaps', 'pop3s', 'smtps', 'https'].includes(protocol) || (!['imap', 'pop3', 'smtp'].includes(protocol) && [993, 995, 465, 443].includes(Number(port)));
      if (implicitTls) {
        const secure = await new Promise((resolve, reject) => {
          const s = tls.connect({ socket, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false }, () => resolve(s));
          s.on('error', err => reject(err.code?.startsWith('ERR_SSL') ? new Error(`The server does not speak TLS on port ${port}`) : err));
          s.setTimeout(timeout, () => { s.destroy(); reject(new Error('The TLS handshake timed out')); });
        });
        socket = secure;
        result.tlsVersion = secure.getProtocol();
        // Connecting does not depend on it, but a certificate that fails verification is a finding.
        result.certificateValid = secure.authorized;
        result.certificateError = secure.authorized ? null : String(secure.authorizationError || '');
        const cert = secure.getPeerCertificate();
        result.certificateInfo = { subject: cert.subject?.CN || null, issuer: cert.issuer?.O || cert.issuer?.CN || null, validFrom: cert.valid_from, validTo: cert.valid_to, fingerprint: cert.fingerprint256 };
      }
      // IMAP, POP3 and SMTP greet first; HTTPS does not.
      if (![443, 80].includes(Number(port))) {
        result.banner = await new Promise((resolve) => {
          let data = '';
          socket.on('data', (chunk) => { data += chunk.toString('latin1'); if (data.includes('\r\n')) resolve(data.trim()); });
          setTimeout(() => resolve(data.trim()), 3000);
        });
      }
      result.status = 'success';
    } catch (err) {
      result.status = 'failed';
      result.error = err.message;
    } finally {
      socket?.destroy();
    }
    return result;
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

      // The conventional address to try; whether it answers is what /exchange/autodiscover checks.
      profile.autodiscoverUrl = `https://autodiscover.${domain}/autodiscover/autodiscover.xml`;

    } catch (err) {
      profile.error = err.message;
    }

    return profile;
  }

  // ── Exchange AutoDiscover ──

  // POX Autodiscover needs the mailbox's credentials on most servers; a 401 without them is reported as such.
  static async exchangeAutoDiscover(email, password) {
    const domain = email.split('@')[1];
    if (!domain) throw new Error('Invalid email');

    const urls = [
      `https://${domain}/autodiscover/autodiscover.xml`,
      `https://autodiscover.${domain}/autodiscover/autodiscover.xml`,
    ];
    const xmlEscape = v => v.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const request = `<?xml version="1.0" encoding="utf-8"?><Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/requestschema/2006"><Request><EMailAddress>${xmlEscape(email)}</EMailAddress><AcceptableResponseSchema>http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a</AcceptableResponseSchema></Request></Autodiscover>`;
    const headers = { 'Content-Type': 'text/xml' };
    if (password) headers.Authorization = `Basic ${Buffer.from(`${email}:${password}`).toString('base64')}`;
    const attempts = [];

    for (const url of urls) {
      try {
        const res = await fetch(url, { method: 'POST', headers, body: request, signal: AbortSignal.timeout(10000) });
        attempts.push({ url, status: res.status });
        if (!res.ok) continue;
        const body = await res.text();
        const ewsMatch = body.match(/<EwsUrl>(.*?)<\/EwsUrl>/);
        const serverMatch = body.match(/<Server>(.*?)<\/Server>/);
        if (ewsMatch || serverMatch) {
          return {
            email, domain, discovered: true,
            ewsUrl: ewsMatch?.[1] || null,
            oabUrl: body.match(/<OABUrl>(.*?)<\/OABUrl>/)?.[1] || null,
            activeSyncUrl: body.match(/<ASUrl>(.*?)<\/ASUrl>/)?.[1] || null,
            server: serverMatch?.[1] || null,
            discoveredFrom: url,
            attempts,
          };
        }
      } catch (err) {
        attempts.push({ url, error: err.message });
      }
    }

    try {
      const srv = await dns.promises.resolveSrv(`_autodiscover._tcp.${domain}`);
      if (srv.length > 0) return { email, domain, discovered: true, server: srv[0].name, port: srv[0].port, discoveredFrom: 'SRV', attempts };
    } catch { /* no SRV record: not discovered */ }

    return { email, domain, discovered: false, attempts, needsPassword: !password && attempts.some(a => a.status === 401) };
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
