import assert from 'node:assert/strict';
import test from 'node:test';

import { handleNotificationsHub, handleNotificationsNegotiate } from '../src/handlers/notifications';
import type { Env } from '../src/types';
import { createJWT } from '../src/utils/jwt';
import type { NotificationSession } from '../src/services/notification-auth';
import { handleRequest } from '../src/router';

const secret = 'notification-security-test-secret-32-bytes';
const userId = 'd75020e1-2de4-46e8-b8f1-475d127b51f2';
const securityStamp = 'security-stamp';

function createTestEnv() {
  const connectionTokens = new Map<string, { userId: string; deviceIdentifier: string | null; expiresAt: number; session: NotificationSession }>();
  const forwardedHubUrls: string[] = [];
  const forwardedHeaders: Headers[] = [];
  const durableObjectNames: string[] = [];
  const userRow = {
    id: userId,
    email: 'user@example.test',
    name: 'Test User',
    master_password_hint: null,
    master_password_hash: 'hash',
    key: 'key',
    private_key: null,
    public_key: null,
    kdf_type: 0,
    kdf_iterations: 600000,
    kdf_memory: null,
    kdf_parallelism: null,
    security_stamp: securityStamp,
    role: 'user',
    status: 'active',
    verify_devices: 0,
    totp_secret: null,
    totp_recovery_code: null,
    yubikey_key1: null,
    yubikey_key2: null,
    yubikey_key3: null,
    yubikey_key4: null,
    yubikey_key5: null,
    yubikey_nfc: 0,
    api_key: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const records = {
    user: userRow as typeof userRow | null,
    device: { user_id: userId, device_identifier: 'fixture-device', session_stamp: 'fixture-session', banned: 0 } as { user_id: string; device_identifier: string; session_stamp: string; banned: number } | null,
    forwardError: null as string | null,
  };
  const db = {
    prepare(sql: string) {
      return {
        bind() {
          return this;
        },
        async first() {
          return sql.includes('FROM devices') ? records.device : records.user;
        },
      };
    },
  } as unknown as D1Database;

  const stub = {
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === '/internal/ws-token') {
        const body = await request.json() as {
          token: string;
          userId: string;
          deviceIdentifier: string | null;
          expiresAt: number;
          session: NotificationSession;
        };
        connectionTokens.set(body.token, body);
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/internal/ws-token/consume') {
        const { token } = await request.json() as { token: string };
        const connection = connectionTokens.get(token);
        connectionTokens.delete(token);
        if (!connection || connection.expiresAt <= Date.now()) return new Response(null, { status: 401 });
        return Response.json(connection);
      }
      forwardedHubUrls.push(request.url);
      forwardedHeaders.push(request.headers);
      if (records.forwardError) throw new Error(records.forwardError);
      return new Response(null, { status: 204 });
    },
  };

  const env = {
    DB: db,
    JWT_SECRET: secret,
    NOTIFICATIONS_HUB: {
      idFromName(name: string) {
        durableObjectNames.push(name);
        return name;
      },
      get() {
        return stub;
      },
    },
  } as unknown as Env;

  return { env, connectionTokens, durableObjectNames, forwardedHubUrls, forwardedHeaders, records };
}

async function validAccessToken(claims = {}, expiresIn = 7200): Promise<string> {
  return createJWT({
    sub: userId,
    email: 'user@example.test',
    name: 'Test User',
    sstamp: securityStamp,
    ...claims,
  }, secret, expiresIn);
}

test('official query access_token authenticates only the hub and is scrubbed before internal forwarding', async () => {
  const { env, forwardedHubUrls, forwardedHeaders } = createTestEnv();
  const token = await validAccessToken();
  const response = await handleNotificationsHub(new Request(
    `https://vault.example.test/notifications/hub?access_token=${encodeURIComponent(token)}&trace=${encodeURIComponent(token)}&nw_uid=attacker`,
    { headers: { Upgrade: 'websocket', Cookie: 'fixture-cookie', Referer: `https://example.test/?access_token=${token}` } }
  ), env);

  assert.equal(response.status, 204);
  assert.equal(new URL(forwardedHubUrls[0]).searchParams.get('nw_uid'), userId);
  assert.equal(forwardedHubUrls[0].includes(token), false);
  assert.equal(forwardedHubUrls[0].includes('access_token'), false);
  assert.equal(JSON.stringify([...forwardedHeaders[0]]).includes(token), false);
  for (const name of ['Authorization', 'Cookie', 'Referer']) assert.equal(forwardedHeaders[0].has(name), false);
});

test('Authorization bearer token still authenticates notifications', async () => {
  const { env, forwardedHubUrls, forwardedHeaders } = createTestEnv();
  const token = await validAccessToken();
  const response = await handleNotificationsHub(new Request(
    'https://vault.example.test/notifications/hub',
    { headers: { Authorization: `Bearer ${token}`, Upgrade: 'websocket' } }
  ), env);

  assert.equal(response.status, 204);
  assert.equal(new URL(forwardedHubUrls[0]).searchParams.get('nw_uid'), userId);
  assert.equal(forwardedHeaders[0].has('Authorization'), false);
});

