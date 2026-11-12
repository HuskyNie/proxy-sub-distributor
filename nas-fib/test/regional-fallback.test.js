import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import YAML from 'yaml';

import { transformClashYaml } from '../src/clash.js';

const proxyNames = [
  '新加坡 HX 2倍|原生解锁',
  '新加坡 UX 2倍|无解锁保证',
  '新加坡 XZ 海外用户|大陆地区无法连接|部分解锁',
  '日本 IX 直连|家宽|全解锁',
  '日本 UX 直连|无解锁保证',
  '日本 TK 链式代理专用节点',
  '美国 IX 2倍|流媒体解锁',
  '美国 WX 直连|无解锁保证',
  '美国 SUB 仅能用于本站相关服务',
  '香港 XE 6倍|原生解锁',
  '香港 WX 直连|无解锁保证',
  '澳门 K 2倍|本地解锁',
  '台湾 HX 2倍|解锁台湾',
  '台湾 IX2 2倍|原生家宽|AI禁止',
  '台湾 XZ 海外用户|大陆地区无法连接|全解锁'
];

const expectedMembers = {
  '🇸🇬新加坡故障转移': proxyNames.slice(0, 2),
  '🇸🇬新加坡解锁故障转移': proxyNames.slice(0, 1),
  '🇯🇵日本故障转移': proxyNames.slice(3, 5),
  '🇯🇵日本解锁故障转移': proxyNames.slice(3, 4),
  '🇺🇸美国故障转移': proxyNames.slice(6, 8),
  '🇺🇸美国解锁故障转移': proxyNames.slice(6, 7),
  '🇭🇰港澳台故障转移': proxyNames.slice(9, 14),
  '🇭🇰港澳台解锁故障转移': [proxyNames[9], proxyNames[11], proxyNames[12]]
};

test('global regional fallback groups include usable nodes and conservatively filter unlock nodes', async () => {
  const strategies = JSON.parse(
    await readFile(new URL('./fixtures/clash-strategies.example.json', import.meta.url), 'utf8')
  );
  const source = YAML.stringify({
    proxies: proxyNames.map((name, index) => ({
      name,
      type: 'ss',
      server: `127.0.0.${index + 1}`,
      port: 8388
    })),
    'proxy-groups': [
      {
        name: '🔰国外流量',
        type: 'select',
        proxies: [...proxyNames]
      }
    ],
    rules: ['MATCH,🔰国外流量']
  });

  const rendered = YAML.parse(
    transformClashYaml(source, { fallbackGroups: strategies.fallbackGroups })
  );
  const groups = rendered['proxy-groups'];
  const target = groups.find((group) => group.name === '🔰国外流量');

  for (const [name, members] of Object.entries(expectedMembers)) {
    const matches = groups.filter((group) => group.name === name);
    assert.equal(matches.length, 1, `${name} should appear exactly once`);
    assert.equal(matches[0].type, 'url-test');
    assert.equal(matches[0].tolerance, 300);
    assert.deepEqual(matches[0].proxies, members, `${name} members`);
    assert.ok(target.proxies.includes(name), `${name} should be selectable from 国外流量`);
  }
});

test('regional url-test validates tolerance and preserves legacy fallback defaults', () => {
  const source = YAML.stringify({ proxies: [{ name: 'SG', type: 'ss', server: 'localhost', port: 1 }], 'proxy-groups': [{ name: 'main', type: 'select', proxies: ['SG'] }] });
  const definition = { name: 'region', targetGroup: 'main' };
  const render = (options) => YAML.parse(transformClashYaml(source, { fallbackGroups: [{ ...definition, ...options }] }))['proxy-groups'][0];
  assert.equal(render({}).type, 'fallback');
  assert.equal(render({}).tolerance, undefined);
  assert.equal(render({ type: 'url-test' }).tolerance, 300);
  assert.equal(render({ type: 'url-test', tolerance: 0 }).tolerance, 0);
  for (const tolerance of [-1, 1.5, 65536, '300']) {
    assert.throws(() => render({ type: 'url-test', tolerance }), /tolerance/);
  }
  assert.throws(() => render({ type: 'invalid' }), /type/);
  const once = transformClashYaml(source, { fallbackGroups: [{ ...definition, type: 'url-test', tolerance: 300 }] });
  assert.equal(transformClashYaml(once, { fallbackGroups: [{ ...definition, type: 'url-test', tolerance: 300 }] }), once);
});
