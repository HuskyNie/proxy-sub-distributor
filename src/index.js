import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SubscriptionCache } from './cache.js';
import { loadConfig } from './config.js';
import { JsonlEventLog } from './event-log.js';
import { checkSubscriptionHealth } from './health.js';
import { runSubscriptionHealthCheck } from './health-monitor.js';
import { createServer } from './server.js';
import { createStrategyConfigLoader } from './strategy-config.js';
import { runSync, syncFromSubscriptionUrl } from './sync.js';
import { transformClashYaml } from './clash.js';

const here = dirname(fileURLToPath(import.meta.url));
const defaultConfigPath = join(here, '..', 'data', 'config.json');
const configPath = process.env.CONFIG_PATH ?? defaultConfigPath;
const dataDir = process.env.DATA_DIR ?? join(here, '..', 'data');

const config = await loadConfig(configPath);
const cache = new SubscriptionCache(dataDir);
const eventLog = new JsonlEventLog(dataDir);
const strategyConfigPath =
  process.env.STRATEGY_CONFIG_PATH ?? join(dataDir, 'clash-strategies.json');
const strategyConfig = createStrategyConfigLoader({
  configPath: strategyConfigPath,
  fallback: config.clash,
  validate: (options, yamlText) =>
    yamlText === null ? undefined : transformClashYaml(yamlText, options),
  onReload: (path) => console.log(`strategy config loaded: ${path}`),
  onError: (error, path) =>
    console.error(`strategy config reload rejected (${path}): ${error.message}`)
});
let initialYaml = null;
try {
  initialYaml = await cache.readLatest();
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
await strategyConfig.loadStrict(initialYaml);

async function checkHealth(yamlText) {
  return checkSubscriptionHealth(yamlText, config.health);
}

async function syncNow() {
  return runSync({
    upstream: config.upstream,
    cache,
    eventLog,
    healthChecker: checkHealth,
    healthOptions: config.health
  });
}

async function syncUrl(subscriptionUrl) {
  return syncFromSubscriptionUrl({
    subscriptionUrl,
    cache,
    eventLog,
    healthChecker: checkHealth,
    healthOptions: config.health
  });
}

async function checkCurrentSubscriptionHealth() {
  return runSubscriptionHealthCheck({
    cache,
    eventLog,
    healthChecker: checkHealth,
    healthOptions: config.health
  });
}

const server = createServer({
  cache,
  devices: config.devices,
  clash: config.clash,
  loadClashOptions: strategyConfig.load,
  syncToken: config.server.syncToken,
  syncNow,
  syncUrl,
  eventLog
});

server.listen(config.server.port, config.server.host, () => {
  console.log(`proxy-sub-distributor listening on ${config.server.host}:${config.server.port}`);
});

if (config.sync.runOnStart) {
  syncNow().catch((error) => {
    console.error(`initial sync failed: ${error.message}`);
  });
}

const intervalMs = config.sync.intervalMinutes * 60 * 1000;
if (intervalMs > 0) {
  setInterval(() => {
    syncNow().catch((error) => {
      console.error(`scheduled sync failed: ${error.message}`);
    });
  }, intervalMs);
}

const healthIntervalMs = config.health.intervalMinutes * 60 * 1000;
if (healthIntervalMs > 0) {
  setInterval(() => {
    checkCurrentSubscriptionHealth().catch((error) => {
      console.error(`scheduled health check failed: ${error.message}`);
    });
  }, healthIntervalMs);
}

function shutdown(signal) {
  console.log(`received ${signal}, shutting down`);
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
