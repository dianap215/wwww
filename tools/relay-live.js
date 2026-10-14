/**
 * Full VLESS relay round-trip against a live deployment.
 *
 *   deno run --allow-net --allow-env tools/relay-live.js <base-url> <uuid> [target]
 *
 * This is the decisive test for "configs connect but nothing pings": the HTTP
 * handshake succeeding only proves Deno Deploy forwards WebSocket upgrades. The
 * tunnel is only alive if the worker can open a raw TCP connection to the
 * target address, and that is the part no serverless edge guarantees.
 *
 * The target defaults to 1.1.1.1:53 over plain TCP — a DNS query we can send and
 * recognise a reply to, with no TLS to complicate it.
 */
import { encodeDnsQuery, looksLikeDnsReply } from './_dns-wire.mjs';

const raw = Deno.args[0] || Deno.env.get('BK_BASE');
const uuid = Deno.args[1] || Deno.env.get('BK_UUID');
const [host, portArg] = (Deno.args[2] || '1.1.1.1:53').split(':');

if (!raw || !uuid) {
  console.error('usage: relay-live.js <https://app.deno.net> <vless-uuid> [host:port]');
  Deno.exit(2);
}

const base = raw.replace(/\/+$/, '');
const wsBase = base.replace(/^http/, 'ws');
const port = Number(portArg || 53);

/** base64url of raw bytes */
const b64url = (bytes) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

// ------------------------------------------------------- build the VLESS header
// [version][uuid 16][addon-len=0][cmd=1 TCP][port 2][atype=1 IPv4][addr]
function ipv4Header(addr) {
  return new Uint8Array([
    0x00,
    ...uuid.replace(/-/g, '').match(/../g).map((h) => parseInt(h, 16)),
    0x00,
    0x01,
    (port >> 8) & 0xff,
    port & 0xff,
    0x01,
    ...addr.split('.').map(Number),
  ]);
}

function domainHeader(domain) {
  const labels = domain.split('.');
  const bytes = labels.flatMap((l) => [l.length, ...[...l].map((c) => c.charCodeAt(0))]);
  return new Uint8Array([
    0x00,
    ...uuid.replace(/-/g, '').match(/../g).map((h) => parseInt(h, 16)),
    0x00,
    0x01,
    (port >> 8) & 0xff,
    port & 0xff,
    0x02,
    ...bytes,
  ]);
}

const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(host);
const header = isIp ? ipv4Header(host) : domainHeader(host);

// The subprotocol carries the header *and* the first payload; the worker parses
// the header out of it and writes the remainder to the upstream socket.
const query = encodeDnsQuery('example.com', 1);
const early = new Uint8Array(header.length + query.length);
early.set(header, 0);
early.set(query, header.length);

// Real clients (v2rayNG, Hiddify, NekoBox) negotiate no subprotocol and send the
// VLESS request as their FIRST BINARY FRAME instead. That is a different code
// path in the worker, so test it separately.
const HEADER_IN_FIRST_MESSAGE = Deno.env.get('BK_EARLY_DATA') !== '1';

console.log(`Relay test: ${base}/bk-ws  ->  ${host}:${port}`);
console.log(`Header delivery: ${HEADER_IN_FIRST_MESSAGE ? 'first binary message (real clients)' : 'subprotocol early data'}\n`);

const outgoing = HEADER_IN_FIRST_MESSAGE
  ? early                                  // sent as a frame once open
  : null;                                  // never sent: it is in the subprotocol
const protocols = HEADER_IN_FIRST_MESSAGE ? undefined : [b64url(early)];

console.log(`Relay test: ${base}/bk-ws  ->  ${host}:${port}\n`);

const outcome = await new Promise((resolve) => {
  const ws = new WebSocket(`${wsBase}/bk-ws`, protocols);
  const chunks = [];
  let sawOpen = false;

  const flatten = () => {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const flat = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) { flat.set(c, offset); offset += c.length; }
    return flat;
  };

  const timer = setTimeout(() => {
    try { ws.close(); } catch {}
    resolve({ stage: 'timeout', bytes: flatten().length });
  }, 20000);

  ws.onopen = () => {
    sawOpen = true;
    if (outgoing) ws.send(outgoing);
  };

  ws.onmessage = async (event) => {
    const data = event.data instanceof Blob ? new Uint8Array(await event.data.arrayBuffer()) : new Uint8Array(event.data);
    chunks.push(data);
    // The worker prefixes a 2-byte VLESS response header before piping.
    const body = flatten().subarray(Math.min(2, flatten().length));
    if (looksLikeDnsReply(body)) {
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve({ stage: 'replied', bytes: flatten().length, body });
    }
  };

  ws.onclose = (event) => {
    clearTimeout(timer);
    resolve({
      stage: sawOpen ? 'closed' : 'rejected',
      code: event.code,
      bytes: chunks.reduce((n, c) => n + c.length, 0),
    });
  };

  ws.onerror = () => {
    clearTimeout(timer);
    resolve({ stage: 'error', bytes: 0 });
  };
});

switch (outcome.stage) {
  case 'replied':
    console.log(`  [PASS] upstream replied — ${outcome.bytes} bytes came back from ${host}:${port}`);
    console.log('         Raw outbound TCP from the worker works; the relay is healthy.');
    break;
  case 'closed':
    console.log(`  [FAIL] socket opened then closed (code ${outcome.code}) after ${outcome.bytes} bytes`);
    console.log('         The worker accepted the tunnel but the upstream connect failed.');
    break;
  case 'rejected':
    console.log(`  [FAIL] handshake rejected (code ${outcome.code}) — path or UUID mismatch`);
    break;
  case 'error':
    console.log('  [FAIL] connection error before any upgrade');
    break;
  default:
    console.log(`  [FAIL] ${outcome.stage} — ${outcome.bytes} bytes received, no reply`);
    console.log('         The worker never returned data from the upstream socket.');
}

Deno.exit(outcome.stage === 'replied' ? 0 : 1);
