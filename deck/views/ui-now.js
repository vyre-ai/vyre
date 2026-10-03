// @ts-check
// /u/now: Now, a configurable view over tasks (team/0.3/DESIGN-tasks.md). The greeting and the date, scope pills (All spaces, Mine, Harlow Legal), "Needs you" (a
// task card for every task that needs the person: a check, a thing to do, or a stuck task that is theirs), today's calendar, Recent events, and Edit Now to choose
// and order the sections. The layout is kept per scope in localStorage (inside try/catch: Now draws without it). The right column starts at 1000 px; a phone gets
// one column, in the same order. Everything reads the Store (ui/store.js) and redraws when it changes.
import { h, put } from "../js/dom.js";
import { pageHeader } from "../js/page-header.js";
import { getStore } from "../ui/store.js";
import { button, iconButton, chip, card, row, banner, emptyState, errorState, loading } from "../ui/components/index.js";
import { needsYou, STATE_LABEL, ownerOf } from "../ui/tasks.js";
import { loadContext, loadRecords, watchStore, taskCard, openTaskSheet, actorAvatar, actorById, nameOf, recordTitle, spaceChip, spaceMark, whenLabel, dateLine } from "../ui/task-card.js";

/** @typedef {import("../ui/task-card.js").Ctx} Ctx */

/** The sections a person can put on Now. `col`: 0 is the main column, 1 the side column from 1000 px. */
export const SECTIONS = /** @type {Record<string, { title: string, col: 0|1 }>} */ ({
  needs: { title: "Needs you", col: 0 },
  work: { title: "Assistants working", col: 0 },
  stuck: { title: "Stuck", col: 0 },
  my: { title: "My tasks", col: 0 },
  cal: { title: "Today's calendar", col: 1 },
  recent: { title: "Recent", col: 1 },
});

/** The layout a scope starts with. */
export const DEFAULT_LAYOUT = /** @type {Record<string, string[]>} */ ({
  all: ["needs", "work", "stuck", "my", "cal", "recent"],
  harlow: ["needs", "work", "stuck", "cal", "recent"],
  mine: ["needs", "my", "cal", "recent"],
});
const KEY = "vyre.ui.now.layout.v1";

/** @returns {Record<string, string[]>} */
function readLayouts() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "{}");
    /** @type {Record<string, string[]>} */
    const out = {};
    for (const [k, v] of Object.entries(raw)) if (Array.isArray(v)) out[k] = v.filter(id => typeof id === "string" && id in SECTIONS);
    return out;
  } catch { return {}; }
}
/** @param {Record<string, string[]>} v */
function writeLayouts(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* Now still works without it */ } }

