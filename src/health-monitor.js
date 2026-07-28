import { recordEvent } from './event-log.js';
import { checkSubscriptionHealth, summarizeHealth } from './health.js';

function healthDetails(health) {
  return summarizeHealth(health);
}

export async function runSubscriptionHealthCheck({
  cache,
  eventLog,
  healthChecker = checkSubscriptionHealth,
  healthOptions = {},
  now = () => new Date()
}) {
  const checkedAt = now().toISOString();
  const metadata = await cache.readMetadata();
  const currentVersion = metadata.version ?? null;
  const latestYaml = await cache.readLatest();
  const currentHealth = await healthChecker(latestYaml, healthOptions);

  await recordEvent(eventLog, 'subscription_health_checked', {
    version: currentVersion,
    healthy: currentHealth.healthy,
    ...healthDetails(currentHealth)
  });

  if (currentHealth.healthy) {
    return {
      action: 'keep_current',
      version: currentVersion,
      health: currentHealth
    };
  }

  const history = await cache.listHistoryVersions();
  for (const candidate of history) {
    if (candidate.version === currentVersion) continue;

    const candidateYaml = await cache.readHistoryVersion(candidate.version);
    const candidateHealth = await healthChecker(candidateYaml, healthOptions);
    if (!candidateHealth.healthy) continue;

    await cache.restoreHistoryVersion(candidate.version, {
      fromVersion: currentVersion,
      restoredAt: checkedAt,
      health: healthDetails(candidateHealth)
    });
    await recordEvent(eventLog, 'subscription_health_rollback', {
      fromVersion: currentVersion,
      toVersion: candidate.version,
      reason: 'both_passed_below_threshold',
      previousBothPassedCount: currentHealth.bothPassedCount,
      restoredBothPassedCount: candidateHealth.bothPassedCount,
      previousBothPassedRatio: currentHealth.bothPassedRatio,
      restoredBothPassedRatio: candidateHealth.bothPassedRatio
    });

    return {
      action: 'rollback',
      fromVersion: currentVersion,
      toVersion: candidate.version,
      previousHealth: currentHealth,
      restoredHealth: candidateHealth
    };
  }

  await recordEvent(eventLog, 'subscription_health_rollback_failed', {
    version: currentVersion,
    reason: 'no_healthy_history_version',
    ...healthDetails(currentHealth)
  });

  return {
    action: 'no_healthy_version',
    version: currentVersion,
    health: currentHealth
  };
}
