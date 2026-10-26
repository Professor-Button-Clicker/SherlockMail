import net from 'net';
import tls from 'tls';
import { buildMessageRecord } from '../services/collection-engine.js';

const CRLF = Buffer.from('\r\n');
const TERMINATOR = Buffer.from('\r\n.\r\n');
const MAX_LOG_ENTRIES = 5000;
const IDLE_TIMEOUT_MS = 120000;

// RFC 1939 byte-stuffing: the server prefixes every line starting with "." with another ".".
function unstuff(buf) {
  if (buf[0] !== 0x2e && buf.indexOf('\r\n.') < 0) return buf;
  const out = Buffer.allocUnsafe(buf.length);
  let o = 0;
  let i = 0;
  while (i < buf.length) {
    if (buf[i] === 0x2e) i++;
    const nl = buf.indexOf(0x0a, i);
    const end = nl < 0 ? buf.length : nl + 1;
    buf.copy(out, o, i, end);
    o += end - i;
    i = end;
  }
  return out.subarray(0, o);
}

export class Pop3Handler {
  constructor(config) {
    this.config = config;
    this.socket = null;
    this.protocolLog = [];
    this.pending = [];
    this.capabilities = new Set();
    this.buf = Buffer.alloc(0);
    this.start = 0;
    this.len = 0;
  }

  log(direction, message) {
    if (this.protocolLog.length >= MAX_LOG_ENTRIES) this.protocolLog.splice(0, this.protocolLog.length - MAX_LOG_ENTRIES + 1);
    this.protocolLog.push({ timestamp: new Date().toISOString(), direction, message });
  }

  append(chunk) {
    if (this.start === this.len) { this.start = 0; this.len = 0; }
    if (this.len + chunk.length > this.buf.length) {
      const live = this.len - this.start;
      const next = Buffer.allocUnsafe(Math.max(this.buf.length * 2, live + chunk.length, 65536));
      this.buf.copy(next, 0, this.start, this.len);
      this.buf = next;
      this.start = 0;
      this.len = live;
    }
    chunk.copy(this.buf, this.len);
    this.len += chunk.length;
  }

  drain() {
    while (this.pending.length) {
      const req = this.pending[0];
      const data = this.buf.subarray(this.start, this.len);
      const lineEnd = data.indexOf(CRLF);
      if (lineEnd < 0) return;
      const status = data.subarray(0, lineEnd).toString('latin1');

      if (!req.multi || !status.startsWith('+OK')) {
        this.start += lineEnd + 2;
        this.pending.shift();
        this.settle(req, status, null);
        continue;
      }

      const term = data.indexOf(TERMINATOR, Math.max(lineEnd, req.scanFrom || 0));
      if (term < 0) {
        req.scanFrom = Math.max(lineEnd, data.length - TERMINATOR.length);
        return;
      }
      const body = unstuff(Buffer.from(data.subarray(lineEnd + 2, term + 2)));
      this.start += term + TERMINATOR.length;
      this.pending.shift();
      this.settle(req, status, body);
    }
  }

  settle(req, status, body) {
    this.log('S→C', body ? `${status} [+ ${body.length} bytes]` : status);
    if (status.startsWith('-ERR')) req.reject(new Error(status));
    else req.resolve({ status, body });
  }

  failAll(err) {
    const pending = this.pending;
    this.pending = [];
    for (const req of pending) req.reject(err);
  }

  request(command, multi = false) {
    return new Promise((resolve, reject) => {
      if (command !== null && (!this.socket || this.socket.destroyed)) {
        reject(new Error('POP3 connection is closed'));
        return;
      }
      this.pending.push({ multi, resolve, reject });
      if (command !== null) {
        this.log('C→S', command.startsWith('PASS ') ? 'PASS ****' : command);
        this.socket.write(command + '\r\n');
      }
    });
  }

  async connect() {
    const { host, port } = this.config;
    const secure = (this.config.useTls ?? this.config.tls) !== false;
    const connectPort = port || (secure ? 995 : 110);

    this.pending = [];
    this.start = 0;
    this.len = 0;
    this.socket = secure
      ? tls.connect({ host, port: connectPort, rejectUnauthorized: false })
      : net.createConnection({ host, port: connectPort });
    const socket = this.socket;
    socket.setTimeout(IDLE_TIMEOUT_MS, () => socket.destroy(new Error(`POP3 idle timeout after ${IDLE_TIMEOUT_MS / 1000}s`)));
    socket.on('data', (chunk) => { if (this.socket === socket) { this.append(chunk); this.drain(); } });
    socket.on('error', (err) => { if (this.socket === socket) this.failAll(err); });
    socket.on('close', () => { if (this.socket === socket) this.failAll(new Error('POP3 connection closed')); });

    try {
      return await this.handshake();
    } catch (err) {
      socket.destroy();
      if (this.socket === socket) this.socket = null;
      throw err;
    }
  }

