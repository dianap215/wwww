/**
 * `env.DNS_FETCH` for Deno.
 *
 * The worker calls `env.DNS_FETCH || fetch` for DoH passthrough. On Node the
 * adapter supplies `lib/dns-fetch-node.mjs`, which retries HTTP/2 because some
 * resolvers answer HTTP/1.1 with 400/505. Deno's fetch is already HTTP/2-capable
 * for https, so a timeout-guarded plain fetch is enough here — and it avoids
 * pulling in `node:http2`.
 */
export function dnsFetch(url, init = {}) {
  const signal = init.signal || AbortSignal.timeout(10_000);
  return fetch(url, { ...init, signal });
}

export default dnsFetch;
