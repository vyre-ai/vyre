// @ts-check
// The icon names a module may put in a block (packages/module-sdk/capsule-view.js ICONS: system symbols, so Lumen draws them natively) as the app's own icon family. One table, so a row a module
// describes with "gear" or "creditcard" draws the family's settings and card icons, and symbols.test.js fails when the module list grows a name this table lacks.

/** @type {Record<string, string>} */
export const FAMILY_OF_SYMBOL = {
  envelope: "mail", "envelope.open": "mail", calendar: "cal", clock: "clock", folder: "projects", doc: "file", "doc.text": "file", "doc.on.doc": "copy", "note.text": "file", key: "key", lock: "lock", "lock.open": "unlock",
  person: "person", "person.2": "users", "person.crop.circle": "person", link: "link", magnifyingglass: "search", star: "star", bell: "bell", bolt: "bolt", bookmark: "pin", "chevron.right": "chev", cloud: "server", gear: "settings",
  globe: "globe", house: "space", tray: "storage", paperplane: "send", pencil: "edit", trash: "trash", tag: "hash", terminal: "term", "arrow.up.right.square": "external", "checkmark.circle": "ok", "exclamationmark.triangle": "warning",
  "list.bullet": "list", "square.and.arrow.up": "share", photo: "file", play: "play", creditcard: "card", "chart.bar": "chart", briefcase: "projects", "building.2": "space", phone: "phone", message: "chat", "bubble.left": "chat",
  curlybraces: "term", hammer: "cfg", "wand.and.stars": "spark", sparkles: "spark", shippingbox: "kits", cart: "budget", map: "trip", mappin: "pin", flag: "pin", heart: "star", eye: "eye", camera: "camera", mic: "mic", wifi: "wink",
  "battery.100": "bolt", "square.stack": "board", "rectangle.stack": "board", "text.alignleft": "list", number: "hash", "dollarsign.circle": "budget", percent: "chart", wrench: "cfg", scissors: "edit", printer: "file",
};

/** The family icon for a row's icon: a symbol name is translated, a family name stays, anything else is no icon. @param {unknown} name @param {readonly string[]} family */
export function iconFor(name, family) {
  if (typeof name !== "string") return undefined;
  const mapped = FAMILY_OF_SYMBOL[name];
  if (mapped) return mapped;
  return family.includes(name) ? name : undefined;
}
