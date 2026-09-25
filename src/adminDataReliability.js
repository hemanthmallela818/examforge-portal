/**
 * Tracks the latest request generation per key so stale responses can be
 * discarded.
 * @returns {{ activate(): void, deactivate(): void, begin(key: unknown): number, isCurrent(key: unknown, generation: number): boolean }}
 */
export function createLatestRequestTracker() {
  /** @type {Map<unknown, number>} */
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

/**
 * @template T
 * @param {() => T | PromiseLike<T>} work
 * @param {number} [timeoutMs]
 * @returns {Promise<T>}
 */
export function runWithDeadline(work, timeoutMs = ADMIN_DATA_LOAD_TIMEOUT_MS) {
  if (typeof work !== 'function') throw new TypeError('A data-load function is required.');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('A positive timeout is required.');

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timeoutId;
  /** @type {Promise<never>} */
  const deadline = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('Administrator data request timed out.')), timeoutMs);
  });

  return Promise.race([Promise.resolve().then(work), deadline])
    .finally(() => clearTimeout(timeoutId));
}
