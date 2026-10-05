// @ts-check
// What this device keeps of the look so it survives a restart: the person's own settings (density, font, reduced motion, larger text) and each space's look (accent, row tint, density, font, corners). Pure: it only
// shapes and checks the text that is kept, so Node tests it. The theme (dark, paper, system) is the settings hub's `appearance.scheme`, kept on the box.

export const KEY = "vyre.appearance";
const DENSITY = ["compact", "default", "comfortable"];
const FONT = ["system", "serif", "sans"];
const CORNERS = ["sharp", "default", "round"];
const ACCENT = ["violet", "amber", "sky", "sage", "rose", "custom"];
const HEX = /^#[0-9a-fA-F]{6}$/;
const pick = (/** @type {any} */ v, /** @type {string[]} */ list) => (typeof v === "string" && list.includes(v) ? v : undefined);

/** @param {any} p the person's settings in force */
export function cleanPerson(p) {
  /** @type {Record<string, any>} */ const out = {};
  const d = pick(p?.density, DENSITY); if (d) out.density = d;
  const f = pick(p?.font, FONT); if (f) out.font = f;
  if (p?.reducedMotion === true) out.reducedMotion = true;
  if (p?.largerText === true) out.largerText = true;
  return out;
}

/** @param {any} l one space's look */
export function cleanLook(l) {
  /** @type {Record<string, any>} */ const out = {};
  const a = pick(l?.accent, ACCENT); if (a) out.accent = a;
  if (typeof l?.hex === "string" && HEX.test(l.hex)) out.hex = l.hex;
  const t = pick(l?.tint, ACCENT.filter((x) => x !== "custom").concat("accent")); if (t) out.tint = t;
  if (typeof l?.thex === "string" && HEX.test(l.thex)) out.thex = l.thex;
  const d = pick(l?.density, DENSITY); if (d) out.density = d;
  const f = pick(l?.font, FONT); if (f) out.font = f;
  const c = pick(l?.corners, CORNERS); if (c) out.corners = c;
  return out;
}

/** Only the looks a person changed: the sample space's and any look still at its default are not kept. @param {Record<string, any>} looks @param {Record<string, any>} [defaults] */
export function changedLooks(looks, defaults = DEFAULTS) {
  /** @type {Record<string, any>} */ const out = {};
  for (const [id, l] of Object.entries(looks ?? {})) {
    const d = defaults[id];
    if (d === null) continue;
    if (d && JSON.stringify(cleanLook(l)) === JSON.stringify(cleanLook(d))) continue;
    out[id] = l;
  }
  return out;
}

/** The looks a space starts with (screens/shell/spaces.js DEFAULT_LOOKS): "mine" as it is, the sample space not at all. */
export const DEFAULTS = { mine: { accent: "violet", tint: "accent", density: "default", font: "system", corners: "default" }, harlow: null };

/** The text to keep. @param {{ person: any, looks: Record<string, any> }} s */
export function pack(s) {
  /** @type {Record<string, any>} */ const looks = {};
  for (const [id, l] of Object.entries(s.looks ?? {})) { if (/^[A-Za-z0-9_.:-]{1,80}$/.test(id)) { const c = cleanLook(l); if (Object.keys(c).length) looks[id] = c; } }
  return JSON.stringify({ v: 1, person: cleanPerson(s.person), looks });
}

/** What was kept, checked again: anything unreadable or from another version is nothing. @param {string | null | undefined} raw @returns {{ person: Record<string, any>, looks: Record<string, any> }} */
export function unpack(raw) {
  try {
    const j = JSON.parse(String(raw ?? ""));
    if (!j || j.v !== 1) return { person: {}, looks: {} };
    /** @type {Record<string, any>} */ const looks = {};
    for (const [id, l] of Object.entries(j.looks ?? {})) if (/^[A-Za-z0-9_.:-]{1,80}$/.test(id)) { const c = cleanLook(l); if (Object.keys(c).length) looks[id] = c; }
    return { person: cleanPerson(j.person), looks };
  } catch { return { person: {}, looks: {} }; }
}
