import YAML from 'yaml';

const DEFAULT_FALLBACK_URL = 'https://www.gstatic.com/generate_204';
const DEFAULT_FALLBACK_INTERVAL = 60;

function positiveInteger(value, fallback, field) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return parsed;
}

function requiredText(value, field) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function optionalPattern(value, field) {
  if (value === undefined || value === null || value === '') return null;
  try {
    return new RegExp(String(value));
  } catch (error) {
    throw new Error(`${field} is not a valid regular expression: ${error.message}`);
  }
}

function parseClashYaml(yamlText) {
  const parsed = YAML.parse(yamlText);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid Clash YAML: root must be an object');
  }
  return parsed;
}

function applyFallbackGroup(parsed, rawDefinition) {
  const name = requiredText(rawDefinition?.name, 'fallback group name');
  const targetGroupName = requiredText(rawDefinition?.targetGroup, `fallback group ${name} targetGroup`);
  if (name === targetGroupName) {
    throw new Error(`fallback group ${name} cannot target itself`);
  }

  const include = optionalPattern(
    rawDefinition?.includePattern,
    `fallback group ${name} includePattern`
  );
  const exclude = optionalPattern(
    rawDefinition?.excludePattern,
    `fallback group ${name} excludePattern`
  );

  const groups = parsed['proxy-groups'];
  if (!Array.isArray(groups)) {
    throw new Error(`fallback group ${name} requires proxy-groups`);
  }

  const targetIndex = groups.findIndex((group) => group?.name === targetGroupName);
  if (targetIndex === -1) {
    throw new Error(`fallback group ${name} target group ${targetGroupName} was not found`);
  }
  const target = groups[targetIndex];
  if (!Array.isArray(target.proxies)) {
    throw new Error(`fallback group ${name} target group ${targetGroupName} has no proxies`);
  }

  const proxyNames = (Array.isArray(parsed.proxies) ? parsed.proxies : [])
    .map((proxy) => String(proxy?.name ?? '').trim())
    .filter(Boolean)
    .filter((proxyName) => (include ? include.test(proxyName) : true))
    .filter((proxyName) => (exclude ? !exclude.test(proxyName) : true));

  if (proxyNames.length === 0) {
    throw new Error(`fallback group ${name} found no matching proxies`);
  }

  const fallback = {
    name,
    type: 'fallback',
    proxies: proxyNames,
    url: String(rawDefinition?.url ?? DEFAULT_FALLBACK_URL),
    interval: positiveInteger(
      rawDefinition?.interval,
      DEFAULT_FALLBACK_INTERVAL,
      `fallback group ${name} interval`
    ),
    lazy: false
  };

  const existingIndex = groups.findIndex((group) => group?.name === name);
  if (existingIndex === -1) {
    groups.splice(targetIndex, 0, fallback);
  } else {
    groups[existingIndex] = fallback;
  }
  target.proxies = [name, ...target.proxies.filter((proxyName) => proxyName !== name)];
}

function optionalMatchingProxy(parsed, patternValue, field) {
  const pattern = optionalPattern(requiredText(patternValue, field), field);
  const matches = (Array.isArray(parsed.proxies) ? parsed.proxies : []).filter((proxy) =>
    pattern.test(String(proxy?.name ?? ''))
  );
  if (matches.length === 0) return null;
  if (matches.length !== 1) {
    throw new Error(`${field} must match exactly one proxy, found ${matches.length}`);
  }
  return matches[0];
}

function applyChainGroup(parsed, rawDefinition) {
  const name = requiredText(rawDefinition?.name, 'chain group name');
  const targetGroupName = requiredText(rawDefinition?.targetGroup, `chain group ${name} targetGroup`);
  const groups = parsed['proxy-groups'];
  const proxies = parsed.proxies;
  if (!Array.isArray(groups) || !Array.isArray(proxies)) {
    throw new Error(`chain group ${name} requires proxies and proxy-groups`);
  }

  const targetIndex = groups.findIndex((group) => group?.name === targetGroupName);
  if (targetIndex === -1) {
    throw new Error(`chain group ${name} target group ${targetGroupName} was not found`);
  }
  const target = groups[targetIndex];
  if (!Array.isArray(target.proxies)) {
    throw new Error(`chain group ${name} target group ${targetGroupName} has no proxies`);
  }

  const secondHop = optionalMatchingProxy(
    parsed,
    rawDefinition?.secondHopPattern,
    `chain group ${name} secondHopPattern`
  );
  const firstHops = rawDefinition?.firstHops;
  if (!Array.isArray(firstHops) || firstHops.length === 0) {
    throw new Error(`chain group ${name} firstHops must be a non-empty array`);
  }

  if (!secondHop) return;

  const generatedNames = [];
  for (const firstHopDefinition of firstHops) {
    const generatedName = requiredText(
      firstHopDefinition?.name,
      `chain group ${name} first hop name`
    );
    const firstHop = optionalMatchingProxy(
      parsed,
      firstHopDefinition?.includePattern,
      `chain group ${name} first hop ${generatedName} includePattern`
    );
    if (!firstHop) continue;
    const generatedProxy = {
      ...secondHop,
      name: generatedName,
      'dialer-proxy': firstHop.name
    };
    const existingProxyIndex = proxies.findIndex((proxy) => proxy?.name === generatedName);
    if (existingProxyIndex === -1) proxies.push(generatedProxy);
    else proxies[existingProxyIndex] = generatedProxy;
    generatedNames.push(generatedName);
  }

  if (generatedNames.length === 0) return;

  const chainGroup = {
    name,
    type: 'fallback',
    proxies: generatedNames,
    url: String(rawDefinition?.url ?? DEFAULT_FALLBACK_URL),
    interval: positiveInteger(
      rawDefinition?.interval,
      DEFAULT_FALLBACK_INTERVAL,
      `chain group ${name} interval`
    ),
    lazy: false
  };
  const existingGroupIndex = groups.findIndex((group) => group?.name === name);
  if (existingGroupIndex === -1) groups.splice(targetIndex, 0, chainGroup);
  else groups[existingGroupIndex] = chainGroup;
  target.proxies = [...target.proxies.filter((proxyName) => proxyName !== name), name];
}

export function transformClashYaml(yamlText, options = {}) {
  const fallbackGroups = options.fallbackGroups ?? [];
  const chainGroups = options.chainGroups ?? [];
  if (!Array.isArray(fallbackGroups)) {
    throw new Error('fallbackGroups must be an array');
  }
  if (!Array.isArray(chainGroups)) {
    throw new Error('chainGroups must be an array');
  }
  if (fallbackGroups.length === 0 && chainGroups.length === 0) return yamlText;

  const parsed = parseClashYaml(yamlText);
  for (const definition of fallbackGroups) {
    applyFallbackGroup(parsed, definition);
  }
  for (const definition of chainGroups) {
    applyChainGroup(parsed, definition);
  }
  return YAML.stringify(parsed);
}

export function validateClashYaml(yamlText) {
  let parsed;
  try {
    parsed = parseClashYaml(yamlText);
  } catch (error) {
    throw new Error(`Invalid Clash YAML: ${error.message}`);
  }

  const proxies = parsed.proxies;
  if (!Array.isArray(proxies) || proxies.length === 0) {
    throw new Error('Invalid Clash YAML: expected at least one proxy');
  }

  const groups = parsed['proxy-groups'];
  if (groups !== undefined && !Array.isArray(groups)) {
    throw new Error('Invalid Clash YAML: proxy-groups must be an array when present');
  }

  return {
    proxyCount: proxies.length,
    groupCount: Array.isArray(groups) ? groups.length : 0
  };
}
