import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import http from 'node:http';
import { pbkdf2, hkdfExpand, bytesToBase64, encryptBw, decryptBw, decryptStr, calcTotpNow } from '../webapp/src/lib/crypto.ts';

const root = process.cwd();
const output = path.resolve(process.argv[2] || 'build/dependency-audit');
const revisions = JSON.parse(fs.readFileSync(new URL('./rollback-baseline.json', import.meta.url), 'utf8'));
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire('miniflare');
const wrangler = path.join(path.dirname(require.resolve('wrangler/package.json')), 'bin', 'wrangler.js');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

// Reconstruct only tracked backend sources at immutable Git revisions. Both
// snapshots use the current tested toolchain; no deploy or remote D1 is involved.
for (const [name, revision] of Object.entries(revisions)) {
  assert.match(revision, /^[a-f0-9]{40}$/);
  const source = path.join(output, `rollback-source-${name}`);
  const files = git('ls-tree', '-r', '--name-only', revision, '--', 'src', 'shared').split('\n');
  for (const file of files) {
    assert.match(file, /^(src|shared)\/[A-Za-z0-9_./-]+$/);
    const target = path.join(source, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, execFileSync('git', ['show', `${revision}:${file}`], { cwd: root, maxBuffer: 4 * 1024 * 1024 }));
  }
  fs.writeFileSync(path.join(source, 'wrangler.toml'), 'name = "local-rollback-test"\nmain = "src/index.ts"\ncompatibility_date = "2024-01-01"\n');
  execFileSync(process.execPath, [wrangler, 'deploy', '--dry-run', '--config', path.join(source, 'wrangler.toml'), '--outdir', path.join(output, `rollback-${name}`)], {
    cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' }, stdio: 'pipe',
  });
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nodewarden-rollback-'));
let worker;
let db;
async function switchCode(name) {
  if (worker) await worker.dispose();
  const options = {
    name: 'nodewarden-rollback-test',
    modules: true, scriptPath: path.join(output, name === 'candidate' ? 'bundle-r2' : `rollback-${name}`, 'index.js'),
    compatibilityDate: '2024-01-01', host: '127.0.0.1', port: 0, inspectorPort: 0, cf: false,
    bindings: { JWT_SECRET: 'local-rollback-only-not-a-production-secret' },
    outboundService: () => new Response('External requests disabled in rollback tests', { status: 503 }),
    d1Databases: { DB: 'isolated-rollback-fixture' }, d1Persist: path.join(temporary, 'd1'),
    r2Buckets: ['ATTACHMENTS'],
    durableObjects: {
      NOTIFICATIONS_HUB: { className: 'NotificationsHub', useSQLite: true },
      BACKUP_TRANSFER_RUNNER: { className: 'BackupTransferRunner', useSQLite: true },
    },
  };
  // Miniflare 5 removed d1Persist; its V4 converter silently omits that key.
  // Set the new persistence root explicitly, otherwise a restart creates a new DB.
  worker = new Miniflare(convertV4MiniflareOptions
    ? { ...convertV4MiniflareOptions(options), resourcePersistencePath: temporary }
    : options);
  const initialized = await worker.dispatchFetch('http://localhost/api/config');
  assert.equal(initialized.status, 200);
  await initialized.arrayBuffer();
  db = await worker.getD1Database('DB');
}

async function material(email, password, userKey) {
  const master = await pbkdf2(password, email, 600000, 32);
  return {
    proof: bytesToBase64(await pbkdf2(master, password, 1, 32)),
    enc: await hkdfExpand(master, 'enc', 32), mac: await hkdfExpand(master, 'mac', 32),
    wrapped: await encryptBw(userKey, await hkdfExpand(master, 'enc', 32), await hkdfExpand(master, 'mac', 32)),
  };
}
const userKey = crypto.getRandomValues(new Uint8Array(64));
const vaultEnc = userKey.slice(0, 32), vaultMac = userKey.slice(32);
const encrypt = (text) => encryptBw(new TextEncoder().encode(text), vaultEnc, vaultMac);
const first = { id: crypto.randomUUID(), email: 'rollback-one@example.invalid' };
const second = { id: crypto.randomUUID(), email: 'rollback-two@example.invalid' };
const initial = await material(first.email, 'local-test-password-one', userKey);
const changed = await material(first.email, 'local-test-password-two', userKey);
const changedAgain = await material(first.email, 'local-test-password-three', userKey);
const totpMaterial = await material(second.email, 'local-test-2fa-password', userKey);
const totpSecret = 'JBSWY3DPEHPK3PXP';
async function seed(user, value, totp = null) {
  const legacy = '$s$' + bytesToBase64(await pbkdf2(value.proof, user.email, 100000, 32));
  await db.prepare('INSERT INTO users(id,email,master_password_hash,key,kdf_type,kdf_iterations,security_stamp,created_at,updated_at,totp_secret) VALUES(?,?,?,?,0,600000,?,?,?,?)')
    .bind(user.id, user.email, legacy, value.wrapped, `stamp-${user.id}`, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', totp).run();
  return legacy;
}
const row = (user = first) => db.prepare('SELECT * FROM users WHERE id=?').bind(user.id).first();
async function login(user, value, extras = {}) {
  const response = await worker.dispatchFetch('http://localhost/identity/connect/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '192.0.2.1' },
    body: new URLSearchParams({ grant_type: 'password', username: user.email, password: value.proof, client_id: 'web', scope: 'api offline_access', deviceType: '9', deviceIdentifier: `fixture-${user.id}`, ...extras }).toString(),
  });
  return { status: response.status, body: await response.json() };
}
async function api(route, token, body) {
  const response = await worker.dispatchFetch(`http://localhost${route}`, {
    method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
async function createCipher(token, label) {
  const response = await api('/api/ciphers', token, { type: 1, name: await encrypt(label), notes: await encrypt('created after the upgrade'), login: { username: await encrypt('fixture'), password: await encrypt('fixture-vault-password'), uris: [] } });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.id;
}
async function changePassword(token, before, after) {
  const response = await api('/api/accounts/password', token, { masterPasswordHash: before.proof, newMasterPasswordHash: after.proof, key: after.wrapped });
  assert.equal(response.status, 200, JSON.stringify(response.body));
}
async function assertVault(token, value, ids) {
  const stored = await row();
  assert.deepEqual(await decryptBw(stored.key, value.enc, value.mac), userKey, 'Current password unwraps the original user key');
  for (const [id, label] of ids) {
    const response = await api(`/api/ciphers/${id}`, token);
    assert.equal(response.status, 200);
    assert.equal(await decryptStr(response.body.name, vaultEnc, vaultMac), label);
    assert.equal(await decryptStr(response.body.login.password, vaultEnc, vaultMac), 'fixture-vault-password');
  }
}

try {
  await switchCode('reader');
  const legacy = await seed(first, initial);
  const legacyTotp = await seed(second, totpMaterial, totpSecret);
  const baselineLogin = await login(first, initial);
  assert.equal(baselineLogin.status, 200);
  assert.equal((await row()).master_password_hash, legacy, 'Reader baseline must not migrate');
  assert.equal((await login(second, totpMaterial)).status, 400);
  assert.equal((await row(second)).master_password_hash, legacyTotp);
  console.log('PASS: reader baseline logs in legacy accounts without migration; 2FA is still required');

  await switchCode('candidate');
  assert.equal((await login(first, { proof: 'wrong-proof' })).status, 400);
  assert.equal((await row()).master_password_hash, legacy);
  const authenticated = await login(first, initial);
  assert.equal(authenticated.status, 200);
  const migrated = await row();
  assert.match(migrated.master_password_hash, /^\$s2\$100000\$/);
  assert.equal(migrated.key, initial.wrapped);
  assert.equal(migrated.security_stamp, `stamp-${first.id}`);
  const firstCipher = await createCipher(authenticated.body.access_token, 'created on the new Worker');
  await changePassword(authenticated.body.access_token, initial, changed);
  assert.notEqual((await row()).security_stamp, migrated.security_stamp);
  assert.equal((await api('/api/sync', authenticated.body.access_token)).status, 401, 'Password changes revoke old access sessions');
  const refresh = await worker.dispatchFetch('http://localhost/identity/connect/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '192.0.2.1' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: authenticated.body.refresh_token }).toString() });
  assert.equal(refresh.status, 400, 'Password changes revoke refresh tokens'); await refresh.arrayBuffer();
  assert.equal((await login(first, initial)).status, 400);
  assert.equal((await login(first, changed)).status, 200);
  assert.equal((await login(second, totpMaterial)).status, 400);
  assert.equal((await login(second, totpMaterial, { twoFactorProvider: '0', twoFactorToken: 'invalid' })).status, 400);
  assert.equal((await row(second)).master_password_hash, legacyTotp, 'Failed second factor must not migrate');
  const totp = (await calcTotpNow(totpSecret)).code;
  assert.equal((await login(second, totpMaterial, { twoFactorProvider: '0', twoFactorToken: totp })).status, 200);
  const migratedTotp = (await row(second)).master_password_hash;
  assert.match(migratedTotp, /^\$s2\$/);
  const currentRows = (await db.prepare('SELECT * FROM ciphers ORDER BY id').all()).results;
  const currentUser = await row();
  console.log('PASS: migration, new encrypted vault data, password change, old-session revocation and successful TOTP migration');

  await switchCode('unsafe');
  assert.equal((await login(first, changed)).status, 400, 'Unpatched old Worker cannot log in migrated accounts');
  console.log('PASS: negative control reproduces the original rollback login failure');

  await switchCode('reader');
  const afterRollback = await login(first, changed);
  assert.equal(afterRollback.status, 200);
  assert.equal((await login(first, initial)).status, 400);
  assert.deepEqual(await row(), currentUser, 'Rollback login changes no account key, verifier, stamp or account timestamp');
  assert.deepEqual((await db.prepare('SELECT * FROM ciphers ORDER BY id').all()).results, currentRows, 'Rollback keeps all latest vault rows');
  await assertVault(afterRollback.body.access_token, changed, [[firstCipher, 'created on the new Worker']]);
  assert.equal((await login(second, totpMaterial)).status, 400);
  assert.equal((await login(second, totpMaterial, { twoFactorProvider: '0', twoFactorToken: totp })).status, 400, 'TOTP replay protection survives rollback');
  const nextTotp = (await calcTotpNow(totpSecret, Date.now() + 30000)).code;
  assert.equal((await login(second, totpMaterial, { twoFactorProvider: '0', twoFactorToken: nextTotp })).status, 200);
  assert.equal((await row(second)).master_password_hash, migratedTotp, 'Rollback keeps s2 and does not silently downgrade');
  const secondCipher = await createCipher(afterRollback.body.access_token, 'created on the rollback Worker');
  await changePassword(afterRollback.body.access_token, changed, changedAgain);
  assert.match((await row()).master_password_hash, /^\$s\$/);
  assert.equal((await login(first, changed)).status, 400);
  const rollbackPassword = await login(first, changedAgain);
  assert.equal(rollbackPassword.status, 200);
  const ids = [[firstCipher, 'created on the new Worker'], [secondCipher, 'created on the rollback Worker']];
  await assertVault(rollbackPassword.body.access_token, changedAgain, ids);
  console.log('PASS: rollback login, latest vault ciphertext/decryption, TOTP requirement/replay protection and password changes without reset');

  await switchCode('candidate');
  const forward = await login(first, changedAgain);
  assert.equal(forward.status, 200);
  assert.match((await row()).master_password_hash, /^\$s2\$/);
  await assertVault(forward.body.access_token, changedAgain, ids);

  // Reproduce the official browser client's skipNegotiation request shape. It
  // carries access_token in the URL, not an Authorization header or id ticket.
  const url = new URL('/notifications/hub', await worker.ready);
  url.searchParams.set('access_token', forward.body.access_token);
  const status = await new Promise((resolve, reject) => {
    const request = http.get(url, { headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' } }, (response) => {
      response.resume(); response.once('end', () => resolve(response.statusCode));
    });
    request.once('upgrade', (_response, socket) => { socket.destroy(); reject(new Error('URL access JWT unexpectedly accepted')); });
    request.once('error', reject);
  });
  assert.equal(status, 401);
  console.log('PASS: forward re-upgrade preserves data; official browser direct-JWT WebSocket shape reproduces HTTP 401 (documented compatibility BLOCKER)');
} finally {
  if (worker) await worker.dispose();
  assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith('nodewarden-rollback-'));
  fs.rmSync(temporary, { recursive: true, force: true });
}
