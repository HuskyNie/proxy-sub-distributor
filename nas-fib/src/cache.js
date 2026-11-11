import { normalizeSubscriptionInfo, contentDigest } from './subscription-info.js';
import { copyFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { validateClashYaml } from './clash.js';

function historyName(isoString) {
  return `${isoString.replace(/[:.]/g, '-')}.yaml`;
}

function serializeError(error) {
  return {
    message: error.message,
    name: error.name ?? 'Error'
  };
}

export class SubscriptionCache {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.latestPath = join(dataDir, 'latest.yaml');
    this.metadataPath = join(dataDir, 'metadata.json');
    this.historyDir = join(dataDir, 'history');
    this.rejectedDir = join(dataDir, 'rejected');
  }

  async ensureDirs() {
    await mkdir(this.historyDir, { recursive: true });
    await mkdir(this.rejectedDir, { recursive: true });
  }

  async readLatest() {
    return readFile(this.latestPath, 'utf8');
  }

  async readMetadata() {
    try {
      return JSON.parse(await readFile(this.metadataPath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') {
        return {
          lastSuccessAt: null,
          lastError: null,
          proxyCount: 0,
          groupCount: 0,
          subscriptionUrlHost: null
        };
      }
      throw error;
    }
  }

  async saveSuccessfulConfig(yamlText, details) {
    const validation = validateClashYaml(yamlText);
    await this.ensureDirs();

    const fetchedAt = details.fetchedAt;
    const version = historyName(fetchedAt);
    const latestTemp = `${this.latestPath}.tmp`;
    await writeFile(latestTemp, yamlText);
    await rename(latestTemp, this.latestPath);
    await writeFile(join(this.historyDir, version), yamlText);

    const metadata = {
      lastSuccessAt: fetchedAt,
      lastError: null,
      proxyCount: validation.proxyCount,
      groupCount: validation.groupCount,
      sourceUrl: details.sourceUrl,
      subscriptionUrlHost: details.subscriptionUrlHost,
      version,
      health: details.health ?? null,
      subscriptionUserinfo: normalizeSubscriptionInfo(details.subscriptionUserinfo),
      contentDigest: contentDigest(yamlText)
    };
    await writeFile(join(this.historyDir, `${version}.info.json`), JSON.stringify({
      subscriptionUserinfo: metadata.subscriptionUserinfo, contentDigest: metadata.contentDigest
    }));
    await writeFile(this.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    return metadata;
  }

  async saveRejectedConfig(yamlText, details) {
    await this.ensureDirs();
    const version = historyName(details.fetchedAt);
    await writeFile(join(this.rejectedDir, version), yamlText);
    await writeFile(
      join(this.rejectedDir, `${version}.health.json`),
      `${JSON.stringify(details.health ?? null, null, 2)}\n`
    );
    return { version };
  }

  async listHistoryVersions() {
    await this.ensureDirs();
    const entries = await readdir(this.historyDir);
    return entries
      .filter((entry) => entry.endsWith('.yaml'))
      .sort()
      .reverse()
      .map((version) => ({
        version,
        path: join(this.historyDir, version)
      }));
  }

  async readHistoryVersion(version) {
    return readFile(join(this.historyDir, version), 'utf8');
  }

  async restoreHistoryVersion(version, details = {}) {
    await this.ensureDirs();
    const yamlText = await this.readHistoryVersion(version);
    const validation = validateClashYaml(yamlText);
    const latestTemp = `${this.latestPath}.tmp`;
    await copyFile(join(this.historyDir, version), latestTemp);
    await rename(latestTemp, this.latestPath);

    const existing = await this.readMetadata();
    let savedInfo = {};
    try { savedInfo = JSON.parse(await readFile(join(this.historyDir, `${version}.info.json`), 'utf8')); }
    catch { /* Older histories have no subscription metadata. Do not reuse a different version's values. */ }
    const digest = contentDigest(yamlText);
    const metadata = {
      ...existing,
      subscriptionUserinfo: savedInfo.contentDigest === digest ? normalizeSubscriptionInfo(savedInfo.subscriptionUserinfo) : null,
      contentDigest: digest,
      lastError: null,
      proxyCount: validation.proxyCount,
      groupCount: validation.groupCount,
      version,
      restoredAt: details.restoredAt,
      restoredFromVersion: details.fromVersion,
      health: details.health ?? null
    };
    await writeFile(this.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    return metadata;
  }

  async recordFailure(error, failedAt) {
    await this.ensureDirs();
    const existing = await this.readMetadata();
    const metadata = {
      ...existing,
      lastError: {
        ...serializeError(error),
        failedAt
      }
    };
    await writeFile(this.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    return metadata;
  }
}
