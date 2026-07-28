import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import YAML from 'yaml';

import { SubscriptionCache } from '../src/cache.js';
import { transformClashYaml } from '../src/clash.js';
import { createServer } from '../src/server.js';
import { createStrategyConfigLoader } from '../src/strategy-config.js';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

function strategy(name) {
  return {
    fallbackGroups: [
      {
        name,
        targetGroup: 'PROXY',
        includePattern: '^Region A ',
        interval: 60
      }
    ]
  };
}

test('subscription requests hot reload strategies and retain the last good config', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'proxy-sub-distributor-hot-reload-'));
  const configPath = join(dir, 'clash-strategies.json');
  const source = YAML.stringify({
    proxies: [
      {
        name: 'Region A Primary',
        type: 'ss',
        server: '127.0.0.1',
        port: 8388
      }
    ],
    'proxy-groups': [
      {
        name: 'PROXY',
        type: 'select',
        proxies: ['Region A Primary']
      }
    ],
    rules: ['MATCH,PROXY']
  });
  const cache = new SubscriptionCache(dir);
  await cache.saveSuccessfulConfig(source, {
    sourceUrl: 'https://seed.example/sub',
    subscriptionUrlHost: 'seed.example',
    fetchedAt: '2026-07-28T00:00:00.000Z'
  });
  await writeFile(configPath, JSON.stringify(strategy('策略 A')));

  let reloads = 0;
  let errors = 0;
  const loader = createStrategyConfigLoader({
    configPath,
    validate: (options, yamlText) => transformClashYaml(yamlText, options),
    onReload: () => reloads++,
    onError: () => errors++
  });
  await loader.loadStrict(source);

  const server = createServer({
    cache,
    devices: { phone: { token: 'phone-token' } },
    loadClashOptions: loader.load,
    syncToken: 'sync-token',
    syncNow: async () => ({ ok: true })
  });

  try {
    const base = await listen(server);
    const getGroups = async () => {
      const response = await fetch(`${base}/sub/phone?token=phone-token`);
      assert.equal(response.status, 200);
      return YAML.parse(await response.text())['proxy-groups'].map((group) => group.name);
    };

    assert.ok((await getGroups()).includes('策略 A'));

    await writeFile(configPath, JSON.stringify(strategy('策略 B')));
    const afterReload = await getGroups();
    assert.ok(afterReload.includes('策略 B'));
    assert.ok(!afterReload.includes('策略 A'));

    await writeFile(configPath, '{ invalid json');
    assert.ok((await getGroups()).includes('策略 B'));
    assert.ok((await getGroups()).includes('策略 B'));
    assert.equal(reloads, 2);
    assert.equal(errors, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
