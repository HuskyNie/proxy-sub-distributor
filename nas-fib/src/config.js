import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

function numberFrom(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Expected a number, got ${value}`);
  return parsed;
}

function requireString(value, message) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(message);
  return normalized;
}

function loadUpstreams(raw = [], defaultInterval) {
  if (!Array.isArray(raw)) throw new Error('upstreams must be an array');
  const ids = new Set();
  const names = new Set();
  return raw.map((entry) => {
    const id = requireString(entry?.id, 'Upstream id is required');
    if (!/^[a-z][a-z0-9_-]{0,31}$/u.test(id) || id === 'fib' || ids.has(id)) {
      throw new Error('Upstream id must be unique, lowercase, and different from fib');
    }
    ids.add(id);
    const name = requireString(entry.name ?? id, 'Upstream name is required');
    if (names.has(name)) throw new Error('Upstream names must be unique');
    names.add(name);
    const targetGroup = requireString(entry.targetGroup, 'Upstream targetGroup is required');
    const intervalMinutes = numberFrom(entry.intervalMinutes, defaultInterval);
    if (intervalMinutes < 0 || intervalMinutes * 60_000 > 2_147_483_647) {
      throw new Error('Upstream intervalMinutes is out of range');
    }

    const socketPath = entry.socketPath === undefined ? undefined :
      requireString(entry.socketPath, 'Upstream socketPath is required');
    const url = entry.url === undefined ? undefined : requireString(entry.url, 'Upstream url is required');
    if (Boolean(socketPath) === Boolean(url) || (socketPath && !isAbsolute(socketPath))) {
      throw new Error('An upstream needs either a URL or an absolute socketPath');
    }
    if (url) {
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error('Upstream url must be an HTTP(S) URL');
      }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
        throw new Error('Upstream url must be an HTTP(S) URL without user information');
      }
    }
    const headers = entry.headers === undefined ? undefined : new Headers(entry.headers);
    let exclude;
    if (entry.excludePattern !== undefined) {
      const pattern = requireString(entry.excludePattern, 'Upstream excludePattern is required');
      exclude = new RegExp(pattern, 'iu');
    }
    return { id, name, targetGroup, intervalMinutes, socketPath, url, headers, exclude };
  });
}

export async function loadConfig(configPath, env = process.env) {
  const raw = JSON.parse(await readFile(configPath, 'utf8'));
  const intervalMinutes = numberFrom(env.SYNC_INTERVAL_MINUTES, numberFrom(raw.sync?.intervalMinutes, 360));

  const devices = raw.devices ?? {};
  for (const [name, device] of Object.entries(devices)) {
    requireString(device?.token, `Device ${name} token is required`);
  }

  return {
    server: {
      host: raw.server?.host ?? env.HOST ?? '0.0.0.0',
      port: numberFrom(env.PORT, numberFrom(raw.server?.port, 7899)),
      syncToken: requireString(
        env.SYNC_TOKEN ?? raw.server?.syncToken,
        'Server syncToken is required'
      )
    },
    fib: {
      baseUrl: raw.fib?.baseUrl ?? 'https://1.fibacc.net',
      email: requireString(env.FIB_EMAIL ?? raw.fib?.email, 'FIB email is required'),
      password: requireString(env.FIB_PASSWORD ?? raw.fib?.password, 'FIB password is required')
    },
    sync: {
      intervalMinutes,
      runOnStart: env.RUN_ON_START === undefined ? raw.sync?.runOnStart !== false : env.RUN_ON_START !== 'false'
    },
    health: {
      intervalMinutes: numberFrom(
        env.HEALTH_INTERVAL_MINUTES,
        numberFrom(raw.health?.intervalMinutes, 30)
      ),
      tcpTimeoutMs: numberFrom(env.HEALTH_TCP_TIMEOUT_MS, numberFrom(raw.health?.tcpTimeoutMs, 2500)),
      concurrency: numberFrom(env.HEALTH_CONCURRENCY, numberFrom(raw.health?.concurrency, 10)),
      minBothPassedRatio: numberFrom(
        env.HEALTH_MIN_BOTH_PASSED_RATIO,
        numberFrom(raw.health?.minBothPassedRatio, 0.5)
      )
    },
    upstreams: loadUpstreams(raw.upstreams, intervalMinutes),
    clash: raw.clash ?? {},
    devices
  };
}
