import { createHash } from 'node:crypto';

// Only normalized decimal fields may be sent as an HTTP response header.
export function normalizeSubscriptionInfo(value) {
  if (typeof value !== 'string' || value.length > 512 || /[\r\n]/.test(value)) return null;
  const fields = new Map();
  for (const part of value.split(';')) {
    const match = part.trim().match(/^(upload|download|total|expire)\s*=\s*(\d+)$/i);
    if (!match || fields.has(match[1].toLowerCase())) return null;
    const number = Number(match[2]);
    if (!Number.isSafeInteger(number) || number < 0) return null;
    fields.set(match[1].toLowerCase(), number);
  }
  if (!['upload', 'download', 'total'].every(key => fields.has(key))) return null;
  return ['upload', 'download', 'total', 'expire'].filter(key => fields.has(key))
    .map(key => `${key}=${fields.get(key)}`).join('; ');
}

export function contentDigest(text) {
  return createHash('sha256').update(text).digest('hex');
}
