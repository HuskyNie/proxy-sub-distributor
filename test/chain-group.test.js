import test from 'node:test';
import assert from 'node:assert/strict';

import YAML from 'yaml';

import { transformClashYaml } from '../src/clash.js';

test('builds a dialer-proxy chain with a primary and fallback entry', () => {
  const source = YAML.stringify({
    proxies: [
      { name: 'Entry Primary A', type: 'ss', server: '127.0.0.1', port: 8388 },
      { name: 'Entry Backup A', type: 'ss', server: '127.0.0.2', port: 8388 },
      { name: 'Exit Node A', type: 'ss', server: '127.0.0.3', port: 8388 }
    ],
    'proxy-groups': [
      {
        name: 'PROXY',
        type: 'select',
        proxies: ['Entry Primary A']
      }
    ],
    rules: ['MATCH,PROXY']
  });

  const rendered = YAML.parse(
    transformClashYaml(source, {
      chainGroups: [
        {
          name: 'Chained Exit Fallback',
          targetGroup: 'PROXY',
          secondHopPattern: '^Exit Node ',
          firstHops: [
            { name: 'Chain Primary', includePattern: '^Entry Primary ' },
            { name: 'Chain Backup', includePattern: '^Entry Backup ' }
          ]
        }
      ]
    })
  );

  const primary = rendered.proxies.find((proxy) => proxy.name === 'Chain Primary');
  const backup = rendered.proxies.find((proxy) => proxy.name === 'Chain Backup');
  assert.equal(primary.server, '127.0.0.3');
  assert.equal(primary['dialer-proxy'], 'Entry Primary A');
  assert.equal(backup.server, '127.0.0.3');
  assert.equal(backup['dialer-proxy'], 'Entry Backup A');

  const chainGroup = rendered['proxy-groups'].find(
    (group) => group.name === 'Chained Exit Fallback'
  );
  assert.deepEqual(chainGroup.proxies, ['Chain Primary', 'Chain Backup']);
  assert.equal(chainGroup.type, 'fallback');

  const target = rendered['proxy-groups'].find((group) => group.name === 'PROXY');
  assert.equal(target.proxies.at(-1), 'Chained Exit Fallback');
});

function chainFixture(names) {
  return YAML.stringify({
    proxies: names.map((name, index) => ({
      name, type: 'ss', server: '127.0.0.1', port: 8388 + index
    })),
    'proxy-groups': [{ name: 'PROXY', type: 'select', proxies: names }],
    rules: ['MATCH,PROXY']
  });
}

function chainOptions() {
  return {
    chainGroups: [{
      name: 'Chain', targetGroup: 'PROXY', secondHopPattern: '^Exit ',
      firstHops: [
        { name: 'Via Primary', includePattern: '^Primary ' },
        { name: 'Via Backup', includePattern: '^Backup ' }
      ]
    }]
  };
}

for (const [label, names] of [
  ['exit is missing', ['Primary A', 'Backup A']],
  ['all entries are missing', ['Exit A']]
]) {
  test(`preserves the original subscription when ${label}`, () => {
    const source = chainFixture(names);
    assert.deepEqual(
      YAML.parse(transformClashYaml(source, chainOptions())),
      YAML.parse(source)
    );
  });
}

for (const entry of ['Primary', 'Backup']) {
  test(`keeps the available ${entry} entry when the other entry is missing`, () => {
    const rendered = YAML.parse(transformClashYaml(
      chainFixture([`${entry} A`, 'Exit A']), chainOptions()
    ));
    const chain = rendered['proxy-groups'].find(group => group.name === 'Chain');
    assert.deepEqual(chain.proxies, [`Via ${entry}`]);
    assert.equal(rendered.proxies.length, 3);
    const generated = rendered.proxies.find(proxy => proxy.name === `Via ${entry}`);
    assert.equal(generated['dialer-proxy'], `${entry} A`);
    assert.equal(generated.port, 8389);
    assert.deepEqual(rendered['proxy-groups'].find(group => group.name === 'PROXY').proxies,
      [`${entry} A`, 'Exit A', 'Chain']);
  });
}

for (const names of [
  ['Primary A', 'Exit A', 'Exit B'],
  ['Primary A', 'Primary B', 'Exit A']
]) {
  test(`rejects ambiguous chain matches: ${names.join(', ')}`, () => {
    assert.throws(() => transformClashYaml(chainFixture(names), chainOptions()),
      /must match exactly one proxy, found 2/);
  });
}
