import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SubscriptionCache } from '../src/cache.js';
import { runSync, syncFromSubscriptionUrl } from '../src/sync.js';

const validYaml = `
proxies:
  - name: jp-01
    type: ss
    server: 127.0.0.1
    port: 8388
    cipher: aes-128-gcm
    password: test
proxy-groups:
  - name: PROXY
    type: select
    proxies:
      - jp-01
rules:
  - MATCH,PROXY
`;

function response(body, init = {}) {
  return new Response(body, {
    status: init.status ?? 200,
    headers: init.headers ?? {}
  });
}

test('logs in to FIB, extracts the Clash URL, downloads YAML, and caches it', async () => {
  const calls = [];
  const events = [];
  const fakeFetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method ?? 'GET', body: options.body?.toString() ?? '' });
    if (String(url) === 'https://1.fibacc.net/auth/login' && options.method === 'POST') {
      assert.match(options.body.toString(), /email=me%40example.com/);
      assert.match(options.body.toString(), /passwd=secret/);
      return response(JSON.stringify({ ret: 1, msg: 'ok' }), {
        headers: { 'set-cookie': 'sid=abc; Path=/; HttpOnly' }
      });
    }
    if (String(url) === 'https://1.fibacc.net/user/checkin' && options.method === 'POST') {
      assert.equal(options.headers.cookie, 'sid=abc');
      assert.equal(options.headers['x-requested-with'], 'XMLHttpRequest');
      assert.equal(options.headers.referer, 'https://1.fibacc.net/user');
      return response(JSON.stringify({ ret: 1, msg: 'obtained 261MB traffic' }), {
        headers: { 'content-type': 'application/json' }
      });
    }
    if (String(url) === 'https://1.fibacc.net/user') {
      assert.equal(options.headers.cookie, 'sid=abc');
      return response('<button data-clipboard-text="https://sub.example.com/once">复制 Clash 订阅</button>');
    }
    if (String(url) === 'https://sub.example.com/once') {
      return response(validYaml);
    }
    throw new Error(`unexpected URL ${url}`);
  };

  const dir = await mkdtemp(join(tmpdir(), 'fib-sub-sync-'));
  try {
    const cache = new SubscriptionCache(dir);
    const result = await runSync({
      fib: { baseUrl: 'https://1.fibacc.net', email: 'me@example.com', password: 'secret' },
      cache,
      fetchImpl: fakeFetch,
      now: () => new Date('2026-06-21T03:00:00.000Z'),
      eventLog: {
        append: async (event, details) => events.push({ event, ...details })
      }
    });

    assert.equal(result.proxyCount, 1);
    assert.equal(result.subscriptionUrlHost, 'sub.example.com');
    assert.deepEqual(calls.map((call) => [call.method, call.url]), [
      ['POST', 'https://1.fibacc.net/auth/login'],
      ['POST', 'https://1.fibacc.net/user/checkin'],
      ['GET', 'https://1.fibacc.net/user'],
      ['GET', 'https://sub.example.com/once']
    ]);

    const latest = await readFile(join(dir, 'latest.yaml'), 'utf8');
    assert.match(latest, /jp-01/);
    assert.deepEqual(events, [
      {
        event: 'fib_sync_started',
        mode: 'account'
      },
      {
        event: 'fib_checkin_succeeded',
        ret: 1,
        msg: 'obtained 261MB traffic'
      },
      {
        event: 'fib_sync_succeeded',
        mode: 'account',
        proxyCount: 1,
        groupCount: 1,
        subscriptionUrlHost: 'sub.example.com'
      }
    ]);
    assert.doesNotMatch(JSON.stringify(events), /once|secret|me@example.com/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('continues account sync when FIB checkin fails', async () => {
  const calls = [];
  const events = [];
  const fakeFetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method ?? 'GET' });
    if (String(url) === 'https://1.fibacc.net/auth/login' && options.method === 'POST') {
      return response(JSON.stringify({ ret: 1, msg: 'ok' }), {
        headers: { 'set-cookie': 'sid=abc; Path=/; HttpOnly' }
      });
    }
    if (String(url) === 'https://1.fibacc.net/user/checkin' && options.method === 'POST') {
      return response(JSON.stringify({ ret: 0, msg: 'checkin temporarily unavailable' }), {
        headers: { 'content-type': 'application/json' }
      });
    }
    if (String(url) === 'https://1.fibacc.net/user') {
      return response('<button data-clipboard-text="https://sub.example.com/once">复制 Clash 订阅</button>');
    }
    if (String(url) === 'https://sub.example.com/once') {
      return response(validYaml);
    }
    throw new Error(`unexpected URL ${url}`);
  };

  const dir = await mkdtemp(join(tmpdir(), 'fib-sub-sync-'));
  try {
    const cache = new SubscriptionCache(dir);
    const result = await runSync({
      fib: { baseUrl: 'https://1.fibacc.net', email: 'me@example.com', password: 'secret' },
      cache,
      fetchImpl: fakeFetch,
      now: () => new Date('2026-06-21T03:00:00.000Z'),
      eventLog: {
        append: async (event, details) => events.push({ event, ...details })
      }
    });

    assert.equal(result.proxyCount, 1);
    assert.deepEqual(calls.map((call) => [call.method, call.url]), [
      ['POST', 'https://1.fibacc.net/auth/login'],
      ['POST', 'https://1.fibacc.net/user/checkin'],
      ['GET', 'https://1.fibacc.net/user'],
      ['GET', 'https://sub.example.com/once']
    ]);
    assert.deepEqual(events.map((event) => event.event), [
      'fib_sync_started',
      'fib_checkin_failed',
      'fib_sync_succeeded'
    ]);
    assert.equal(events[1].ret, 0);
    assert.equal(events[1].msg, 'checkin temporarily unavailable');
    assert.doesNotMatch(JSON.stringify(events), /once|secret|me@example.com/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('records a failure and keeps the previous cache when upstream YAML is invalid', async () => {
  const events = [];
  const fakeFetch = async (url, options = {}) => {
    if (String(url) === 'https://1.fibacc.net/auth/login' && options.method === 'POST') {
      return response(JSON.stringify({ ret: 1, msg: 'ok' }), {
        headers: { 'set-cookie': 'sid=abc; Path=/; HttpOnly' }
      });
    }
    if (String(url) === 'https://1.fibacc.net/user/checkin' && options.method === 'POST') {
      return response(JSON.stringify({ ret: 1, msg: 'obtained 261MB traffic' }), {
        headers: { 'content-type': 'application/json' }
      });
    }
    if (String(url) === 'https://1.fibacc.net/user') {
      return response('<button data-clipboard-text="https://sub.example.com/bad">复制 Clash 订阅</button>');
    }
    if (String(url) === 'https://sub.example.com/bad') {
      return response('proxies: []');
    }
    throw new Error(`unexpected URL ${url}`);
  };

  const dir = await mkdtemp(join(tmpdir(), 'fib-sub-sync-'));
  try {
    const cache = new SubscriptionCache(dir);
    await cache.saveSuccessfulConfig(validYaml, {
      sourceUrl: 'https://seed.example/sub',
      subscriptionUrlHost: 'seed.example',
      fetchedAt: '2026-06-21T02:00:00.000Z'
    });

    await assert.rejects(
      () => runSync({
        fib: { baseUrl: 'https://1.fibacc.net', email: 'me@example.com', password: 'secret' },
        cache,
        fetchImpl: fakeFetch,
        now: () => new Date('2026-06-21T03:00:00.000Z'),
        eventLog: {
          append: async (event, details) => events.push({ event, ...details })
        }
      }),
      /at least one proxy/
    );

    const latest = await readFile(join(dir, 'latest.yaml'), 'utf8');
    assert.match(latest, /jp-01/);

    const metadata = JSON.parse(await readFile(join(dir, 'metadata.json'), 'utf8'));
    assert.match(metadata.lastError.message, /at least one proxy/);
    assert.equal(events[0].event, 'fib_sync_started');
    assert.equal(events[1].event, 'fib_checkin_succeeded');
    assert.equal(events[2].event, 'fib_sync_failed');
    assert.equal(events[2].mode, 'account');
    assert.match(events[2].errorMessage, /at least one proxy/);
    assert.doesNotMatch(JSON.stringify(events), /bad|secret|me@example.com/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('records an unhealthy downloaded subscription without replacing the previous cache', async () => {
  const unhealthyYaml = validYaml.replace(/jp-01/g, 'broken-01');
  const events = [];
  const fakeFetch = async (url, options = {}) => {
    if (String(url) === 'https://1.fibacc.net/auth/login' && options.method === 'POST') {
      return response(JSON.stringify({ ret: 1, msg: 'ok' }), {
        headers: { 'set-cookie': 'sid=abc; Path=/; HttpOnly' }
      });
    }
    if (String(url) === 'https://1.fibacc.net/user/checkin' && options.method === 'POST') {
      return response(JSON.stringify({ ret: 1, msg: 'obtained 261MB traffic' }), {
        headers: { 'content-type': 'application/json' }
      });
    }
    if (String(url) === 'https://1.fibacc.net/user') {
      return response('<button data-clipboard-text="https://sub.example.com/unhealthy">复制 Clash 订阅</button>');
    }
    if (String(url) === 'https://sub.example.com/unhealthy') {
      return response(unhealthyYaml);
    }
    throw new Error(`unexpected URL ${url}`);
  };

  const dir = await mkdtemp(join(tmpdir(), 'fib-sub-sync-'));
  try {
    const cache = new SubscriptionCache(dir);
    await cache.saveSuccessfulConfig(validYaml, {
      sourceUrl: 'https://seed.example/sub',
      subscriptionUrlHost: 'seed.example',
      fetchedAt: '2026-06-21T02:00:00.000Z'
    });

    await assert.rejects(
      () => runSync({
        fib: { baseUrl: 'https://1.fibacc.net', email: 'me@example.com', password: 'secret' },
        cache,
        fetchImpl: fakeFetch,
        now: () => new Date('2026-06-21T03:00:00.000Z'),
        healthChecker: async () => ({
          proxyCount: 1,
          dnsFailedCount: 1,
          tcpFailedCount: 0,
          bothPassedCount: 0,
          bothPassedRatio: 0,
          healthy: false
        }),
        eventLog: {
          append: async (event, details) => events.push({ event, ...details })
        }
      }),
      /health check failed/
    );

    const latest = await readFile(join(dir, 'latest.yaml'), 'utf8');
    assert.match(latest, /jp-01/);
    assert.doesNotMatch(latest, /broken-01/);

    const rejected = await readFile(
      join(dir, 'rejected', '2026-06-21T03-00-00-000Z.yaml'),
      'utf8'
    );
    assert.match(rejected, /broken-01/);

    const metadata = JSON.parse(await readFile(join(dir, 'metadata.json'), 'utf8'));
    assert.match(metadata.lastError.message, /health check failed/);
    assert.deepEqual(events.map((event) => event.event), [
      'fib_sync_started',
      'fib_checkin_succeeded',
      'fib_sync_health_failed',
      'fib_sync_failed'
    ]);
    assert.equal(events[2].bothPassedCount, 0);
    assert.equal(events[2].dnsFailedCount, 1);
    assert.equal(events[2].tcpFailedCount, 0);
    assert.equal(events[2].action, 'keep_last_good');
    assert.doesNotMatch(JSON.stringify(events), /unhealthy|secret|me@example.com/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('syncs directly from a manually supplied one-time subscription URL', async () => {
  const events = [];
  const fakeFetch = async (url) => {
    assert.equal(String(url), 'https://sub.example.com/manual-once');
    return response(validYaml);
  };

  const dir = await mkdtemp(join(tmpdir(), 'fib-sub-sync-'));
  try {
    const cache = new SubscriptionCache(dir);
    const result = await syncFromSubscriptionUrl({
      subscriptionUrl: 'https://sub.example.com/manual-once',
      cache,
      fetchImpl: fakeFetch,
      now: () => new Date('2026-06-21T05:00:00.000Z'),
      eventLog: {
        append: async (event, details) => events.push({ event, ...details })
      }
    });

    assert.equal(result.proxyCount, 1);
    assert.equal(result.subscriptionUrlHost, 'sub.example.com');
    assert.match(await readFile(join(dir, 'latest.yaml'), 'utf8'), /jp-01/);
    assert.deepEqual(events, [
      {
        event: 'fib_sync_started',
        mode: 'manual_url'
      },
      {
        event: 'fib_sync_succeeded',
        mode: 'manual_url',
        proxyCount: 1,
        groupCount: 1,
        subscriptionUrlHost: 'sub.example.com'
      }
    ]);
    assert.doesNotMatch(JSON.stringify(events), /manual-once/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
