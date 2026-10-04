// @ts-check
// Which space is showing, and the look each space gives (ui-primitives.md section 2): pure, so Node tests it.
// "all" is not a space with a look of its own: it shows Mine's, as the prototype does.

/** @typedef {{ accent: string, hex?: string, tint: string, thex?: string, density: string, font: string, corners: string }} SpaceLook */

/** @type {Record<string, SpaceLook>} */
export const DEFAULT_LOOKS = {
  mine: { accent: "violet", tint: "accent", density: "default", font: "system", corners: "default" },
  harlow: { accent: "amber", tint: "accent", density: "compact", font: "system", corners: "default" },
};

/** The space whose look applies when `id` is showing. */
export function lookOwner(/** @type {string} */ id) {
  return id === "all" ? "mine" : id;
}

/**
 * The full space theme for the provider. Every key is present (undefined clears), so switching from a space with a custom hex to one
 * without leaves nothing behind.
 * @param {string} id @param {Record<string, SpaceLook>} looks
 * @returns {SpaceLook & { hex: string|undefined, thex: string|undefined }}
 */
export function themeFor(id, looks) {
  const l = looks[lookOwner(id)] ?? DEFAULT_LOOKS.mine;
  return { accent: l.accent, hex: l.hex, tint: l.tint ?? "accent", thex: l.thex, density: l.density, font: l.font, corners: l.corners };
}

/** What the Appearance screen says is showing: "Harlow Legal with accent amber, compact density, Instrument Sans, default corners". */
export function showingLine(/** @type {string} */ name, /** @type {{ accent: string, density: string, font: string, corners: string }} */ r, /** @type {Record<string,string>} */ fontNames, /** @type {boolean} */ own) {
  return `${name} with accent ${r.accent}, ${r.density} density, ${fontNames[r.font] ?? r.font}, ${r.corners} corners${own ? " (some of it is your own override)" : ""}.`;
}
