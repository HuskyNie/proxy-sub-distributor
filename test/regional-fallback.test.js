import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import YAML from 'yaml';

import { transformClashYaml } from '../src/clash.js';

test('example fallback strategy includes matching nodes and applies exclusions', async () => {
  const strategies = JSON.parse(
    await readFile(new URL('../data/clash-strategies.example.json', import.meta.url), 'utf8')
  );
  const proxyNames = [
    'Region A Primary',
    'Region A Backup',
    'Region A Deprecated',
    'Region B Primary'
  ];
  const source = YAML.stringify({
    proxies: proxyNames.map((name, index) => ({
      name,
      type: 'ss',
      server: `127.0.0.${index + 1}`,
      port: 8388
    })),
    'proxy-groups': [
      {
        name: 'PROXY',
        type: 'select',
        proxies: [...proxyNames]
      }
    ],
    rules: ['MATCH,PROXY']
  });

  const rendered = YAML.parse(
    transformClashYaml(source, { fallbackGroups: strategies.fallbackGroups })
  );
  const groups = rendered['proxy-groups'];
  const fallback = groups.find((group) => group.name === 'Region A Fallback');
  const target = groups.find((group) => group.name === 'PROXY');

  assert.deepEqual(fallback.proxies, ['Region A Primary', 'Region A Backup']);
  assert.equal(groups.filter((group) => group.name === 'Region A Fallback').length, 1);
  assert.ok(target.proxies.includes('Region A Fallback'));
});
