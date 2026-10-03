// @ts-check
// /u/task/:id: one task, as a page (team/0.3/DESIGN-tasks.md): who does it (one doer, accountable), who checks it, what done looks like, how it is made and what
// it starts from. A stuck task says why and offers Fix and Reassign; a drafted item shows the draft with its one sentence, and Send with Face ID and Edit.
import { h, put, link, back } from "../js/dom.js";
import { pageHeader } from "../js/page-header.js";
import { getStore } from "../ui/store.js";
import { button, iconButton, chip, banner, card, segmented, emptyState, errorState, loading, showToast } from "../ui/components/index.js";
import { STATE_LABEL, HOW_LABEL } from "../ui/tasks.js";
import { cardModel as model, loadContext, loadRecords, watchStore, taskFacts, draftBlock, recordTitle, spaceChip, runAction } from "../ui/task-card.js";

/** @param {any} ctx */
export default async function screen(ctx) {
  const root = /** @type {HTMLElement} */ (ctx.root);
  const store = getStore();
  const id = String(ctx.params?.a || "");
  root.classList.add("un-task");
  put(root, loading({ rows: 3 }));
  let drawing = 0;

  async function draw() {
    const token = ++drawing;
    try {
      const c = await loadContext(store);
      const task = await store.task(id);
      if (token !== drawing) return;
      if (!task) { put(root, emptyState({ title: "That task is gone", body: "It may have been removed.", action: button({ label: "Back to Now", kind: "primary", onclick: () => back("/u/now") }) })); return; }
      const siblings = await store.tasks({ record: task.record });
      await loadRecords(c, [task.record, task.template]);
      if (token !== drawing) return;
      const rec = c.records.get(task.record);
      const space = c.spaces.find(s => s.id === rec?.space);
      const tpl = task.template ? c.records.get(task.template) : null;
      const m = model({ task, record: rec, recordTitle: recordTitle(c, rec), actors: c.actors, me: c.me, space, templateName: tpl ? recordTitle(c, tpl) : undefined,
        fieldDef: k => c.types.get(rec?.type || "")?.fields.find(f => f.key === k) });
      const note = /** @type {any} */ (task).note;
      const chips = h("span", { class: "un-chips" },
        chip(STATE_LABEL[task.state], { tone: task.state === "done" ? "ok" : task.state === "stuck" ? "sealed" : task.state === "needs_check" || task.state === "ready" ? "accent" : "plain" }),
        rec ? link(`/u/record/${rec.id}`, { class: "ui-chip ui-chip-plain un-chip-link" }, recordTitle(c, rec)) : null,
        space ? spaceChip(space) : null,
        typeof note === "string" && note && !/^is /.test(note) ? chip(note) : null);

      const showHow = ["sent", "draft", "note"].includes(task.output?.kind);
      const how = showHow ? h("div", { class: "un-how" },
        segmented({ options: /** @type {[string, string][]} */ (Object.entries(HOW_LABEL)), value: task.how || "person", label: "How", onchange: async v => {
          try { await store.updateTask(task.id, { how: /** @type {any} */ (v) }, c.me); } catch (e) { showToast({ text: String(/** @type {any} */ (e)?.message || e) }); }
        } }),
        tpl ? link(`/u/record/${tpl.id}`, { class: "ui-chip ui-chip-accent un-chip-link" }, recordTitle(c, tpl)) : null) : undefined;

      const stuck = task.state === "stuck" && task.stuck ? banner({ tone: "warn", icon: "lock" },
        h("div", { class: "un-stuck" }, h("div", null, h("b", null, `${m.title}.`), " ", task.stuck.reason, " ", task.stuck.suggestedFix),
          h("div", { class: "un-btns" }, ...m.actions.map(a => button({ label: a.label, kind: a.kind, size: "sm", onclick: () => runAction(c, task, a.id, {}) }))))) : null;
      const draft = draftBlock(c, task, rec);
      const acts = task.state !== "stuck" && m.reason ? h("div", { class: "un-btns" }, m.actions.filter(a => a.id !== "open" && a.id !== "save").map(a => button({ label: a.label, kind: a.kind, icon: a.icon, onclick: () => runAction(c, task, a.id, {}) }))) : null;

      /** @type {Map<string, string>} */
      const titles = new Map(siblings.map(t => [t.id, t.title]));
      put(root, h("div", { class: "un-wrap" },
        h("div", { class: "un-thead" }, iconButton({ icon: "left", label: "Back", onclick: () => back(rec ? `/u/record/${rec.id}` : "/u/now") }), pageHeader({ title: task.title, meta: chips })),
        stuck, card({}, taskFacts(c, task, { record: rec, how, titles })),
        draft ? h("div", { class: "un-sec" }, h("div", { class: "un-sec-h" }, h("h2", { class: "un-sec-t" }, "The draft")), draft) : null,
        acts));
    } catch (e) {
      if (token === drawing) put(root, errorState({ title: "Could not load this task.", reason: String(/** @type {any} */ (e)?.message || e), retry: () => { put(root, loading({ rows: 3 })); void draw(); } }));
    }
  }
  watchStore(store, ctx, root, () => void draw());
  await draw();
}

