import test from 'node:test';
import assert from 'node:assert/strict';

import { checkSubscriptionHealth } from '../src/health.js';

const yaml = `
proxies:
  - name: good-domain
    type: ss
    server: good.example.com
    port: 10001
  - name: dns-bad
    type: ss
    server: missing.example.com
    port: 10002
  - name: tcp-bad
    type: ss
    server: slow.example.com
    port: 10003
  - name: ip-node
    type: ss
    server: 127.0.0.1
    port: 10004
proxy-groups:
  - name: PROXY
    type: select
    proxies:
      - good-domain
      - dns-bad
      - tcp-bad
      - ip-node
`;

test('checks every proxy with DNS and TCP and counts nodes that pass both tests', async () => {
  const dnsCalls = [];
  const tcpCalls = [];

  const health = await checkSubscriptionHealth(yaml, {
    concurrency: 2,
    tcpTimeoutMs: 25,
    lookup: async (host) => {
      dnsCalls.push(host);
      if (host === 'missing.example.com') {
        const error = new Error('not found');
        error.code = 'ENOTFOUND';
        throw error;
      }
      return [{ address: '203.0.113.10', family: 4 }];
    },
    tcpConnect: async ({ host, port }) => {
      tcpCalls.push(`${host}:${port}`);
      if (host === 'slow.example.com') {
        const error = new Error('timeout');
        error.code = 'ETIMEDOUT';
        throw error;
      }
    }
  });

  assert.equal(health.proxyCount, 4);
  assert.equal(health.dnsFailedCount, 1);
  assert.equal(health.tcpFailedCount, 1);
  assert.equal(health.bothPassedCount, 2);
  assert.equal(health.bothPassedRatio, 0.5);
  assert.equal(health.healthy, true);
  assert.deepEqual(dnsCalls.sort(), [
    'good.example.com',
    'missing.example.com',
    'slow.example.com'
  ]);
  assert.deepEqual(tcpCalls.sort(), [
    '127.0.0.1:10004',
    'good.example.com:10001',
    'slow.example.com:10003'
  ]);
});

test('marks a subscription unhealthy when fewer than half of the nodes pass both checks', async () => {
  const health = await checkSubscriptionHealth(yaml, {
    minBothPassedRatio: 0.51,
    lookup: async (host) => {
      if (host === 'missing.example.com') throw new Error('not found');
      return [{ address: '203.0.113.10', family: 4 }];
    },
    tcpConnect: async ({ host }) => {
      if (host === 'slow.example.com') throw new Error('timeout');
    }
  });

  assert.equal(health.bothPassedCount, 2);
  assert.equal(health.healthy, false);
});
