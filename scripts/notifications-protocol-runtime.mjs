import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import { createRequire } from 'node:module';
import { createJWT } from '../src/utils/jwt.ts';

const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire('miniflare');
const WireWebSocket = createRequire(wranglerRequire.resolve('miniflare'))('ws');
const output = process.argv[2] || 'build/dependency-audit';
const secret = 'local-protocol-fixture-only-not-a-real-secret';
const limit = (promise, label) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), 10000);
  })]).finally(() => clearTimeout(timer));
};

// Load the unmodified browser distributions used by the official 2026.10.0
// clients. A browser-like VM makes SignalR use its real access_token URL path;
// its Node transport would otherwise silently authenticate with a header.
function browserSignalR() {
  const sockets = [];
  class BrowserWebSocket extends WireWebSocket {
    constructor(url, protocols) { super(url, protocols); sockets.push(this); }
  }
  const context = vm.createContext({
    window: { document: new EventTarget() }, console, setTimeout, clearTimeout, setInterval, clearInterval,
    URL, URLSearchParams, fetch, Headers, Request, Response, AbortController,
    TextEncoder, TextDecoder, ArrayBuffer, Uint8Array, DataView, WebSocket: BrowserWebSocket,
  });
  context.self = context;
  for (const [name, file] of [['@microsoft/signalr', 'signalr.js'], ['@microsoft/signalr-protocol-msgpack', 'signalr-protocol-msgpack.js']]) {
    const packageRoot = path.dirname(require.resolve(`${name}/package.json`));
    vm.runInContext(fs.readFileSync(path.join(packageRoot, 'dist/browser', file), 'utf8'), context);
  }
  return { signalR: context.signalR, sockets };
}

