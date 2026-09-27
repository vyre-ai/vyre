// @ts-check
// Icon drawings, copied from the Deck boards (16 grid, 1.5 stroke), and the Lead mark from
// TOKENS.md. These constants are the only markup the Deck ever parses.

const P = {
  now: '<circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none"/>',
  projects: '<path d="M2 4.5h4.2l1.4 1.5H14v6.5H2z"/>',
  memory: '<circle cx="4" cy="11.5" r="1.9"/><circle cx="12" cy="4.5" r="1.9"/><circle cx="12.5" cy="12" r="1.3"/><path d="M5.5 10.3l5-4.6M5.9 11.7h5.3"/>',
  agents: '<rect x="2" y="2.5" width="12" height="8.5" rx="1.2"/><path d="M5.5 14h5M8 11v3"/>',
  vault: '<rect x="2.5" y="2.5" width="11" height="11" rx="1.2"/><circle cx="8" cy="8" r="2.3"/><path d="M8 5.7V4.6M5 13.5v1M11 13.5v1"/>',
  settings: '<path d="M2.5 5H5M8 5h5.5M2.5 11H9M12 11h1.5"/><circle cx="6.5" cy="5" r="1.5"/><circle cx="10.5" cy="11" r="1.5"/>',
  lock: '<rect x="3" y="7" width="10" height="7" rx="1.2"/><path d="M5.5 7V5a2.5 2.5 0 015 0v2"/>',
  search: '<circle cx="7" cy="7" r="4.3"/><path d="M10.3 10.3L13.5 13.5"/>',
  watch: '<rect x="1.5" y="2.5" width="13" height="9" rx="1.2"/><path d="M1.5 5h13M5 14h6"/>',
  pin: '<path d="M6 2.5h4M7 2.5v4L4.5 9h7L9 6.5v-4M8 9v4.5"/>',
  mute: '<path d="M3 6v4h2.5L9 13V3L5.5 6z"/><path d="M11.5 6.5l3 3M14.5 6.5l-3 3"/>',
  plus: '<path d="M8 3.5v9M3.5 8h9"/>',
  minus: '<path d="M3.5 8h9"/>',
  mic: '<rect x="6" y="2" width="4" height="7.5" rx="2"/><path d="M3.8 8a4.2 4.2 0 008.4 0M8 12.2V14"/>',
  send: '<path d="M3.5 8h9M9 4.5L12.5 8 9 11.5"/>',
  file: '<path d="M4 1.8h5l3 3v9.4H4z"/><path d="M9 1.8v3h3"/>',
  close: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>',
  chevron: '<path d="M5 6.5L8 9.5l3-3"/>',
  right: '<path d="M6.5 4.5L10 8l-3.5 3.5"/>',
  left: '<path d="M9.5 4.5L6 8l3.5 3.5"/>',
  edit: '<path d="M10.5 2.5l3 3L6 13H3v-3z"/>',
  lines: '<path d="M3 4h10M3 8h10M3 12h6"/>',
  mail: '<rect x="2" y="3.5" width="12" height="9" rx="1"/><path d="M2.5 4.5L8 9l5.5-4.5"/>',
  chat: '<path d="M2.5 3.5h11v7H7l-3 2.5v-2.5H2.5z"/>',
  clock: '<circle cx="8" cy="8" r="5.8"/><path d="M8 4.8V8l2.2 1.5"/>',
  branch: '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7c0 3-7 2-7 4"/>',
  key: '<circle cx="5.5" cy="8" r="3"/><path d="M8.5 8h6M12.5 8v2.5M14.5 8v2"/>',
  login: '<path d="M6.5 9.5l3-3"/><path d="M7.5 4.5l1-1a2.8 2.8 0 014 4l-1 1M8.5 11.5l-1 1a2.8 2.8 0 01-4-4l1-1"/>',
  pass: '<path d="M2 8h4M10 8h4"/><circle cx="8" cy="8" r="2"/><path d="M2 5v6M14 5v6"/>',
  check: '<path d="M3.5 8.5l3 3 6-7"/>',
  ask: '<circle cx="8" cy="8" r="5.8"/><path d="M6.3 6.3a1.8 1.8 0 113 1.4c-.8.5-1.3.9-1.3 1.8M8 11.5v.01"/>',
  terminal: '<rect x="1.5" y="2.5" width="13" height="11" rx="1.2"/><path d="M4.5 6.5l2 1.5-2 1.5M8 10h3.5"/>',
  phone: '<rect x="4.5" y="1.5" width="7" height="13" rx="1.4"/><path d="M7 12.2h2"/>',
  laptop: '<rect x="3" y="3" width="10" height="7" rx="1"/><path d="M1.5 12.5h13"/>',
  copy: '<rect x="5" y="5" width="8.5" height="8.5" rx="1.2"/><path d="M3 10.5V3.8C3 3.3 3.3 3 3.8 3h6.7"/>',
  // Drawn for the rail (Design A): a calendar page with two rings, and a laptop beside a phone.
  planner: '<rect x="2.5" y="3.2" width="11" height="10.3" rx="1.2"/><path d="M2.5 6.7h11M5.5 1.8v2.6M10.5 1.8v2.6M5.3 9.6h1.4M9.3 9.6h1.4"/>',
  devices: '<rect x="1.5" y="3.5" width="8.5" height="6.2" rx="1"/><path d="M1.2 12.5h8.6"/><rect x="11.5" y="5.5" width="3.5" height="8" rx="0.9"/>',
  bell: '<path d="M8 2.3a3.8 3.8 0 00-3.8 3.8v2.1L2.8 10.5h10.4L11.8 8.2V6.1A3.8 3.8 0 008 2.3z"/><path d="M6.5 12.5a1.5 1.5 0 003 0"/>',
};