  async handshake() {
    const { username, password, email } = this.config;
    await this.request(null);
    this.capabilities = new Set();
    try {
      const { body } = await this.request('CAPA', true);
      for (const line of body.toString('latin1').split('\r\n')) {
        if (line) this.capabilities.add(line.split(' ')[0].toUpperCase());
      }
    } catch {
      // CAPA is optional (RFC 2449); servers without it get no pipelining.
    }

    await this.request(`USER ${username || email}`);
    await this.request(`PASS ${password}`);

    const { status } = await this.request('STAT');
    const [, count, size] = status.match(/\+OK\s+(\d+)\s+(\d+)/) || [null, '0', '0'];
    this.log('CLIENT', `Connected. ${count} messages, ${size} bytes${this.capabilities.has('PIPELINING') ? ', pipelining enabled' : ''}`);
    return { success: true, messageCount: parseInt(count), totalSize: parseInt(size) };
  }

  async ensureConnected() {
    if (!this.socket || this.socket.destroyed) await this.connect();
  }

  async listMessages() {
    const { body } = await this.request('LIST', true);
    return body.toString('latin1').split('\r\n').filter(Boolean).map(line => {
      const [num, size] = line.split(' ');
      return { number: parseInt(num), size: parseInt(size) };
    });
  }

  async listUidls() {
    try {
      const { body } = await this.request('UIDL', true);
      const map = new Map();
      for (const line of body.toString('latin1').split('\r\n')) {
        const sp = line.indexOf(' ');
        if (sp > 0) map.set(parseInt(line.slice(0, sp)), line.slice(sp + 1).trim());
      }
      return map;
    } catch {
      return new Map();
    }
  }

  async enumerate(_folder, { limit } = {}) {
    await this.ensureConnected();
    const list = await this.listMessages();
    const uidls = await this.listUidls();
    let refs = list.map(m => ({ key: String(m.number), uid: m.number, serviceId: uidls.get(m.number) || null, size: m.size }));
    if (limit > 0) refs = refs.slice(0, limit);
    return { key: 'INBOX', refs };
  }

  async fetchBatch(_key, refs, deliver) {
    const out = [];
    const emit = deliver || (item => out.push(item));
    let delivered = 0;
    let firstError = null;
    const retrieve = (ref) => this.request(`RETR ${ref.uid}`, true).then(
      ({ body }) => { delivered++; emit({ ref, raw: body, meta: { flags: [] } }); },
      (err) => { firstError = firstError || err; },
    );
    if (this.capabilities.has('PIPELINING')) {
      await Promise.all(refs.map(retrieve));
    } else {
      for (const ref of refs) await retrieve(ref);
    }
    if (!delivered && firstError) throw firstError;
    return out;
  }

  async fetchMessage(messageNumber) {
    const { body } = await this.request(`RETR ${messageNumber}`, true);
    return buildMessageRecord(body, { uid: messageNumber, folder: 'INBOX', flags: [] });
  }

  async disconnect() {
    if (this.socket) {
      try { if (!this.socket.destroyed) await this.request('QUIT'); } catch {}
      this.socket.destroy();
      this.socket = null;
      this.log('CLIENT', 'Disconnected');
    }
  }

  getProtocolLog() {
    return this.protocolLog;
  }

  static getProviderPresets() {
    return {
      gmail: { host: 'pop.gmail.com', port: 995, useTls: true },
      outlook: { host: 'outlook.office365.com', port: 995, useTls: true },
      yahoo: { host: 'pop.mail.yahoo.com', port: 995, useTls: true },
      aol: { host: 'pop.aol.com', port: 995, useTls: true },
      zoho: { host: 'pop.zoho.com', port: 995, useTls: true },
      fastmail: { host: 'pop.fastmail.com', port: 995, useTls: true },
      yandex: { host: 'pop.yandex.com', port: 995, useTls: true },
      custom: { host: '', port: 995, useTls: true },
    };
  }
}
