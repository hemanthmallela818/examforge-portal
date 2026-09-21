const PLACEHOLDER_PATTERN = /YOUR_|example|replace[-_ ]?me/i;

export const validateRuntimeConfiguration = (supabaseUrl, anonKey) => {
  const errors = [];
  let parsedUrl = null;
  try {
    parsedUrl = new URL(String(supabaseUrl || ''));
  } catch {
    errors.push('The Supabase URL is missing or invalid.');
  }

  if (parsedUrl) {
    const localHost = ['localhost', '127.0.0.1', '::1', 'host.docker.internal'].includes(parsedUrl.hostname);
    if (parsedUrl.protocol !== 'https:' && !(localHost && parsedUrl.protocol === 'http:')) {
      errors.push('The Supabase URL must use HTTPS outside local development.');
    }
    if (PLACEHOLDER_PATTERN.test(parsedUrl.href)) errors.push('The Supabase URL still contains a placeholder.');
  }

  const key = String(anonKey || '');
  if (key.length < 20 || /\s/.test(key) || PLACEHOLDER_PATTERN.test(key)) {
    errors.push('The public Supabase key is missing or invalid.');
  }

  return { valid: errors.length === 0, errors };
};

export const SUPPORTED_ENVIRONMENTS = Object.freeze({
  desktop: [
    { browser: 'Google Chrome', minVersion: '90+' },
    { browser: 'Microsoft Edge', minVersion: '90+' },
    { browser: 'Mozilla Firefox', minVersion: '90+' },
    { browser: 'Apple Safari', minVersion: '15+' }
  ],
  mobile: [
    { browser: 'Chrome for Android', minVersion: '90+' },
    { browser: 'Safari for iOS/iPadOS', minVersion: '15+' },
    { browser: 'Samsung Internet', minVersion: '15+' }
  ],
  operatingSystems: [
    'Windows 10 / 11',
    'macOS 12 (Monterey) or later',
    'Ubuntu 20.04+ / Linux Desktop',
    'Android 10 or later',
    'iOS / iPadOS 15 or later'
  ]
});

export const checkBrowserCompatibility = (env = (typeof window !== 'undefined' ? window : {})) => {
  const missingFeatures = [];
  const storageProbe = (storage, label) => {
    if (!storage || typeof storage.setItem !== 'function' || typeof storage.getItem !== 'function' || typeof storage.removeItem !== 'function') {
      missingFeatures.push(`${label} (Offline Recovery Storage)`);
      return;
    }
    const probeKey = `__cbt_storage_probe_${label.toLowerCase()}__`;
    try {
      storage.setItem(probeKey, 'ok');
      if (storage.getItem(probeKey) !== 'ok') throw new Error('storage read-back failed');
      storage.removeItem(probeKey);
    } catch {
      try { storage.removeItem(probeKey); } catch {}
      missingFeatures.push(`${label} is blocked, full, or unavailable`);
    }
  };

  if (typeof env.crypto?.randomUUID !== 'function') {
    missingFeatures.push('crypto.randomUUID (Secure Unique Identifiers)');
  }
  storageProbe(env.localStorage, 'localStorage');
  storageProbe(env.sessionStorage, 'sessionStorage');
  if (typeof env.fetch !== 'function') {
    missingFeatures.push('fetch (HTTP Communications)');
  }
  const PromiseImpl = env.Promise || globalThis.Promise;
  if (typeof PromiseImpl?.allSettled !== 'function') {
    missingFeatures.push('Promise.allSettled (Concurrent Operations)');
  }
  if (typeof env.Intl === 'undefined') {
    missingFeatures.push('Intl (Internationalization and Number Formatting)');
  }

  return {
    compatible: missingFeatures.length === 0,
    missingFeatures,
    supportedEnvironments: SUPPORTED_ENVIRONMENTS
  };
};

export const isNarrowViewport = (width = (typeof window !== 'undefined' ? window.innerWidth : 1024)) => {
  return typeof width === 'number' && width < 768;
};
