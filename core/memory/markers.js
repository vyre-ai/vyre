// @ts-check
// markers — how the three layers of memory find each other (team/0.3/DESIGN-memory-layers.md).
//
// Identity, Spaces, Projects: each layer owns its facts and nothing learned in one Space is copied into another. A higher layer holds MARKERS that point down: a Space's memory
// has one per project in it, the person's identity memory one per Space and per project. A marker names where memory is and what it takes to read it; it grants nothing and
// carries no content beyond a short summary built from non-sealed counts and names. Following one is always a call to the target layer's own memory under the caller's own
// grants, so the layer's own rules decide.
//
// Markers are derived on every read from what the layers hold, never stored, so one cannot go stale or outlive what it points at.

/**
 * @typedef {{ kind: "project"|"space", urn: string, slug: string|null, name: string, summary: string, topics: string[], counts: { facts: number, decisions: number, sessions: number }, updated: number|null }} Marker
 * @typedef {{ kind: "project"|"space", urn: string, name: string, access: "follow"|"exists", summary?: string, topics?: string[], counts?: Marker["counts"], updated?: number|null, slug?: string }} Seen
 */

/** The marker for a project's memory, from counts the layer holds. @param {{ space: string, slug: string, name: string, facts?: number, decisions?: number, sessions?: number, topics?: string[], updated?: number|null }} p @returns {Marker} */
export function projectMarker({ space, slug, name, facts = 0, decisions = 0, sessions = 0, topics = [], updated = null }) {
  const t = [...new Set(topics.map(x => String(x).replace(/[\u0000-\u001f<>`]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40)).filter(Boolean))].slice(0, 8);
  return { kind: "project", urn: `vyre://${space}/project/${slug}`, slug, name: String(name).slice(0, 80), counts: { facts, decisions, sessions }, topics: t, updated,
    summary: `${facts} fact${facts === 1 ? "" : "s"}, ${decisions} decision${decisions === 1 ? "" : "s"}, ${sessions} session${sessions === 1 ? "" : "s"}${t.length ? `; about ${t.slice(0, 5).join(", ")}` : ""}`.slice(0, 200) };
}

/** The marker for a Space's own memory. @param {{ space: string, name?: string|null, projects?: number }} s @returns {Marker} */
export function spaceMarker({ space, name = null, projects = 0 }) {
  return { kind: "space", urn: `vyre://${space}/space`, slug: null, name: String(name || space).slice(0, 80), counts: { facts: 0, decisions: 0, sessions: 0 }, topics: [], updated: null,
    summary: `the Space's own memory (records, events and session lines)${projects ? `; ${projects} project${projects === 1 ? "" : "s"} below it` : ""}`.slice(0, 200) };
}

/**
 * What a caller sees of the markers. Following needs the grant for that layer: the person's own surfaces and the identity-level assistant follow every one; an agent follows the
 * projects it is granted and nothing above them. A marker the caller may not follow is not shown at all, and not counted: a project's name can be a client's.
 * @param {Marker[]} markers
 * @param {{ all?: boolean, assistant?: boolean, slugs?: Set<string>, space?: boolean }} reach
 * @returns {Seen[]}
 */
export function visible(markers, reach) {
  const everything = Boolean(reach.all || reach.assistant);
  // A caller sees only the markers it may follow: the others are not named and not counted (a project's name can be a client's).
  return markers.filter(m => (m.kind === "space" ? everything || Boolean(reach.space) : everything || Boolean(m.slug && reach.slugs && reach.slugs.has(m.slug)))).map(m =>
    ({ kind: m.kind, urn: m.urn, name: m.name, access: /** @type {const} */ ("follow"), ...(m.slug ? { slug: m.slug } : {}), summary: m.summary, topics: m.topics, counts: m.counts, updated: m.updated }));
}

/** The marker among `markers` a caller names: by urn, or by a project's slug or name. @param {Marker[]} markers @param {string} ref */
export function find(markers, ref) {
  const r = String(ref || "").trim().toLowerCase();
  if (!r) return null;
  return markers.find(m => m.urn.toLowerCase() === r || (m.slug && m.slug.toLowerCase() === r) || m.name.toLowerCase() === r) || null;
}
