// @ts-check
// The Apps grid: how many equal tiles fit a row, and how wide each is. Three across on a wide page, two on a tablet, one on a phone; the width is the grid's own, so the sidebar is already out of it.

/** Columns for a grid `width` px wide: 3 from 720, 2 from 460, else 1 (and 1 before the width is known). @param {number} width */
export const columnsFor = (width) => (width >= 720 ? 3 : width >= 460 ? 2 : 1);

/** One tile's width in px for `cols` columns and a `gap`, rounded down so a row never wraps early; "100%" before the width is known. @param {number} width @param {number} cols @param {number} gap @returns {number | string} */
export const tileWidth = (width, cols, gap) => (width > 0 ? Math.floor((width - gap * (cols - 1)) / cols) : "100%");
