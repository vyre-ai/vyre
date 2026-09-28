// @ts-check
// lib/project-id: the one canonical shape of a project id, as a pure library (ADR 0033, section
// 3). No feature state: nothing here reads config, the store or another module.
//
// A project has one id: the marker's slug (core/projects/markers.js). Everything else that
// names a project derives from it rather than growing its own shape:
//   - memory's rooms are keyed on this slug directly (core/memory/curator.js refreshRooms);
//   - a teammate's agent name is `<role>-<project>`, where `<project>` must be this slug
//     (core/team, ADR 0031) — teammates validated that against its own copy of this regex before
//     this lib existed; it should import SLUG_RE from here instead;
//   - a vault grant's `project` column (ADR 0031 section 12, queued) names this same slug.
//
// Import this instead of re-deriving the shape: any part may import a lib (boundaries test).

/** The exact charset `slugify` below can produce: lowercase letters, digits and single hyphens,
 * neither leading nor trailing. */
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A name, folder or anything else turned into the canonical shape. Matches
 * core/projects/markers.js's own slugify exactly: this lib is that function's home, and markers.js
 * re-exports it so existing callers (`M.slugify`) keep working unchanged. */
export function slugify(s) {
  return String(s || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Whether a value is already in the canonical shape — the check every other part should run on
 * a project id it did not just get from `projects.list` or `projects.of`, instead of writing its
 * own regex (teammates' core/team/index.js SLUG constant is the case this replaces). */
export function isProjectId(v) {
  return typeof v === "string" && v.length > 0 && SLUG_RE.test(v);
}
