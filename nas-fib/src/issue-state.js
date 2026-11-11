import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
export class IssueState {
  constructor(dataDir) { this.path = join(dataDir, 'issue-state.json'); this.dataDir = dataDir; }
  async reserve(now = new Date()) {
    let state = {};
    try { state = JSON.parse(await readFile(this.path, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('FIB issue state unreadable'); }
    const time = now.getTime();
    const day = new Date(time + 8 * 3600000).toISOString().slice(0, 10);
    if (state.lastAttemptAt !== undefined &&
        (!Number.isFinite(state.lastAttemptAt) || !Number.isInteger(state.attempts) || state.attempts < 0)) {
      throw new Error('FIB issue state invalid');
    }
    if (state.lastAttemptAt !== undefined && time - state.lastAttemptAt < 65000) {
      throw new Error('FIB issue cooldown: wait at least 65 seconds between attempts');
    }
    const attempts = state.day === day ? state.attempts : 0;
    if (attempts >= 8) throw new Error('FIB local daily issue attempt limit reached');
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(this.path + '.tmp', JSON.stringify({ day, attempts: attempts + 1, lastAttemptAt: time }), { mode: 0o600 });
    await rename(this.path + '.tmp', this.path);
  }
}
