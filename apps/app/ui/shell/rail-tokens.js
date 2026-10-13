// @ts-check
// The sidebar's numbers (the Quiet look, picked by the owner): one object, so nothing in the rail or its panels carries a size of its own.

export const RAIL = Object.freeze({
  width: 248, inset: 16,
  rowH: 38, rowGap: 2, rowRadius: 10, rowPadX: 12, iconSize: /** @type {18} */ (18), labelSize: 15, labelLine: 20,
  sectionGap: 24, sectionLabelSize: 12,
  tile: /** @type {32} */ (32), face: /** @type {32} */ (32),
  /** The folded rail: a 40 square target centred in the column. */
  foldedRow: 40,
  /** How far the page keeps from the rail and the edge, and how wide a reading column grows (the "squished" fix, see tokens layout). */
  contentPad: 40,
  /** The slide between the main sidebar and a panel, in ms. */
  slideMs: 180,
});