test('negotiate issues a short-lived one-time websocket connection token', async () => {
  const { env, connectionTokens, forwardedHubUrls } = createTestEnv();
  const accessToken = await validAccessToken();
  const negotiate = await handleNotificationsNegotiate(new Request(
    'https://vault.example.test/notifications/hub/negotiate',
    { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` } }
  ), env);
  const body = await negotiate.json() as { connectionToken: string };
  const stored = connectionTokens.get(body.connectionToken);

  assert.equal(negotiate.status, 200);
  assert.ok(stored);
  assert.ok(stored.expiresAt > Date.now());
  assert.ok(stored.expiresAt <= Date.now() + 60_000);

  const request = () => new Request(
    `https://vault.example.test/notifications/hub?id=${encodeURIComponent(body.connectionToken)}`,
    { headers: { Upgrade: 'websocket' } }
  );
  assert.equal((await handleNotificationsHub(request(), env)).status, 204);
  assert.equal((await handleNotificationsHub(request(), env)).status, 401);
  assert.equal(forwardedHubUrls.length, 1);
  assert.equal(new URL(forwardedHubUrls[0]).searchParams.has('id'), false);
});

test('a valid URL JWT never overrides an invalid explicit Authorization or ticket', async () => {
  const { env, forwardedHubUrls } = createTestEnv();
  const token = await validAccessToken();
  const url = `https://vault.example.test/notifications/hub?access_token=${encodeURIComponent(token)}`;
  assert.equal((await handleNotificationsHub(new Request(url, { headers: { Upgrade: 'websocket', Authorization: 'Bearer invalid' } }), env)).status, 401);
  assert.equal((await handleNotificationsHub(new Request(url + '&id=invalid', { headers: { Upgrade: 'websocket' } }), env)).status, 401);
  assert.deepEqual(forwardedHubUrls, []);
});

for (const [label, method, path, upgrade, expected] of [
  ['plain HTTP', 'GET', '/notifications/hub', false, 426],
  ['wrong method', 'POST', '/notifications/hub', true, 404],
  ['another API', 'GET', '/api/sync', true, 404],
  ['trailing path', 'GET', '/notifications/hub/extra', true, 404],
] as const) {
  test(`URL JWT is unavailable for ${label}`, async () => {
    const { env, forwardedHubUrls } = createTestEnv();
    const token = await validAccessToken();
    const response = await handleNotificationsHub(new Request(`https://vault.example.test${path}?access_token=${token}`, { method, headers: upgrade ? { Upgrade: 'websocket' } : {} }), env);
    assert.equal(response.status, expected);
    assert.deepEqual(forwardedHubUrls, []);
  });
}

test('query JWT is not accepted for negotiate or with duplicate query credentials', async () => {
  const { env } = createTestEnv();
  const token = await validAccessToken();
  assert.equal((await handleNotificationsNegotiate(new Request(`https://vault.example.test/notifications/hub/negotiate?access_token=${token}`, { method: 'POST' }), env)).status, 401);
  assert.equal((await handleNotificationsHub(new Request(`https://vault.example.test/notifications/hub?access_token=${token}&access_token=${token}`, { headers: { Upgrade: 'websocket' } }), env)).status, 401);
});

test('expired, tampered, malformed and purpose-incompatible JWTs are rejected', async () => {
  const { env, forwardedHubUrls } = createTestEnv();
  const tokens = [await validAccessToken({}, -1), await validAccessToken({}, 0), 'invalid',
    (await validAccessToken()).slice(0, -4) + 'AAAA', await validAccessToken({ sstamp: '' }),
    await validAccessToken({ did: 'fixture-device' }), await validAccessToken({ dstamp: 'fixture-session' })];
  for (const token of tokens) {
    assert.equal((await handleNotificationsHub(new Request(`https://vault.example.test/notifications/hub?access_token=${token}`, { headers: { Upgrade: 'websocket' } }), env)).status, 401);
  }
  assert.deepEqual(forwardedHubUrls, []);
});

test('each handshake freshly validates account status, security stamp and device session', async () => {
  const { env, records } = createTestEnv();
  const token = await validAccessToken({ did: 'fixture-device', dstamp: 'fixture-session' });
  const connect = () => handleNotificationsHub(new Request(`https://vault.example.test/notifications/hub?access_token=${token}`, { headers: { Upgrade: 'websocket' } }), env);
  assert.equal((await connect()).status, 204);
  records.device!.session_stamp = 'revoked-session';
  assert.equal((await connect()).status, 401);
  records.device = null;
  assert.equal((await connect()).status, 401);
  records.device = { user_id: userId, device_identifier: 'fixture-device', session_stamp: 'fixture-session', banned: 1 };
  assert.equal((await connect()).status, 401);
  records.device.banned = 0;
  records.user!.status = 'banned';
  assert.equal((await connect()).status, 401);
  records.user!.status = 'disabled';
  assert.equal((await connect()).status, 401);
  records.user!.status = 'active';
  records.user!.security_stamp = 'changed-password-stamp';
  assert.equal((await connect()).status, 401);
  records.user = null;
  assert.equal((await connect()).status, 401);
});

test('valid signatures do not bypass required JWT headers, issuer or claim types', async () => {
  const { env } = createTestEnv();
  const source = await validAccessToken();
  const payload = JSON.parse(Buffer.from(source.split('.')[1], 'base64url').toString());
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  for (const [claims, header] of [
    [{ ...payload, exp: undefined }, { alg: 'HS256', typ: 'JWT' }],
    [{ ...payload, exp: String(payload.exp) }, { alg: 'HS256', typ: 'JWT' }],
    [{ ...payload, iss: 'another-purpose' }, { alg: 'HS256', typ: 'JWT' }],
    [{ ...payload, iat: payload.exp }, { alg: 'HS256', typ: 'JWT' }],
    [{ ...payload, nbf: payload.exp }, { alg: 'HS256', typ: 'JWT' }],
    [payload, { alg: 'none', typ: 'JWT' }],
    [payload, { alg: 'HS256', typ: 'another-purpose' }],
  ]) {
    const data = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
    const token = `${data}.${Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))).toString('base64url')}`;
    assert.equal((await handleNotificationsHub(new Request(`https://vault.example.test/notifications/hub?access_token=${token}`, { headers: { Upgrade: 'websocket' } }), env)).status, 401);
  }
});

test('ticket deadline does not extend the original access JWT expiry', async () => {
  const { env, connectionTokens } = createTestEnv();
  const accessToken = await validAccessToken({}, 30);
  const negotiate = await handleNotificationsNegotiate(new Request('https://vault.example.test/notifications/hub/negotiate', { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` } }), env);
  const { connectionToken } = await negotiate.json() as { connectionToken: string };
  const stored = connectionTokens.get(connectionToken)!;
  assert.ok(stored.expiresAt <= stored.session.exp * 1000);
  assert.equal(JSON.stringify(stored).includes(accessToken), false);
});

test('one-time tickets also reject an account disabled after negotiation', async () => {
  const { env, records, forwardedHubUrls } = createTestEnv();
  const token = await validAccessToken();
  const negotiate = await handleNotificationsNegotiate(new Request('https://vault.example.test/notifications/hub/negotiate', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }), env);
  const { connectionToken } = await negotiate.json() as { connectionToken: string };
  records.user!.status = 'disabled';
  assert.equal((await handleNotificationsHub(new Request(`https://vault.example.test/notifications/hub?id=${connectionToken}`, { headers: { Upgrade: 'websocket' } }), env)).status, 401);
  assert.deepEqual(forwardedHubUrls, []);
});

test('notification exceptions do not serialize request credentials into application logs', async (ctx) => {
  const { env, records } = createTestEnv();
  const token = await validAccessToken();
  records.forwardError = `Transport failure containing credentials: ${token}`;
  const logger = ctx.mock.method(console, 'error', () => {});
  const response = await handleRequest(new Request(`https://vault.example.test/notifications/hub?access_token=${token}`, { headers: { Upgrade: 'websocket' } }), env);
  assert.equal(response.status, 500);
  assert.ok(logger.mock.callCount() > 0);
  assert.equal(JSON.stringify(logger.mock.calls.map(c => c.arguments)).includes(token), false);
  assert.equal((await response.text()).includes(token), false);
});

test('a non-upgrade request does not consume a websocket connection token', async () => {
  const { env, connectionTokens } = createTestEnv();
  const accessToken = await validAccessToken();
  const negotiate = await handleNotificationsNegotiate(new Request(
    'https://vault.example.test/notifications/hub/negotiate',
    { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` } }
  ), env);
  const { connectionToken } = await negotiate.json() as { connectionToken: string };
  const url = `https://vault.example.test/notifications/hub?id=${encodeURIComponent(connectionToken)}`;

  assert.equal((await handleNotificationsHub(new Request(url), env)).status, 426);
  assert.ok(connectionTokens.has(connectionToken));
  assert.equal((await handleNotificationsHub(new Request(url, { headers: { Upgrade: 'websocket' } }), env)).status, 204);
});

test('a forged ticket cannot select or activate a Durable Object', async () => {
  const { env, durableObjectNames } = createTestEnv();
  const response = await handleNotificationsHub(new Request(
    'https://vault.example.test/notifications/hub?id=attacker-controlled.invalid-signature',
    { headers: { Upgrade: 'websocket' } }
  ), env);

  assert.equal(response.status, 401);
  assert.deepEqual(durableObjectNames, []);
});
