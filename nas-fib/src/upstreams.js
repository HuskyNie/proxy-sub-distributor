import http from 'node:http';
import { join } from 'node:path';
import YAML from 'yaml';

import { SubscriptionCache } from './cache.js';
import { DEFAULT_FALLBACK_INTERVAL, DEFAULT_FALLBACK_URL } from './clash.js';
import { recordEvent } from './event-log.js';
import { summarizeHealth } from './health.js';
import { contentDigest, normalizeSubscriptionInfo } from './subscription-info.js';
import { createTaskGate } from './task-gate.js';

const MAX_YAML_BYTES = 2 * 1024 * 1024;
const REGIONS = new Intl.DisplayNames(['zh-CN'], { type: 'region', fallback: 'none' });
const REGION_NAMES = { HK: '香港', MO: '澳门', TW: '台湾' };

class UpstreamError extends Error {}

function requestSocket(socketPath, signal) {
  return new Promise((resolve, reject) => {
    const request = http.get({ socketPath, path: '/subscription', signal }, resolve);
    request.on('error', reject);
  });
}

async function downloadUpstream(source, fetchImpl) {
  const signal = AbortSignal.timeout(55_000);
  let response;
  let status;
  let body;
  let rawInfo;
  try {
    if (source.socketPath) {
      response = await requestSocket(source.socketPath, signal);
      status = response.statusCode;
      body = response;
      rawInfo = response.headers['subscription-userinfo'];
    } else {
      const headers = new Headers({ Accept: 'application/yaml, text/yaml, text/plain, */*' });
      for (const [name, value] of source.headers ?? []) headers.set(name, value);
      response = await fetchImpl(source.url, { headers, signal, redirect: 'error' });
      status = response.status;
      body = response.body;
      rawInfo = response.headers.get('subscription-userinfo');
    }
    if (status < 200 || status >= 300) {
      if (source.socketPath) response.destroy();
      else await body?.cancel();
      throw new UpstreamError(status === 401 ? 'Upstream requires sign-in' : `Upstream returned HTTP ${status}`);
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of body ?? []) {
      size += chunk.length;
      if (size > MAX_YAML_BYTES) throw new UpstreamError('Upstream YAML exceeds 2 MiB');
      chunks.push(chunk);
    }
    return {
      yamlText: Buffer.concat(chunks).toString('utf8'),
      subscriptionUserinfo: normalizeSubscriptionInfo(rawInfo)
    };
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    throw new UpstreamError('Upstream download failed');
  }
}

function parseUpstreamNodes(yamlText, exclude) {
  let document;
  try {
    document = YAML.parse(yamlText);
  } catch {
    throw new UpstreamError('Upstream returned invalid Clash YAML');
  }
  const nodes = Array.isArray(document?.proxies)
    ? document.proxies.filter((node) => !exclude?.test(node?.name))
    : [];
  if (nodes.length === 0) throw new UpstreamError('Upstream returned no usable proxies');
  const names = new Set();
  for (const node of nodes) {
    if (typeof node?.name !== 'string' || !node.name.trim() || names.has(node.name)
      || typeof node.type !== 'string' || !node.type.trim()
      || typeof node.server !== 'string' || !node.server.trim()
      || !Number.isInteger(Number(node.port)) || Number(node.port) < 1 || Number(node.port) > 65_535) {
      throw new UpstreamError('Upstream returned an invalid or duplicate proxy');
    }
    names.add(node.name);
  }
  for (const node of nodes) {
    const dialer = node['dialer-proxy'];
    if (dialer !== undefined && dialer !== 'DIRECT' && (!names.has(dialer) || dialer === node.name)) {
      throw new UpstreamError('Upstream contains a proxy with an unsupported dialer reference');
    }
  }
  return nodes;
}

function exitRegion(name) {
  const flag = name.match(/\p{Regional_Indicator}{2}/u)?.[0];
  if (!flag) return '其他';
  const code = Array.from(flag, (letter) => String.fromCodePoint(letter.codePointAt(0) - 0x1f1e6 + 65)).join('');
  return REGION_NAMES[code] ?? REGIONS.of(code) ?? code;
}

function reserveName(occupied, base) {
  let name = base;
  for (let suffix = 2; occupied.has(name); suffix += 1) name = `${base} (${suffix})`;
  occupied.add(name);
  return name;
}

