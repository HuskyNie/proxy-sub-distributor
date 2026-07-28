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

async function requireOk(response, context) {
  if (!response.ok) {
    throw new Error(`${context} failed with HTTP ${response.status}`);
  }
  return response;
}

async function fetchSubscription(fetchImpl, subscriptionUrl, headers = {}) {
  const response = await requireOk(
    await fetchImpl(subscriptionUrl, {
      method: 'GET',
      headers: {
        accept: 'text/yaml, application/yaml, text/plain, */*',
        'user-agent': 'proxy-sub-distributor/0.1',
        ...headers
      }
    }),
    'subscription download'
  );
  return response.text();
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

async function assertHealthySubscription({
  yamlText,
  healthChecker,
  healthOptions,
  cache,
  details,
  eventLog,
  mode
}) {
  if (typeof healthChecker !== 'function') return null;

  const health = await healthChecker(yamlText, healthOptions ?? {});
  const summary = summarizeHealth(health);

  if (health.healthy) {
    await recordEvent(eventLog, 'subscription_sync_health_checked', {
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
  await recordEvent(eventLog, 'subscription_sync_health_failed', {
    mode,
    healthy: false,
    action: 'keep_last_good',
    ...summary
  });
  throw new SubscriptionHealthError(health);
}

async function syncSubscription({
  subscriptionUrl,
  headers,
  mode,
  cache,
  fetchImpl,
  now,
  eventLog,
  healthChecker,
  healthOptions
}) {
  const fetchedAt = now().toISOString();
  const normalizedUrl = new URL(subscriptionUrl).toString();
  await recordEvent(eventLog, 'subscription_sync_started', { mode });

  try {
    const yamlText = await fetchSubscription(fetchImpl, normalizedUrl, headers);
    const parsedUrl = new URL(normalizedUrl);
    const details = {
      sourceUrl: normalizedUrl,
      subscriptionUrlHost: parsedUrl.host,
      fetchedAt
    };
    const health = await assertHealthySubscription({
      yamlText,
      healthChecker,
      healthOptions,
      cache,
      details,
      eventLog,
      mode
    });
    const metadata = await cache.saveSuccessfulConfig(yamlText, {
      ...details,
      health
    });
    await recordEvent(
      eventLog,
      'subscription_sync_succeeded',
      syncSuccessDetails(mode, metadata)
    );
    return metadata;
  } catch (error) {
    await cache.recordFailure(error, fetchedAt);
    await recordEvent(eventLog, 'subscription_sync_failed', syncFailureDetails(mode, error));
    throw error;
  }
}

export async function runSync({
  upstream,
  cache,
  fetchImpl = fetch,
  now = () => new Date(),
  eventLog,
  healthChecker,
  healthOptions
}) {
  return syncSubscription({
    subscriptionUrl: upstream.url,
    headers: upstream.headers,
    mode: 'configured_url',
    cache,
    fetchImpl,
    now,
    eventLog,
    healthChecker,
    healthOptions
  });
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
  return syncSubscription({
    subscriptionUrl,
    headers: {},
    mode: 'manual_url',
    cache,
    fetchImpl,
    now,
    eventLog,
    healthChecker,
    healthOptions
  });
}
