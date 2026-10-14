// Assumption probe: run once with
//   deno run --allow-all tools/probe.js
const line = (label, value) => console.log(`${label.padEnd(46)} ${value}`);

try {
  new Response(null, { status: 101 });
  line('native Response allows status 101', 'YES (shim still needed for .webSocket)');
} catch (err) {
  line('native Response allows status 101', `NO -> ${err.constructor.name}: ${err.message}`);
}

try {
  await import('cloudflare:sockets');
  line('import("cloudflare:sockets")', 'RESOLVED (unexpected)');
} catch (err) {
  line('import("cloudflare:sockets")', `rejects catchably -> ${err.constructor.name}: ${err.message}`);
}

try {
  const net = await import('node:net');
  const tls = await import('node:tls');
  const stream = await import('node:stream');
  line('node:net / node:tls / node:stream', `ok (net.createConnection=${typeof net.default.createConnection}, tls.connect=${typeof tls.default.connect}, Readable.toWeb=${typeof stream.Readable.toWeb})`);
} catch (err) {
  line('node:net / node:tls / node:stream', `FAILED -> ${err.message}`);
}

try {
  const kv = await Deno.openKv();
  await kv.set(['probe'], 'ok');
  const got = await kv.get(['probe']);
  await kv.delete(['probe']);
  kv.close();
  line('Deno.openKv()', `ok (round-trip = ${got.value})`);
} catch (err) {
  line('Deno.openKv()', `FAILED -> ${err.message}`);
}

line('Deno.upgradeWebSocket', typeof Deno.upgradeWebSocket);
line('Deno.serve', typeof Deno.serve);
line('globalThis.process', typeof globalThis.process);
line('process.env.PATH set', typeof globalThis.process !== 'undefined' ? Boolean(process.env.PATH) : 'n/a');
