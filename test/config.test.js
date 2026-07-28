import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '../src/config.js';

test('loads generic upstream config and applies environment overrides', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'proxy-sub-distributor-'));
  try {
    const configPath = join(dir, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        server: { host: '127.0.0.1', port: 7899, syncToken: 'file-sync-token' },
        upstream: {
          url: 'https://provider.example/subscription.yaml',
          headers: { Authorization: 'Bearer example' }
        },
        sync: { intervalMinutes: 360, runOnStart: true },
        devices: { router: { token: 'router-token' } }
      })
    );

    const config = await loadConfig(configPath, {
      UPSTREAM_URL: 'https://override.example/subscription.yaml',
      SYNC_TOKEN: 'env-sync-token',
      PORT: '7999'
    });

    assert.equal(config.server.port, 7999);
    assert.equal(config.server.syncToken, 'env-sync-token');
    assert.equal(config.upstream.url, 'https://override.example/subscription.yaml');
    assert.equal(config.upstream.headers.Authorization, 'Bearer example');
    assert.deepEqual(config.clash, {});
    assert.equal(config.devices.router.token, 'router-token');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejects configs without an upstream URL or device tokens', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'proxy-sub-distributor-'));
  try {
    const configPath = join(dir, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        server: { syncToken: 'sync-token' },
        devices: { phone: { token: '' } }
      })
    );

    await assert.rejects(() => loadConfig(configPath, {}), /Device phone token is required/);

    await writeFile(
      configPath,
      JSON.stringify({
        server: { syncToken: 'sync-token' },
        devices: { phone: { token: 'phone-token' } }
      })
    );
    await assert.rejects(
      () => loadConfig(configPath, {}),
      /Upstream subscription URL is required/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
