import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '../src/config.js';

test('loads config and applies secret environment overrides', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fib-sub-sync-'));
  try {
    const configPath = join(dir, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        server: { host: '127.0.0.1', port: 7899, syncToken: 'file-sync-token' },
        fib: { baseUrl: 'https://1.fibacc.net', email: 'file@example.com', password: 'file-password' },
        sync: { intervalMinutes: 360, runOnStart: true },
        devices: { mt5000: { token: 'router-token' } }
      })
    );

    const config = await loadConfig(configPath, {
      FIB_EMAIL: 'env@example.com',
      FIB_PASSWORD: 'env-password',
      SYNC_TOKEN: 'env-sync-token',
      PORT: '7999'
    });

    assert.equal(config.server.port, 7999);
    assert.equal(config.server.syncToken, 'env-sync-token');
    assert.equal(config.fib.email, 'env@example.com');
    assert.equal(config.fib.password, 'env-password');
    assert.deepEqual(config.clash, {});
    assert.equal(config.devices.mt5000.token, 'router-token');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejects configs without device tokens', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fib-sub-sync-'));
  try {
    const configPath = join(dir, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        fib: { email: 'me@example.com', password: 'secret' },
        devices: { phone: { token: '' } }
      })
    );

    await assert.rejects(
      () => loadConfig(configPath, {}),
      /Device phone token is required/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
