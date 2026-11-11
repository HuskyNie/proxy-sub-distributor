import { Worker } from 'node:worker_threads';
export function solveChallenge(challenge, { timeoutMs = 30000, maxBits = 24 } = {}) {
  const part = typeof challenge === 'string' ? challenge.split('.')[3] : '';
  const bits = /^\d+$/.test(part ?? '') ? Number(part) : NaN;
  if (!Number.isInteger(bits) || bits < 1 || bits > maxBits || challenge.length > 4096) {
    return Promise.reject(new Error('FIB challenge format or difficulty unsupported'));
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./pow-worker.js', import.meta.url), {
      workerData: { challenge, bits }, execArgv: []
    });
    const timer = setTimeout(() => finish(new Error('FIB proof of work timed out')), timeoutMs);
    let done = false;
    function finish(error, nonce) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(error); else resolve(nonce);
    }
    worker.once('message', nonce => finish(null, nonce));
    worker.once('error', () => finish(new Error('FIB proof of work worker failed')));
    worker.once('exit', () => finish(new Error('FIB proof of work ended without solution')));
  });
}
