export function createLatestRequestTracker() {
  const generations = new Map();
  let active = true;

  return {
    activate() { active = true; },
    deactivate() { active = false; },
    begin(key) {
      const generation = (generations.get(key) || 0) + 1;
      generations.set(key, generation);
      return generation;
    },
    isCurrent(key, generation) {
      return active && generations.get(key) === generation;
    }
  };
}

export const ADMIN_DATA_LOAD_TIMEOUT_MS = 15_000;

export function runWithDeadline(work, timeoutMs = ADMIN_DATA_LOAD_TIMEOUT_MS) {
  if (typeof work !== 'function') throw new TypeError('A data-load function is required.');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('A positive timeout is required.');

  let timeoutId;
  const deadline = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('Administrator data request timed out.')), timeoutMs);
  });

  return Promise.race([Promise.resolve().then(work), deadline])
    .finally(() => clearTimeout(timeoutId));
}
