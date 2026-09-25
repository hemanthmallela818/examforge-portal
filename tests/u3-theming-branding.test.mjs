import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AA_NORMAL_TEXT,
  BRAND_STEPS,
  DARK_SURFACE,
  DEFAULT_BRAND_SCALE,
  brandCssVariables,
  contrastRatio,
  deriveBrandScale,
  describeBrandContrast,
  hexToOklch,
  normalizeHexColor,
  oklchToHex
} from '../src/branding/brandPalette.js';
import { LOGO_PATH_PATTERN, normalizeBranding, normalizeInstitutionName } from '../src/branding/brandingStore.js';
import { logoObjectName, validateLogoFile } from '../src/branding/logoProcessing.js';

test('hex colours are validated and normalised', () => {
  assert.equal(normalizeHexColor('#0F766E'), '#0f766e');
  assert.equal(normalizeHexColor(' 0f766e '), '#0f766e');
  for (const bad of ['#fff', 'red', '#12345g', '', null, 42, '#1234567']) assert.equal(normalizeHexColor(bad), null);
});

test('WCAG contrast matches known values', () => {
  assert.equal(contrastRatio('#000000', '#ffffff'), 21);
  assert.ok(Math.abs(contrastRatio('#2563eb', '#ffffff') - 5.17) < 0.01);
});

test('OKLCH round-trips sRGB colours', () => {
  for (const hex of ['#2563eb', '#0f766e', '#b45309', '#000000', '#ffffff']) {
    assert.equal(oklchToHex(hexToOklch(hex)), hex);
  }
});

test('the brand scale keeps the chosen colour at 600 and is ordered light to dark', () => {
  for (const color of ['#2563eb', '#0f766e', '#7f1d1d', '#9333ea', '#facc15']) {
    const scale = deriveBrandScale(color);
    assert.deepEqual(Object.keys(scale).map(Number).sort((a, b) => a - b), [...BRAND_STEPS]);
    assert.equal(scale[600], color);
    const lightness = BRAND_STEPS.map(step => hexToOklch(scale[step]).l);
    for (let i = 1; i < lightness.length; i += 1) {
      assert.ok(lightness[i] <= lightness[i - 1] + 1e-6, `${color}: brand-${BRAND_STEPS[i]} is not darker than brand-${BRAND_STEPS[i - 1]}`);
    }
    // Dark-theme accents (brand-300 text on the dark surface) stay readable.
    assert.ok(contrastRatio(scale[300], DARK_SURFACE) >= AA_NORMAL_TEXT, `${color} dark accent`);
  }
});

test('unset or invalid colours fall back to the default blue', () => {
  assert.deepEqual(deriveBrandScale(null), { ...DEFAULT_BRAND_SCALE });
  assert.deepEqual(deriveBrandScale('nope'), { ...DEFAULT_BRAND_SCALE });
  assert.deepEqual(brandCssVariables(null), {});
  assert.equal(brandCssVariables('#0f766e')['--brand-600'], '#0f766e');
  assert.equal(describeBrandContrast(null).passesAA, true);
  assert.equal(describeBrandContrast('#facc15').passesAA, false);
});

test('cached/public branding is re-validated', () => {
  assert.equal(normalizeInstitutionName('  Sunrise \n  School '), 'Sunrise School');
  assert.equal(normalizeInstitutionName('x'.repeat(81)), null);
  assert.equal(normalizeInstitutionName('   '), null);
  const branding = normalizeBranding({
    institution_name: 'A',
    primary_color: 'javascript:alert(1)',
    logo_path: '../../etc/passwd',
    logoUrl: 'javascript:alert(1)'
  });
  assert.deepEqual(branding, { institutionName: 'A', primaryColor: null, logoPath: null, logoUrl: null, updatedAt: null });
  const withLogo = normalizeBranding({
    logoPath: 'logo-0f8fad5b-d9cb-469f-a165-70867728950e.png',
    logoUrl: 'https://project.supabase.co/storage/v1/object/public/branding/logo-0f8fad5b-d9cb-469f-a165-70867728950e.png'
  });
  assert.ok(withLogo.logoUrl.startsWith('https://'));
  assert.ok(LOGO_PATH_PATTERN.test(logoObjectName('webp', '0F8FAD5B-D9CB-469F-A165-70867728950E')));
});

test('logos: SVG and files over 1 MB are rejected before decoding', async () => {
  const svg = await validateLogoFile({ name: 'logo.svg', type: 'image/svg+xml', size: 100 });
  assert.equal(svg.valid, false);
  assert.match(svg.error, /SVG/);
  const big = await validateLogoFile({ name: 'logo.png', type: 'image/png', size: 2 * 1024 * 1024 });
  assert.match(big.error, /limit is 1 MB/);
});

test('the dark theme is variable-driven, CSP-safe and applied before render', () => {
  const css = readFileSync(resolve('src/index.css'), 'utf8');
  const main = readFileSync(resolve('src/main.jsx'), 'utf8');
  const html = readFileSync(resolve('index.html'), 'utf8');
  assert.match(css, /@custom-variant dark \(&:where\(\.dark, \.dark \*\)\);/);
  assert.match(css, /--color-brand-600: var\(--brand-600\);/);
  assert.match(css, /\.dark \{[^}]*--color-white: var\(--theme-surface\);/);
  assert.match(css, /\.dark \{[^}]*--color-slate-50: #0b1120;/);
  assert.match(css, /\.dark \.theme-island \{/);
  assert.match(css, /@media \(prefers-color-scheme: dark\)/);
  assert.match(main, /initTheme\(\)\s*\ninitBrandingFromCache\(\)/);
  assert.ok(main.indexOf('initTheme()') < main.indexOf("import('./App.jsx')"));
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, 'no inline scripts');
});

test('the branding migration exposes only public fields to anon and audits root changes', () => {
  const sql = readFileSync(resolve('supabase/migrations/20260926110000_institution_branding.sql'), 'utf8');
  assert.match(sql, /REVOKE ALL ON public\.institution_branding FROM PUBLIC, anon, authenticated;/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.get_public_branding\(\) TO anon, authenticated, service_role;/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.root_update_branding\(text, text, text\) FROM PUBLIC, anon;/);
  assert.match(sql, /IF NOT public\.is_root_developer\(\) THEN/);
  assert.match(sql, /'UPDATE_BRANDING'/);
  assert.match(sql, /VALUES \('branding', 'branding', true, 1048576, ARRAY\['image\/png', 'image\/webp'\]\)/);
});
