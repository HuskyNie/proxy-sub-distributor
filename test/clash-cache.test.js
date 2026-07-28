import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import YAML from 'yaml';

import { transformClashYaml, validateClashYaml } from '../src/clash.js';
import { SubscriptionCache } from '../src/cache.js';

const validYaml = `
port: 7890
socks-port: 7891
proxies:
  - name: hk-01
    type: ss
    server: 127.0.0.1
    port: 8388
    cipher: aes-128-gcm
    password: test
proxy-groups:
  - name: PROXY
    type: select
    proxies:
      - hk-01
rules:
  - MATCH,PROXY
`;

test('validates Clash YAML with at least one proxy', () => {
  const result = validateClashYaml(validYaml);

  assert.equal(result.proxyCount, 1);
  assert.equal(result.groupCount, 1);
});

test('rejects Clash YAML with no proxies', () => {
  assert.throws(
    () => validateClashYaml('proxies: []\nproxy-groups: []\nrules: []\n'),
    /at least one proxy/
  );
});

test('adds an idempotent example fallback group before the target selector', () => {
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
  - name: Region A Deprecated
    type: ss
    server: 127.0.0.3
    port: 8388
  - name: Region B Primary
    type: ss
    server: 127.0.0.4
    port: 8388
proxy-groups:
  - name: PROXY
    type: select
    proxies:
      - Region A Primary
      - Region A Backup
      - DIRECT
rules:
  - MATCH,PROXY
`;
  const fallbackGroups = [
    {
      name: 'Region A Fallback',
      targetGroup: 'PROXY',
      includePattern: '^Region A ',
      excludePattern: 'Deprecated|Unavailable',
      url: 'https://www.gstatic.com/generate_204',
      interval: 60
    }
  ];

  const first = transformClashYaml(source, { fallbackGroups });
  const second = transformClashYaml(first, { fallbackGroups });
  const parsed = YAML.parse(second);
  const groups = parsed['proxy-groups'];
  const fallback = groups.find((group) => group.name === 'Region A Fallback');
  const target = groups.find((group) => group.name === 'PROXY');

  assert.equal(groups.filter((group) => group.name === 'Region A Fallback').length, 1);
  assert.equal(fallback.type, 'fallback');
  assert.deepEqual(fallback.proxies, ['Region A Primary', 'Region A Backup']);
  assert.equal(fallback.url, 'https://www.gstatic.com/generate_204');
  assert.equal(fallback.interval, 60);
  assert.equal(fallback.lazy, false);
  assert.equal(target.proxies[0], 'Region A Fallback');
  assert.equal(target.proxies.filter((name) => name === 'Region A Fallback').length, 1);
});

test('fails safely when an enabled fallback group cannot find its target or candidates', () => {
  assert.throws(
    () =>
      transformClashYaml(validYaml, {
        fallbackGroups: [
          {
            name: 'EXAMPLE-AUTO',
            targetGroup: 'MISSING',
            includePattern: '^sg-'
          }
        ]
      }),
    /target group MISSING was not found/
  );

  assert.throws(
    () =>
      transformClashYaml(validYaml, {
        fallbackGroups: [
          {
            name: 'SG-AUTO',
            targetGroup: 'PROXY',
            includePattern: '^sg-'
          }
        ]
      }),
    /found no matching proxies/
  );
});

test('cache writes valid YAML and refuses to overwrite it with invalid YAML', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'proxy-sub-distributor-'));
  try {
    const cache = new SubscriptionCache(dir);
    await cache.saveSuccessfulConfig(validYaml, {
      sourceUrl: 'https://upstream.example/sub',
      subscriptionUrlHost: 'upstream.example',
      fetchedAt: '2026-06-21T00:00:00.000Z'
    });

    const first = await readFile(join(dir, 'latest.yaml'), 'utf8');
    assert.match(first, /hk-01/);

    await assert.rejects(
      () => cache.saveSuccessfulConfig('proxies: []', {
        sourceUrl: 'https://upstream.example/bad',
        subscriptionUrlHost: 'upstream.example',
        fetchedAt: '2026-06-21T01:00:00.000Z'
      }),
      /at least one proxy/
    );

    const after = await readFile(join(dir, 'latest.yaml'), 'utf8');
    assert.equal(after, first);

    const meta = JSON.parse(await readFile(join(dir, 'metadata.json'), 'utf8'));
    assert.equal(meta.proxyCount, 1);
    assert.equal(meta.lastError, null);
    assert.ok((await stat(join(dir, 'history'))).isDirectory());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cache records sync failures without replacing latest YAML', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'proxy-sub-distributor-'));
  try {
    const cache = new SubscriptionCache(dir);
    await writeFile(join(dir, 'latest.yaml'), validYaml);

    await cache.recordFailure(new Error('upstream failed'), '2026-06-21T02:00:00.000Z');

    const latest = await readFile(join(dir, 'latest.yaml'), 'utf8');
    assert.equal(latest, validYaml);

    const meta = JSON.parse(await readFile(join(dir, 'metadata.json'), 'utf8'));
    assert.equal(meta.lastError.message, 'upstream failed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
