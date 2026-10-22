import assert from 'node:assert/strict';
import test from 'node:test';
import { createPasswordVerifier, needsPasswordVerifierUpgrade, verifyPasswordVerifier } from '../src/services/password-verifier';

const proof = 'local-test-client-proof';
const email = 'existing@example.invalid';

test('new verifiers use independent random salts and verify only the correct proof', async () => {
  const first = await createPasswordVerifier(proof);
  const second = await createPasswordVerifier(proof);
  assert.notEqual(first, second);
  assert.equal(await verifyPasswordVerifier(proof, first, email), true);
  assert.equal(await verifyPasswordVerifier('wrong-proof', first, email), false);
  assert.equal(await verifyPasswordVerifier(proof, first, 'changed@example.invalid'), true);
  assert.equal(needsPasswordVerifierUpgrade(first), false);
});

test('existing email-salted PBKDF2 verifiers remain usable and need migration', async () => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(proof), 'PBKDF2', false, ['deriveBits']);
  const digest = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', iterations: 100000, salt: new TextEncoder().encode(email) }, key, 256);
  const legacy = '$s$' + Buffer.from(digest).toString('base64');
  assert.equal(await verifyPasswordVerifier(proof, legacy, ' Existing@Example.Invalid '), true);
  assert.equal(await verifyPasswordVerifier('wrong-proof', legacy, email), false);
  assert.equal(await verifyPasswordVerifier(proof, legacy, 'other@example.invalid'), false);
  assert.equal(needsPasswordVerifierUpgrade(legacy), true);
});

test('raw legacy client proofs remain compatible without accepting a wrong proof', async () => {
  assert.equal(await verifyPasswordVerifier(proof, proof, email), true);
  assert.equal(await verifyPasswordVerifier('wrong-proof', proof, email), false);
  assert.equal(needsPasswordVerifierUpgrade(proof), true);
});

for (const stored of ['$s$invalid', '$s2$100000$invalid$invalid', '$s2$1$invalid$invalid', '$s2$999999999999$invalid$invalid', '$unknown$proof']) {
  test(`reserved malformed verifier cannot authenticate by raw equality: ${stored}`, async () => {
    assert.equal(await verifyPasswordVerifier(stored, stored, email), false);
  });
}

test('missing or empty stored verifiers never authenticate', async () => {
  assert.equal(await verifyPasswordVerifier(proof, null, email), false);
  assert.equal(await verifyPasswordVerifier('', '', email), false);
});
