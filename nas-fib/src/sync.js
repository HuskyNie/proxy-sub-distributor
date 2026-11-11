import { normalizeSubscriptionInfo } from './subscription-info.js';
import { resolveSubscription } from './sublink.js';
import { IssueState } from './issue-state.js';
import { checkinUrl, loginUrl, normalizeFibConfig } from './fib.js';
import { recordEvent } from './event-log.js';
import { summarizeHealth } from './health.js';

class SubscriptionHealthError extends Error {
  constructor(health) {
    super(
      `subscription health check failed: ${health.bothPassedCount}/${health.proxyCount} nodes passed DNS and TCP`
    );
    this.name = 'SubscriptionHealthError';
    this.health = health;
  }
}

function appendCookie(cookieHeader, setCookieValue) {
  if (!setCookieValue) return cookieHeader;
  const cookie = setCookieValue.split(';')[0];
  return cookieHeader ? `${cookieHeader}; ${cookie}` : cookie;
}

function responseCookies(response) {
  if (typeof response.headers.getSetCookie === 'function') {
    return response.headers.getSetCookie();
  }
  const single = response.headers.get('set-cookie');
  return single ? [single] : [];
}

async function requireOk(response, context) {
  if (!response.ok) {
    throw new Error(`${context} failed with HTTP ${response.status}`);
  }
  return response;
}

async function login(fetchImpl, fib) {
  const body = new URLSearchParams({
    email: fib.email,
    passwd: fib.password,
    remember_me: 'on'
  });
  const response = await requireOk(
    await fetchImpl(loginUrl(fib), {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'x-requested-with': 'XMLHttpRequest'
      },
      body
    }),
    'FIB login'
  );

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('FIB login did not return JSON');
  }

  if (payload.ret !== 1) {
    throw new Error(`FIB login rejected: ${payload.msg ?? 'unknown error'}`);
  }

  return responseCookies(response).reduce(appendCookie, '');
}

