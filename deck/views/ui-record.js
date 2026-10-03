// @ts-check
// /u/record/:id: one record, its page drawn from the type's definition (ui/views.js recordPage), read from the Store. The page asks the Store for what it shows:
// fields, the event timeline, the work around it (the team, from the record's tasks), the records that link to it. Reveal goes through store.reveal with the proof.
import { h, put, go, back } from "../js/dom.js";
import { pageHeader } from "../js/page-header.js";
import { loading } from "../js/states.js";
import { iconButton, chip, errorState, emptyState } from "../ui/components/index.js";
import { getFieldStore, linkIndex, reasonOf } from "../ui/field-screens.js";
import { recordPage, titleOf } from "../ui/views.js";

/** @param {any} ctx */
export default async function screen(ctx) {
  const id = ctx.params.a;
  put(ctx.root, loading());
  /** @type {any} */
  let page = null;
  /** @type {null | (() => void)} */
  let off = null;

  async function draw() {
    try {
      const store = await getFieldStore();
      const row = id ? await store.get(id) : null;
      const types = await store.types();
      if (!row) { put(ctx.root, h("div", { class: "uv-page" }, emptyState({ title: "That record is not here", body: "It may have been removed, or it lives in a space you cannot see." }))); return; }
      const def = types.find(t => t.id === row.type);
      if (!def) { put(ctx.root, h("div", { class: "uv-page" }, errorState({ title: "That record has no type.", reason: `Nothing defines "${row.type}".` }))); return; }
      const [actors, spaces, links, events, tasks, same] = await Promise.all([store.actors(), store.spaces(), linkIndex(store, types), store.events({ record: id }), store.tasks({ record: id }), store.list(def.id)]);
      // Records that link to this one (a contact's matters), for Linked records.
      const related = [];
      for (const t of types) for (const f of t.fields) if (f.kind === "link" && f.link === def.id)
        for (const r of await store.list(t.id)) if (r.values[f.key] === id) related.push({ id: r.id, title: titleOf(t, r), type: t.id });
      const ids = [...new Set(tasks.flatMap(t => [t.doer, t.checker, ...(t.helpers || [])]).filter(/** @returns {x is string} */ x => !!x))];
      const team = ids.map(i => { const a = actors.find(x => x.id === i); const w = tasks.find(t => t.doer === i && t.state === "working"); return { id: i, role: a?.role, doing: w?.now ? `${a?.name} ${w.now}` : a?.role }; });
      const working = tasks.find(t => t.state === "working" && t.now);
      const o = { actors, links, now: Date.now(), rows: same, events, related, team, who: "person",
        doing: working ? `${actors.find(a => a.id === working.doer)?.name} ${working.now}` : null,
        open: (/** @type {string} */ to) => go(`/u/record/${encodeURIComponent(to)}`),
        reveal: (/** @type {string} */ rid, /** @type {string} */ key, /** @type {any} */ proof) => store.reveal(rid, key, proof),
        seesAs: (/** @type {string} */ rid) => store.seesAs(rid, "assistant"),
        onupdate: (/** @type {Record<string, any>} */ patch) => store.update(row.id, patch),
        onaddfield: /** @type {any} */ (store).addField ? (/** @type {any} */ f) => /** @type {any} */ (store).addField(def.id, f) : undefined,
        onsealtype: /** @type {any} */ (store).sealField ? (/** @type {string} */ k) => /** @type {any} */ (store).sealField(def.id, k) : undefined };
      const space = spaces.find(s => s.id === row.space);
      page = recordPage(def, row, o);
      put(ctx.root, h("div", { class: "uv-page" },
        h("div", { class: "uv-head" }, iconButton({ icon: "left", label: `Back to ${def.plural}`, onclick: () => back(`/u/records/${def.id}`) }),
          pageHeader({ title: titleOf(def, row), meta: h("span", { class: "uv-meta" }, chip(def.name), space ? chip(space.name) : null) })),
        page));
      if (!off) { off = store.subscribe(async () => { const fresh = await store.get(id); if (fresh && page) page.setRow(fresh); }); ctx.cleanup?.(() => off?.()); }
    } catch (e) {
      put(ctx.root, h("div", { class: "uv-page" }, errorState({ title: "That record could not be opened.", reason: reasonOf(e), retry: draw })));
    }
  }
  await draw();
}
