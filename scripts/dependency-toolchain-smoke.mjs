import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// Exercise the exact Miniflare installed for Wrangler, including nested overrides.
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare } = wranglerRequire('miniflare');
const bundleDir = process.argv[2] || 'build/dependency-audit';

for (const variant of ['r2', 'kv']) {
  const mf = new Miniflare({
    modules: true,
    scriptPath: path.join(bundleDir, `bundle-${variant}`, 'index.js'),
    compatibilityDate: '2024-01-01',
    host: '127.0.0.1',
    port: 0,
    inspectorPort: 0,
    cf: false,
    bindings: { JWT_SECRET: 'local-audit-only-not-a-real-secret-1234567890' },
    d1Databases: ['DB'],
    ...(variant === 'r2'
      ? { r2Buckets: ['ATTACHMENTS'] }
      : { kvNamespaces: ['ATTACHMENTS_KV'] }),
    durableObjects: {
      NOTIFICATIONS_HUB: { className: 'NotificationsHub', useSQLite: true },
      BACKUP_TRANSFER_RUNNER: { className: 'BackupTransferRunner', useSQLite: true },
    },
  });

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
const images = new Miniflare({
  modules: true,
  host: '127.0.0.1',
  port: 0,
  cf: false,
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
});
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
