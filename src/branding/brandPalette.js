// Institution brand colour maths (U3). Pure functions only: colour parsing,
// WCAG contrast, and derivation of the brand-50…950 scale that drives the
// Tailwind `brand-*` utilities. The chosen colour becomes brand-600 (primary
// buttons, links); the lighter and darker steps are generated in OKLCH so the
// scale keeps the chosen hue at perceptually even lightness steps.

/** Default brand colour (Tailwind blue-600) used when branding is unset or invalid. */
export const DEFAULT_BRAND_COLOR = '#2563eb';

/** Surface colours the contrast checks are measured against. */
export const LIGHT_SURFACE = '#ffffff';
export const DARK_SURFACE = '#131c2e';

/** @type {readonly number[]} */
export const BRAND_STEPS = Object.freeze([50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]);

/** The stylesheet's default brand scale (src/index.css :root --brand-*). */
export const DEFAULT_BRAND_SCALE = Object.freeze(/** @type {Record<number, string>} */ ({
  50: '#eff6ff', 100: '#dbeafe', 200: '#bfdbfe', 300: '#93c5fd', 400: '#60a5fa', 500: '#3b82f6',
  600: '#2563eb', 700: '#1d4ed8', 800: '#1e40af', 900: '#1e3a8a', 950: '#172554'
}));

const HEX_PATTERN = /^#?([0-9a-f]{6})$/i;

/**
 * Returns the colour as lowercase `#rrggbb`, or null when it is not a 6-digit hex colour.
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeHexColor(value) {
  if (typeof value !== 'string') return null;
  const match = HEX_PATTERN.exec(value.trim());
  return match ? `#${match[1].toLowerCase()}` : null;
}

/**
 * @param {string} hex `#rrggbb`
 * @returns {[number, number, number]} sRGB channels 0…255
 */
export function hexToRgb(hex) {
  const value = /** @type {string} */ (normalizeHexColor(hex));
  if (!value) throw new TypeError(`Invalid hex colour: ${hex}`);
  return /** @type {[number, number, number]} */ ([0, 2, 4].map(offset => parseInt(value.slice(1 + offset, 3 + offset), 16)));
}

/**
 * @param {number[]} rgb sRGB channels 0…255 (clamped and rounded)
 * @returns {string}
 */
export function rgbToHex(rgb) {
  return `#${rgb.map(channel => Math.round(Math.min(255, Math.max(0, channel))).toString(16).padStart(2, '0')).join('')}`;
}

/** @param {number} channel 0…255 */
const toLinear = (channel) => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** @param {number} linear */
const fromLinear = (linear) => {
  const c = linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
  return c * 255;
};

/**
 * WCAG 2.x relative luminance.
 * @param {string} hex
 */
export function relativeLuminance(hex) {
  const [r, g, b] = hexToRgb(hex).map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * WCAG 2.x contrast ratio between two colours (1…21).
 * @param {string} a
 * @param {string} b
 */
export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * @param {string} hex
 * @returns {{ l: number, c: number, h: number }} OKLCH (l 0…1, c ≥ 0, h degrees)
 */
export function hexToOklch(hex) {
  const [r, g, b] = hexToRgb(hex).map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const c = Math.hypot(A, B);
  const h = ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
  return { l: L, c, h };
}

/**
 * @param {{ l: number, c: number, h: number }} color
 * @returns {number[] | null} linear sRGB, or null when outside the sRGB gamut
 */
function oklchToLinearRgb({ l: L, c, h }) {
  const rad = (h * Math.PI) / 180;
  const A = c * Math.cos(rad);
  const B = c * Math.sin(rad);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  ];
  return rgb.every(channel => channel >= -0.0005 && channel <= 1.0005) ? rgb : null;
}

/**
 * OKLCH → hex, reducing chroma until the colour fits the sRGB gamut.
 * @param {{ l: number, c: number, h: number }} color
 */
export function oklchToHex({ l, c, h }) {
  const lightness = Math.min(1, Math.max(0, l));
  let chroma = Math.max(0, c);
  for (let i = 0; i < 40; i += 1) {
    const linear = oklchToLinearRgb({ l: lightness, c: chroma, h });
    if (linear) return rgbToHex(linear.map(channel => fromLinear(Math.min(1, Math.max(0, channel)))));
    chroma *= 0.9;
  }
  return rgbToHex(/** @type {number[]} */ (oklchToLinearRgb({ l: lightness, c: 0, h })).map(fromLinear));
}

