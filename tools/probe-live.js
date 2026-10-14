/**
 * Probe a live deployment's proxy WebSocket endpoint.
 *
 *   deno run --allow-net --allow-env tools/probe-live.js <base-url>
 *
 * Confirms three things that can only be checked against the real host:
 *   1. Deno Deploy forwards WebSocket upgrades at all (a plain HTTP 404 here
 *      means the platform, not the app, is dropping them).
 *   2. The app's own upgrade gate answers — 426 = no Upgrade header, 404 =
 *      unknown path, 101 = accepted.
 *   3. A garbage VLESS header is rejected with a WebSocket close code rather
 *      than an HTTP error, which proves the request reached the relay.
 */
const raw = Deno.args[0] || Deno.env.get('BK_BASE');
if (!raw) {
  console.error('usage: probe-live.js <https://your-app.deno.net>');
  Deno.exit(2);
}
const base = raw.replace(/\/+$/, '');
const wsBase = base.replace(/^http/, 'ws');

function probe(label, url, protocols) {
  return new Promise((resolve) => {
    const ws = protocols ? new WebSocket(url, protocols) : new WebSocket(url);
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      console.log(`  ${result.ok ? 'OK  ' : 'FAIL'}  ${label} — ${result.detail}`);
      resolve(result.ok);
    };
    const timer = setTimeout(() => finish({ ok: false, detail: 'timed out' }), 15000);
    ws.onopen = () => setTimeout(() => finish({ ok: true, detail: 'handshake accepted (101)' }), 800);
    ws.onclose = (e) => finish({
      ok: true,
      detail: `closed with code ${e.code}${e.reason ? ` (${e.reason})` : ''} — reached the relay`,
    });
    ws.onerror = () => finish({ ok: false, detail: 'connection error / no upgrade' });
  });
}

console.log(`Probing ${base}\n`);

// 1. No Upgrade header at all — the app must answer 426, not 404.
const plain = await fetch(`${base}/bk-ws`);
console.log(`  ${plain.status === 426 ? 'OK  ' : 'FAIL'}  GET /bk-ws without an Upgrade header — HTTP ${plain.status} (426 = app route exists)`);

// 2. An unknown path must not upgrade, but must be answered by the app (404),
//    which also proves requests are reaching the Worker at all.
const bogus = await fetch(`${base}/this-path-does-not-exist`);
const bogusBody = await bogus.text();
const reachedWorker = bogusBody.includes('BlueKnight') || bogus.status === 404;
console.log(`  ${reachedWorker ? 'OK  ' : 'FAIL'}  unknown path answered by the app — HTTP ${bogus.status}`);

// 3. The real proxy path with a garbage VLESS header.
const ws = await probe('WS upgrade to /bk-ws (bad VLESS header)', `${wsBase}/bk-ws`);

console.log(
  ws
    ? '\nWebSocket upgrades reach the relay. The remaining variable is the UUID/token in the config.'
    : '\nWebSocket upgrades are NOT reaching the app — something between Deno Deploy and the worker is dropping them.',
);
