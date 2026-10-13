// @ts-check
// The pure half of GroupedList: named groups in an order, each item says which one it is in by `group` (none is the default section). Groups are presentation, never a permission.

/** @typedef {{ name: string, collapsed?: boolean }} Group */

const same = (/** @type {string} */ a, /** @type {string} */ b) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The sections to draw: the default one first (only when it has items), then every group in order, even an empty one. With no groups: one flat section. @template {{ group?: string }} T @param {Group[]} groups @param {T[]} items */
export function sectionsOf(groups, items) {
  if (!groups.length) return [{ name: "", title: "", collapsed: false, flat: true, items }];
  const known = new Set(groups.map((g) => g.name));
  const loose = items.filter((i) => !i.group || !known.has(i.group));
  return [
    ...(loose.length ? [{ name: "", title: "", collapsed: false, flat: false, items: loose }] : []),
    ...groups.map((g) => ({ name: g.name, title: g.name, collapsed: !!g.collapsed, flat: false, items: items.filter((i) => i.group === g.name) })),
  ];
}

/** @param {Group[]} groups @param {string} name */
export const addGroup = (groups, name) => (!name.trim() || groups.some((g) => same(g.name, name)) ? groups : [...groups, { name: name.trim() }]);

/** The group and every item in it take the new name. A blank or taken name changes nothing. @template {{ group?: string }} T @param {Group[]} groups @param {T[]} items @param {string} from @param {string} to */
export function renameGroup(groups, items, from, to) {
  if (!to.trim() || groups.some((g) => g.name !== from && same(g.name, to))) return { groups, items };
  const n = to.trim();
  return { groups: groups.map((g) => (g.name === from ? { ...g, name: n } : g)), items: items.map((i) => (i.group === from ? { ...i, group: n } : i)) };
}

/** @param {Group[]} groups @param {string} name @param {number} dir */
export function moveGroup(groups, name, dir) {
  const i = groups.findIndex((g) => g.name === name), j = i + dir;
  if (i < 0 || j < 0 || j >= groups.length) return groups;
  const n = [...groups];
  [n[i], n[j]] = [n[j], n[i]];
  return n;
}

/** The group goes; its items stay, in the default section. @template {{ group?: string }} T @param {Group[]} groups @param {T[]} items @param {string} name */
export function removeGroup(groups, items, name) {
  return { groups: groups.filter((g) => g.name !== name), items: items.map((i) => { if (i.group !== name) return i; const { group: _g, ...rest } = i; return /** @type {T} */ (rest); }) };
}

/** @param {Group[]} groups @param {string} name */
export const toggleGroup = (groups, name) => groups.map((g) => (g.name === name ? { ...g, collapsed: !g.collapsed } : g));
