import test from 'node:test';
import assert from 'node:assert/strict';

import YAML from 'yaml';

import { transformClashYaml } from '../src/clash.js';

test('builds a dialer-proxy chain with a primary and fallback entry', () => {
  const source = YAML.stringify({
    proxies: [
      {
        name: '日本 XX2 2倍|高速|流媒体|手游',
        type: 'ss',
        server: '127.0.0.1',
        port: 8388
      },
      {
        name: '日本 WX 0.75倍|直连|高速|无解锁保证',
        type: 'ss',
        server: '127.0.0.2',
        port: 8388
      },
      {
        name: '日本 TK 0.25倍|链式代理专用节点',
        type: 'ss',
        server: '127.0.0.3',
        port: 8388
      }
    ],
    'proxy-groups': [
      {
        name: '🔰国外流量',
        type: 'select',
        proxies: ['日本 XX2 2倍|高速|流媒体|手游']
      }
    ],
    rules: ['MATCH,🔰国外流量']
  });

  const rendered = YAML.parse(
    transformClashYaml(source, {
      chainGroups: [
        {
          name: '🇯🇵日本链式代理',
          targetGroup: '🔰国外流量',
          secondHopPattern: '^日本 TK ',
          firstHops: [
            { name: '🇯🇵链式·XX2→TK', includePattern: '^日本 XX2 ' },
            { name: '🇯🇵链式·WX→TK', includePattern: '^日本 WX ' }
          ]
        }
      ]
    })
  );

  const primary = rendered.proxies.find((proxy) => proxy.name === '🇯🇵链式·XX2→TK');
  const backup = rendered.proxies.find((proxy) => proxy.name === '🇯🇵链式·WX→TK');
  assert.equal(primary.server, '127.0.0.3');
  assert.equal(primary['dialer-proxy'], '日本 XX2 2倍|高速|流媒体|手游');
  assert.equal(backup.server, '127.0.0.3');
  assert.equal(backup['dialer-proxy'], '日本 WX 0.75倍|直连|高速|无解锁保证');

  const chainGroup = rendered['proxy-groups'].find(
    (group) => group.name === '🇯🇵日本链式代理'
  );
  assert.deepEqual(chainGroup.proxies, ['🇯🇵链式·XX2→TK', '🇯🇵链式·WX→TK']);
  assert.equal(chainGroup.type, 'fallback');

  const target = rendered['proxy-groups'].find((group) => group.name === '🔰国外流量');
  assert.equal(target.proxies.at(-1), '🇯🇵日本链式代理');
});