function mergeUpstreams(yamlText, ready) {
  if (ready.length === 0) return yamlText;
  const base = YAML.parse(yamlText);
  if (!Array.isArray(base?.proxies) || !Array.isArray(base['proxy-groups'])) return yamlText;
  const originalCount = base.proxies.length;
  const groups = base['proxy-groups'];
  const targets = new Map(groups.filter((group) => group?.type === 'select' && Array.isArray(group.proxies))
    .map((group) => [group.name, group]));
  const occupied = new Set([
    ...base.proxies.map((proxy) => proxy?.name),
    ...groups.map((group) => group?.name),
    ...Object.keys(base['proxy-providers'] ?? {})
  ]);
  for (const { source, nodes } of ready) {
    const target = targets.get(source.targetGroup);
    if (!target) continue;
    const names = new Map(nodes.map((node) => [node.name, reserveName(occupied, `${source.name} ${node.name}`)]));
    const regions = new Map();
    for (const node of nodes) {
      const name = names.get(node.name);
      const proxy = { ...node, name };
      const dialer = names.get(node['dialer-proxy']);
      if (dialer) proxy['dialer-proxy'] = dialer;
      base.proxies.push(proxy);
      const region = exitRegion(node.name);
      if (!regions.has(region)) regions.set(region, []);
      regions.get(region).push(name);
    }
    for (const [region, proxies] of regions) {
      const name = reserveName(occupied, `${source.name} ${region}`);
      groups.push({
        name,
        type: 'url-test',
        proxies,
        url: DEFAULT_FALLBACK_URL,
        interval: DEFAULT_FALLBACK_INTERVAL,
        tolerance: 300,
        lazy: false
      });
      target.proxies.push(name);
    }
  }
  return base.proxies.length === originalCount ? yamlText : YAML.stringify(base);
}

export function createAdditionalUpstreams({ sources, dataDir, eventLog, healthChecker,
  fetchImpl = fetch, now = () => new Date() }) {
  const upstreams = sources.map((source) => {
    const cache = new SubscriptionCache(join(dataDir, 'upstreams', source.id));
    const gate = createTaskGate();
    return { source, cache, gate };
  });

  async function refresh({ source, cache, gate }) {
    return gate('sync', async () => {
      const fetchedAt = now().toISOString();
      try {
        const download = await downloadUpstream(source, fetchImpl);
        const proxies = parseUpstreamNodes(download.yamlText, source.exclude);
        const yamlText = YAML.stringify({ proxies });
        const health = healthChecker ? await healthChecker(yamlText) : null;
        if (health?.healthy === false) throw new UpstreamError('Upstream did not pass the node health check');
        const metadata = await cache.saveSuccessfulConfig(yamlText, {
          fetchedAt,
          health: health ? summarizeHealth(health) : null,
          subscriptionUserinfo: download.subscriptionUserinfo
        });
        await recordEvent(eventLog, 'upstream_sync_succeeded', { id: source.id, proxyCount: metadata.proxyCount });
        return { id: source.id, lastSuccessAt: fetchedAt, proxyCount: metadata.proxyCount };
      } catch (error) {
        const failure = error instanceof UpstreamError ? error : new UpstreamError('Upstream cache update failed');
        await cache.recordFailure(failure, fetchedAt).catch(() => {});
        await recordEvent(eventLog, 'upstream_sync_failed', { id: source.id, error: failure.message });
        throw failure;
      }
    });
  }

  async function render(yamlText) {
    const loaded = await Promise.all(upstreams.map(async ({ source, cache }) => {
      try {
        // The metadata publishes the committed version after the history file is complete.
        const metadata = await cache.readMetadata();
        if (!metadata.version) return null;
        const sourceYaml = await cache.readHistoryVersion(metadata.version);
        if (metadata.contentDigest !== contentDigest(sourceYaml)) {
          throw new UpstreamError('Upstream cache digest differs');
        }
        return { source, nodes: parseUpstreamNodes(sourceYaml, source.exclude) };
      } catch (error) {
        if (error.code !== 'ENOENT') {
          await recordEvent(eventLog, 'upstream_cache_unavailable', { id: source.id });
        }
        return null;
      }
    }));
    return mergeUpstreams(yamlText, loaded.filter(Boolean));
  }

  async function status() {
    return Promise.all(upstreams.map(async ({ source, cache }) => {
      const metadata = await cache.readMetadata().catch(() => null);
      return {
        id: source.id,
        lastSuccessAt: metadata?.lastSuccessAt ?? null,
        proxyCount: metadata?.proxyCount ?? 0,
        lastError: metadata ? metadata.lastError : { message: 'Upstream cache unavailable' }
      };
    }));
  }

  return {
    jobs: upstreams.map((entry) => ({ ...entry.source, refresh: () => refresh(entry) })),
    render,
    status
  };
}
