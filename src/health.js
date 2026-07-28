import { lookup as dnsLookup } from 'node:dns/promises';
import net from 'node:net';

import YAML from 'yaml';

const DEFAULT_TCP_TIMEOUT_MS = 2500;
const DEFAULT_CONCURRENCY = 10;
const DEFAULT_MIN_BOTH_PASSED_RATIO = 0.5;

function numberFrom(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function ratioFrom(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

function normalizeOptions(options = {}) {
  return {
    tcpTimeoutMs: numberFrom(options.tcpTimeoutMs, DEFAULT_TCP_TIMEOUT_MS),
    concurrency: Math.max(1, Math.floor(numberFrom(options.concurrency, DEFAULT_CONCURRENCY))),
    minBothPassedRatio: ratioFrom(options.minBothPassedRatio, DEFAULT_MIN_BOTH_PASSED_RATIO),
    lookup: options.lookup ?? ((host) => dnsLookup(host, { all: true })),
    tcpConnect: options.tcpConnect ?? defaultTcpConnect
  };
}

function parseProxyEndpoints(yamlText) {
  const parsed = YAML.parse(yamlText);
  const proxies = Array.isArray(parsed?.proxies) ? parsed.proxies : [];

  return proxies.map((proxy, index) => ({
    index,
    name: String(proxy?.name ?? `proxy-${index}`),
    server: proxy?.server === undefined || proxy?.server === null ? '' : String(proxy.server).trim(),
    port: Number(proxy?.port)
  }));
}

function isValidPort(port) {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

function errorDetails(error) {
  return {
    name: error?.name ?? 'Error',
    code: error?.code,
    message: error?.message ?? String(error)
  };
}

async function defaultTcpConnect({ address, host, port, timeoutMs }) {
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: address || host, port });
    let settled = false;

    function settle(callback, value) {
      if (settled) return;
      settled = true;
      socket.destroy();
      callback(value);
    }

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => settle(resolve));
    socket.once('timeout', () => {
      const error = new Error('TCP connect timed out');
      error.code = 'ETIMEDOUT';
      settle(reject, error);
    });
    socket.once('error', (error) => settle(reject, error));
  });
}

async function mapConcurrent(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

async function checkEndpoint(endpoint, options, dnsCache) {
  if (!endpoint.server || !isValidPort(endpoint.port)) {
    return {
      ...endpoint,
      dnsPassed: false,
      tcpPassed: false,
      dnsError: { name: 'Error', message: 'missing server or port' },
      tcpError: null
    };
  }

  let dnsPassed = true;
  let dnsError = null;
  let addresses = [];

  if (net.isIP(endpoint.server)) {
    addresses = [{ address: endpoint.server }];
  } else {
    if (!dnsCache.has(endpoint.server)) {
      dnsCache.set(
        endpoint.server,
        options.lookup(endpoint.server).then(
          (result) => ({ ok: true, result: Array.isArray(result) ? result : [result] }),
          (error) => ({ ok: false, error })
        )
      );
    }

    const lookupResult = await dnsCache.get(endpoint.server);
    if (lookupResult.ok) {
      addresses = lookupResult.result.filter((entry) => entry?.address);
      dnsPassed = addresses.length > 0;
      if (!dnsPassed) dnsError = { name: 'Error', message: 'DNS lookup returned no address' };
    } else {
      dnsPassed = false;
      dnsError = errorDetails(lookupResult.error);
    }
  }

  let tcpPassed = false;
  let tcpError = null;
  if (dnsPassed) {
    try {
      await options.tcpConnect({
        host: endpoint.server,
        address: addresses[0]?.address,
        port: endpoint.port,
        timeoutMs: options.tcpTimeoutMs
      });
      tcpPassed = true;
    } catch (error) {
      tcpError = errorDetails(error);
    }
  }

  return {
    ...endpoint,
    dnsPassed,
    tcpPassed,
    dnsError,
    tcpError
  };
}

export async function checkSubscriptionHealth(yamlText, rawOptions = {}) {
  const options = normalizeOptions(rawOptions);
  const endpoints = parseProxyEndpoints(yamlText);
  const dnsCache = new Map();
  const nodes = await mapConcurrent(endpoints, options.concurrency, (endpoint) =>
    checkEndpoint(endpoint, options, dnsCache)
  );

  const proxyCount = nodes.length;
  const dnsFailedCount = nodes.filter((node) => !node.dnsPassed).length;
  const tcpFailedCount = nodes.filter((node) => node.dnsPassed && !node.tcpPassed).length;
  const bothPassedCount = nodes.filter((node) => node.dnsPassed && node.tcpPassed).length;
  const bothPassedRatio = proxyCount === 0 ? 0 : bothPassedCount / proxyCount;

  return {
    proxyCount,
    dnsFailedCount,
    tcpFailedCount,
    bothPassedCount,
    bothPassedRatio,
    healthy: proxyCount > 0 && bothPassedRatio >= options.minBothPassedRatio,
    minBothPassedRatio: options.minBothPassedRatio,
    failedHosts: [
      ...new Set(
        nodes
          .filter((node) => !node.dnsPassed || !node.tcpPassed)
          .map((node) => node.server)
          .filter(Boolean)
      )
    ].slice(0, 20),
    nodes
  };
}

export function summarizeHealth(health) {
  return {
    proxyCount: health.proxyCount,
    dnsFailedCount: health.dnsFailedCount,
    tcpFailedCount: health.tcpFailedCount,
    bothPassedCount: health.bothPassedCount,
    bothPassedRatio: health.bothPassedRatio,
    minBothPassedRatio: health.minBothPassedRatio,
    failedHosts: health.failedHosts ?? []
  };
}
