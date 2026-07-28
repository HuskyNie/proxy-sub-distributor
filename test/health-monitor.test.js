import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SubscriptionCache } from '../src/cache.js';
import { runSubscriptionHealthCheck } from '../src/health-monitor.js';

function yaml(name) {
  return `
proxies:
  - name: ${name}
    type: ss
    server: ${name}.example.com
    port: 10001
proxy-groups:
  - name: PROXY
    type: select
    proxies:
      - ${name}
`;
}

test('keeps latest subscription when at least half of nodes pass health checks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'proxy-sub-distributor-'));
  const events = [];

  try {
    const cache = new SubscriptionCache(dir);
    await cache.saveSuccessfulConfig(yaml('current-good'), {
      sourceUrl: 'https://seed.example/current',
      subscriptionUrlHost: 'seed.example',
      fetchedAt: '2026-06-29T01:00:00.000Z'
    });

    const result = await runSubscriptionHealthCheck({
      cache,
      eventLog: { append: async (event, details) => events.push({ event, ...details }) },
      healthChecker: async () => ({
        proxyCount: 1,
        dnsFailedCount: 0,
        tcpFailedCount: 0,
        bothPassedCount: 1,
        bothPassedRatio: 1,
        healthy: true
      }),
      now: () => new Date('2026-06-29T02:00:00.000Z')
    });

    assert.equal(result.action, 'keep_current');
    assert.match(await readFile(join(dir, 'latest.yaml'), 'utf8'), /current-good/);
    assert.equal(events[0].event, 'subscription_health_checked');
    assert.equal(events[0].bothPassedCount, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rolls back to the newest previous healthy history version when latest drops below threshold', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'proxy-sub-distributor-'));
  const events = [];
  const checked = [];

  try {
    const cache = new SubscriptionCache(dir);
    await cache.saveSuccessfulConfig(yaml('old-good'), {
      sourceUrl: 'https://seed.example/old',
      subscriptionUrlHost: 'seed.example',
      fetchedAt: '2026-06-29T01:00:00.000Z'
    });
    await cache.saveSuccessfulConfig(yaml('current-bad'), {
      sourceUrl: 'https://seed.example/current',
      subscriptionUrlHost: 'seed.example',
      fetchedAt: '2026-06-29T02:00:00.000Z'
    });

    const result = await runSubscriptionHealthCheck({
      cache,
      eventLog: { append: async (event, details) => events.push({ event, ...details }) },
      healthChecker: async (yamlText) => {
        checked.push(yamlText);
        if (yamlText.includes('old-good')) {
          return {
            proxyCount: 1,
            dnsFailedCount: 0,
            tcpFailedCount: 0,
            bothPassedCount: 1,
            bothPassedRatio: 1,
            healthy: true
          };
        }
        return {
          proxyCount: 1,
          dnsFailedCount: 1,
          tcpFailedCount: 0,
          bothPassedCount: 0,
          bothPassedRatio: 0,
          healthy: false
        };
      },
      now: () => new Date('2026-06-29T03:00:00.000Z')
    });

    assert.equal(result.action, 'rollback');
    assert.match(await readFile(join(dir, 'latest.yaml'), 'utf8'), /old-good/);
    assert.equal(checked.length, 2);
    assert.deepEqual(events.map((event) => event.event), [
      'subscription_health_checked',
      'subscription_health_rollback'
    ]);
    assert.equal(events[1].previousBothPassedCount, 0);
    assert.equal(events[1].restoredBothPassedCount, 1);
    assert.doesNotMatch(JSON.stringify(events), /seed\\.example/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
