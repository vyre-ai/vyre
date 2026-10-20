// @ts-check
// The sidebar's numbers (the Quiet look, picked by the owner): one object, so nothing in the rail or its panels carries a size of its own.

export const RAIL = Object.freeze({
  /** The left sidebar, the same in every section: default, least and most width. */
  width: 300, minWidth: 180, maxWidth: 420,
  /** The one left gutter every edge of content aligns to (the space mark, the search, the row faces, the section labels, the foot's face); rows are inset half of it and pad the other half. */
  gutter: 16, rowInset: 8,
  topH: 56, footH: 56, searchH: 36,
  /** A nav row, and a chat row. */
  navRowH: 36, chatRowH: 56, rowGap: 2, rowRadius: 8, iconSize: /** @type {18} */ (18), iconGap: 12, labelSize: 14, labelLine: 20, subSize: 13, subLine: 18,
  sectionGap: 24, sectionLabelSize: 12, sectionLabelAbove: 20,
  tile: /** @type {24} */ (24), face: /** @type {28} */ (28), chatFace: /** @type {32} */ (32),
  /** The folded rail: a 40 square target centred in the column. */
  foldedRow: 40,
  /** How far the page keeps from the rail and the edge, and how wide a reading column grows (the "squished" fix, see tokens layout). */
  contentPad: 40,
  /** The slide between the main sidebar and a panel, in ms. */
  slideMs: 180,
  /** Hover, selection and resize ease. */
  easeMs: 150,
  /** The chat's right panel: default, least and most width. */
  panelWidth: 360, panelMin: 300, panelMax: 520,
});
