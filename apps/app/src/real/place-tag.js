// @ts-check
// Which tag a thing carries (12 Oct ruling: "Personal - Home", "Personal - Cloud", or the team space's name, on everything). The text is decided by placeTag (src/state/space-name.js) from the space row; this picks the row:
// her own home's (`home`), the space that is showing (`showing`), or a named one (a thing's own space id). Pure: PlaceTag.tsx draws it.

/** @typedef {{ id: string, tag?: string }} Card */

/** @param {Card[]} cards @param {string} of "home", "showing" or a space id @param {string} showing the space showing ("all" when none) @returns {string | null} */
export function tagFor(cards, of, showing) {
  const list = Array.isArray(cards) ? cards : [];
  const card = of === "home" ? list.find((c) => typeof c.tag === "string" && c.tag.startsWith("Personal -"))
    : of === "showing" ? list.find((c) => c.id === showing)
    : list.find((c) => c.id === of);
  return card && card.tag ? card.tag : null;
}

/** The space id an address names (vyre://<space>/<type>/<id>), or "" for anything else. @param {unknown} urn */
export const spaceOfUrn = (urn) => { const m = /^vyre:\/\/(spc_[a-z2-7]{12})\//.exec(String(urn || "")); return m ? m[1] : ""; };