for (const variant of ['r2', 'kv']) {
  const options = {
    name: 'local-protocol-test', modules: true,
    scriptPath: path.join(output, `bundle-${variant}`, 'index.js'), compatibilityDate: '2024-01-01',
    host: '127.0.0.1', port: 0, inspectorPort: 0, cf: false,
    bindings: { JWT_SECRET: secret }, d1Databases: ['DB'],
    ...(variant === 'r2' ? { r2Buckets: ['ATTACHMENTS'] } : { kvNamespaces: ['ATTACHMENTS_KV'] }),
    outboundService: () => new Response('External requests disabled in protocol tests', { status: 503 }),
    durableObjects: { NOTIFICATIONS_HUB: { className: 'NotificationsHub', useSQLite: true }, BACKUP_TRANSFER_RUNNER: { className: 'BackupTransferRunner', useSQLite: true } },
  };
  const worker = new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options);
  const connections = [];
  try {
    const init = await worker.dispatchFetch('http://localhost/api/config'); await init.arrayBuffer();
    const db = await worker.getD1Database('DB');
    const userId = crypto.randomUUID();
    const did = 'protocol-fixture-device', dstamp = 'protocol-fixture-session', stamp = 'protocol-fixture-security';
    await db.prepare('INSERT INTO users(id,email,master_password_hash,key,kdf_type,kdf_iterations,security_stamp,created_at,updated_at) VALUES(?,?,?,?,0,600000,?,?,?)')
      .bind(userId, `${userId}@example.invalid`, 'unused-fixture-proof', 'unused-fixture-key', stamp, '2026-01-01', '2026-01-01').run();
    await db.prepare('INSERT INTO devices(user_id,device_identifier,name,type,session_stamp,created_at,updated_at) VALUES(?,?,?,9,?,?,?)')
      .bind(userId, did, 'Protocol fixture', dstamp, '2026-01-01', '2026-01-01').run();
    const claims = { sub: userId, email: `${userId}@example.invalid`, name: null, sstamp: stamp, did, dstamp };
    let token = await createJWT(claims, secret);
    const url = new URL('/notifications/hub', await worker.ready).toString();
    const { signalR, sockets } = browserSignalR();
    const build = () => {
      const connection = new signalR.HubConnectionBuilder().withUrl(url, {
        skipNegotiation: true, transport: signalR.HttpTransportType.WebSockets,
        accessTokenFactory: () => token,
      }).withHubProtocol(new signalR.protocols.msgpack.MessagePackHubProtocol())
        .configureLogging(signalR.LogLevel.None).build();
      connections.push(connection);
      return connection;
    };
    const connection = build();
    await limit(connection.start(), 'Official browser SignalR start');
    assert.equal(connection.state, signalR.HubConnectionState.Connected);
    assert.equal(new URL(sockets[0].url).searchParams.get('access_token'), token);
    assert.equal(new URL(sockets[0].url).searchParams.has('id'), false);
    const namespace = await worker.getDurableObjectNamespace('NOTIFICATIONS_HUB');
    const hub = namespace.get(namespace.idFromName(userId));
    const notify = async () => {
      const response = await hub.fetch('http://localhost/internal/notify', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, updateType: 5, payload: { UserId: userId, Date: '2026-10-22T00:00:00.000Z' } }) });
      assert.equal(response.status, 204); await response.arrayBuffer();
    };
    const receive = () => limit(new Promise(resolve => {
      const callback = value => { connection.off('ReceiveMessage', callback); resolve(value); };
      connection.on('ReceiveMessage', callback);
    }), 'MessagePack ReceiveMessage');
    let received = receive(); await notify();
    assert.equal((await received).Type, 5);
    await limit(connection.stop(), 'Clean close');
    await limit(connection.start(), 'Official-style reconnect');
    received = receive(); await notify(); assert.equal((await received).Payload.UserId, userId);
    console.log(`${variant}: official browser SignalR 10 + MessagePack handshake, ReceiveMessage, clean close and reconnect passed`);

    // Explicit header and the Web Vault ticket remain usable on real upgrades.
    const direct = async (query, headers) => {
      const target = new URL(url); target.protocol = 'ws:'; target.search = query;
      const socket = new WireWebSocket(target, { headers });
      await limit(new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); }), 'Direct WebSocket upgrade');
      await limit(new Promise(resolve => { socket.once('close', resolve); socket.close(1000, 'local test'); }), 'Direct clean close');
    };
    await direct('', { Authorization: `Bearer ${token}` });
    const negotiated = await worker.dispatchFetch('http://localhost/notifications/hub/negotiate', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    assert.equal(negotiated.status, 200);
    const ticket = (await negotiated.json()).connectionToken;
    await direct(`?id=${encodeURIComponent(ticket)}`);
    const status = async (route, headers = {}) => {
      const target = new URL(route, await worker.ready);
      return limit(new Promise((resolve, reject) => {
        const request = http.get(target, { headers }, response => { response.resume(); response.once('end', () => resolve(response.statusCode)); });
        request.once('error', reject);
        request.once('upgrade', (_response, socket) => { socket.destroy(); reject(new Error('Expected rejected upgrade')); });
      }), 'Rejected request');
    };
    const upgrade = { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64') };
    assert.equal(await status(`/notifications/hub?id=${encodeURIComponent(ticket)}`, upgrade), 401);
    assert.equal(await status(`/api/sync?access_token=${token}`), 401);
    assert.equal(await status(`/notifications/hub?access_token=${token}`), 426);
    console.log(`${variant}: header/ticket 101, ticket replay denial and unchanged API authentication passed`);

    let closed = limit(new Promise(resolve => connection.onclose(resolve)), 'Revoked connection close');
    let delivered = false;
    connection.on('ReceiveMessage', () => { delivered = true; });
    await db.prepare('UPDATE devices SET session_stamp=? WHERE user_id=? AND device_identifier=?').bind('revoked-device-session', userId, did).run();
    await notify(); await closed;
    assert.equal(delivered, false, 'No delivery after device revocation');
    assert.equal(await status(`/notifications/hub?access_token=${token}`, upgrade), 401);
    token = await createJWT({ ...claims, dstamp: 'revoked-device-session' }, secret);
    await limit(connection.start(), 'Renewed device session reconnect');
    closed = limit(new Promise(resolve => connection.onclose(resolve)), 'Disabled account close');
    await db.prepare('UPDATE users SET status=? WHERE id=?').bind('banned', userId).run();
    await notify(); await closed;
    assert.equal(await status(`/notifications/hub?access_token=${token}`, upgrade), 401);
    await db.prepare('UPDATE users SET status=?,security_stamp=? WHERE id=?').bind('active', 'changed-security-stamp', userId).run();
    assert.equal(await status(`/notifications/hub?access_token=${token}`, upgrade), 401);
    console.log(`${variant}: device/account revocation closes before delivery; stale JWT reconnects are denied`);

    token = await createJWT({ ...claims, sstamp: 'changed-security-stamp', dstamp: 'revoked-device-session' }, secret, 4);
    const expiring = build();
    await limit(expiring.start(), 'Short-lived connection start');
    await limit(new Promise(resolve => expiring.onclose(resolve)), 'JWT expiration alarm close');
    assert.equal(await status(`/notifications/hub?access_token=${token}`, upgrade), 401);
    console.log(`${variant}: active connection expires and expired-token reconnect is denied`);
  } finally {
    for (const connection of connections) await connection.stop();
    await worker.dispose();
  }
}
