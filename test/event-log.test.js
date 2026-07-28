import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JsonlEventLog } from '../src/event-log.js';

test('event log appends JSON lines with timestamps and event names', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'proxy-sub-distributor-'));
  const timestamps = [
    new Date('2026-06-23T01:00:00.000Z'),
    new Date('2026-06-23T01:01:00.000Z')
  ];

  try {
    const eventLog = new JsonlEventLog(dir, {
      now: () => timestamps.shift()
    });

    await eventLog.append('subscription_sync_started', { mode: 'configured_url' });
    await eventLog.append('subscription_served', {
      device: 'phone',
      status: 200,
      remoteAddress: '192.168.31.20'
    });

    const lines = (await readFile(join(dir, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    assert.deepEqual(lines, [
      {
        ts: '2026-06-23T09:00:00.000+08:00',
        event: 'subscription_sync_started',
        mode: 'configured_url'
      },
      {
        ts: '2026-06-23T09:01:00.000+08:00',
        event: 'subscription_served',
        device: 'phone',
        status: 200,
        remoteAddress: '192.168.31.20'
      }
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
