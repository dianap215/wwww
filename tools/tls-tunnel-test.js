/**
 * Push real traffic through the relay and prove it comes back.
 *
 *   deno run --allow-net --allow-env tools/tls-tunnel-test.js <base-url> <uuid> [host:port]
 *
 * The DNS test proves TCP works to one IP literal. What a proxy actually does is
 * dial arbitrary hosts and carry whatever the client sends. Success here is
 * deliberately weak — *any* bytes returned by the upstream — because an upstream
 * is entitled to answer with a TLS alert or a redirect. The point is to prove
 * bidirectional flow, not that the upstream liked our probe.
 */
import { clientHello } from './_tls-wire.mjs';

const raw = Deno.args[0] || Deno.env.get('BK_BASE');
const uuid = Deno.args[1] || Deno.env.get('BK_UUID');
const target = Deno.args[2] || Deno.env.get('BK_TARGET') || 'example.com:80';

if (!raw || !uuid) {
  console.error('usage: tls-tunnel-test.js <https://app.deno.net> <uuid> [host:port]');
  Deno.exit(2);
}

const base = raw.replace(/\/+$/, '');
const path = Deno.env.get('BK_RELAY_PATH') || '/bk-ws';
const wsBase = base.replace(/^http/, 'ws');
const [host, portArg] = target.split(':');
const port = Number(portArg || 443);

const b64url = (bytes) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const uuidBytes = uuid.replace(/-/g, '').match(/../g).map((h) => parseInt(h, 16));
const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(host);

// VLESS address types: 0x01 = 4 raw bytes, 0x02 = [len][domain], 0x03 = 16 bytes.
// 0x02 is a single length byte followed by the whole domain — NOT
// length-prefixed labels, which is a different (Socks5) encoding.
const addressBytes = isIp
  ? [0x01, ...host.split('.').map(Number)]
  : [0x02, host.length, ...[...host].map((c) => c.charCodeAt(0))];

const header = new Uint8Array([
  0x00, ...uuidBytes, 0x00, 0x01,
  (port >> 8) & 0xff, port & 0xff,
  ...addressBytes,
]);

// Match the probe to the port: a plain HTTP request on 80, a ClientHello on 443.
const isTlsPort = port !== 80 && port !== 8080;
const probe = isTlsPort
  ? clientHello(host)
  : new TextEncoder().encode(
      `GET / HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: relay-test\r\nConnection: close\r\n\r\n`,
    );

console.log(`Tunnel test: ${base}${path}  ->  ${host}:${port}`);
console.log(`Probe: ${isTlsPort ? 'TLS ClientHello' : 'plain HTTP request'}\n`);

const outcome = await new Promise((resolve) => {
  const ws = new WebSocket(`${wsBase}${path}`);
  const chunks = [];
  let opened = false;

  const total = () => chunks.reduce((n, c) => n + c.length, 0);

  const timer = setTimeout(() => {
    try { ws.close(); } catch {}
    resolve({ stage: 'timeout', bytes: total() });
  }, 20000);

  ws.onopen = () => {
    opened = true;
    const frame = new Uint8Array(header.length + probe.length);
    frame.set(header, 0);
    frame.set(probe, header.length);
    ws.send(frame);
  };

  ws.onmessage = async (event) => {
    const data = event.data instanceof Blob ? new Uint8Array(await event.data.arrayBuffer()) : new Uint8Array(event.data);
    chunks.push(data);
    // The worker prefixes a 2-byte VLESS response header before piping.
    const body = total() - 2;
    if (body > 0) {
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve({ stage: 'data', bytes: body });
    }
  };

  ws.onclose = (event) => {
    clearTimeout(timer);
    resolve({ stage: opened ? 'closed' : 'rejected', code: event.code, bytes: total() });
  };

  ws.onerror = () => {
    clearTimeout(timer);
    resolve({ stage: 'error', bytes: 0 });
  };
});

const VERDICTS = {
  data: () => `[PASS] ${outcome.bytes} bytes relayed back from ${host}:${port} — the tunnel is live`,
  closed: () => `[FAIL] socket opened then closed (code ${outcome.code}, ${outcome.bytes} bytes) — the upstream dial failed`,
  rejected: () => `[FAIL] handshake rejected (code ${outcome.code}) — path or UUID mismatch`,
  error: () => '[FAIL] connection error before any upgrade',
  timeout: () => `[FAIL] no reply within 20s — the worker never reached ${host}:${port}`,
};

console.log(`  ${VERDICTS[outcome.stage]?.() ?? outcome.stage}`);

if (outcome.stage === 'data') {
  console.log('         Domain dialling and bidirectional flow both work for real proxy traffic.');
}
Deno.exit(outcome.stage === 'data' ? 0 : 1);
