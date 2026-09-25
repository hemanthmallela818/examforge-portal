/** @import { StorageAreaName, StorageLike } from './types' */

/** @typedef {StorageAreaName | StorageLike | null | undefined} StorageTarget */

/**
 * @param {StorageTarget} areaOrStorage Storage object, or the name of a global area (default localStorage).
 * @returns {StorageLike | null}
 */
function resolveStorage(areaOrStorage) {
  if (areaOrStorage && typeof areaOrStorage !== 'string') return areaOrStorage;
  try {
    return globalThis[areaOrStorage || 'localStorage'] || null;
  } catch {
    return null;
  }
}

/**
 * @param {StorageTarget} areaOrStorage
 * @param {string} key
 * @returns {string | null}
 */
export function safeStorageGet(areaOrStorage, key) {
  try { return resolveStorage(areaOrStorage)?.getItem(key) ?? null; } catch { return null; }
}

/**
 * @param {StorageTarget} areaOrStorage
 * @param {string} key
 * @param {unknown} value Stored as `String(value)`.
 * @returns {boolean} false when storage is unavailable or the write failed.
 */
export function safeStorageSet(areaOrStorage, key, value) {
  try {
    const storage = resolveStorage(areaOrStorage);
    if (!storage) return false;
    storage.setItem(key, String(value));
    return true;
  } catch { return false; }
}

/**
 * @param {StorageTarget} areaOrStorage
 * @param {string} key
 * @returns {boolean}
 */
export function safeStorageRemove(areaOrStorage, key) {
  try {
    const storage = resolveStorage(areaOrStorage);
    if (!storage) return false;
    storage.removeItem(key);
    return true;
  } catch { return false; }
}

/**
 * Parsed JSON value, or null when missing/corrupt. The result is unvalidated.
 * @param {StorageTarget} areaOrStorage
 * @param {string} key
 * @returns {import('./types').UntrustedInput}
 */
export function safeStorageJson(areaOrStorage, key) {
  const raw = safeStorageGet(areaOrStorage, key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