/** @param {number} at */
function greeting(at) { const hr = new Date(at).getHours(); return hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening"; }
const firstName = (/** @type {string} */ n) => n.split(" ")[0];

/** @param {any} ctx the Deck's screen context ({ root, cleanup }), or the lab's; `now` is an optional clock */
export default async function screen(ctx) {
  const root = /** @type {HTMLElement} */ (ctx.root);
  const clock = ctx.now || (() => Date.now());
  const store = getStore();
  const state = { scope: "all", editing: false, layouts: readLayouts(), drawing: 0, /** @type {Set<string>|null} */ seen: null };
  root.classList.add("un-now");
  put(root, loading({ rows: 4 }));

  const layout = () => state.layouts[state.scope] || DEFAULT_LAYOUT[state.scope] || DEFAULT_LAYOUT.all;
  /** @param {string[]} next */
  const setLayout = next => { state.layouts[state.scope] = next; writeLayouts(state.layouts); void draw(); };

  async function draw() {
    const token = ++state.drawing;
    try {
      const c = await loadContext(store);
      const [allTasks, events, cal] = await Promise.all([store.tasks({}), store.events({ limit: 40 }), store.calendar ? store.calendar() : Promise.resolve([])]);
      await loadRecords(c, [...allTasks.map(t => t.record), ...allTasks.map(t => t.template), ...events.map(e => e.record)]);
      if (token !== state.drawing) return;
      put(root, view(c, allTasks, events, cal));
    } catch (e) {
      if (token !== state.drawing) return;
      put(root, errorState({ title: "Could not load Now.", reason: String(/** @type {any} */ (e)?.message || e), retry: () => { put(root, loading({ rows: 4 })); void draw(); } }));
    }
  }

  /** @param {Ctx} c @param {import("../ui/contracts.js").Task[]} allTasks @param {import("../ui/contracts.js").VyreEvent[]} events @param {any[]} cal */
  function view(c, allTasks, events, cal) {
    const inScope = (/** @type {string|undefined} */ recordId) => state.scope === "all" || c.records.get(recordId || "")?.space === state.scope;
    const tasks = allTasks.filter(t => inScope(t.record));
    const mine = tasks.filter(t => needsYou(t, c.me, c.actors));
    const showSpace = state.scope === "all";
    const me = actorById(c, c.me);
    const now = clock();

    // Which cards are new since the last draw: they glow once.
    const ids = new Set(mine.map(t => t.id));
    const fresh = state.seen ? new Set([...ids].filter(i => !state.seen?.has(i))) : new Set();
    state.seen = ids;

    const working = [...new Set(allTasks.filter(t => t.state === "working").map(t => t.doer))].slice(0, 3);
    const header = pageHeader({
      title: `${greeting(now)}, ${firstName(me?.name || "there")}`,
      meta: `${dateLine(now)} · ${mine.length === 0 ? "nothing needs you" : mine.length === 1 ? "1 thing needs you" : `${mine.length} things need you`}`,
      actions: [working.length ? h("span", { class: "un-stack", "aria-label": "Working now" }, working.map(id => actorAvatar(actorById(c, id), 28))) : null,
        button({ label: state.editing ? "Done" : "Edit Now", kind: state.editing ? "secondary" : "ghost", size: "sm", onclick: () => { state.editing = !state.editing; void draw(); } })],
    });

    const pills = h("div", { class: "un-pills", role: "group", "aria-label": "Spaces" }, [{ id: "all", name: "All spaces" }, ...c.spaces].map(s =>
      h("button", { type: "button", class: "un-pill", "aria-pressed": String(state.scope === s.id), onclick: () => { state.scope = s.id; void draw(); } },
        s.id === "all" ? null : spaceMark(/** @type {any} */ (s)), s.name)));

    const order = layout();
    const cols = [[], []].map(() => /** @type {string[]} */ ([]));
    for (const id of order) cols[SECTIONS[id].col].push(id);
    /** @param {string} id */
    const section = id => {
      const i = order.indexOf(id);
      const spec = SECTIONS[id];
      const count = id === "needs" ? mine.length : undefined;
      const tools = state.editing ? h("span", { class: "un-tools" },
        iconButton({ icon: "chevron", label: `Move ${spec.title} up`, size: 36, onclick: () => i > 0 && setLayout(swap(order, i, i - 1)) }),
        iconButton({ icon: "chevron", label: `Move ${spec.title} down`, size: 36, onclick: () => i < order.length - 1 && setLayout(swap(order, i, i + 1)) }),
        iconButton({ icon: "close", label: `Remove ${spec.title}`, size: 36, onclick: () => setLayout(order.filter(x => x !== id)) })) : null;
      tools?.firstElementChild?.classList.add("un-up");
      return h("section", { class: "un-sec", "data-sec": id },
        h("div", { class: "un-sec-h" }, h("h2", { class: "un-sec-t" }, spec.title + (count !== undefined ? ` · ${count}` : "")), tools),
        body(id));
    };

    /** @param {string} id */
    function body(id) {
      if (id === "needs") {
        return mine.length ? h("div", { class: "un-stack-v" }, mine.map(t => taskCard(c, t, { showSpace, fresh: fresh.has(t.id) })))
          : card({}, emptyState({ title: "Nothing needs you", body: "Tasks that wait on you show up here." }));
      }
      if (id === "my") {
        const list = tasks.filter(t => t.doer === c.me && t.state !== "done" && t.state !== "skipped" && !needsYou(t, c.me, c.actors));
        return card({}, list.length ? list.map(t => row({ lead: h("span", { class: `un-dot is-${t.state}` }), title: t.title, sub: `${recordTitle(c, c.records.get(t.record))} · ${STATE_LABEL[t.state]}`,
          end: showSpace ? spaceChip(c.spaces.find(s => s.id === c.records.get(t.record)?.space)) : null, onclick: () => openTaskSheet(c, t) })) : emptyState({ title: "All clear" }));
      }
      if (id === "work") {
        const list = tasks.filter(t => t.state === "working");
        return list.length ? card({}, list.map(t => row({ lead: actorAvatar(actorById(c, t.doer), 32), title: recordTitle(c, c.records.get(t.record)),
          sub: `${nameOf(c, t.doer)} ${t.now || `is working on ${t.title.toLowerCase()}`}`, end: [h("span", { class: "un-dot is-working" }), showSpace ? spaceChip(c.spaces.find(s => s.id === c.records.get(t.record)?.space)) : null], onclick: () => openTaskSheet(c, t) })))
          : h("p", { class: "un-hint" }, "Nobody is working right now.");
      }
      if (id === "stuck") {
        const list = tasks.filter(t => t.state === "stuck");
        return card({}, list.length ? list.map(t => {
          const who = ownerOf(t.doer, c.actors);
          return row({ lead: actorAvatar(actorById(c, t.doer), 32), title: /** @type {any} */ (t).say || t.title, sub: `${t.stuck?.reason || ""} · ${who === c.me ? "With you" : `With ${nameOf(c, who)}`}`,
            end: chip("Stuck", { tone: "sealed" }), onclick: () => openTaskSheet(c, t) });
        }) : emptyState({ title: "Nothing is stuck" }));
      }
      if (id === "cal") {
        return card({}, cal.length ? cal.map(e => h("div", { class: "un-cal" }, h("span", { class: "un-cal-t" }, whenLabel(e.at, e.at)),
          h("span", { class: "un-cal-b" }, h("b", null, e.title), e.sub ? h("span", { class: "un-meta" }, e.sub) : null))) : emptyState({ title: "Nothing on your calendar today" }));
      }
      // recent
      const list = events.filter(e => e.record ? inScope(e.record) : state.scope !== "mine").slice(0, 5);
      return list.length ? h("div", { class: "un-recent" }, list.map(e => {
        const a = actorById(c, e.actor);
        const who = e.actor === c.me ? "You" : a?.kind === "person" ? firstName(a.name) : a?.name || "Vyre";
        return h("div", { class: "un-act" }, actorAvatar(a, 24), h("span", { class: "un-act-t" }, `${who} ${e.what}`), h("time", { class: "un-act-at" }, whenLabel(e.at, now)));
      })) : h("p", { class: "un-hint" }, "Nothing has happened yet.");
    }

    const editBar = state.editing ? banner({ tone: "plain", icon: "info" }, h("b", null, "Editing Now"), " ", h("span", { class: "un-meta" },
      `Layout for ${state.scope === "all" ? "All spaces" : c.spaces.find(s => s.id === state.scope)?.name}. Move a section, remove it, or add one.`)) : null;
    const unused = Object.keys(SECTIONS).filter(id => !order.includes(id));
    const adder = state.editing ? card({ title: "Add a section" }, h("div", { class: "un-chips" }, unused.map(id =>
      h("button", { type: "button", class: "un-add", onclick: () => setLayout([...order, id]) }, `Add ${SECTIONS[id].title}`)), unused.length ? null : h("span", { class: "un-hint" }, "Every section is on Now.")),
      state.layouts[state.scope] ? button({ label: "Use the default layout", kind: "ghost", size: "sm", onclick: () => { delete state.layouts[state.scope]; writeLayouts(state.layouts); void draw(); } }) : null) : null;

    return h("div", { class: "un-wrap" }, header, pills, editBar,
      h("div", { class: "un-cols" }, h("div", { class: "un-col" }, cols[0].map(section)), h("div", { class: "un-col" }, cols[1].map(section))), adder);
  }

  watchStore(store, ctx, root, () => void draw());
  await draw();
}

/** @param {string[]} a @param {number} i @param {number} j */
function swap(a, i, j) { const b = [...a]; [b[i], b[j]] = [b[j], b[i]]; return b; }

