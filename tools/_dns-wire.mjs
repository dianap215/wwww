/**
 * Minimal DNS wire helpers — just enough to build one query for the relay test
 * and recognise the reply. No dependencies (the project's own lib/dns-wire.mjs
 * is CommonJS and not worth pulling in for this).
 */

/** Build an A-record query for `name` as a DNS-over-TCP message. */
export function encodeDnsQuery(name, type = 1) {
  const labels = name.replace(/\.$/, '').split('.');
  const qname = labels.flatMap((l) => [l.length, ...[...l].map((c) => c.charCodeAt(0))]);

  const header = [
    0x12, 0x34, // id
    0x01, 0x00, // recursion desired
    0x00, 0x01, // one question
    0x00, 0x00,
    0x00, 0x00,
    0x00, 0x00,
  ];

  const question = [...qname, 0x00, (type >> 8) & 0xff, type & 0xff, 0x00, 0x01];

  const message = new Uint8Array([...header, ...question]);

  // DNS over TCP is length-prefixed. The relay carries the prefix through to the
  // upstream, exactly as a real client would.
  const framed = new Uint8Array(2 + message.length);
  framed[0] = (message.length >> 8) & 0xff;
  framed[1] = message.length & 0xff;
  framed.set(message, 2);
  return framed;
}

/**
 * Is this a DNS reply with at least one answer? Every record starts after the
 * 12-byte header and the question name, so checking the counters plus a
 * plausible answer count is enough to tell "the upstream spoke" from "the
 * connection died".
 */
export function looksLikeDnsReply(bytes) {
  if (bytes.length < 12) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = view.getUint16(2);
  const qr = (flags & 0x8000) !== 0; // response bit
  const questions = view.getUint16(4);
  const answers = view.getUint16(6);
  return qr && questions >= 1 && answers >= 1;
}
