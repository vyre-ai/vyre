// How a list row's accessory is drawn. A quiet list (the settings density) says it as plain text; a state that needs the person (accent, warn or err) stays a chip so it is not missed. Every other list draws a chip.
/** @param {boolean} tight a tight list @param {string | undefined} tone the row's tone */
export const accessoryAsChip = (tight, tone) => !tight || tone === "accent" || tone === "warn" || tone === "err";

/**
 * What a list row draws beyond its title: faces (people and assistants), provider marks, several accessories (a chip, or quiet text) and whether it is dim. The language checks these (lib/views/blocks.js);
 * this reads them for the drawing and treats anything of the wrong shape as absent.
 * @param {any} x a row @returns {{ faces: { kind: string, name: string }[], providers: string[], accessories: { label: string, tone?: string, as: "chip" | "text" }[], dim: boolean, any: boolean }}
 */
export function rowExtras(x) {
  const faces = Array.isArray(x && x.faces) ? x.faces.filter((/** @type {any} */ f) => f && typeof f.name === "string" && (f.kind === "person" || f.kind === "assistant")) : [];
  const providers = Array.isArray(x && x.providers) ? x.providers.filter((/** @type {any} */ p) => typeof p === "string" && p) : [];
  const accessories = Array.isArray(x && x.accessories) ? x.accessories.filter((/** @type {any} */ a) => a && typeof a.label === "string" && a.label).map((/** @type {any} */ a) => ({ label: a.label, ...(typeof a.tone === "string" ? { tone: a.tone } : {}), as: /** @type {"chip" | "text"} */ (a.as === "text" ? "text" : "chip") })) : [];
  const dim = Boolean(x && x.dim === true);
  return { faces, providers, accessories, dim, any: Boolean(faces.length || providers.length || accessories.length) };
}
