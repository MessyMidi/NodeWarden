import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// Exercise the exact Miniflare installed for Wrangler, including nested overrides.
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire('miniflare');
const bundleDir = process.argv[2] || 'build/dependency-audit';

for (const variant of ['r2', 'kv']) {
  // Wrangler 4.146 ships Miniflare 5. Use its supported V4 option converter.
  const mf = new Miniflare(convertV4MiniflareOptions({
    host: '127.0.0.1',
    port: 0,
    inspectorPort: 0,
    cf: false,
    name: 'local-nodewarden',
    modules: true,
    scriptPath: path.join(bundleDir, `bundle-${variant}`, 'index.js'),
    compatibilityDate: '2024-01-01',
    // Login can schedule push registration. Keep all test egress local.
    outboundService: () => new Response('External requests disabled in local tests', { status: 503 }),
    bindings: { JWT_SECRET: 'local-audit-only-not-a-real-secret-1234567890' },
    d1Databases: ['DB'],
    ...(variant === 'r2'
      ? { r2Buckets: ['ATTACHMENTS'] }
      : { kvNamespaces: ['ATTACHMENTS_KV'] }),
    durableObjects: {
      NOTIFICATIONS_HUB: { className: 'NotificationsHub', useSQLite: true },
      BACKUP_TRANSFER_RUNNER: { className: 'BackupTransferRunner', useSQLite: true },
    },
  }));

  try {
    for (const [route, status] of [
      ['/api/config', 200],
      ['/api/version', 200],
      ['/api/sync', 401],
    ]) {
      const response = await mf.dispatchFetch(`http://localhost${route}`);
      assert.equal(response.status, status, `${variant} ${route}: ${await response.text()}`);
    }
    const prelogin = await mf.dispatchFetch('http://localhost/identity/accounts/prelogin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' },
      body: JSON.stringify({ email: 'audit@example.invalid' }),
    });
    assert.equal(prelogin.status, 200, await prelogin.text());

    const db = await mf.getD1Database('DB');
    const tables = await db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='users'"
    ).all();
    assert.equal(tables.results.length, 1, 'Real Worker initializes local D1');

    // Fixtures exist only in this disposable Miniflare D1. Exercise upgrades through
    // the real token endpoint, after password/2FA checks, without production data.
    const userId = `audit-${variant}`;
    const email = `${userId}@example.invalid`;
    const proof = 'local-audit-client-proof';
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(proof), 'PBKDF2', false, ['deriveBits']);
    const digest = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', iterations: 100000, salt: new TextEncoder().encode(email) }, key, 256);
    const legacy = '$s$' + Buffer.from(digest).toString('base64');
    await db.prepare('INSERT INTO users (id,email,master_password_hash,key,private_key,public_key,kdf_type,kdf_iterations,security_stamp,created_at,updated_at) VALUES (?,?,?,?,?,?,0,600000,?,?,?)')
      .bind(userId, email, legacy, 'wrapped-key-fixture', 'private-key-fixture', 'public-key-fixture', 'stamp-fixture', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z').run();
    const login = async (password, extra = {}) => {
      const response = await mf.dispatchFetch('http://localhost/identity/connect/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '192.0.2.1' },
        body: new URLSearchParams({ grant_type: 'password', username: email, password, client_id: 'web', scope: 'api offline_access', deviceType: '9', deviceIdentifier: `device-${variant}`, ...extra }).toString(),
      });
      return { status: response.status, body: await response.json() };
    };
    const storedUser = () => db.prepare('SELECT master_password_hash, key, private_key, public_key, security_stamp, updated_at FROM users WHERE id=?').bind(userId).first();
    assert.equal((await login('incorrect-proof')).status, 400);
    assert.equal((await storedUser()).master_password_hash, legacy, 'Wrong password must not migrate');
    const authenticated = await login(proof);
    assert.equal(authenticated.status, 200, authenticated.body.error_description);
    let migrated = await storedUser();
    assert.match(migrated.master_password_hash, /^\$s2\$100000\$/);
    assert.deepEqual([migrated.key, migrated.private_key, migrated.public_key, migrated.security_stamp, migrated.updated_at], ['wrapped-key-fixture', 'private-key-fixture', 'public-key-fixture', 'stamp-fixture', '2026-01-01T00:00:00.000Z']);
    await db.prepare('UPDATE users SET master_password_hash=? WHERE id=?').bind(proof, userId).run();
    assert.equal((await login(proof)).status, 200, 'Raw legacy account still logs in');
    assert.match((await storedUser()).master_password_hash, /^\$s2\$100000\$/);
    await db.prepare('UPDATE users SET master_password_hash=?,totp_secret=? WHERE id=?').bind(legacy, 'JBSWY3DPEHPK3PXP', userId).run();
    assert.equal((await login(proof)).status, 400, 'Required second factor must not be bypassed');
    assert.equal((await storedUser()).master_password_hash, legacy, 'Pending second factor must not migrate');
    assert.equal((await login('invalid-access-code', { authRequest: 'missing-auth-request' })).status, 400);
    assert.equal((await storedUser()).master_password_hash, legacy, 'Auth request grant must not migrate password');
    await db.prepare('UPDATE users SET totp_secret=NULL WHERE id=?').bind(userId).run();

    const negotiate = await mf.dispatchFetch('http://localhost/notifications/hub/negotiate', { method: 'POST', headers: { Authorization: `Bearer ${authenticated.body.access_token}` } });
    assert.equal(negotiate.status, 200);
    const negotiation = await negotiate.json();
    assert.ok(negotiation.connectionToken);
    const hubNamespace = await mf.getDurableObjectNamespace('NOTIFICATIONS_HUB');
    const hub = hubNamespace.get(hubNamespace.idFromName(userId));
    const consume = () => hub.fetch('http://localhost/internal/ws-token/consume', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: negotiation.connectionToken }),
    });
    const firstUse = await consume();
    assert.equal(firstUse.status, 200);
    assert.equal((await firstUse.json()).userId, userId);
    const replay = await consume();
    assert.equal(replay.status, 401, 'Real Durable Object consumes each ticket once');
    await replay.arrayBuffer();
    console.log(`${variant}: legacy password migration preserves vault keys; failed/2FA/auth-request logins do not migrate; WebSocket tickets are single-use`);

    if (variant === 'r2') {
      const bucket = await mf.getR2Bucket('ATTACHMENTS');
      await bucket.put('audit', 'local-only');
      assert.equal(await (await bucket.get('audit')).text(), 'local-only');
      await bucket.delete('audit');
    } else {
      const kv = await mf.getKVNamespace('ATTACHMENTS_KV');
      await kv.put('audit', 'local-only');
      assert.equal(await kv.get('audit'), 'local-only');
      await kv.delete('audit');
    }

    for (const binding of ['NOTIFICATIONS_HUB', 'BACKUP_TRANSFER_RUNNER']) {
      const namespace = await mf.getDurableObjectNamespace(binding);
      const response = await namespace.get(namespace.idFromName('local-audit'))
        .fetch('http://localhost/unknown');
      assert.equal(response.status, 404, `${binding} initializes and rejects unknown routes`);
      await response.arrayBuffer();
    }
    console.log(`${variant}: public API, authentication gate, prelogin, D1, storage and Durable Objects passed`);
  } finally {
    await mf.dispose();
  }
}