async function checkin(fetchImpl, fib, cookie) {
  const response = await fetchImpl(checkinUrl(fib), {
    method: 'POST',
    headers: {
      accept: 'application/json, text/javascript, */*; q=0.01',
      cookie,
      referer: `${fib.baseUrl}/user`,
      'user-agent': 'fib-sub-sync/0.1',
      'x-requested-with': 'XMLHttpRequest'
    }
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  return {
    ok: response.ok,
    status: response.status,
    ret: payload.ret,
    msg: payload.msg ?? payload.message ?? null
  };
}

function isAlreadyCheckedIn(message) {
  return /已.*签|already/i.test(String(message ?? ''));
}

async function tryCheckin(fetchImpl, fib, cookie, eventLog) {
  try {
    const result = await checkin(fetchImpl, fib, cookie);
    if (result.ok && (result.ret === 1 || isAlreadyCheckedIn(result.msg))) {
      await recordEvent(eventLog, 'fib_checkin_succeeded', {
        ret: result.ret,
        msg: result.msg,
        ...(result.ret !== 1 ? { alreadyCheckedIn: true } : {})
      });
      return;
    }

    await recordEvent(eventLog, 'fib_checkin_failed', {
      status: result.status,
      ret: result.ret,
      msg: result.msg
    });
  } catch (error) {
    await recordEvent(eventLog, 'fib_checkin_failed', {
      errorName: error.name ?? 'Error',
      errorMessage: error.message
    });
  }
}

async function fetchUserPage(fetchImpl, fib, cookie) {
  const response = await requireOk(
    await fetchImpl(`${fib.baseUrl}/user`, {
      method: 'GET',
      headers: {
        cookie,
        'user-agent': 'fib-sub-sync/0.1'
      }
    }),
    'FIB user page'
  );
  return response.text();
}

async function fetchSubscription(fetchImpl, subscriptionUrl) {
  const response = await requireOk(
    await fetchImpl(subscriptionUrl, {
      method: 'GET',
      headers: {
        accept: 'text/yaml, application/yaml, text/plain, */*',
        'user-agent': 'fib-sub-sync/0.1'
      }
    }),
    'FIB subscription download'
  );
  return { yamlText: await response.text(),
    subscriptionUserinfo: normalizeSubscriptionInfo(response.headers.get('subscription-userinfo')) };
}

function syncSuccessDetails(mode, metadata) {
  const details = {
    mode,
    proxyCount: metadata.proxyCount,
    groupCount: metadata.groupCount,
    subscriptionUrlHost: metadata.subscriptionUrlHost
  };
  if (metadata.health) {
    details.dnsFailedCount = metadata.health.dnsFailedCount;
    details.tcpFailedCount = metadata.health.tcpFailedCount;
    details.bothPassedCount = metadata.health.bothPassedCount;
    details.bothPassedRatio = metadata.health.bothPassedRatio;
  }
  return details;
}

function syncFailureDetails(mode, error) {
  return {
    mode,
    errorName: error.name ?? 'Error',
    errorMessage: error.message
  };
}

async function assertHealthySubscription({ yamlText, healthChecker, healthOptions, cache, details, eventLog, mode }) {
  if (typeof healthChecker !== 'function') return null;

  const health = await healthChecker(yamlText, healthOptions ?? {});
  const summary = summarizeHealth(health);

  if (health.healthy) {
    await recordEvent(eventLog, 'fib_sync_health_checked', {
      mode,
      healthy: true,
      ...summary
    });
    return summary;
  }

  await cache.saveRejectedConfig(yamlText, {
    ...details,
    health: summary
  });
  await recordEvent(eventLog, 'fib_sync_health_failed', {
    mode,
    healthy: false,
    action: 'keep_last_good',
    ...summary
  });
  throw new SubscriptionHealthError(health);
}

export async function runSync({
  fib,
  cache,
  fetchImpl = fetch,
  now = () => new Date(),
  eventLog,
  healthChecker,
  healthOptions
}) {
  const originalFetch = fetchImpl;
  fetchImpl = (url, options = {}) => originalFetch(url, { ...options, signal: AbortSignal.timeout(30000) });
  const fetchedAt = now().toISOString();
  const normalizedFib = normalizeFibConfig(fib);
  await recordEvent(eventLog, 'fib_sync_started', { mode: 'account' });

  try {
    const cookie = await login(fetchImpl, normalizedFib);
    await tryCheckin(fetchImpl, normalizedFib, cookie, eventLog);
    const userPage = await fetchUserPage(fetchImpl, normalizedFib, cookie);
    const links = await resolveSubscription({ html: userPage, fib: normalizedFib, cookie, fetchImpl,
      issueState: new IssueState(cache.dataDir), eventLog, now });
    const { yamlText, subscriptionUserinfo } = await fetchSubscription(fetchImpl, links.clash);
    const subscriptionUrl = new URL(links.clash);
    const details = {
      sourceUrl: links.clash,
      subscriptionUrlHost: subscriptionUrl.host,
      fetchedAt,
      subscriptionUserinfo
    };
    const health = await assertHealthySubscription({
      yamlText,
      healthChecker,
      healthOptions,
      cache,
      details,
      eventLog,
      mode: 'account'
    });

    const metadata = await cache.saveSuccessfulConfig(yamlText, {
      ...details,
      health
    });
    await recordEvent(eventLog, 'fib_sync_succeeded', syncSuccessDetails('account', metadata));
    return metadata;
  } catch (error) {
    await cache.recordFailure(error, fetchedAt);
    await recordEvent(eventLog, 'fib_sync_failed', syncFailureDetails('account', error));
    throw error;
  }
}

export async function syncFromSubscriptionUrl({
  subscriptionUrl,
  cache,
  fetchImpl = fetch,
  now = () => new Date(),
  eventLog,
  healthChecker,
  healthOptions
}) {
  const originalFetch = fetchImpl;
  fetchImpl = (url, options = {}) => originalFetch(url, { ...options, signal: AbortSignal.timeout(30000) });
  const fetchedAt = now().toISOString();
  const normalizedUrl = new URL(subscriptionUrl).toString();
  await recordEvent(eventLog, 'fib_sync_started', { mode: 'manual_url' });

  try {
    const { yamlText, subscriptionUserinfo } = await fetchSubscription(fetchImpl, normalizedUrl);
    const parsedUrl = new URL(normalizedUrl);
    const details = {
      sourceUrl: normalizedUrl,
      subscriptionUrlHost: parsedUrl.host,
      fetchedAt,
      subscriptionUserinfo
    };
    const health = await assertHealthySubscription({
      yamlText,
      healthChecker,
      healthOptions,
      cache,
      details,
      eventLog,
      mode: 'manual_url'
    });
    const metadata = await cache.saveSuccessfulConfig(yamlText, {
      ...details,
      health
    });
    await recordEvent(eventLog, 'fib_sync_succeeded', syncSuccessDetails('manual_url', metadata));
    return metadata;
  } catch (error) {
    await cache.recordFailure(error, fetchedAt);
    await recordEvent(eventLog, 'fib_sync_failed', syncFailureDetails('manual_url', error));
    throw error;
  }
}
