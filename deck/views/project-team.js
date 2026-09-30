// @ts-check
// A project's Team tab (/projects/<slug>?tab=team): the teammates that serve it, and for each one what it is
// doing now, what it last delivered, its notes, and its setup (who fills the role, its charter, its duties).
// Reads: team.list {project}, team.status {request}, team.notes {agent}, team.charter.get, team.duties.list.
// Writes, all the person's own: team.add, team.notes set, team.charter.set and .draft, team.duties.enable, .disable and
// .run-now, team.role.fill, team.retire, team.default.set. Every value from the box is drawn as text. Nothing
// polls: it loads on open, after each action, and on the team and teammate events.
//
// The box has no tool that lists a teammate's queued requests yet, so the pane shows how many are queued (from
// team.list) and the one running (team.status), not each queued ask.

import { h, put, empty } from "../js/dom.js";
import { attempt as apiAttempt } from "../js/api.js";
import { plural } from "../js/fmt.js";
import { watcherCard } from "../chat/cards/watcher.js";

export const EVENTS = ["teammate.added", "teammate.retired", "teammate.charter-changed", "teammate.default-changed", "team.state", "team.request", "team.done", "team.failed", "team.cancelled"];
const ROLE = /^[a-z][a-z0-9-]{0,30}$/;
const errWords = (/** @type {any} */ e) => (e?.missing ? "Teammates are not available on this box yet." : String(e?.message || e || "That did not go through."));
const STATE_WORDS = { idle: "Idle", working: "Working", running: "Working", waiting: "Waiting", queued: "Queued", failed: "Failed", done: "Done" };
/** A teammate's state as a word; an unknown one is shown as sent. @param {any} s */
export const stateWord = s => STATE_WORDS[String(s)] || String(s || "Idle");
/** The first line of a result, clipped: a row shows it, the pane shows it whole. @param {any} t @param {number} [n] */
export const clip = (t, n = 160) => { const s = String(t ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

/** @param {any} d team.list's answer @returns {any[]} */
export function teammatesOf(d) {
  return (Array.isArray(d) ? d : Array.isArray(d?.teammates) ? d.teammates : []).filter((/** @type {any} */ t) => t && typeof t.agent === "string" && typeof t.role === "string").map((/** @type {any} */ t) => ({
    agent: String(t.agent), role: String(t.role), brief: t.brief ? String(t.brief) : "", filler: t.filler?.kind === "agent" ? String(t.filler.agent) : null, state: String(t.state || "idle"), queued: Number(t.queued) || 0,
    current: t.current_request ? String(t.current_request) : null, last: t.last_result && typeof t.last_result === "object" ? { state: String(t.last_result.state || ""), result: String(t.last_result.result ?? "") } : null }));
}

/**
 * @param {HTMLElement} el @param {{ alive: () => boolean, on?: (t: string, fn: (e: any) => void) => void }} ctx @param {{ slug: string, name?: string }} project
 * @param {{ attempt?: typeof apiAttempt }} [deps]
 */
export async function drawTeam(el, ctx, project, deps = {}) {
  const attempt = deps.attempt || apiAttempt;
  if (typeof document !== "undefined" && document.head) for (const href of ["/css/views/memory-lessons.css", "/css/views/project-team.css"]) if (!document.querySelector?.(`link[href="${href}"]`)) document.head.append(h("link", { rel: "stylesheet", href }));
  const st = { rows: /** @type {ReturnType<typeof teammatesOf>} */ ([]), error: /** @type {any} */ (null), open: "", pane: /** @type {Record<string, any>} */ ({}), steer: /** @type {boolean|null} */ (null),
    agents: /** @type {string[]} */ ([]), problem: /** @type {string|null} */ (null), busy: "", cards: /** @type {Map<string, HTMLElement>} */ (new Map()), adding: false, editing: /** @type {"" | "notes" | "charter"} */ (""), sure: "" };

  async function load() {
    const [l, d] = await Promise.all([attempt("team.list", { project: project.slug }), attempt("team.default.get", { project: project.slug })]);
    if (!ctx.alive()) return;
    st.error = l.error || null;
    st.rows = l.error ? [] : teammatesOf(l.data);
    st.steer = d.error ? null : d.data?.enabled !== false;
    draw();
  }
  async function loadPane(/** @type {ReturnType<typeof teammatesOf>[number]} */ t) {
    const [notes, charter, duties, status] = await Promise.all([
      attempt("team.notes", { action: "get", agent: t.agent }), attempt("team.charter.get", { teammate: t.agent }),
      attempt("team.duties.list", { teammate: t.agent }), t.current ? attempt("team.status", { request: t.current }) : Promise.resolve({ data: null })]);
    if (!ctx.alive()) return;
    st.pane[t.agent] = { notes: notes.error ? null : notes.data, charter: charter.error ? null : charter.data?.charter || null, duties: duties.error ? [] : (duties.data?.duties || []), status: status.error ? null : status.data,
      errors: [notes, charter, duties].filter(r => r.error).length };
    draw();
  }
  async function toggle(/** @type {ReturnType<typeof teammatesOf>[number]} */ t) {
    if (st.open === t.agent) { st.open = ""; st.editing = ""; draw(); return; }
    st.open = t.agent; st.editing = ""; st.sure = ""; st.problem = null; draw();
    await loadPane(t);
    if (!st.agents.length) { const a = await attempt("agents.list", {}); if (ctx.alive()) st.agents = (Array.isArray(a.data) ? a.data : a.data?.agents || []).filter((/** @type {any} */ x) => x && x.kind !== "assistant").map((/** @type {any} */ x) => String(x.name)); draw(); }
  }
  /** Run one write, say why when it fails, and reload what it touched. @param {string} busy @param {() => Promise<{ data?: any, error?: any }>} fn @param {() => void} [after] */
  async function act(busy, fn, after) {
    st.busy = busy; st.problem = null; draw();
    const r = await fn();
    st.busy = "";
    if (r.error) { st.problem = errWords(r.error); draw(); return false; }
    after?.();
    await load();
    const t = st.rows.find(x => x.agent === st.open);
    if (t) await loadPane(t);
    return true;
  }

  function pane(/** @type {ReturnType<typeof teammatesOf>[number]} */ t) {
    const p = st.pane[t.agent];
    if (!p) return h("div", { class: "small faint" }, "Reading…");
    const notes = /** @type {HTMLTextAreaElement} */ (h("textarea", { class: "input tm-text", rows: 8, "aria-label": `${t.role} notes` }, p.notes?.text || ""));
    notes.value = p.notes?.text || "";
    const charter = /** @type {HTMLTextAreaElement} */ (h("textarea", { class: "input tm-text", rows: 8, "aria-label": `${t.role} charter` }));
    charter.value = p.charter?.text || "";
    const pick = /** @type {HTMLSelectElement} */ (h("select", { class: "input", "aria-label": `Who fills ${t.role}` },
      h("option", { value: "" }, "The project's helper"), st.agents.map(a => h("option", { value: a }, a))));
    pick.value = t.filler || "";
    return h("div", { class: "tm-pane", "data-pane": t.agent },
      h("section", { class: "tm-sec", "data-sec": "now" }, h("h3", { class: "lbl" }, "Now"),
        p.status && t.current ? h("p", { class: "small" }, `${stateWord(p.status.state)}${p.status.position != null ? `, position ${p.status.position}` : ""}`) : h("p", { class: "small muted" }, "Nothing running."),
        t.queued ? h("p", { class: "small faint" }, `${plural(t.queued, "request")} waiting in its inbox.`) : null),
      h("section", { class: "tm-sec", "data-sec": "results" }, h("h3", { class: "lbl" }, "Last result"),
        t.last ? h("p", { class: "small tm-result" }, (t.last.state === "failed" ? "Failed: " : "") + t.last.result) : h("p", { class: "small muted" }, "No finished work yet.")),
      h("section", { class: "tm-sec", "data-sec": "notes" }, h("h3", { class: "lbl" }, "Notes"),
        p.notes == null ? h("p", { class: "small muted" }, "Notes could not be read.")
          : st.editing === "notes" ? h("div", null, notes, h("div", { class: "tm-actions" },
            h("button", { class: "btn btn-primary btn-sm", type: "button", "data-act": "notes-save", disabled: st.busy === "notes", onclick: () => act("notes", () => attempt("team.notes", { action: "set", agent: t.agent, text: notes.value }), () => { st.editing = ""; }) }, "Save notes"),
            h("button", { class: "btn btn-ghost btn-sm", type: "button", "data-act": "cancel", onclick: () => { st.editing = ""; draw(); } }, "Cancel")))
            : h("div", null, h("p", { class: "small tm-result" }, p.notes.text || "No notes yet."),
              h("button", { class: "btn btn-ghost btn-sm", type: "button", "data-act": "notes-edit", onclick: () => { st.editing = "notes"; draw(); } }, "Edit notes"))),
      h("section", { class: "tm-sec", "data-sec": "setup" }, h("h3", { class: "lbl" }, "Setup"),
        h("div", { class: "set-row" }, h("div", { class: "set-k" }, "Who fills it"),
          h("div", { class: "set-v" }, pick, h("button", { class: "btn btn-sm", type: "button", "data-act": "fill", disabled: st.busy === "fill", onclick: () => act("fill", () => attempt("team.role.fill", { teammate: t.agent, ...(pick.value ? { agent: pick.value } : {}) })) }, "Change"))),
        h("div", { class: "set-row" }, h("div", { class: "set-k" }, "Charter"),
          h("div", { class: "set-v tm-col" },
            st.editing === "charter" ? h("div", null, charter, h("div", { class: "tm-actions" },
              h("button", { class: "btn btn-primary btn-sm", type: "button", "data-act": "charter-save", disabled: st.busy === "charter", onclick: () => act("charter", () => attempt("team.charter.set", { teammate: t.agent, text: charter.value }), () => { st.editing = ""; }) }, "Save charter"),
              h("button", { class: "btn btn-ghost btn-sm", type: "button", "data-act": "cancel", onclick: () => { st.editing = ""; draw(); } }, "Cancel")))
              : h("div", null, h("p", { class: "small tm-result" }, p.charter?.text || "No charter yet."),
                h("div", { class: "tm-actions" },
                  h("button", { class: "btn btn-ghost btn-sm", type: "button", "data-act": "charter-edit", onclick: () => { st.editing = "charter"; draw(); } }, "Edit"),
                  h("button", { class: "btn btn-ghost btn-sm", type: "button", "data-act": "charter-draft", disabled: st.busy === "draft", onclick: () => act("draft", () => attempt("team.charter.draft", { teammate: t.agent })) }, st.busy === "draft" ? "Drafting" : "Draft it from the project"))))),
        h("div", { class: "set-row" }, h("div", { class: "set-k" }, "Duties"),
          h("div", { class: "set-v tm-col" }, p.duties.length ? p.duties.map((/** @type {any} */ d) => h("div", { class: "tm-duty", "data-duty": String(d.id) },
            // A proposal (not started) has no watcher folder yet, so watchers.card would not find it: it shows its title, full text, trigger and act line only.
            // The title comes with the full instruction, its trigger and whether it acts, never alone: a title must not stand for text the person did not read.
            d.title ? h("strong", { class: "small tm-duty-title" }, String(d.title)) : null,
            h("span", { class: "small tm-duty-text" }, String(d.instruction || d.id)),
            h("span", { class: "small faint" }, [d.trigger ? String(d.trigger) : "", d.act === true ? "Can make changes" : d.act === false ? "Only looks and tells you" : ""].filter(Boolean).join(" · ")),
            d.watcher && d.started === true ? h("button", { class: "btn btn-ghost btn-sm", type: "button", "data-act": "duty-card", "aria-expanded": String(st.cards.has(String(d.id))), onclick: () => { const k = String(d.id); if (st.cards.has(k)) st.cards.delete(k); else st.cards.set(k, watcherCard({ name: String(d.watcher) }, { turnOn: () => attempt("team.duties.enable", { id: k, expect: String(d.instruction || "") }), onDone: () => { st.cards.delete(k); void loadPane(t); } })); draw(); } }, st.cards.has(String(d.id)) ? "Hide what it will do" : "What it will do") : null,
            st.cards.get(String(d.id)) || null,
            h("button", { class: "btn btn-ghost btn-sm", type: "button", "data-act": "duty-toggle", disabled: st.busy === "duty" + d.id, onclick: () => act("duty" + d.id, () => attempt(d.enabled ? "team.duties.disable" : "team.duties.enable", d.enabled ? { id: String(d.id) } : { id: String(d.id), expect: String(d.instruction || "") })) }, d.enabled ? "Pause" : "Turn on"),
            d.enabled ? h("button", { class: "btn btn-ghost btn-sm", type: "button", "data-act": "duty-run", onclick: () => act("run" + d.id, () => attempt("team.duties.run-now", { id: String(d.id) })) }, "Run now") : null)) : h("span", { class: "small muted" }, "No duties."))),
        st.sure === t.agent
          ? h("div", { class: "tm-actions" }, h("span", { class: "small muted" }, `Retire ${t.role}? Its notes and history are kept, and adding ${t.role} again brings it back.`),
            h("button", { class: "btn btn-sm", type: "button", "data-act": "retire-yes", disabled: st.busy === "retire", onclick: () => act("retire", () => attempt("team.retire", { teammate: t.agent }), () => { st.open = ""; st.sure = ""; }) }, "Retire"),
            h("button", { class: "btn btn-ghost btn-sm", type: "button", "data-act": "retire-no", onclick: () => { st.sure = ""; draw(); } }, "Keep"))
          : h("div", { class: "tm-actions" }, h("button", { class: "btn btn-ghost btn-sm", type: "button", "data-act": "retire", onclick: () => { st.sure = t.agent; draw(); } }, `Retire ${t.role}`))));
  }

  function row(/** @type {ReturnType<typeof teammatesOf>[number]} */ t) {
    const open = st.open === t.agent;
    return h("div", { class: "ml-row tm-row", "data-teammate": t.agent },
      h("div", { class: "ml-main" },
        h("div", { class: "ml-rule" }, t.role, h("span", { class: "tag ml-quiet", style: { marginLeft: "8px" } }, stateWord(t.state))),
        h("div", { class: "ml-meta small faint" }, h("span", null, t.filler ? `${t.filler} fills it` : "The project's helper"), t.queued ? h("span", null, `${t.queued} queued`) : null),
        t.brief ? h("div", { class: "small muted" }, clip(t.brief, 200)) : null,
        !open && t.last ? h("div", { class: "small faint" }, (t.last.state === "failed" ? "Failed: " : "Last: ") + clip(t.last.result)) : null,
        open ? pane(t) : null),
      h("div", { class: "ml-act" }, h("button", { class: "btn btn-ghost btn-sm", type: "button", "data-act": "open", "aria-expanded": String(open), onclick: () => toggle(t) }, open ? "Hide" : "Open")));
  }

  function draw() {
    if (st.error) { put(el, empty(st.error?.missing ? "Teammates are not on this box yet." : "Teammates could not be read.", st.error)); return; }
    const role = /** @type {HTMLInputElement} */ (h("input", { class: "input", "aria-label": "Role", placeholder: "A role, like design or backend", autocomplete: "off" }));
    const brief = /** @type {HTMLInputElement} */ (h("input", { class: "input", "aria-label": "What goes to it", placeholder: "What work goes to it (optional)", autocomplete: "off" }));
    put(el, h("div", { class: "ml ml-pad tm" },
      h("div", { class: "ml-head" }, h("h2", { class: "lbl" }, "Teammates"), h("span", { class: "ml-count" }, plural(st.rows.length, "teammate")),
        st.steer != null ? h("label", { class: "small tm-steer" }, h("input", { type: "checkbox", "data-act": "steer", checked: st.steer, disabled: st.busy === "steer",
          onchange: (/** @type {any} */ e) => { void act("steer", () => attempt("team.default.set", { project: project.slug, enabled: e.target.checked })); } }), " Steer new work to teammates") : null),
      st.problem ? h("p", { class: "small muted", role: "alert" }, st.problem) : null,
      st.rows.length ? h("div", { class: "ml-rows" }, st.rows.map(row)) : h("div", { class: "ml-none empty" }, h("strong", null, "No teammates yet"), h("p", { class: "small muted" }, "A teammate is a role in this project, like design or backend, that keeps its own notes and takes work in order.")),
      st.adding ? h("form", { class: "tm-add", onsubmit: (/** @type {Event} */ e) => { e.preventDefault(); const r = role.value.trim().toLowerCase();
        if (!ROLE.test(r)) { st.problem = "A role is one lowercase word, like design."; draw(); return; }
        void act("add", () => attempt("team.add", { project: project.slug, role: r, ...(brief.value.trim() ? { brief: brief.value.trim() } : {}) }), () => { st.adding = false; }); } },
        role, brief, h("button", { class: "btn btn-primary btn-sm", type: "submit", "data-act": "add-go", disabled: st.busy === "add" }, "Add"),
        h("button", { class: "btn btn-ghost btn-sm", type: "button", "data-act": "add-cancel", onclick: () => { st.adding = false; st.problem = null; draw(); } }, "Cancel"))
        : h("div", { class: "tm-actions" }, h("button", { class: "btn btn-sm", type: "button", "data-act": "add", onclick: () => { st.adding = true; draw(); } }, "Add a teammate"))));
  }

  for (const t of EVENTS) ctx.on?.(t, () => { void load(); });
  await load();
}
