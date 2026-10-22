import assert from 'node:assert/strict';
import test from 'node:test';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js';
import { buildBitwardenZipBytes, encryptZipBytesWithPassword } from '../webapp/src/lib/export-formats';

const data = JSON.stringify({ encrypted: false, folders: [], items: [{ id: 'fixture', name: '本地导出测试' }] });
const attachment = new Uint8Array([0, 1, 127, 128, 255]);
const archive = () => buildBitwardenZipBytes(data, [{ cipherId: 'fixture', fileName: '测试.bin', bytes: attachment }]);

test('real export preserves JSON and binary attachment through AES-256 ZIP encryption', async () => {
  const result = await encryptZipBytesWithPassword(archive(), 'local-export-test-password');
  assert.equal(result.encrypted, true);
  const reader = new ZipReader(new Uint8ArrayReader(result.bytes), { useWebWorkers: false });
  try {
    const entries = await reader.getEntries();
    assert.equal(entries.length, 2);
    for (const entry of entries) {
      assert.equal(entry.encrypted, true);
      assert.ok(!entry.directory);
      if (entry.directory) throw new Error('Unexpected directory');
      const bytes = await entry.getData(new Uint8ArrayWriter(), { password: 'local-export-test-password' });
      if (entry.filename === 'data.json') assert.equal(new TextDecoder().decode(bytes), data);
      else {
        assert.equal(entry.filename, 'attachments/fixture/测试.bin');
        assert.deepEqual(bytes, attachment);
      }
    }
  } finally { await reader.close(); }
});

test('password-protected export rejects a wrong password', async () => {
  const result = await encryptZipBytesWithPassword(archive(), 'local-export-test-password');
  const reader = new ZipReader(new Uint8ArrayReader(result.bytes), { useWebWorkers: false });
  try {
    const entry = (await reader.getEntries())[0];
    if (entry.directory) throw new Error('Unexpected directory');
    await assert.rejects(entry.getData(new Uint8ArrayWriter(), { password: 'incorrect-password' }));
  } finally { await reader.close(); }
});

test('export without a ZIP password preserves the original archive', async () => {
  const bytes = archive();
  const result = await encryptZipBytesWithPassword(bytes, '');
  assert.equal(result.encrypted, false);
  assert.equal(result.bytes, bytes);
});
