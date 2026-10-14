/**
 * BlueKnight Panel — Deno Deploy entrypoint.
 * ============================================================================
 * The panel itself is `src/worker.js`: the same self-contained Cloudflare
 * Worker bundle that `dist/worker-standalone.js` ships (panel UI, encrypted
 * DNS, subscription generation, VLESS/Trojan WebSocket relay). It is written
 * against the Worker API, so it runs unchanged on Deno — it just needs three
 * things Deno does not provide out of the box:
 *
 *   globalThis.WebSocketPair   -> shims/websocket.js
 *   Response with status 101   -> shims/websocket.js
 *   env.BK_KV / env.WD_KV      -> shims/kv.js      (Deno KV)
 *
 * The raw-TCP half of the proxy works through the bundle's own fallback:
 * `cloudflare:sockets` is absent here, so it falls through to the bundled
 * node:net / node:tls connector, which Deno implements natively.
 *
 * Local run:   deno task dev      (http://localhost:8000/panel)
 * Deploy:      console.deno.com -> Dynamic Entrypoint = src/index.js
 * ============================================================================
 */
import worker from './worker.js';
import { WebSocketPair, WorkerResponse, bridgeDenoSocket } from './shims/websocket.js';
import { createKvNamespace } from './shims/kv.js';
import { dnsFetch } from './shims/dns-fetch.js';

// workerd extensions the bundle assumes. Must be installed before the first
// request — the bundle only reads them lazily, so module scope is early enough.
globalThis.WebSocketPair = WebSocketPair;
globalThis.Response = WorkerResponse;

const KV = createKvNamespace();

const env = {
  ...Deno.env.toObject(),
  PANEL_PASSWORD: Deno.env.get('PANEL_PASSWORD') || '',
  JWT_SECRET: Deno.env.get('JWT_SECRET') || '',
  DNS_FETCH: dnsFetch,
  BK_KV: KV,
  WD_KV: KV,
};

const PORT = Number(Deno.env.get('PORT') || 8000);

const executionCtx = () => ({
  waitUntil: (promise) =>
    Promise.resolve(promise).catch((err) => console.error('[BlueKnight async error]', err)),
  passThroughOnException: () => {},
});

const isUpgrade = (req) => (req.headers.get('upgrade') || '').toLowerCase() === 'websocket';

Deno.serve({ port: PORT }, async (req) => {
  try {
    if (isUpgrade(req)) {
      // Ask the worker first: it may refuse the upgrade (unknown path, bad
      // credentials) with an ordinary response, in which case we must not
      // hijack the connection.
      const res = await worker.fetch(req, env, executionCtx());
      if (res.status === 101 && res.webSocket) {
        const { socket, response } = Deno.upgradeWebSocket(req);
        bridgeDenoSocket(socket, res.webSocket);
        return response;
      }
      return res;
    }

    return await worker.fetch(req, env, executionCtx());
  } catch (err) {
    console.error('[BlueKnight] Unhandled request error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal Server Error', message: err?.message || String(err) }, null, 2),
      { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
    );
  }
});

console.log(`BlueKnight Panel (Deno) listening on http://localhost:${PORT}/panel`);
