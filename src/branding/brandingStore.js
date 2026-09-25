// Institution branding (U3): name, primary colour and logo shown on the login
// page, admin sidebar, student dashboard and exam header.
//
// The public values come from the get_public_branding() RPC (callable before
// sign-in). They are cached in sessionStorage and applied in main.jsx before
// React renders, so a reload does not flash the default colours. Every value
// is re-validated here because the cache is browser-controlled.
import { useSyncExternalStore } from 'react';
import { safeStorageJson, safeStorageRemove, safeStorageSet } from '../browserStorage.js';
import { brandCssVariables, BRAND_STEPS, normalizeHexColor } from './brandPalette.js';

export const BRANDING_CACHE_KEY = 'examforge.branding.v1';
export const BRANDING_BUCKET = 'branding';
export const DEFAULT_INSTITUTION_NAME = 'ExamForge';
export const MAX_INSTITUTION_NAME_LENGTH = 80;
/** Object names the root_update_branding() RPC accepts. */
export const LOGO_PATH_PATTERN = /^logo-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|webp)$/;

/**
 * @typedef {{
 *   institutionName: string | null,
 *   primaryColor: string | null,
 *   logoPath: string | null,
 *   logoUrl: string | null,
 *   updatedAt: string | null
 * }} Branding
 */

/** @type {Readonly<Branding>} */
export const DEFAULT_BRANDING = Object.freeze({
  institutionName: null,
  primaryColor: null,
  logoPath: null,
  logoUrl: null,
  updatedAt: null
});

/**
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeInstitutionName(value) {
  if (typeof value !== 'string') return null;
  // Collapse whitespace and drop control characters.
  const name = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return name.length >= 1 && name.length <= MAX_INSTITUTION_NAME_LENGTH ? name : null;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
const normalizeLogoUrl = (value) => {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
};

/**
 * Validates branding from the RPC (snake_case) or the cache (camelCase).
 * @param {unknown} raw
 * @returns {Branding}
 */
export function normalizeBranding(raw) {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_BRANDING };
  const source = /** @type {Record<string, unknown>} */ (raw);
  const logoPath = typeof (source.logoPath ?? source.logo_path) === 'string' && LOGO_PATH_PATTERN.test(/** @type {string} */ (source.logoPath ?? source.logo_path))
    ? /** @type {string} */ (source.logoPath ?? source.logo_path)
    : null;
  const updatedAt = source.updatedAt ?? source.updated_at;
  return {
    institutionName: normalizeInstitutionName(source.institutionName ?? source.institution_name),
    primaryColor: normalizeHexColor(source.primaryColor ?? source.primary_color),
    logoPath,
    logoUrl: logoPath ? normalizeLogoUrl(source.logoUrl ?? source.logo_url) : null,
    updatedAt: typeof updatedAt === 'string' && updatedAt.length <= 64 ? updatedAt : null
  };
}

/**
 * Sets (or clears) the brand colour variables on <html>.
 * @param {Pick<Branding, 'primaryColor'>} branding
 * @param {Document | undefined} [doc]
 */
export function applyBrandingToDocument(branding, doc = typeof document !== 'undefined' ? document : undefined) {
  const root = doc?.documentElement;
  if (!root) return;
  const variables = brandCssVariables(branding.primaryColor);
  for (const step of BRAND_STEPS) {
    const name = `--brand-${step}`;
    if (variables[name]) root.style.setProperty(name, variables[name]);
    else root.style.removeProperty(name);
  }
}

/** @type {Branding} */
let current = { ...DEFAULT_BRANDING };
const listeners = new Set();

/** @param {Branding} next */
const publish = (next) => {
  current = next;
  applyBrandingToDocument(next);
  listeners.forEach(listener => listener());
};

/** Applies the cached branding (called in main.jsx before the first render). */
export function initBrandingFromCache() {
  publish(normalizeBranding(safeStorageJson('sessionStorage', BRANDING_CACHE_KEY)));
}

/**
 * Stores and applies branding (e.g. right after the root developer saves it).
 * @param {unknown} raw
 */
export function setBranding(raw) {
  const next = normalizeBranding(raw);
  safeStorageSet('sessionStorage', BRANDING_CACHE_KEY, JSON.stringify(next));
  publish(next);
  return next;
}

/**
 * Public URL of a logo in the public `branding` bucket (cache-busted by the update time).
 * @param {{ storage: { from: (bucket: string) => { getPublicUrl: (path: string) => { data: { publicUrl: string } } } } }} client
 * @param {string | null} logoPath
 * @param {string | null} [updatedAt]
 */
export function brandingLogoUrl(client, logoPath, updatedAt = null) {
  if (!logoPath) return null;
  const url = client.storage.from(BRANDING_BUCKET).getPublicUrl(logoPath)?.data?.publicUrl;
  if (!url) return null;
  return updatedAt ? `${url}?v=${encodeURIComponent(updatedAt)}` : url;
}

/**
 * Loads the public branding from the server. On failure the cached/current
 * branding stays in place (the defaults when nothing was cached).
 * @returns {Promise<Branding>}
 */
export async function refreshBranding() {
  try {
    const { supabase } = await import('../supabase.js');
    const response = await supabase.rpc('get_public_branding');
    if (!response || response.error) return current;
    const row = Array.isArray(response.data) ? response.data[0] : response.data;
    if (!row) {
      safeStorageRemove('sessionStorage', BRANDING_CACHE_KEY);
      publish({ ...DEFAULT_BRANDING });
      return current;
    }
    const base = normalizeBranding(row);
    return setBranding({ ...base, logoUrl: brandingLogoUrl(supabase, base.logoPath, base.updatedAt) });
  } catch {
    return current;
  }
}

/** @param {() => void} listener */
const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const getSnapshot = () => current;

/**
 * Current branding plus the display name (institution name or "ExamForge").
 * @returns {Branding & { displayName: string, isCustom: boolean }}
 */
export function useBranding() {
  const branding = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    ...branding,
    displayName: branding.institutionName || DEFAULT_INSTITUTION_NAME,
    isCustom: Boolean(branding.institutionName || branding.primaryColor || branding.logoPath)
  };
}
