// @ts-check
// /u/project/:id: a record of a type that holds work, as a project (team/0.3/DESIGN-tasks.md, ui-primitives.md 4.2). It is the record page (ui/views.js recordPage:
// the stage strip, You / Your assistant sees, the fields, the timeline, linked records, chats and files) with the work around it: each stage is a list of its
// tasks, the current one open, and the team shows what each teammate is doing right now. When the last required task of a stage is done the record moves on by
// itself; this page redraws from the Store and says so. A task opens its card sheet in place; the sheet leads to /u/task/:id.
import { h, put, go, back } from "../js/dom.js";
import { pageHeader } from "../js/page-header.js";
import { icon } from "../js/icons.js";
import { loading } from "../js/states.js";
import { iconButton, chip, errorState, emptyState, showToast } from "../ui/components/index.js";
import { getFieldStore, linkIndex, reasonOf, relatedRecords } from "../ui/field-screens.js";
import { recordPage, titleOf } from "../ui/views.js";
import { createdLine, liveLine, projectTasks, teamOf } from "../ui/project.js";
import { loadContext, loadRecords, openTaskSheet, spaceChip, tintOf, watchStore } from "../ui/task-card.js";

/** @param {any} ctx */
export default async function screen(ctx) {
  const root = /** @type {HTMLElement} */ (ctx.root);
  const id = String(ctx.params?.a || "");
  root.classList.add("up-root");
  put(root, loading());
  /** @type {any} */
  let built = null;
  let drawing = 0;

  async function draw() {
    const token = ++drawing;
    try {
      const store = await getFieldStore();
      const row = id ? await store.get(id) : null;
      const types = await store.types();
      if (!row) { put(root, h("div", { class: "uv-page" }, emptyState({ title: "That project is not here", body: "It may have been removed, or it lives in a space you cannot see." }))); built = null; return; }
      const def = types.find(t => t.id === row.type);
      if (!def) { put(root, h("div", { class: "uv-page" }, errorState({ title: "That record has no type.", reason: `Nothing defines "${row.type}".` }))); built = null; return; }
      const [actors, spaces, links, events, tasks, same, related, me] = await Promise.all([store.actors(), store.spaces(), linkIndex(store, types), store.events({ record: id }),
        store.tasks({ record: id }), store.list(def.id), relatedRecords(store, types, def, id), store.me ? store.me() : Promise.resolve("alex")]);
      if (token !== drawing) return;
      const stageField = def.fields.find(f => f.kind === "stage");
      const stages = stageField?.stages || [];
      const owner = String(row.values[def.fields.find(f => f.kind === "actor")?.key || "owner"] || "");
      const space = spaces.find(s => s.id === row.space);
      const o = built?.o || { who: "person", open: (/** @type {string} */ to) => go(`/u/record/${encodeURIComponent(to)}`),
        reveal: (/** @type {string} */ rid, /** @type {string} */ key, /** @type {any} */ proof) => store.reveal(rid, key, proof),
        seesAs: (/** @type {string} */ rid) => store.seesAs(rid, "assistant"),
        onupdate: (/** @type {Record<string, any>} */ patch) => store.update(row.id, patch),
        onaddfield: /** @type {any} */ (store).addField ? (/** @type {any} */ f) => /** @type {any} */ (store).addField(def.id, f) : undefined,
        onsealtype: /** @type {any} */ (store).sealField ? (/** @type {string} */ k) => /** @type {any} */ (store).sealField(def.id, k) : undefined,
        tasks: projectTasks({ me, open: async t => { if (ctx.openTask) return ctx.openTask(t); const c = await loadContext(store); await loadRecords(c, [t.record, t.template]); openTaskSheet(c, t); } }) };
      Object.assign(o, { actors, links, now: Date.now(), rows: same, events, related, team: teamOf({ tasks, actors, owner }), doing: liveLine(tasks, actors) });
      const stage = stageField ? String(row.values[stageField.key] ?? row.stage ?? "") : row.stage;
      o.tasks.update({ tasks, stages, current: stage, actors, me });

      const created = createdLine(events, actors);
      const head = h("div", { class: "uv-head up-head" },
        iconButton({ icon: "left", label: `Back to Projects`, onclick: () => back("/u/projects") }),
        h("span", { class: "up-em", style: `--tint:${tintOf(space)}`, "aria-hidden": "true" }, icon(/** @type {any} */ (def.icon), 20)),
        pageHeader({ title: titleOf(def, row), meta: h("span", { class: "uv-meta" }, chip(def.name), space ? spaceChip(space) : null) }));
      const createdEl = created ? h("p", { class: "up-created" }, created) : null;

      if (!built) {
        const page = recordPage(def, row, o);
        built = { o, page, stage, headBox: h("div", { class: "up-headbox" }) };
        put(root, h("div", { class: "uv-page up-page" }, built.headBox, built.page));
      } else {
        built.page.setRow(row, def);
        if (built.stage !== undefined && stage && built.stage !== stage) {
          showToast({ text: `${titleOf(def, row)} moved to ${stage}.` });
          const strip = built.page.querySelector?.(".ui-stages");
          strip?.classList.add("up-moved");
        }
        built.stage = stage;
      }
      put(built.headBox, head, createdEl);
    } catch (e) {
      if (token === drawing) put(root, h("div", { class: "uv-page" }, errorState({ title: "That project could not be opened.", reason: reasonOf(e), retry: () => { built = null; void draw(); } })));
    }
  }
  const store = await getFieldStore();
  watchStore(store, ctx, root, () => void draw());
  await draw();
}
