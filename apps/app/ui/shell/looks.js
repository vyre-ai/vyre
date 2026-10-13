// @ts-check
// The shell's looks: the sidebar and the space identity as three complete token sets. Pure data, so Node tests it and the Shell reads one object.
// Every number the rail draws is here and nowhere else. The chosen look becomes the default; the others stay until the owner retires them.

/**
 * @typedef {{
 *   name: string, line: string,
 *   rail: number, inset: number, floating: boolean, translucent: boolean, railRadius: number,
 *   rowH: number, rowGap: number, rowRadius: number, rowPadX: number, iconSize: 16 | 18 | 20, iconChip: number, labelSize: number, labelLine: number, labelWeight: "regular" | "medium" | "strong",
 *   active: "wash" | "fill" | "pill", bar: boolean,
 *   sectionGap: number, section: "plain" | "caps",
 *   tile: number, tileShape: "squircle" | "round", switcher: "plain" | "card" | "bar", person: "plain" | "card" | "bar", personFace: 28 | 32 | 40,
 *   contentPad: number,
 * }} ShellLook
 */

/** @type {Record<"quiet" | "studio" | "glass", ShellLook>} */
export const LOOKS = {
  quiet: {
    name: "Quiet", line: "Flat and airy: one soft surface, light rows, a calm wash for where you are.",
    rail: 248, inset: 16, floating: false, translucent: false, railRadius: 0,
    rowH: 38, rowGap: 2, rowRadius: 10, rowPadX: 12, iconSize: 18, iconChip: 0, labelSize: 15, labelLine: 20, labelWeight: "regular",
    active: "wash", bar: false,
    sectionGap: 24, section: "plain",
    tile: 32, tileShape: "squircle", switcher: "plain", person: "plain", personFace: 32,
    contentPad: 40,
  },
  studio: {
    name: "Studio", line: "A floating panel with icon chips: roomy rows, a solid mark for the current place, cards for space and you.",
    rail: 272, inset: 12, floating: true, translucent: false, railRadius: 20,
    rowH: 42, rowGap: 2, rowRadius: 12, rowPadX: 8, iconSize: 18, iconChip: 30, labelSize: 15, labelLine: 20, labelWeight: "medium",
    active: "fill", bar: false,
    sectionGap: 28, section: "caps",
    tile: 36, tileShape: "squircle", switcher: "card", person: "card", personFace: 32,
    contentPad: 48,
  },
  glass: {
    name: "Glass", line: "Light and rounded: a translucent rail, pill rows, round marks, everything with room to breathe.",
    rail: 256, inset: 12, floating: true, translucent: true, railRadius: 24,
    rowH: 40, rowGap: 4, rowRadius: 999, rowPadX: 16, iconSize: 18, iconChip: 0, labelSize: 15, labelLine: 20, labelWeight: "medium",
    active: "pill", bar: false,
    sectionGap: 24, section: "plain",
    tile: 32, tileShape: "round", switcher: "bar", person: "bar", personFace: 32,
    contentPad: 44,
  },
};

export const LOOK_NAMES = /** @type {("quiet" | "studio" | "glass")[]} */ (Object.keys(LOOKS));
export const DEFAULT_LOOK = "quiet";

/** The look for a name; an unknown name gets the default. @param {unknown} name */
export function lookOf(name) {
  return LOOKS[/** @type {keyof typeof LOOKS} */ (name)] ?? LOOKS[DEFAULT_LOOK];
}
