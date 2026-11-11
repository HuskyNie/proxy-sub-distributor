// One writer for cache updates and rollback; duplicate account syncs share one result.
export function createTaskGate() {
  let tail = Promise.resolve();
  const pending = new Map();
  return (key, task) => {
    if (pending.has(key)) return pending.get(key);
    const result = tail.then(task);
    tail = result.catch(() => {});
    pending.set(key, result);
    result.then(() => pending.delete(key), () => pending.delete(key));
    return result;
  };
}
