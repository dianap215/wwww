/**
 * Minimal TLS ClientHello builder — enough to make a server answer, nothing more.
 * Chrome-ish cipher list and a single `application_layer_protocol_negotiation`
 * extension, so a picky upstream still replies.
 */

function u16(n) {
  return [(n >> 8) & 0xff, n & 0xff];
}
function u24(n) {
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}
function ext(type, body) {
  return [...u16(type), ...u16(body.length), ...body];
}
/** SNI extension (type 0x0000) for `host`. */
function sniExt(host) {
  const h = [...host].map((c) => c.charCodeAt(0));
  const nameType = [0x00];
  const entry = [h.length, ...h];
  const list = [...u16(entry.length), ...entry];
  return ext(0x0000, [...u16(list.length), ...list]);
}

/**
 * Build a ClientHello record for `host`. Returns the whole TLS record
 * (handshake header + ClientHello body), ready to write to a socket.
 */
export function clientHello(host) {
  const cipherSuites = [
    0x13, 0x02, 0x13, 0x01, 0xc0, 0x2f, 0xc0, 0x2b, 0xc0, 0x30, 0xc0, 0x2c,
    0x00, 0x9e, 0x00, 0x9f, 0x00, 0xa2, 0x00, 0xff,
  ];
  const hello = [
    ...u16(0x0303), // legacy_version TLS 1.2
    ...new Array(32).fill(0x11), // random
    0x00, // legacy_session_id length
    ...u16(cipherSuites.length / 2), ...cipherSuites,
    0x01, 0x00, // legacy_compression_methods: null
  ];

  const extensions = [
    sniExt(host),
    // supported_groups (0x000a): x25519, secp256r1, secp384r1
    ext(0x000a, [...u16(6), 0x00, 0x1d, 0x00, 0x17, 0x00, 0x18]),
    // ec_point_formats (0x000b): uncompressed
    ext(0x000b, [...u16(1), 0x00]),
    // signature_algorithms (0x000d): a short chrome-ish list
    ext(0x000d, [
      ...u16(14),
      0x04, 0x03, 0x08, 0x04, 0x04, 0x01, 0x05, 0x03,
      0x08, 0x05, 0x05, 0x01, 0x08, 0x06,
    ]),
    // ALPN (0x0010): http/1.1 — a proxy tunnel needs HTTP/1.1, not h2
    ext(0x0010, [
      ...u16(12),
      0x00, 0x08, ...['h','t','t','p','/','1','.','1'].map((c) => c.charCodeAt(0)),
    ]),
    // supported_versions (0x002b): TLS 1.3, 1.2
    ext(0x002b, [...u16(4), 0x02, 0x03, 0x04, 0x03, 0x03]),
  ];
  const extBytes = extensions.flat();
  hello.push(...u16(extBytes.length), ...extBytes);

  // handshake header: type 1 (client_hello), 24-bit length
  const handshake = [0x01, ...u24(hello.length), ...hello];

  // TLS record: content_type 22, version TLS 1.0 (as per RFC for ClientHello)
  return [0x16, 0x03, 0x01, ...u16(handshake.length), ...handshake];
}

export default clientHello;
