// @ts-check
// The square kept from a profile photo before encodePhoto draws it again. The crop is the centre of the picture, on the short side, so a wide or tall
// photo becomes a square with no extra step. The encoder then scales that square to at most 512 pixels and never enlarges a smaller one.

/**
 * The centre square of a picture, in the picture's own pixels. A side under 1 is treated as 1. Fractions are floored, so an odd width stays inside the picture.
 * @param {number} w @param {number} h
 * @returns {{ originX: number, originY: number, width: number, height: number }}
 */
export function centreCrop(w, h) {
  const width = Math.max(1, Math.floor(Number(w) || 0));
  const height = Math.max(1, Math.floor(Number(h) || 0));
  const side = Math.min(width, height);
  return { originX: Math.floor((width - side) / 2), originY: Math.floor((height - side) / 2), width: side, height: side };
}
