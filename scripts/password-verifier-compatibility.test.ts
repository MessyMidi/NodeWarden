import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthService } from '../src/services/auth';
import { createPasswordVerifier } from '../src/services/password-verifier';
import type { Env } from '../src/types';

// Authentication verification does not need storage; this is deliberately not a
// fake integration test. The cross-version D1 lifecycle has a separate runner.
const auth = new AuthService({ DB: {} } as Env);
const proof = 'local-rollback-client-proof';
const email = 'rollback@example.invalid';

test('AuthService accepts s2 rows without exposing a pass-the-hash fallback', async () => {
  const stored = await createPasswordVerifier(proof);
  assert.equal(await auth.verifyPassword(proof, stored, email), true);
  assert.equal(await auth.verifyPassword('wrong-proof', stored, email), false);
  assert.equal(await auth.verifyPassword(stored, stored, email), false);
});

test('AuthService still accepts email-salted legacy rows', async () => {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(proof), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', iterations: 100000, salt: new TextEncoder().encode(email) }, material, 256);
  const stored = '$s$' + Buffer.from(bits).toString('base64');
  assert.equal(await auth.verifyPassword(proof, stored, email), true);
  assert.equal(await auth.verifyPassword('wrong-proof', stored, email), false);
});

test('AuthService keeps raw legacy compatibility and rejects corrupt reserved rows', async () => {
  assert.equal(await auth.verifyPassword(proof, proof, email), true);
  for (const stored of ['$s$corrupt', '$s2$1$invalid$invalid', '$unknown$proof']) {
    assert.equal(await auth.verifyPassword(stored, stored, email), false);
  }
});