// NodeWarden does not bind Images. This separately exercises Miniflare's sharp adapter.
const images = new Miniflare(convertV4MiniflareOptions({
  host: '127.0.0.1',
  port: 0,
  cf: false,
  name: 'local-images',
  modules: true,
  compatibilityDate: '2024-01-01',
  images: { binding: 'IMAGES' },
  script: `export default {
    async fetch(request, env) {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="red"/></svg>';
      const image = await env.IMAGES.input(new Response(svg).body)
        .transform({ width: 2 }).output({ format: 'image/png' });
      return image.response();
    }
  }`,
}));
try {
  const response = await images.dispatchFetch('http://localhost/');
  assert.equal(response.status, 200, await response.clone().text());
  assert.match(response.headers.get('content-type'), /image\/png/);
  const png = Buffer.from(await response.arrayBuffer());
  assert.equal(png.readUInt32BE(16), 2);
  assert.equal(png.readUInt32BE(20), 2);
  console.log('Miniflare Images: patched sharp converts SVG to 2x2 PNG');
} finally {
  await images.dispose();
}

for (const variant of ['r2', 'kv']) {
  const meta = JSON.parse(fs.readFileSync(path.join(bundleDir, `bundle-${variant}.json`), 'utf8'));
  const inputs = Object.keys(meta.inputs);
  const forbidden = inputs.filter((input) =>
    /(?:^|[/\\])node_modules[/\\](?:wrangler|miniflare|undici|sharp|tailwindcss|@tailwindcss|postcss(?:-selector-parser)?|braces|nanoid|source-map-js|browserslist|baseline-browser-mapping|@babel)(?:[/\\]|$)/.test(input)
  );
  assert.deepEqual(forbidden, [], 'Audited development tools must stay out of the Worker bundle');
  console.log(`${variant}: checked ${inputs.length} Worker bundle inputs; no audited development tools bundled`);
}
