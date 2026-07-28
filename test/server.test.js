import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import YAML from 'yaml';

import { SubscriptionCache } from '../src/cache.js';
import { createServer } from '../src/server.js';

const validYaml = `
proxies:
  - name: us-01
    type: ss
    server: 127.0.0.1
    port: 8388
    cipher: aes-128-gcm
    password: test
proxy-groups:
  - name: PROXY
    type: select
    proxies:
      - us-01
rules:
  - MATCH,PROXY
`;

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

test('serves health, status, and token-protected device subscriptions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'proxy-sub-distributor-'));
  const cache = new SubscriptionCache(dir);
  await cache.saveSuccessfulConfig(validYaml, {
    sourceUrl: 'https://seed.example/sub',
    subscriptionUrlHost: 'seed.example',
    fetchedAt: '2026-06-21T04:00:00.000Z'
  });

  const server = createServer({
    cache,
    devices: {
      mt5000: { token: 'router-token' },
      phone: { token: 'phone-token' }
    },
    syncToken: 'sync-secret',
    syncNow: async () => ({ ok: true, proxyCount: 1 })
  });

  try {
    const base = await listen(server);

    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);

    const forbidden = await fetch(`${base}/sub/mt5000?token=wrong`);
    assert.equal(forbidden.status, 403);

    const sub = await fetch(`${base}/sub/mt5000?token=router-token`);
    assert.equal(sub.status, 200);
    assert.match(sub.headers.get('content-type'), /yaml/);
    assert.match(await sub.text(), /us-01/);

    const status = await fetch(`${base}/status`);
    assert.equal(status.status, 200);
    const statusBody = await status.json();
    assert.equal(statusBody.cache.proxyCount, 1);
    assert.deepEqual(statusBody.devices.sort(), ['mt5000', 'phone']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('manual sync requires the admin token', async () => {
  let syncCalls = 0;
  const dir = await mkdtemp(join(tmpdir(), 'proxy-sub-distributor-'));
  const server = createServer({
    cache: new SubscriptionCache(dir),
    devices: {},
    syncToken: 'sync-secret',
    syncNow: async () => {
      syncCalls += 1;
      return { ok: true, proxyCount: 2 };
    }
  });

  try {
    const base = await listen(server);

    const forbidden = await fetch(`${base}/sync`, { method: 'POST' });
    assert.equal(forbidden.status, 403);

    const ok = await fetch(`${base}/sync?token=sync-secret`, { method: 'POST' });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).proxyCount, 2);
    assert.equal(syncCalls, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('applies global Clash transforms to every device subscription', async () => {
  const source = `
proxies:
  - name: Region A Primary
    type: ss
    server: 127.0.0.1
    port: 8388
  - name: Region A Backup
    type: ss
    server: 127.0.0.2
    port: 8388
proxy-groups:
  - name: PROXY
    type: select
    proxies:
      - Region A Primary
      - Region A Backup
rules:
  - MATCH,PROXY
`;
  const dir = await mkdtemp(join(tmpdir(), 'proxy-sub-distributor-'));
  const cache = new SubscriptionCache(dir);
  await cache.saveSuccessfulConfig(source, {
    sourceUrl: 'https://seed.example/sub',
    subscriptionUrlHost: 'seed.example',
    fetchedAt: '2026-06-21T04:00:00.000Z'
  });

  const server = createServer({
    cache,
    clash: {
      fallbackGroups: [
        {
          name: 'Region A Fallback',
          targetGroup: 'PROXY',
          includePattern: '^Region A ',
          interval: 60
        }
      ]
    },
    devices: {
      mt3600be: {
        token: 'router-token',
        clash: {
          fallbackGroups: [
            {
              name: 'Region A Fallback',
              targetGroup: 'PROXY',
              includePattern: '^Region A ',
              interval: 30
            }
          ]
        }
      },
      phone: { token: 'phone-token' }
    },
    syncToken: 'sync-secret',
    syncNow: async () => ({ ok: true })
  });

  try {
    const base = await listen(server);
    const routerYaml = YAML.parse(
      await (await fetch(`${base}/sub/mt3600be?token=router-token`)).text()
    );
    const phoneYaml = YAML.parse(
      await (await fetch(`${base}/sub/phone?token=phone-token`)).text()
    );

    assert.ok(
      routerYaml['proxy-groups'].some((group) => group.name === 'Region A Fallback')
    );
    assert.ok(
      phoneYaml['proxy-groups'].some((group) => group.name === 'Region A Fallback')
    );
    assert.equal(
      routerYaml['proxy-groups'].find((group) => group.name === 'Region A Fallback')
        .interval,
      30
    );
    assert.equal(
      phoneYaml['proxy-groups'].find((group) => group.name === 'Region A Fallback').interval,
      60
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('manual URL sync endpoint requires the admin token and accepts JSON', async () => {
  let receivedUrl = null;
  const dir = await mkdtemp(join(tmpdir(), 'proxy-sub-distributor-'));
  const server = createServer({
    cache: new SubscriptionCache(dir),
    devices: {},
    syncToken: 'sync-secret',
    syncNow: async () => ({ ok: true }),
    syncUrl: async (url) => {
      receivedUrl = url;
      return { ok: true, subscriptionUrlHost: 'sub.example.com' };
    }
  });

  try {
    const base = await listen(server);

    const forbidden = await fetch(`${base}/sync-url`, {
      method: 'POST',
      body: JSON.stringify({ url: 'https://sub.example.com/manual-once' })
    });
    assert.equal(forbidden.status, 403);

    const ok = await fetch(`${base}/sync-url?token=sync-secret`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://sub.example.com/manual-once' })
    });
    assert.equal(ok.status, 200);
    assert.equal(receivedUrl, 'https://sub.example.com/manual-once');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('logs device subscription attempts without recording tokens', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'proxy-sub-distributor-'));
  const cache = new SubscriptionCache(dir);
  const events = [];
  const eventLog = {
    append: async (event, details) => events.push({ event, ...details })
  };

  await cache.saveSuccessfulConfig(validYaml, {
    sourceUrl: 'https://seed.example/sub',
    subscriptionUrlHost: 'seed.example',
    fetchedAt: '2026-06-21T04:00:00.000Z'
  });

  const server = createServer({
    cache,
    devices: {
      mt5000: { token: 'router-token' }
    },
    syncToken: 'sync-secret',
    syncNow: async () => ({ ok: true }),
    eventLog
  });

  try {
    const base = await listen(server);

    await fetch(`${base}/sub/mt5000?token=wrong-token`, {
      headers: { 'user-agent': 'clash/1.0' }
    });
    await fetch(`${base}/sub/mt5000?token=router-token`, {
      headers: { 'user-agent': 'clash/1.0' }
    });
    await fetch(`${base}/sub/unknown?token=router-token`, {
      headers: { 'user-agent': 'clash/1.0' }
    });

    assert.deepEqual(
      events.map(({ event, device, reason, status, userAgent }) => ({
        event,
        device,
        reason,
        status,
        userAgent
      })),
      [
        {
          event: 'subscription_denied',
          device: 'mt5000',
          reason: 'invalid_token',
          status: 403,
          userAgent: 'clash/1.0'
        },
        {
          event: 'subscription_served',
          device: 'mt5000',
          reason: undefined,
          status: 200,
          userAgent: 'clash/1.0'
        },
        {
          event: 'subscription_denied',
          device: 'unknown',
          reason: 'unknown_device',
          status: 404,
          userAgent: 'clash/1.0'
        }
      ]
    );
    assert.doesNotMatch(JSON.stringify(events), /router-token|wrong-token|sync-secret/);
    assert.ok(events.every((event) => typeof event.remoteAddress === 'string' && event.remoteAddress.length > 0));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
