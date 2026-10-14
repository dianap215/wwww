/**
 * `cloudflare:sockets` for Deno.
 *
 * The worker reaches raw TCP through
 *   await import("cloudflare:sockets")
 * and only falls back to its own bundled connector when that import fails. The
 * bundle shipped here is the Cloudflare Workers build, where Node built-ins are
 * deliberately stubbed out ("node:net createConnection is not available in this
 * Cloudflare build"), so on Deno the fallback is a dead end and the proxy relay
 * cannot dial its upstream.
 *
 * Deno implements node:net and node:tls, so this module provides the same
 * `connect(address, options)` contract on top of them — identical to the
 * project's own lib/sockets.mjs, which is proven on Node hosts.
 *
 * Deno resolves it because deno.json maps the specifier:
 *   "imports": { "cloudflare:sockets": "./src/shims/sockets.js" }
 */
import net from 'node:net';
import tls from 'node:tls';
import { Readable, Writable } from 'node:stream';

/**
 * @param {string | { hostname?: string, host?: string, port?: number | string, secureTransport?: string }} address
 * @param {{ secureTransport?: 'off' | 'on' | 'starttls' }} [options]
 */
export function connect(address, options = {}) {
  let hostname;
  let port;
  let secure = options.secureTransport === 'on';

  if (typeof address === 'string') {
    const parts = address.split(':');
    hostname = parts[0];
    port = parseInt(parts[1] || '80', 10);
  } else if (typeof address === 'object' && address !== null) {
    hostname = String(address.hostname || address.host || '127.0.0.1').replace(/^\[|\]$/g, '');
    port = typeof address.port === 'number' ? address.port : parseInt(address.port || '80', 10);
    secure ||= address.secureTransport === 'on' || address.secureTransport === 'starttls';
  } else {
    throw new Error('Invalid address argument for connect()');
  }

  // Cloudflare does not verify the upstream certificate, and the panel's whole
  // point is dialling user-run hosts with self-signed certs. Same choice as
  // lib/sockets.mjs.
  const sock = secure
    ? tls.connect({ host: hostname, port, rejectUnauthorized: false })
    : net.createConnection({ host: hostname, port });

  sock.setNoDelay(true);

  const opened = new Promise((resolve, reject) => {
    sock.once('connect', () => resolve({ remoteAddress: sock.remoteAddress, remotePort: sock.remotePort }));
    sock.once('secureConnect', () => resolve({ remoteAddress: sock.remoteAddress, remotePort: sock.remotePort }));
    sock.once('error', reject);
  });

  const closed = new Promise((resolve) => {
    sock.once('close', (hadError) => resolve({ hadError }));
    sock.once('end', () => resolve({ hadError: false }));
  });

  return {
    opened,
    closed,
    readable: Readable.toWeb(sock),
    writable: Writable.toWeb(sock),
    close: () => {
      try {
        sock.destroy();
      } catch {
        /* already gone */
      }
    },
    startTls: (tlsOptions = {}) => {
      const upgraded = tls.connect({ socket: sock, host: hostname, rejectUnauthorized: false, ...tlsOptions });
      return {
        readable: Readable.toWeb(upgraded),
        writable: Writable.toWeb(upgraded),
      };
    },
  };
}

export default { connect };
