import http from 'node:http';

import { transformClashYaml } from './clash.js';
import { recordEvent } from './event-log.js';

function sendJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function sendText(response, status, text, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store'
  });
  response.end(text);
}

function tokenMatches(actual, expected) {
  return typeof actual === 'string' && actual.length > 0 && actual === expected;
}

function mergeClashOptions(globalOptions, deviceOptions) {
  const fallbackGroups = new Map();
  for (const group of [
    ...(globalOptions?.fallbackGroups ?? []),
    ...(deviceOptions?.fallbackGroups ?? [])
  ]) {
    fallbackGroups.set(group?.name, group);
  }
  const chainGroups = new Map();
  for (const group of [
    ...(globalOptions?.chainGroups ?? []),
    ...(deviceOptions?.chainGroups ?? [])
  ]) {
    chainGroups.set(group?.name, group);
  }
  return {
    ...globalOptions,
    ...deviceOptions,
    fallbackGroups: [...fallbackGroups.values()],
    chainGroups: [...chainGroups.values()]
  };
}

function firstHeader(value) {
  if (Array.isArray(value)) return value[0] ?? null;
  if (typeof value !== 'string' || value.length === 0) return null;
  return value.slice(0, 512);
}

function requestDetails(request) {
  const forwardedFor = firstHeader(request.headers['x-forwarded-for']);
  return {
    remoteAddress: forwardedFor?.split(',')[0]?.trim() || request.socket.remoteAddress || null,
    userAgent: firstHeader(request.headers['user-agent'])
  };
}

async function readJsonBody(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1024 * 1024) throw new Error('request body too large');
  }
  return body ? JSON.parse(body) : {};
}

async function recordSubscriptionEvent(eventLog, event, request, details) {
  await recordEvent(eventLog, event, {
    ...requestDetails(request),
    ...details
  });
}

export function createServer({
  cache,
  devices,
  clash,
  loadClashOptions,
  syncToken,
  syncNow,
  syncUrl,
  eventLog
}) {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');

    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/status') {
        sendJson(response, 200, {
          cache: await cache.readMetadata(),
          devices: Object.keys(devices)
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/sync') {
        if (!tokenMatches(url.searchParams.get('token'), syncToken)) {
          sendJson(response, 403, { error: 'forbidden' });
          return;
        }
        sendJson(response, 200, await syncNow());
        return;
      }

      if (request.method === 'POST' && url.pathname === '/sync-url') {
        if (!tokenMatches(url.searchParams.get('token'), syncToken)) {
          sendJson(response, 403, { error: 'forbidden' });
          return;
        }
        if (typeof syncUrl !== 'function') {
          sendJson(response, 501, { error: 'manual URL sync is not configured' });
          return;
        }
        const body = await readJsonBody(request);
        if (typeof body.url !== 'string' || body.url.length === 0) {
          sendJson(response, 400, { error: 'url is required' });
          return;
        }
        sendJson(response, 200, await syncUrl(body.url));
        return;
      }

      const subMatch = url.pathname.match(/^\/sub\/([A-Za-z0-9_-]+)$/);
      if (request.method === 'GET' && subMatch) {
        const deviceName = subMatch[1];
        const device = devices[deviceName];
        if (!device) {
          await recordSubscriptionEvent(eventLog, 'subscription_denied', request, {
            device: deviceName,
            reason: 'unknown_device',
            status: 404
          });
          sendJson(response, 404, { error: 'unknown device' });
          return;
        }
        if (!tokenMatches(url.searchParams.get('token'), device.token)) {
          await recordSubscriptionEvent(eventLog, 'subscription_denied', request, {
            device: deviceName,
            reason: 'invalid_token',
            status: 403
          });
          sendJson(response, 403, { error: 'forbidden' });
          return;
        }
        try {
          const latest = await cache.readLatest();
          const globalClash =
            typeof loadClashOptions === 'function' ? await loadClashOptions(latest) : clash;
          const rendered = transformClashYaml(
            latest,
            mergeClashOptions(globalClash, device.clash)
          );
          await recordSubscriptionEvent(eventLog, 'subscription_served', request, {
            device: deviceName,
            status: 200
          });
          sendText(response, 200, rendered, 'text/yaml; charset=utf-8');
        } catch (error) {
          await recordSubscriptionEvent(eventLog, 'subscription_failed', request, {
            device: deviceName,
            status: 500,
            errorName: error.name ?? 'Error',
            errorMessage: error.message
          });
          throw error;
        }
        return;
      }

      sendJson(response, 404, { error: 'not found' });
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }
  });
}
