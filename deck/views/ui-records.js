// @ts-check
// /u/records/:type: every record of one type, as a list, a board, a calendar or a dashboard, drawn from the type's definition (ui/views.js) and read from the
// Store. Space chips narrow it; New adds a blank record and opens it. No code here knows what a Contact or a Matter is.
import { h, put, go } from "../js/dom.js";
import { pageHeader } from "../js/page-header.js";
import { loading } from "../js/states.js";
import { button, chip, segmented, errorState, emptyState } from "../ui/components/index.js";
import { getFieldStore, linkIndex, reasonOf } from "../ui/field-screens.js";
import { listView, boardView, calendarView, dashboardView } from "../ui/views.js";

/** @param {any} ctx */
export default async function screen(ctx) {
  const typeId = ctx.params.a || "contact";
  const state = { view: ctx.query?.get("view") || "list", space: "all" };
  put(ctx.root, loading());
  /** @type {null | (() => void)} */
  let off = null;

  async function draw() {
    try {
      const store = await getFieldStore();
      const [types, spaces, actors] = await Promise.all([store.types(), store.spaces(), store.actors()]);
      const def = types.find(t => t.id === typeId) || types.find(t => !t.holdsWork) || types[0];
      if (!def) { put(ctx.root, h("div", { class: "uv-page" }, emptyState({ title: "No types yet", body: "This space has no record types." }))); return; }
      const [rows, links] = await Promise.all([store.list(def.id, state.space === "all" ? {} : { space: state.space }), linkIndex(store, types)]);
      const kinds = /** @type {[string, string][]} */ ([["list", "List"], ...(def.views.board ? [["board", "Board"]] : []), ...(def.views.calendar ? [["calendar", "Calendar"]] : []), ...(def.views.dashboard ? [["dashboard", "Dashboard"]] : [])]);
      if (!kinds.some(k => k[0] === state.view)) state.view = "list";
      const o = { actors, links, open: (/** @type {string} */ id) => go(`/u/record/${encodeURIComponent(id)}`), now: Date.now(),
        rowExtra: state.space === "all" ? (/** @type {any} */ r) => { const s = spaces.find(x => x.id === r.space); return s ? chip(s.name, { tone: "plain" }) : null; } : null,
        empty: `No ${def.plural.toLowerCase()} here yet.` };
      const body = h("div", { class: "uv-body" });
      const view = () => put(body, state.view === "board" ? boardView(def, rows, o) : state.view === "calendar" ? calendarView(def, rows, o) : state.view === "dashboard" ? dashboardView(def, rows, o) : listView(def, rows, o));
      view();
      const scope = h("div", { class: "uv-chips", role: "group", "aria-label": "Space" },
        [["all", "All spaces"], ...spaces.map(s => [s.id, s.name])].map(([id, name]) =>
          h("button", { type: "button", class: "uv-fchip", "aria-pressed": String(state.space === id), onclick: () => { state.space = id; draw(); } }, name)));
      put(ctx.root, h("div", { class: "uv-page" },
        pageHeader({ title: def.plural, meta: state.space === "all" ? "Every space, one list. Pick a space to narrow it." : `In ${spaces.find(s => s.id === state.space)?.name}`,
          actions: [button({ label: `New ${def.name.toLowerCase()}`, kind: "secondary", icon: "plus", onclick: async () => {
            const r = await store.create(def.id, { [def.titleKey]: `New ${def.name.toLowerCase()}` });
            go(`/u/record/${encodeURIComponent(r.id)}`);
          } })] }),
        scope,
        kinds.length > 1 ? h("div", { class: "uv-bar" }, segmented({ options: kinds, value: state.view, label: "View", onchange: v => { state.view = v; view(); } })) : null,
        body));
      if (!off) { off = store.subscribe(() => { draw(); }); ctx.cleanup?.(() => off?.()); }
    } catch (e) {
      put(ctx.root, h("div", { class: "uv-page" }, errorState({ title: "Records are not available.", reason: reasonOf(e), retry: draw })));
    }
  }
  await draw();
}
