// @ts-check
// Memory's plain logic, with no DOM: what the Memory view and its Lessons tab decide, kept here
// so deck/test/memory.test.js can run it under node:test.

/** A relation in words, for a link on the map. */
export const REL = {
  works_at: "works at", has_email: "email", has_domain: "domain", at_domain: "at", owned_by: "owned by",
  has_title: "title", client_of: "client of", repo_for: "repo for", deadline: "due", prefers: "prefers",
  decided: "decided", noted: "note", mentioned_in: "in",
};
export const relWords = rel => REL[rel] || String(rel || "").replace(/_/g, " ");

/**
 * The address of the exact turn a fact came from: the thread, in its project when known, with
 * ?seq=N. Null when the fact has no turn (taught by a module).
 * @param {{ session?: string, seq?: number } | null | undefined} ref
 * @param {(session: string) => string | undefined} [projectOf]
 */
export function turnHref(ref, projectOf) {
  if (!ref || !ref.session) return null;
  const p = projectOf ? projectOf(ref.session) : undefined;
  const base = p ? `/projects/${encodeURIComponent(p)}/${encodeURIComponent(ref.session)}` : `/threads/${encodeURIComponent(ref.session)}`;
  return Number.isInteger(ref.seq) ? `${base}?seq=${ref.seq}` : base;
}

/**
 * A fact's sentence split around its object, so the object can become a field in place:
 * "Dana Reyes works at [Harlow Legal]". The last match wins ("Harlow's page is Harlow").
 * @param {string} text @param {string} object
 */
export function splitFact(text, object) {
  const t = String(text || ""), o = String(object || "");
  const i = o ? t.lastIndexOf(o) : -1;
  if (i < 0) return { before: t + (t && o ? ": " : ""), object: o, after: "" };
  return { before: t.slice(0, i), object: o, after: t.slice(i + o.length) };
}

/** A confidence as a percentage, "92%". */
export const pct = c => `${Math.round(Number(c || 0) * 100)}%`;

// ---- the graph cursor --------------------------------------------------------------------

/**
 * When to fetch memory.graph again. One call per change, none while the tab is hidden, and none
 * at all when an event says nothing moved (SPEC principle 8: a background tab follows the event
 * stream and runs no timers).
 *
 *   curated(payload)  a memory.curated event; skipped when its `updated` is what we drew
 *   visible()         the tab came back; fetches once if something changed while it was away
 *   request()         fetch now (or mark dirty when hidden)
 *
 * fetch(since) resolves to the graph or `{ updated, unchanged: true }`; draw(graph) is only
 * called with a graph that changed.
 * @param {{ fetch: (since: number | undefined) => Promise<any>, draw: (graph: any) => void, hidden: () => boolean }} io
 */
export function graphCursor(io) {
  const st = { updated: /** @type {number|undefined} */ (undefined), dirty: false, busy: /** @type {Promise<void>|null} */ (null), again: false, gen: 0, fetches: 0 };
  function run() {
    if (st.busy) { st.again = true; return st.busy; }
    st.busy = (async () => {
      do {
        st.again = false;
        const gen = st.gen, since = st.updated;
        st.fetches++;
        const g = await io.fetch(since);
        // The scope changed while this was in flight: what came back is for the old one.
        if (gen !== st.gen) { st.again = true; continue; }
        if (!g || g.unchanged) { if (g && g.updated !== undefined) st.updated = g.updated; continue; }
        if (since !== undefined && g.updated === since) continue;
        st.updated = g.updated;
        io.draw(g);
      } while (st.again);
    })().finally(() => { st.busy = null; });
    return st.busy;
  }
  return {
    state: st,
    /** Fetch now; `fresh` drops the cursor (the scope changed). */
    request(fresh = false) {
      if (fresh) { st.updated = undefined; st.gen++; }
      if (io.hidden()) { st.dirty = true; return Promise.resolve(); }
      st.dirty = false;
      return run();
    },
    /** @param {{ updated?: number } | null | undefined} payload */
    curated(payload) {
      if (payload && payload.updated !== undefined && payload.updated === st.updated) return Promise.resolve();
      return this.request();
    },
    visible() {
      if (!st.dirty || io.hidden()) return Promise.resolve();
      return this.request();
    },
  };
}

// ---- rooms -------------------------------------------------------------------------------

/**
 * What a Memory call names for the selected project: its room, by slug. Never its folders: a
 * project may have none (only picked threads), and one project's folder can sit inside
 * another's. No project is the main graph.
 * @param {string} [slug]
 * @returns {{ room?: string }}
 */
export function roomInput(slug) {
  return slug ? { room: slug } : {};
}

/**
 * The projects the scope select offers: from projects.list when it answered, else from the main
 * graph's rooms (which carry each project's folders).
 * @param {any[] | null} list projects.list's projects
 * @param {any[] | null} rooms memory.graph's rooms, main graph
 * @returns {{ slug: string, name: string, folders: string[] }[]}
 */
