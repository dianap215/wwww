# BlueKnight Panel — Deno Deploy

The BlueKnight Panel running on [deno.com](https://console.deno.com) (the new Deno
Deploy, not the sunsetting Deploy Classic).

The panel UI, encrypted DNS resolver and subscription links run here exactly as
they do on Cloudflare Workers. The VLESS/Trojan/Shadowsocks WebSocket relay also
runs, because the new Deno Deploy is a full Deno runtime in a Linux microVM
rather than a V8-isolate edge sandbox.

---

## Why the old `index.js` never started

The previous file in this folder was the **Replit monolith** — the single-file
Node build that uses Express, `require()`, and spawns `sing-box` / `xray` /
`argo` binaries with `child_process`. Deno is ESM-only, so the very first line
died:

```
ReferenceError: require is not defined
    at file:///app/src/index.js:92:12
const fs = require('fs');
```

Renaming it to `.cjs` or adding `"type": "commonjs"` only moves the failure
later. That build cannot work on any serverless host, because it needs to:

- spawn long-lived proxy daemons from binaries on disk,
- accept inbound TCP on a dozen arbitrary ports,
- keep a writable data directory across requests.

None of that exists on Deno Deploy. So this folder now ships the **worker
build** of the same panel — the one written against the Worker API, which does
the relay in-process instead of shelling out to a daemon. It is the same code
that powers the Cloudflare deployment, plus a small Deno adapter.

---

## Layout

```
deno.json                  tasks + the `cloudflare:sockets` import map
src/index.js               entrypoint — Deno.serve, KV wiring, WebSocket bridge
src/worker.js              the panel itself (Cloudflare Worker bundle, unmodified)
src/shims/websocket.js     WebSocketPair + status-101 Response + Deno socket bridge
src/shims/sockets.js       cloudflare:sockets -> node:net / node:tls
src/shims/kv.js            env.BK_KV / env.WD_KV -> Deno KV
src/shims/dns-fetch.js     env.DNS_FETCH
tools/smoke.js             end-to-end test against a running server
tools/dns-local.js         hermetic DoH test (no internet needed)
tools/reset.js             wipes the local KV file
```

Only the four files in `src/shims/` and `src/index.js` are Deno-specific.
`src/worker.js` is copied verbatim from the project's `dist/worker-standalone.js`
and is never edited — regenerate it with `npm run build:standalone` in
`Blue knight Worker` and copy it over.

---

## Run it locally

```sh
deno task start        # http://localhost:8000/panel
deno task dev          # same, with --watch
```

Deno was not installed on this machine, so a portable copy lives at
`D:\Webprogram\BlueKnightPanel\.deno-runtime\deno.exe` (Deno 2.9.7). Either put
that folder on `PATH`, or call the binary directly:

```sh
..\.deno-runtime\deno.exe task start
```

The first request redirects you to `/panel/setup` to choose a password. State is
kept in `data/blueknight_kv.sqlite3`; `deno task reset` wipes it.

Verify it works:

```sh
deno task smoke        # end-to-end: setup, panel, 11 subscription formats, relay, DoH
deno task dns          # DoH round trip against a local mock upstream
```

`deno task smoke` prints a hint if a proxy is configured in your shell — the
WebSocket check cannot reach `localhost` through one, so re-run it with
`NO_PROXY=localhost,127.0.0.1`.

---

## Deploy to Deno Deploy

Deno Deploy apps are created from a GitHub repository, and **mono-repos are not
supported** — the repository root must be this folder. Push it as its own repo
(or use a repo whose root is this directory).

1. **Create the app** — [console.deno.com](https://console.deno.com) → `+ New App`
   → pick the repository.

2. **Build config** (`Edit build config`):

   | Field | Value |
   | --- | --- |
   | Framework preset | `No Preset` |
   | Install command | *(leave empty — there is no `package.json`)* |
   | Build command | *(leave empty)* |
   | Runtime configuration | `Dynamic` |
   | **Dynamic Entrypoint** | **`src/index.js`** |
   | Dynamic arguments | *(empty)* |
   | Static Directory | *(empty)* |
   | Single Page App mode | off |

   `src/index.js` is deliberate: it is the path the failed build was already
   pointing at, so no change is needed if you are updating an existing app.

3. **Provision KV** — the panel needs somewhere to keep the admin password, the
   VLESS UUID and the subscription token. Without it the panel still boots, but
   every restart regenerates the UUID and silently breaks every subscription
   link already handed to a client.

   `Databases` → `Provision Database` → engine **Deno KV** → name it → then
   `Assign` it to this app. Nothing to configure in code — `Deno.openKv()`
   connects to whichever database is assigned to the running timeline.

4. **Environment variables** (optional, but strongly recommended on a serverless
   host). Setting these pins the identity values so they survive any restart,
   redeploy or lost KV:

   | Variable | Purpose |
   | --- | --- |
   | `VLESS_UUID` | pins the VLESS UUID |
   | `SUB_TOKEN` | pins the subscription token |
   | `TROJAN_PASSWORD` | pins the Trojan password |
   | `PANEL_PASSWORD` | sets the admin password without first-run setup |
   | `JWT_SECRET` | pins the session signing key (32+ chars) |
   | `DENO_KV_PATH` | *local only* — overrides the SQLite path |

   Mark the secrets as **secret** in the console.

5. **Deploy**, then open `https://<app>.deno.deno.net/panel`.

### Verifying a deployment

```sh
BK_BASE=https://<app>.deno.deno.net deno task smoke
```

The relay check needs the client machine to reach the app over WebSocket; the
DoH check needs that app to reach the internet, which it can.

---

## What works on Deno Deploy

| | |
| --- | --- |
| Panel UI, login, settings | Yes |
| Subscription links (11 formats) | Yes — `/sub/vless`, `/sub/clash`, `/sub/singbox`, `/sub/xray`, `/sub/xray-json`, `/sub/all`, `/sub/ss`, `/sub/trojan`, … |
| Encrypted DNS (DoH) | Yes — `/dns-query` |
| VLESS / Trojan / Shadowsocks over WebSocket | Yes — verified with a live TCP round trip |
| Warp / AmneziaWG profiles | After generating credentials in Panel Settings |
| OpenVPN, ShadowTLS, QUIC, raw TCP inbounds | No — these need the native engine host (`deploy-native.mjs`). `/sub/openvpn` answers `503`, as it does on Cloudflare Workers and every other serverless target. |

---

## Known limitations

- **One instance, many regions.** Deno Deploy runs several isolates; they share
  the assigned Deno KV database, so panel state is consistent, but nothing is
  pinned to a single machine.
- **Cold starts.** Deno Deploy stops idle apps and restarts them on the next
  request. Keep `src/worker.js` as-is rather than re-bundling with extra
  dependencies, which is what keeps startup fast.
- **The panel cannot update itself.** Cloudflare's "Panel Update" button uses
  the Cloudflare API to replace the running script. There is no equivalent here
  — to update, replace `src/worker.js` from a newer `dist/worker-standalone.js`
  and push.