// Lighter steps interpolate from the chosen lightness towards near-white,
// darker steps towards near-black. Chroma factors follow Tailwind's blue ramp.
const LIGHT_STEPS = /** @type {const} */ ({ 50: 0.93, 100: 0.84, 200: 0.7, 300: 0.5, 400: 0.3, 500: 0.12 });
// Minimum lightness of the lighter steps, so a very dark brand colour still
// yields readable dark-theme accents (brand-300 text) and visible tints.
const LIGHT_FLOOR = /** @type {Record<number, number>} */ ({ 50: 0.96, 100: 0.92, 200: 0.86, 300: 0.78, 400: 0.68, 500: 0.58 });
const DARK_STEPS = /** @type {const} */ ({ 700: 0.16, 800: 0.32, 900: 0.45, 950: 0.68 });
const CHROMA = /** @type {Record<number, number>} */ ({ 50: 0.06, 100: 0.13, 200: 0.24, 300: 0.4, 400: 0.67, 500: 0.87, 700: 0.99, 800: 0.81, 900: 0.6, 950: 0.37 });
const DARK_MIN_CONTRAST = /** @type {Record<number, number>} */ ({ 700: 7, 800: 9, 900: 11, 950: 14 });
const LIGHT_TARGET = 0.98;
const DARK_TARGET = 0.18;

/**
 * Derives the brand-50…950 scale from one colour; brand-600 is the colour itself.
 * @param {unknown} color Any value; invalid colours fall back to DEFAULT_BRAND_COLOR.
 * @returns {Record<number, string>}
 */
export function deriveBrandScale(color) {
  const base = normalizeHexColor(color);
  if (!base) return { ...DEFAULT_BRAND_SCALE };
  const { l, c, h } = hexToOklch(base);
  /** @type {Record<number, string>} */
  const scale = { 600: base };
  for (const [step, fraction] of Object.entries(LIGHT_STEPS)) {
    const lightness = Math.max(l + (LIGHT_TARGET - l) * fraction, LIGHT_FLOOR[Number(step)]);
    scale[Number(step)] = oklchToHex({ l: lightness, c: c * CHROMA[Number(step)], h });
  }
  const darkTarget = Math.min(DARK_TARGET, l * 0.4);
  for (const [step, fraction] of Object.entries(DARK_STEPS)) {
    let lightness = l - (l - darkTarget) * fraction;
    const chroma = c * CHROMA[Number(step)];
    // Dark steps carry white text and light brand-100 labels (the exam header
    // is brand-700), so keep a minimum contrast with white.
    while (lightness > 0.05 && contrastRatio('#ffffff', oklchToHex({ l: lightness, c: chroma, h })) < DARK_MIN_CONTRAST[Number(step)]) {
      lightness -= 0.01;
    }
    scale[Number(step)] = oklchToHex({ l: lightness, c: chroma, h });
  }
  return scale;
}

/**
 * CSS custom properties for a brand colour (`--brand-50` … `--brand-950`), or
 * an empty object when the colour is unset/invalid so the stylesheet defaults apply.
 * @param {unknown} color
 * @returns {Record<string, string>}
 */
export function brandCssVariables(color) {
  if (!normalizeHexColor(color)) return {};
  const scale = deriveBrandScale(color);
  return Object.fromEntries(BRAND_STEPS.map(step => [`--brand-${step}`, scale[step]]));
}

/** WCAG AA thresholds. */
export const AA_NORMAL_TEXT = 4.5;
export const AA_NON_TEXT = 3;

/**
 * Contrast report for the Branding settings form.
 * - `onButton`: white button text on the colour (brand-600 buttons, both themes).
 * - `asLightText`: the colour as link/accent text on a white surface.
 * - `asDarkText`: the dark-theme accent (brand-300) on the dark surface.
 * @param {unknown} color
 */
export function describeBrandContrast(color) {
  const base = normalizeHexColor(color) || DEFAULT_BRAND_COLOR;
  const scale = deriveBrandScale(color);
  const onButton = contrastRatio('#ffffff', base);
  const asLightText = contrastRatio(base, LIGHT_SURFACE);
  const asDarkText = contrastRatio(scale[300], DARK_SURFACE);
  return {
    color: base,
    onButton,
    asLightText,
    asDarkText,
    passesAA: onButton >= AA_NORMAL_TEXT && asLightText >= AA_NORMAL_TEXT && asDarkText >= AA_NORMAL_TEXT
  };
}
