import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SubscriptionCache } from '../src/cache.js';
import { JsonlEventLog } from '../src/event-log.js';
import { runSync, syncFromSubscriptionUrl } from '../src/sync.js';

const validYaml = `
proxies:
  - name: Example A
    type: ss
    server: node.example.com
    port: 8388
proxy-groups:
  - name: PROXY
    type: select
    proxies:
      - Example A
rules:
  - MATCH,PROXY
`;

function response(body, init = {}) {
  return new Response(body, init);
}

test('downloads a configured upstream subscription with custom headers and caches it', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push([String(url), options]);
    return response(validYaml);
  };
  const dir = await mkdtemp(join(tmpdir(), 'proxy-sub-distributor-'));

  try {
    const cache = new SubscriptionCache(dir);
    const eventLog = new JsonlEventLog(dir);
    const metadata = await runSync({
      upstream: {
        url: 'https://provider.example/subscription.yaml',
        headers: { Authorization: 'Bearer example' }
      },
      cache,
      eventLog,
      fetchImpl,
      now: () => new Date('2026-07-28T00:00:00.000Z')
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0][0], 'https://provider.example/subscription.yaml');
    assert.equal(requests[0][1].headers.Authorization, 'Bearer example');
    assert.equal(metadata.proxyCount, 1);
    assert.equal((await cache.readMetadata()).subscriptionUrlHost, 'provider.example');

    const events = (await readFile(join(dir, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      events.map((event) => event.event),
      ['subscription_sync_started', 'subscription_sync_succeeded']
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('records a failure and keeps the previous cache when upstream YAML is invalid', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'proxy-sub-distributor-'));
  try {
    const cache = new SubscriptionCache(dir);
    await cache.saveSuccessfulConfig(validYaml, {
      sourceUrl: 'https://old.example/sub',
      subscriptionUrlHost: 'old.example',
      fetchedAt: '2026-07-27T00:00:00.000Z'
    });

    await assert.rejects(
      () =>
        runSync({
          upstream: { url: 'https://provider.example/subscription.yaml', headers: {} },
          cache,
          fetchImpl: async () => response('not: valid: yaml: ['),
          now: () => new Date('2026-07-28T00:00:00.000Z')
        }),
      /Invalid Clash YAML/
    );
    assert.equal(await cache.readLatest(), validYaml);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('keeps the previous cache when a downloaded subscription fails health checks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'proxy-sub-distributor-'));
  try {
    const cache = new SubscriptionCache(dir);
    await cache.saveSuccessfulConfig(validYaml, {
      sourceUrl: 'https://old.example/sub',
      subscriptionUrlHost: 'old.example',
      fetchedAt: '2026-07-27T00:00:00.000Z'
    });

    await assert.rejects(
      () =>
        runSync({
          upstream: { url: 'https://provider.example/subscription.yaml', headers: {} },
          cache,
          fetchImpl: async () => response(validYaml.replace('Example A', 'Example B')),
          healthChecker: async () => ({
            healthy: false,
            proxyCount: 1,
            dnsFailedCount: 1,
            tcpFailedCount: 1,
            bothPassedCount: 0,
            bothPassedRatio: 0,
            nodes: []
          })
        }),
      /subscription health check failed/
    );
    assert.equal(await cache.readLatest(), validYaml);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('syncs directly from a manually supplied subscription URL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'proxy-sub-distributor-'));
  try {
    const cache = new SubscriptionCache(dir);
    const metadata = await syncFromSubscriptionUrl({
      subscriptionUrl: 'https://manual.example/subscription.yaml',
      cache,
      fetchImpl: async () => response(validYaml),
      now: () => new Date('2026-07-28T00:00:00.000Z')
    });

    assert.equal(metadata.proxyCount, 1);
    assert.equal(metadata.subscriptionUrlHost, 'manual.example');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
