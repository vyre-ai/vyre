// @ts-check
// The theme's custom properties, mirrored on <html> for the web's portals. Menus, selects and sheets are portalled to <body>, outside every
// ThemeProvider's view, so their text reads var(--text) from <html> alone. Several providers can be up at once (the root routes' and the unlock
// cover's, a session's): each one is an entry here, and the newest still mounted is the one on <html>. A provider that goes away hands <html> back to
// the one under it instead of wiping it: wiping it left every open menu with no text colour (dark on the dark panel) after the unlock cover closed.

/** @typedef {{ setProperty: (k: string, v: string) => void, removeProperty: (k: string) => void }} StyleLike */
/** @typedef {{ map: Record<string, string | number> }} Entry */

/** @type {WeakMap<StyleLike, Entry[]>} */
const stacks = new WeakMap();

/** @param {StyleLike} style @param {Record<string, string | number>} map */
const write = (style, map) => { for (const [k, v] of Object.entries(map)) style.setProperty(k, String(v)); };

/**
 * Put a provider's properties on `style` (document.documentElement.style). Returns the release: the provider's cleanup. Pure apart from `style`, so Node tests it.
 * @param {StyleLike} style @param {Record<string, string | number>} map @returns {() => void}
 */
export function mirrorVars(style, map) {
  let stack = stacks.get(style);
  if (!stack) stacks.set(style, (stack = []));
  /** @type {Entry} */
  const entry = { map };
  stack.push(entry);
  write(style, map);
  const own = stack;
  return () => {
    const i = own.indexOf(entry);
    if (i < 0) return;
    own.splice(i, 1);
    const top = own[own.length - 1];
    for (const k of Object.keys(map)) if (!top || !(k in top.map)) style.removeProperty(k);
    if (top) write(style, top.map);
  };
}
