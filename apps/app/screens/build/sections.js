// @ts-check
// The sections of Build, as rules: which section a path is in, the next and previous one for the arrow keys. Build is one footer place that drills the sidebar into this list, the way Settings does
// (ui/shell/sidebar-stack.js), with the section on the right. The old routes are the sections' own routes, so every link to them keeps working. Pure, so Node tests it.

/** [id, label, icon, route, prefixes]. Playbooks (templates-ux's board), Objects (the record-type editor), Kits. */
export const BUILD_SECTIONS = /** @type {readonly [string, string, string, string, readonly string[]][]} */ ([
  ["playbooks", "Playbooks", "file", "/u/playbooks", ["/u/playbooks", "/u/templates"]],
  ["skills", "Skills and plugins", "spark", "/u/skills", ["/u/skills"]],
  ["objects", "Objects", "list", "/u/settings/customize", ["/u/settings/customize"]],
  ["documents", "Documents", "file", "/u/documents?tab=templates", ["/u/documents"]],
  ["kits", "Kits", "box", "/u/kits", ["/u/kits"]],
]);

/** Every path that is inside Build (the sidebar drills into its list for them). */
export const BUILD_PREFIXES = BUILD_SECTIONS.flatMap((s) => s[4]);

/** The section a path is in; null outside Build. @param {string} path */
export function sectionOf(path) {
  const p = String(path || "").split("?")[0].replace(/\/+$/, "");
  return BUILD_SECTIONS.find((s) => s[4].some((x) => p === x || p.startsWith(x + "/")))?.[0] ?? null;
}

/** The route the arrow keys move to: down is the next section, up the previous, and neither wraps. @param {string | null} id @param {-1 | 1} dir */
export function stepSection(id, dir) {
  const i = BUILD_SECTIONS.findIndex(([x]) => x === id);
  const j = i < 0 ? 0 : i + dir;
  return j < 0 || j >= BUILD_SECTIONS.length ? null : BUILD_SECTIONS[j][3];
}
