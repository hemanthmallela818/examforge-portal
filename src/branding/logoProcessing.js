// Institution logo checks and re-encoding (U3).
//
// The logo is shown to anonymous visitors, so it is never stored as uploaded:
// SVG is rejected (script risk), raster files go through the shared image
// validation (declared type, magic bytes, decoded dimensions), and the pixels
// are re-drawn on a canvas and saved as a fresh PNG (WebP when the PNG would
// exceed the limit). Re-encoding drops metadata and any appended payload.
import { validateImageUpload } from '../imageValidation.js';

export const MAX_LOGO_BYTES = 1024 * 1024; // 1 MB, matches the branding bucket limit
export const LOGO_MAX_DIMENSION = 512;
export const LOGO_ACCEPT = 'image/png,image/jpeg,image/webp';

/**
 * @param {File | null | undefined} file
 * @returns {Promise<{ valid: true, width: number, height: number } | { valid: false, error: string }>}
 */
export async function validateLogoFile(file) {
  if (!file) return { valid: false, error: 'Choose a logo file.' };
  if (file.type === 'image/svg+xml' || /\.svg$/i.test(file.name || '')) {
    return { valid: false, error: 'SVG logos are not accepted. Upload a PNG, JPEG or WebP image.' };
  }
  if (file.size > MAX_LOGO_BYTES) {
    return { valid: false, error: `The logo is ${(file.size / (1024 * 1024)).toFixed(1)} MB. The limit is 1 MB.` };
  }
  const result = await validateImageUpload(file);
  if (!result.valid) return { valid: false, error: result.error || 'The logo could not be read.' };
  return { valid: true, width: result.dimensions?.width || 0, height: result.dimensions?.height || 0 };
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {string} type
 * @param {number} [quality]
 * @returns {Promise<Blob | null>}
 */
const canvasToBlob = (canvas, type, quality) => new Promise(resolve => canvas.toBlob(resolve, type, quality));

/**
 * Re-draws the logo (scaled to fit LOGO_MAX_DIMENSION) and encodes it as PNG,
 * falling back to WebP when the PNG is larger than 1 MB.
 * @param {File} file A file that passed validateLogoFile().
 * @returns {Promise<{ blob: Blob, type: 'image/png' | 'image/webp', extension: 'png' | 'webp' }>}
 */
export async function reencodeLogo(file) {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, LOGO_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser cannot process images.');
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    const png = await canvasToBlob(canvas, 'image/png');
    if (png && png.size <= MAX_LOGO_BYTES) return { blob: png, type: 'image/png', extension: 'png' };
    const webp = await canvasToBlob(canvas, 'image/webp', 0.9);
    if (webp && webp.type === 'image/webp' && webp.size <= MAX_LOGO_BYTES) return { blob: webp, type: 'image/webp', extension: 'webp' };
    throw new Error('The logo is still larger than 1 MB after compression. Use a smaller image.');
  } finally {
    bitmap.close?.();
  }
}

/**
 * Object name accepted by the branding bucket policy and root_update_branding().
 * @param {'png' | 'webp'} extension
 * @param {string} [id]
 */
export function logoObjectName(extension, id = crypto.randomUUID()) {
  return `logo-${id.toLowerCase()}.${extension}`;
}
