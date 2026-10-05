// The project emblem (design-system v2, ux-research.md section 5.3): a rounded tile of four cells. Eight bytes of the project's avatar seed choose everything: the
// ground is the first palette colour; each cell holds one of eight shapes in one of four rotations; the cell is filled with the tile's second colour or with
// the ink. About a million looks that read at 24 px, never initials or a face. A draft is the same emblem dashed and unfilled. The shapes are drawn in
// 60-unit cells of a 120-unit canvas, as in team/0.2.2/ux-prototype.html.
import { PROJECT_COLORS } from "./identity.js";

/** @param {number} t shape 0 to 7 @param {number} r rotation 0 to 3 @param {number} x @param {number} y cell origin @param {string} f fill */
function shape(t, r, x, y, f) {
  const cx = x + 30, cy = y + 30, rot = `transform="rotate(${r * 90} ${cx} ${cy})"`;
  switch (t) {
    case 0: return `<circle cx="${cx}" cy="${cy}" r="22" fill="${f}"/>`;
    case 1: return `<path d="M${x + 8} ${y + 52} L${x + 8} ${y + 8} A44 44 0 0 1 ${x + 52} ${y + 52} Z" fill="${f}" ${rot}/>`;
    case 2: return `<path d="M${x + 8} ${cy} A22 22 0 0 1 ${x + 52} ${cy} Z" fill="${f}" ${rot}/>`;
    case 3: return `<rect x="${x + 10}" y="${y + 10}" width="40" height="40" rx="7" fill="${f}"/>`;
    case 4: return `<path d="M${cx} ${y + 6} L${x + 54} ${cy} L${cx} ${y + 54} L${x + 6} ${cy} Z" fill="${f}"/>`;
    case 5: return `<circle cx="${cx}" cy="${cy}" r="18" fill="none" stroke="${f}" stroke-width="9"/>`;
    case 6: return `<path d="M${x + 8} ${y + 52} L${x + 52} ${y + 52} L${x + 8} ${y + 8} Z" fill="${f}" ${rot}/>`;
    default: return `<rect x="${x + 20}" y="${y + 20}" width="20" height="20" rx="10" fill="${f}"/>`;
  }
}

/**
 * @param {ArrayLike<number>} b the project's eight seed bytes (lib/avatar-seed projectBytes)
 * @param {{ draft?: boolean, theme?: "dark" | "paper", size?: number }} [o]
 * @returns {string} SVG source
 */
export function emblem(b, { draft = false, theme = "dark", size = 120 } = {}) {
  const n = PROJECT_COLORS.length;
  const c1 = PROJECT_COLORS[b[0] % n], c2 = PROJECT_COLORS[(b[0] + 2 + (b[1] % (n - 2))) % n];
  const ink = theme === "paper" ? "#F4F1EA" : "#141311";
  const cells = [[0, 0], [60, 0], [0, 60], [60, 60]].map(([x, y], i) => shape(b[2 + i] % 8, (b[2 + i] >> 3) % 4, x, y, (b[6] >> i) & 1 ? c2 : draft ? c1 : ink)).join("");
  const frame = draft
    ? `<rect x="3" y="3" width="114" height="114" rx="30" fill="none" stroke="${c1}" stroke-width="5" stroke-dasharray="9 7"/><g opacity=".55">${cells}</g>`
    : `<g clip-path="url(#em)"><rect width="120" height="120" fill="${c1}"/>${cells}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="${size}" height="${size}"><defs><clipPath id="em"><rect x="2" y="2" width="116" height="116" rx="30"/></clipPath></defs>${frame}</svg>`;
}
