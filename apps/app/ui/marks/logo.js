// @ts-check
// A space's own logo: what a file may be, how it is cropped to a square, and what is kept. Pure, so Node tests it; the picture work (a canvas) is in components/LogoPicker.

export const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const LOGO_MAX_BYTES = 5_000_000;
/** The kept logo is this many pixels square (shown at up to 56, so 2x of the largest). */
export const LOGO_PX = 128;
/** A kept logo's data address stays under this many characters (about 90 KB of image). */
export const LOGO_MAX_CHARS = 120_000;

/** Why a file cannot be a logo, or null when it can. @param {{ type: string, size: number }} f */
export function checkLogoFile(f) {
  if (!LOGO_TYPES.includes(f.type)) return "Use a PNG, JPEG or WebP image.";
  if (!(f.size > 0)) return "That file is empty.";
  if (f.size > LOGO_MAX_BYTES) return "Use an image under 5 MB.";
  return null;
}

/** The biggest centred square of a w by h image, and the size it is drawn at. @param {number} w @param {number} h */
export function coverSquare(w, h) {
  if (!(w > 0) || !(h > 0)) return null;
  const side = Math.min(w, h);
  return { sx: Math.round((w - side) / 2), sy: Math.round((h - side) / 2), side, out: LOGO_PX };
}

/** A logo as it may be kept and drawn: a small raster image data address; anything else is null. @param {unknown} v @returns {string | null} */
export function keepableLogo(v) {
  return typeof v === "string" && v.length <= LOGO_MAX_CHARS && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(v) ? v : null;
}
