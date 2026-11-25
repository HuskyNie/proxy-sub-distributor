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
    assert.deepEqual(config.upstreams, []);
    assert.equal(config.devices.mt5000.token, 'router-token');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loads optional socket and URL upstreams without changing the FIB login', async (context) => {
  const dir = await mkdtemp(join(tmpdir(), 'fib-upstreams-config-'));
  context.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'config.json');
  const kitty = { id: 'kitty', name: 'Kitty', targetGroup: 'PROXY', socketPath: '/run/kitty/subscription.sock',
    excludePattern: '^(?:🇦🇱\\s*)?剩余流量[：:]' };
  const other = { id: 'other', name: 'Other', targetGroup: 'PROXY', url: 'https://example.invalid/sub',
    headers: { 'User-Agent': 'mihomo' }, intervalMinutes: 30 };
  const settings = { server: { syncToken: 'test' }, fib: { email: 'test@example.invalid', password: 'test' },
    sync: { intervalMinutes: 120 }, upstreams: [kitty, other] };
  await writeFile(configPath, JSON.stringify(settings));
  const config = await loadConfig(configPath, {});

  assert.equal(config.fib.email, 'test@example.invalid');
  assert.equal(config.upstreams[0].intervalMinutes, 120);
  assert.equal(config.upstreams[0].socketPath, kitty.socketPath);
  assert.equal(config.upstreams[0].exclude.test('🇦🇱 剩余流量：100 GB'), true);
  assert.equal(config.upstreams[1].headers.get('user-agent'), 'mihomo');

  settings.upstreams.push({ ...kitty, socketPath: '/run/test.sock' });
  await writeFile(configPath, JSON.stringify(settings));
  await assert.rejects(loadConfig(configPath, {}), /Upstream id must be unique/);
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
