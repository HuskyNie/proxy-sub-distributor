import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import { SubscriptionCache } from '../src/cache.js';
import { createServer } from '../src/server.js';
import { createAdditionalUpstreams } from '../src/upstreams.js';

const node = (name, fields = {}) => ({
  name, type: 'ss', server: '192.0.2.10', port: 443, cipher: 'aes-128-gcm', password: 'fixture', ...fields
});

function profile(...proxies) {
  return YAML.stringify({
    proxies,
    'proxy-groups': [{ name: 'PROXY', type: 'select', proxies: proxies.map((proxy) => proxy.name) }],
    rules: ['MATCH,PROXY']
  });
}

test('device YAML merges independently cached sources into regional url-test groups', async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'fib-upstreams-'));
  const socketPath = join(dataDir, 'provider.sock');
  let requests = 0;
  let providerStatus = 200;
  const vision = {
    type: 'vless', uuid: '00000000-0000-4000-8000-000000000000', flow: 'xtls-rprx-vision',
    tls: true, 'reality-opts': { 'public-key': 'fixture', 'short-id': '00000000' }
  };
  const hongKong = node('🇭🇰 Hong Kong 01', vision);
  const japan = node('🇯🇵 Japan 01', { ...vision, 'dialer-proxy': hongKong.name });
  const provider = http.createServer((request, response) => {
    assert.equal(request.url, '/subscription');
    requests += 1;
    response.writeHead(providerStatus, { 'subscription-userinfo': 'upload=0; download=21; total=500' });
    response.end(profile(hongKong, japan, node('🇦🇱 剩余流量：1 GB', vision)));
  });
  provider.listen(socketPath);
  await once(provider, 'listening');

  const fibYaml = profile(node('FIB US'), node('Kitty 🇭🇰 Hong Kong 01'));
  const baseCache = new SubscriptionCache(dataDir);
  const fibUsage = 'upload=0; download=1; total=100';
  await baseCache.saveSuccessfulConfig(fibYaml, {
    fetchedAt: '2026-11-25T00:00:00.000Z', subscriptionUserinfo: fibUsage
  });
  let directName = '🇩🇪 Germany 01';
  const upstreams = createAdditionalUpstreams({
    dataDir,
    sources: [
      { id: 'kitty', name: 'Kitty', targetGroup: 'PROXY', socketPath, exclude: /^🇦🇱\s*剩余流量[：:]/u },
      { id: 'other', name: 'Other', targetGroup: 'PROXY', url: 'https://example.invalid/private-fixture' }
    ],
    fetchImpl: async () => new Response(profile(node(directName)))
  });
  const server = createServer({
    cache: baseCache,
    devices: { router: { token: 'router-fixture' } },
    renderUpstreams: upstreams.render,
    upstreamStatus: upstreams.status
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(async () => {
    await Promise.all([new Promise((resolve) => server.close(resolve)), new Promise((resolve) => provider.close(resolve))]);
    await rm(dataDir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const subscription = `${origin}/sub/router?token=router-fixture`;
  assert.equal(await (await fetch(subscription)).text(), fibYaml);
  assert.equal((await fetch(`${origin}/sub/router?token=invalid`)).status, 403);

  const [kitty, other] = upstreams.jobs;
  await Promise.all([kitty.refresh(), kitty.refresh(), other.refresh()]);
  assert.equal(requests, 1);

  const reply = await fetch(subscription);
  assert.equal(reply.headers.get('subscription-userinfo'), fibUsage);
  const rendered = YAML.parse(await reply.text());
  assert.deepEqual(rendered.rules, ['MATCH,PROXY']);
  assert.deepEqual(rendered['proxy-groups'][0].proxies,
    ['FIB US', 'Kitty 🇭🇰 Hong Kong 01', 'Kitty 香港', 'Kitty 日本', 'Other 德国']);
  const kittyGroups = rendered['proxy-groups'].slice(1, 3);
  for (const group of kittyGroups) {
    assert.equal(group.type, 'url-test');
    assert.equal(group.tolerance, 300);
    assert.equal(group.interval, 60);
    assert.equal(group.lazy, false);
  }
  assert.deepEqual(kittyGroups[0].proxies, ['Kitty 🇭🇰 Hong Kong 01 (2)']);
  assert.deepEqual(kittyGroups[1].proxies, ['Kitty 🇯🇵 Japan 01']);
  const extraJapan = rendered.proxies.find((proxy) => proxy.name === 'Kitty 🇯🇵 Japan 01');
  assert.deepEqual(extraJapan['reality-opts'], vision['reality-opts']);
  assert.equal(extraJapan['dialer-proxy'], 'Kitty 🇭🇰 Hong Kong 01 (2)');
  assert.equal(rendered.proxies.some((proxy) => proxy.name.includes('剩余流量')), false);
  assert.equal((await fetch(subscription, { method: 'HEAD' })).headers.get('subscription-userinfo'), fibUsage);

  providerStatus = 401;
  directName = '🇸🇬 Singapore 01';
  await assert.rejects(kitty.refresh(), /Upstream requires sign-in/);
  await other.refresh();
  const afterFailure = YAML.parse(await (await fetch(subscription)).text());
  assert.deepEqual(afterFailure['proxy-groups'].slice(1, 3), kittyGroups);
  assert.ok(afterFailure['proxy-groups'].some((group) => group.name === 'Other 新加坡'));
  assert.equal(await baseCache.readLatest(), fibYaml);
  const status = await (await fetch(`${origin}/status`)).json();
  assert.deepEqual(status.upstreams.map(({ id, proxyCount }) => [id, proxyCount]), [['kitty', 2], ['other', 1]]);
  assert.equal(status.upstreams[0].lastError.message, 'Upstream requires sign-in');
  assert.ok(!JSON.stringify(status.upstreams).includes('private-fixture'));
});

test('a broken supplemental YAML or unavailable selector preserves the last working subscription', async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'fib-upstreams-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  let sourceYaml = profile(node('🇺🇸 United States 01'));
  const upstreams = createAdditionalUpstreams({
    dataDir,
    sources: [{ id: 'kitty', name: 'Kitty', targetGroup: 'PROXY', url: 'https://example.invalid/sub' }],
    fetchImpl: async () => new Response(sourceYaml)
  });
  const base = profile(node('FIB'));
  await upstreams.jobs[0].refresh();
  const good = await upstreams.render(base);
  sourceYaml = 'proxies: [invalid';
  await assert.rejects(upstreams.jobs[0].refresh(), /invalid Clash YAML/);
  assert.equal(await upstreams.render(base), good);
  await mkdir(join(dataDir, 'upstreams', 'kitty', 'metadata.json.tmp'));
  sourceYaml = profile(node('🇺🇸 United States 02'));
  await assert.rejects(upstreams.jobs[0].refresh(), /cache update failed/);
  assert.equal(await upstreams.render(base), good);
  const differentSelector = base.replaceAll('PROXY', 'OTHER');
  assert.equal(await upstreams.render(differentSelector), differentSelector);
});
