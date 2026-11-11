import { parentPort, workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';
const { challenge, bits } = workerData;
const bytes = Math.floor(bits / 8), remainder = bits % 8;
for (let nonce = 0; nonce < 0x7fffffff; nonce++) {
  const hash = createHash('sha256').update(`${challenge}:${nonce}`).digest();
  if (hash.subarray(0, bytes).every(b => b === 0) &&
      (remainder === 0 || (hash[bytes] >>> (8 - remainder)) === 0)) {
    parentPort.postMessage(String(nonce));
    break;
  }
}
