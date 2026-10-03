// @ts-check
// /u/projects: every record of a type that holds work (Matters, Projects, Trips), in one list, from the Store. Scope chips narrow it by space and by type; a row
// opens /u/project/:id. Name, Type, Stage, Owner and how many of its tasks are done. No code here knows what a Matter is: a type that holds work is listed.
import { h, put, go } from "../js/dom.js";
import { pageHeader } from "../js/page-header.js";
import { icon } from "../js/icons.js";
import { loading } from "../js/states.js";
import { button, menu, table, emptyState, errorState } from "../ui/components/index.js";
import { getFieldStore, reasonOf } from "../ui/field-screens.js";
import { titleOf } from "../ui/views.js";
import { actorAvatar, spaceChip, spaceMark, tintOf, watchStore } from "../ui/task-card.js";
import { actorOf } from "../ui/tasks.js";

/** @param {any} ctx */
export default async function screen(ctx) {
  const root = /** @type {HTMLElement} */ (ctx.root);
  const state = { space: "all", type: "all" };
  root.classList.add("up-root");
  put(root, loading());
  let drawing = 0;

  async function draw() {
    const token = ++drawing;
    try {
      const store = await getFieldStore();
      const [types, spaces, actors, tasks] = await Promise.all([store.types(), store.spaces(), store.actors(), store.tasks()]);
      if (token !== drawing) return;
      const work = types.filter(t => t.holdsWork);
      if (!work.some(t => t.id === state.type)) state.type = "all";
      if (state.space !== "all" && !spaces.some(s => s.id === state.space)) state.space = "all";
      const lists = await Promise.all(work.filter(t => state.type === "all" || t.id === state.type).map(async t => ({ t, rows: await store.list(t.id, state.space === "all" ? {} : { space: state.space }) })));
      if (token !== drawing) return;
      const items = lists.flatMap(({ t, rows }) => rows.map(r => ({ def: t, row: r })));
      const progress = (/** @type {string} */ id) => { const own = tasks.filter(t => t.record === id); return own.length ? `${own.filter(t => t.state === "done" || t.state === "skipped").length} of ${own.length} tasks` : "No tasks"; };
      const ownerKey = (/** @type {any} */ def) => def.fields.find((/** @type {any} */ f) => f.kind === "actor")?.key || "owner";
      const columns = [
        { key: "name", label: "Name", render: (/** @type {any} */ i) => { const sp = spaces.find(s => s.id === i.row.space); return h("span", { class: "up-name" },
          h("span", { class: "up-em up-em-sm", style: `--tint:${tintOf(sp)}`, "aria-hidden": "true" }, icon(/** @type {any} */ (i.def.icon), 18)), h("b", null, titleOf(i.def, i.row)), spaceChip(sp)); } },
        { key: "type", label: "Type", render: (/** @type {any} */ i) => i.def.name },
        { key: "stage", label: "Stage", render: (/** @type {any} */ i) => i.row.stage || "" },
        { key: "owner", label: "Owner", render: (/** @type {any} */ i) => { const a = actorOf(String(i.row.values[ownerKey(i.def)] || ""), actors); return a ? h("span", { class: "up-owner" }, actorAvatar(a, 22), a.name) : ""; } },
        { key: "tasks", label: "Tasks", render: (/** @type {any} */ i) => progress(i.row.id) },
      ];
      const pill = (/** @type {string} */ key, /** @type {string} */ id, /** @type {any} */ label, /** @type {any} */ lead) =>
        h("button", { type: "button", class: "un-pill", "aria-pressed": String(state[/** @type {"space"|"type"} */ (key)] === id), onclick: () => { state[/** @type {"space"|"type"} */ (key)] = id; void draw(); } }, lead, label);
      const newBtn = button({ label: "New", kind: "primary", icon: "plus", onclick: () => menu({ anchor: newBtn, items: work.map(t => ({ label: `New ${t.name.toLowerCase()}`, onclick: async () => {
        const r = await store.create(t.id, { [t.titleKey]: `New ${t.name.toLowerCase()}` });
        go(`/u/project/${encodeURIComponent(r.id)}`);
      } })) }) });
      put(root, h("div", { class: "uv-page up-page" },
        pageHeader({ title: "Projects", actions: [newBtn] }),
        h("div", { class: "un-pills up-pills", role: "group", "aria-label": "Space" }, [{ id: "all", name: "All spaces" }, ...spaces].map(s => pill("space", s.id, s.name, s.id === "all" ? null : spaceMark(/** @type {any} */ (s))))),
        h("div", { class: "un-pills up-pills", role: "group", "aria-label": "Type" }, [["all", "All"], ...work.map(t => [t.id, t.plural])].map(([id, label]) => pill("type", id, label, null))),
        items.length ? table({ columns, rows: items, onrow: i => go(`/u/project/${encodeURIComponent(i.row.id)}`) })
          : emptyState({ title: "Nothing here yet", body: "A record of a type that holds work shows up here with its tasks and its team." })));
    } catch (e) {
      if (token === drawing) put(root, h("div", { class: "uv-page" }, errorState({ title: "Projects are not available.", reason: reasonOf(e), retry: () => void draw() })));
    }
  }
  const store = await getFieldStore();
  watchStore(store, ctx, root, () => void draw());
  await draw();
}
