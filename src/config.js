import { readFile } from 'node:fs/promises';

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

function stringMap(value, field) {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      requireString(key, `${field} key is required`),
      requireString(item, `${field}.${key} must be a string`)
    ])
  );
}

export async function loadConfig(configPath, env = process.env) {
  const raw = JSON.parse(await readFile(configPath, 'utf8'));

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
    upstream: {
      url: requireString(
        env.UPSTREAM_URL ?? raw.upstream?.url,
        'Upstream subscription URL is required'
      ),
      headers: stringMap(raw.upstream?.headers, 'upstream.headers')
    },
    sync: {
      intervalMinutes: numberFrom(env.SYNC_INTERVAL_MINUTES, numberFrom(raw.sync?.intervalMinutes, 360)),
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
    clash: raw.clash ?? {},
    devices
  };
}
