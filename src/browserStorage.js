function resolveStorage(areaOrStorage) {
  if (areaOrStorage && typeof areaOrStorage !== 'string') return areaOrStorage;
  try {
    return globalThis[areaOrStorage || 'localStorage'] || null;
  } catch {
    return null;
  }
}

export function safeStorageGet(areaOrStorage, key) {
  try { return resolveStorage(areaOrStorage)?.getItem(key) ?? null; } catch { return null; }
}

export function safeStorageSet(areaOrStorage, key, value) {
  try {
    const storage = resolveStorage(areaOrStorage);
    if (!storage) return false;
    storage.setItem(key, String(value));
    return true;
  } catch { return false; }
}

export function safeStorageRemove(areaOrStorage, key) {
  try {
    const storage = resolveStorage(areaOrStorage);
    if (!storage) return false;
    storage.removeItem(key);
    return true;
  } catch { return false; }
}

export function safeStorageJson(areaOrStorage, key) {
  const raw = safeStorageGet(areaOrStorage, key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