export function projectsFrom(list, rooms) {
  if (list && list.length) return list.map(p => ({ slug: p.slug, name: p.name,
    folders: p.workspaces?.length ? p.workspaces : p.home ? [p.home] : p.folders || [] }));
  return (rooms || []).filter(r => r.kind === "project" && r.slug).map(r => ({ slug: r.slug, name: r.label, folders: r.folders || [] }));
}

/** Nodes grouped by the room they are drawn in; a node naming an unknown room goes to the first. */
export function byRoom(graph) {
  const out = new Map((graph.rooms || []).map(r => [r.id, []]));
  const first = graph.rooms?.[0]?.id;
  for (const n of graph.nodes || []) {
    const k = out.has(n.room) ? n.room : first;
    if (k !== undefined) out.get(k).push(n);
  }
  return out;
}

// ---- lessons -----------------------------------------------------------------------------

/** "Everywhere", "Only in Harlow Legal", "Only for juno". */
export function scopeWords(scope, names = new Map()) {
  if (!scope || scope === "all") return "Everywhere";
  if (typeof scope === "object" && scope.project) return `Only in ${names.get(scope.project) || scope.project}`;
  if (typeof scope === "object" && scope.agent) return `Only for ${scope.agent}`;
  return String(scope);
}

/** "applied 14 · caught 3 · broken 1" */
export const countsLine = l => `applied ${l.applied || 0} · caught ${l.caught || 0} · broken ${l.broken || 0}`;

/** What a check does, in a tag. */
export function checkWords(check) {
  if (!check) return null;
  const k = check.kind;
  return k === "text" ? "text check" : k === "touched" ? "file check" : k === "before" ? "order check"
    : k === "tool" ? "tool check" : k === "path" ? "path check" : k === "after" ? "after check" : "check";
}

export const SOURCE = {
  prompt: "your correction", correction: "your correction", remember: "a lesson you wrote", edited: "your edit to a draft",
  "draft-edit": "your edit to a draft", denied: "a call you denied", declined: "a call you declined", reverted: "a change you reverted",
  repeated: "a correction you repeated", corrected: "a fact you corrected", "test-fix": "a test you fixed", user: "you",
};

/** Proposed, active and retired, oldest first within each; dormant counts as active. */
export function groupLessons(list) {
  const g = { proposed: [], active: [], retired: [] };
  for (const l of list || []) (l.status === "proposed" ? g.proposed : l.status === "retired" ? g.retired : g.active).push(l);
  return g;
}

/**
 * learn.stats's verdict for one lesson, from whichever shape it answers in: an array of rows, an
 * object with `lessons`, or an object keyed by id. Null when there is none.
 * @returns {{ verdict: string, text: string } | null}
 */
export function verdictOf(stats, id) {
  if (!stats) return null;
  const rows = Array.isArray(stats) ? stats : Array.isArray(stats.lessons) ? stats.lessons : null;
  const s = rows ? rows.find(r => String(r.id ?? r.lesson) === String(id)) : stats[id];
  const v = s && (s.verdict || s.effect);
  if (!v) return null;
  const turns = s.turns ?? s.measured;
  const fmt = n => (Math.round(Number(n) * 10) / 10).toString();
  const rate = s.before !== undefined && s.after !== undefined ? `, ${fmt(s.before)} to ${fmt(s.after)} per 100 turns` : "";
  const text = v === "working" ? `Working${rate}` : v === "not working" || v === "not_working" ? `Not working${rate}`
    : `Measuring${turns !== undefined ? `, ${turns} turns so far` : ""}`;
  return { verdict: v === "not_working" ? "not working" : v, text };
}

/** The level a relax can lower to: the ones under the current one. */
export const LEVELS = ["remind", "ask", "block"];
export const lowerLevels = level => LEVELS.slice(0, Math.max(0, LEVELS.indexOf(level)));

/**
 * What to tell the user when a presence tool was refused for want of a person: the passkey when
 * the Deck has one, else the terminal command or the Capsule.
 * @param {string} tool @param {string|number} id @param {boolean} passkey
 */
export function presenceText(tool, id, passkey) {
  if (passkey) return "Confirm with your passkey";
  const cmd = tool === "learn.accept" ? `vyre learn accept ${id}` : tool === "learn.retire" ? `vyre learn retire ${id}`
    : tool === "learn.relax" ? `vyre learn relax ${id}` : tool === "learn.skill_install" ? `vyre learn skills install ${id}`
    : tool === "learn.skill_retire" ? `vyre learn skills retire ${id}` : `vyre call ${tool}`;
  const verb = tool === "learn.accept" ? "Accept" : tool === "learn.retire" ? "Retire" : tool === "learn.relax" ? "Relax"
    : tool === "learn.skill_install" ? "Install" : "Confirm";
  return `${verb} this in a terminal: ${cmd}, or from the Capsule`;
}
