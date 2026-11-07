import net from 'net';
import { Agent, ProxyAgent, Socks5ProxyAgent, setGlobalDispatcher } from 'undici';
import { SocksClient } from 'socks';

// The proxy every outgoing connection uses. REST protocols go through the global fetch dispatcher, IMAP
// through imapflow's own proxy option and POP3 through connectThroughProxy.
let current = null;

const CONNECT_TIMEOUT_MS = 30000;

function proxyUrl(p) {
  const auth = p.username ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password || '')}@` : '';
  return `${p.proxyType}://${auth}${p.host}:${p.port}`;
}

export function describeProxy(p = current) {
  return p ? `${p.proxyType}://${p.host}:${p.port}${p.username ? ` (as ${p.username})` : ''}` : 'none (direct connection)';
}

export function applyProxy(settings) {
  const active = settings && settings.proxyType && settings.proxyType !== 'none' && settings.host ? settings : null;
  if (active && !['http', 'https', 'socks5'].includes(active.proxyType)) {
    throw new Error(`Unsupported proxy type ${active.proxyType}. Use http, https or socks5.`);
  }
  if (active && !(active.port > 0)) throw new Error('The proxy needs a port number');
  current = active;
  if (!active) setGlobalDispatcher(new Agent());
  else if (active.proxyType === 'socks5') setGlobalDispatcher(new Socks5ProxyAgent(proxyUrl(active)));
  else setGlobalDispatcher(new ProxyAgent(proxyUrl(active)));
  return describeProxy();
}

export function mailProxyUrl() {
  return current ? proxyUrl(current) : undefined;
}

// A TCP tunnel to host:port through the configured proxy, or null when connecting directly.
export async function connectThroughProxy(host, port) {
  if (!current) return null;
  if (current.proxyType === 'socks5') {
    const { socket } = await SocksClient.createConnection({
      proxy: { host: current.host, port: current.port, type: 5, userId: current.username || undefined, password: current.password || undefined },
      command: 'connect',
      destination: { host, port },
      timeout: CONNECT_TIMEOUT_MS,
    });
    return socket;
  }
  return new Promise((resolve, reject) => {
    const socket = net.connect(current.port, current.host);
    const fail = (err) => { socket.destroy(); reject(err); };
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => fail(new Error('The proxy did not answer in time')));
    socket.once('error', fail);
    socket.once('connect', () => {
      const auth = current.username ? `Proxy-Authorization: Basic ${Buffer.from(`${current.username}:${current.password || ''}`).toString('base64')}\r\n` : '';
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
    });
    let buf = '';
    const onData = (d) => {
      buf += d.toString('latin1');
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.removeListener('data', onData);
      socket.removeListener('error', fail);
      socket.setTimeout(0);
      if (!/^HTTP\/1\.[01] 200/.test(buf)) return fail(new Error(`The proxy refused the connection: ${buf.split('\r\n')[0]}`));
      // Hold what the server sends until the caller is listening; bytes after the proxy's answer are the server's.
      socket.pause();
      if (buf.length > end + 4) socket.unshift(Buffer.from(buf.slice(end + 4), 'latin1'));
      resolve(socket);
    };
    socket.on('data', onData);
  });
}
