/**
 * Hermetic proof of the DoH path, with no internet involved.
 *
 * The panel proxies `/dns-query` to whatever upstream is configured in
 * `config:dns_doh`, through `env.DNS_FETCH || fetch`. That indirection is the
 * only part this Deno build touches, so this test runs the real worker module
 * in-process against a mock upstream on loopback and asserts the answer came
 * back. It passes on a machine with no outbound internet, and it does not need
 * a running server.
 *
 *   deno task dns
 */
import worker from '../src/worker.js';

const MARKER = new TextEncoder().encode('BK-MOCK-ANSWER');

// ------------------------------------------------------------ mock upstream
const hits = [];
const upstream = Deno.serve(
  { hostname: '127.0.0.1', port: 0, onListen: () => {} },
  async (req) => {
    const query = new Uint8Array(await req.arrayBuffer());
    hits.push({ method: req.method, url: req.url, bytes: query.length });
    // Query bytes, then a marker. The worker passes the body through untouched,
    // so finding the marker on the far side proves the round trip.
    const body = new Uint8Array(query.length + MARKER.length);
    body.set(query, 0);
    body.set(MARKER, query.length);
    return new Response(body, { headers: { 'Content-Type': 'application/dns-message' } });
  },
);
const upstreamUrl = `http://127.0.0.1:${upstream.addr.port}/dns-query`;

// ------------------------------------------------------------ memory KV
function memoryKv(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    envOverrides: true,
    async get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async put(key, value) {
      map.set(key, String(value));
      return true;
    },
    async delete(key) {
      return map.delete(key);
    },
  };
}

const env = {
  BK_KV: memoryKv({
    'config:dns_doh': upstreamUrl,
    'config:sub_token': 'test-sub-token',
  }),
  PANEL_PASSWORD: '',
  JWT_SECRET: '',
  // The worker calls env.DNS_FETCH first and only falls back to the global
  // fetch — the same hook src/shims/dns-fetch.js occupies in production.
  DNS_FETCH: (url, init) => fetch(url, { ...init, signal: init?.signal || AbortSignal.timeout(10_000) }),
};
env.WD_KV = env.BK_KV;

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };

let failures = 0;
function report(label, ok, detail = '') {
  if (!ok) failures++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
}

console.log(`Mock DoH upstream -> ${upstreamUrl}\n`);

// A real DNS query for example.com A.
const query = new Uint8Array([
  0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x07, 0x65, 0x78, 0x61, 0x6d, 0x70, 0x6c, 0x65, 0x03, 0x63, 0x6f, 0x6d,
  0x00, 0x00, 0x01, 0x00, 0x01,
]);

function containsMarker(bytes) {
  outer: for (let i = 0; i + MARKER.length <= bytes.length; i++) {
    for (let j = 0; j < MARKER.length; j++) if (bytes[i + j] !== MARKER[j]) continue outer;
    return true;
  }
  return false;
}

console.log('worker /dns-query');

const post = await worker.fetch(
  new Request('http://panel.test/dns-query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/dns-message', Accept: 'application/dns-message' },
    body: query,
  }),
  env,
  ctx,
);
const postBody = new Uint8Array(await post.arrayBuffer());
report('POST application/dns-message reaches the upstream', post.status === 200 && containsMarker(postBody), `HTTP ${post.status}, ${postBody.length} bytes`);
report('upstream saw exactly one request', hits.length === 1, JSON.stringify(hits[0] ?? null));

// GET /dns-query?dns=<base64url> is the RFC 8484 form browsers and Android use.
const b64 = btoa(String.fromCharCode(...query)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const get = await worker.fetch(new Request(`http://panel.test/dns-query?dns=${b64}`), env, ctx);
const getBody = new Uint8Array(await get.arrayBuffer());
report('GET ?dns= reaches the upstream', get.status === 200 && containsMarker(getBody), `HTTP ${get.status}, ${getBody.length} bytes`);

// The panel is a passthrough, not a validator: a short body still goes
// upstream. What matters here is that it is answered, not that it is 500.
const shortBody = await worker.fetch(
  new Request('http://panel.test/dns-query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/dns-message' },
    body: new Uint8Array([0x00]),
  }),
  env,
  ctx,
);
report('a short body is answered, not crashed', shortBody.status < 500, `HTTP ${shortBody.status}`);
report('upstream request count is 3', hits.length === 3, `saw ${hits.length}`);

await upstream.shutdown();

console.log(`\n${failures === 0 ? 'DNS path verified against a local upstream.' : `${failures} check(s) failed.`}`);
Deno.exit(failures === 0 ? 0 : 1);
