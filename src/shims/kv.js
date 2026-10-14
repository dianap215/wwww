/**
 * Cloudflare `KVNamespace` -> Deno KV.
 *
 * The worker only ever touches `env.BK_KV ?? env.WD_KV` and uses three methods
 * (get / put / delete), with string keys and string values. Deno KV keys are
 * tuples, so every key is wrapped in a one-element array — consistently, or
 * reads would miss writes.
 *
 * On Deno Deploy `Deno.openKv()` talks to the managed KV database assigned to
 * the app. Running locally it writes to a SQLite file, and `DENO_KV_PATH`
 * overrides where. If no KV backend can be opened at all, this degrades to a
 * per-instance Map rather than throwing on every request, so the panel still
 * boots (edits just do not survive a restart).
 */

// Identity keys that may be pinned by environment variables. Same table as
// lib/kv-store.mjs / server.js, so an operator can keep the same secrets across
// providers and never lose a subscription link to a regenerated UUID.
const ENV_FALLBACK = {
  'config:admin_password': 'PANEL_PASSWORD',
  'config:jwt_secret': 'JWT_SECRET',
  'config:sub_token': 'SUB_TOKEN',
  'config:vless_uuid': 'VLESS_UUID',
  'config:trojan_password': 'TROJAN_PASSWORD',
  'config:proxy_path': 'PROXY_PATH',
  'config:node_share_token': 'NODE_SHARE_TOKEN',
};

function createMemoryStore() {
  const map = new Map();
  return {
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

/**
 * `Deno.openKv` is built in but sits behind `--unstable-kv` in the CLI. Deno
 * Deploy enables it and connects it to the KV database assigned to the app in
 * the console, so there it just works.
 *
 * When the global is absent entirely (a plain `deno run` without the flag),
 * fall back to `@deno/kv` — the npm package the API was extracted to. That
 * fallback is deliberately not used when `Deno.openKv` exists but fails: on
 * Deno Deploy the cause would be an unassigned database, which the npm package
 * cannot fix either.
 */
async function openDatabase() {
  const path = Deno.env.get('DENO_KV_PATH');

  if (typeof Deno.openKv === 'function') {
    const handle = await (path ? Deno.openKv(path) : Deno.openKv());
    return { handle, backend: 'Deno.openKv' };
  }

  const { openKv } = await import('npm:@deno/kv');
  const handle = await (path ? openKv(path) : openKv());
  return { handle, backend: 'npm:@deno/kv' };
}

export function createKvNamespace() {
  const memory = createMemoryStore();

  // Single-flight: one connection attempt for the process, not one per request.
  let connection = null; // Promise<{ handle, backend } | null> — null means "no KV"
  let backend = null;

  function connect() {
    if (connection) return connection;
    connection = openDatabase().then(
      (opened) => {
        backend = opened.backend;
        console.log(`[BlueKnight KV] connected via ${opened.backend}`);
        return opened;
      },
      (err) => {
        console.warn(
          '[BlueKnight KV] no KV database available, using a per-instance memory store ' +
            '(panel edits will not survive a restart). On Deno Deploy, provision a Deno KV ' +
            'database under Databases and assign it to this app.',
          err?.message || err,
        );
        return null; // sticky: do not retry on every request
      },
    );
    return connection;
  }

  return {
    // The worker skips its settings-snapshot cache when this is set, so env-var
    // overrides are always honoured. Matches server.js / api/index.js.
    envOverrides: true,

    mode: () => (backend ? `kv (${backend})` : 'memory'),

    async get(key) {
      const envName = ENV_FALLBACK[key];
      if (envName) {
        const fromEnv = Deno.env.get(envName);
        if (fromEnv) return fromEnv;
      }
      const opened = await connect();
      if (!opened) return memory.get(key);
      const result = await opened.handle.get([key]);
      return result.value === null || result.value === undefined ? null : String(result.value);
    },

    async put(key, value) {
      const opened = await connect();
      if (!opened) return memory.put(key, value);
      await opened.handle.set([key], String(value));
      return true;
    },

    async delete(key) {
      const opened = await connect();
      if (!opened) return memory.delete(key);
      await opened.handle.delete([key]);
      return true;
    },
  };
}
