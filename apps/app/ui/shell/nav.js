// @ts-check
// Pure rules for the shell's navigation: which item is current, and how a nav definition splits for a phone or a wide screen.
// No React here, so Node tests it.

/** @typedef {{ id: string, label: string, icon: string, href: string, match?: string[], badge?: number }} NavItem */

/** An item is current when the path is its href or sits under it (or under one of its `match` prefixes). */
export function isActive(/** @type {string} */ path, /** @type {NavItem} */ item) {
  const p = String(path || "").split("?")[0].replace(/\/+$/, "") || "/";
  return [item.href, ...(item.match ?? [])].some((h) => {
    const base = h.replace(/\/+$/, "") || "/";
    return p === base || p.startsWith(base + "/");
  });
}

/** The one item that is current: the longest matching href wins, so /u/records/contact beats /u/records. */
export function currentItem(/** @type {string} */ path, /** @type {NavItem[]} */ all) {
  let best = null;
  let len = -1;
  for (const it of all) {
    for (const h of [it.href, ...(it.match ?? [])]) {
      if (isActive(path, { ...it, href: h, match: [] }) && h.length > len) { best = it; len = h.length; }
    }
  }
  return best;
}

/**
 * A phone shows the first `tabs` items as tabs, then More. More holds the rest of `items`, then `more`, then `bottom`.
 * @param {{ items: NavItem[], more: NavItem[], bottom: NavItem[] }} nav
 * @param {number} [tabs]
 */
export function phoneSplit(nav, tabs = 4) {
  return { tabs: nav.items.slice(0, tabs), more: [...nav.items.slice(tabs), ...nav.more, ...nav.bottom] };
}
