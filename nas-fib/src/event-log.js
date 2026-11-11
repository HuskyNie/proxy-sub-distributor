import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

function formatOffset(offsetMinutes) {
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0');
  const minutes = String(absolute % 60).padStart(2, '0');
  return `${sign}${hours}:${minutes}`;
}

export function formatTimestamp(date, offsetMinutes = 8 * 60) {
  const shifted = new Date(date.getTime() + offsetMinutes * 60 * 1000);
  return shifted.toISOString().replace('Z', formatOffset(offsetMinutes));
}

export class JsonlEventLog {
  constructor(dataDir, { now = () => new Date(), filename = 'events.jsonl', offsetMinutes = 8 * 60 } = {}) {
    this.dataDir = dataDir;
    this.path = join(dataDir, filename);
    this.now = now;
    this.offsetMinutes = offsetMinutes;
  }

  async append(event, details = {}) {
    await mkdir(this.dataDir, { recursive: true });
    const entry = {
      ts: formatTimestamp(this.now(), this.offsetMinutes),
      event,
      ...details
    };
    await appendFile(this.path, `${JSON.stringify(entry)}\n`);
    return entry;
  }
}

export async function recordEvent(eventLog, event, details = {}) {
  if (!eventLog || typeof eventLog.append !== 'function') return;

  try {
    await eventLog.append(event, details);
  } catch (error) {
    console.error(`event log write failed: ${error.message}`);
  }
}