const parser = new DOMParser();

/**
 * An icon as an SVG element, stroked in currentColor.
 * @param {keyof typeof P} name @param {number} [size]
 */
export function icon(name, size = 16) {
  // Parsed once per name and size, then cloned: a fast scroll through a long transcript mounts
  // many rows a frame, each with its icons (chat, native bar budget 6).
  const key = name + "@" + size;
  let made = ICONS.get(key);
  if (!made) {
    const src = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ""}</svg>`;
    made = /** @type {SVGElement} */ (document.importNode(parser.parseFromString(src, "image/svg+xml").documentElement, true));
    // A DOM without cloneNode (the tests' fake) gets a fresh parse each time.
    if (typeof made.cloneNode !== "function") return made;
    ICONS.set(key, made);
  }
  return /** @type {SVGElement} */ (made.cloneNode(true));
}
/** @type {Map<string, SVGElement>} */
const ICONS = new Map();

function parse(src) {
  return /** @type {SVGElement} */ (document.importNode(parser.parseFromString(src, "image/svg+xml").documentElement, true));
}

/** The Lead mark. dot: "signal" (default), "beacon" for needs-you, "ink" on paper. */
export function mark(size = 20, dot = "signal") {
  const fill = dot === "beacon" ? "var(--beacon-dot)" : dot === "ink" ? "var(--text)" : "var(--focus)";
  const m = parse(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3.5 5.5L12 19.5L17.96 9.69" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="20.5" cy="5.5" r="2.3"/></svg>`);
  const c = /** @type {SVGElement} */ (m.querySelector("circle"));
  c.style.fill = fill;
  m.style.color = "var(--text)";
  return m;
}

/** The monoline wordmark "vyre", h tall. */
export function wordmark(h = 22) {
  const w = Math.round(h * 62 / 26);
  const m = parse(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="-2 3 62 26" fill="none" role="img" aria-label="vyre"><path d="M0 6L6 20L12 6M16 6L22 20M28 6L19.4 26M33 6V20M33 13Q33 6 40 6M43 13H57A7 7 0 1 0 55.36 17.5" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`);
  m.style.color = "var(--text)";
  return m;
}
