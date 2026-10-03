// @ts-check
// UI lab scenarios for Now and the task page, on the mock store (see lab.js). The clock is fixed to Thursday 1 October 2026, 13:00, as in the prototype's shots.
//   now         Now as the morning after a payment (7 things need Alex)
//   now-paid    the "client pays" scenario already played on top of it
//   task        the Research task of Doe estate plan (k1, done)       task?id=k5 opens another
//   task-draft  the Q3 report draft waiting for Alex (k13)
//   task-stuck  juno stopped on the court portal (k6)
// The Now scenario has a Play button: it plays "client pays" step by step, and the new card appears by itself.
import { h, put } from "../../js/dom.js";
import { createMockStore } from "../mock-store.js";
import { setStore } from "../store.js";
import { runClientPays } from "../scenario.js";
import { button } from "../components/index.js";

const NOW = new Date(2026, 9, 1, 13, 0, 0).getTime();

/** @param {"morning"|"payday"|"empty"} world */
function freshStore(world) { const s = createMockStore({ world, now: () => NOW }); setStore(s); return s; }

/** @param {string} name @param {Record<string, string>} params */
async function mount(name, params) {
  const mod = await import(`../../views/ui-${name}.js`);
  const root = h("div", { class: "un-lab-root" });
  await mod.default({ root, params: { screen: name, ...params }, now: () => NOW, cleanup() {} });
  return root;
}

const RIBBON = /** @type {Record<number, string>} */ ({
  1: "Jane Doe paid $1,500. Flow On payment is starting the work.",
  2: "Doe estate plan was created from the Kit Estate planning matter. The team is working.",
  3: "Research filled 3 fields and added a note with 3 sources.",
  4: "Intake drafted the Welcome email. It waits for one tap.",
});

export const scenarios = {
  async now() {
    freshStore("morning");
    const wrap = h("div", { class: "un-lab" });
    const bar = h("div", { class: "un-lab-bar" });
    const ribbon = h("p", { class: "un-hint", role: "status" }, "Local sample data. Nothing is sent.");
    const screen = h("div");
    const draw = async () => put(screen, await mount("now", { a: "" }));
    const play = button({ label: "Play: client pays", kind: "primary", size: "sm", onclick: async () => {
      play.disabled = true;
      freshStore("payday");
      await draw();
      await runClientPays(/** @type {any} */ (await import("../store.js")).getStore(), { pace: 1400, sleep: ms => new Promise(r => setTimeout(r, ms)), onStep: n => { ribbon.textContent = RIBBON[n] || ""; } });
      play.disabled = false;
    } });
    put(bar, play, ribbon);
    put(wrap, bar, screen);
    await draw();
    return wrap;
  },
  async "now-paid"() {
    const store = freshStore("payday");
    await runClientPays(store, {});
    return mount("now", { a: "" });
  },
  async task({ q }) { freshStore("morning"); return mount("task", { a: q.get("id") || "k1" }); },
  async "task-draft"({ q }) { freshStore("morning"); return mount("task", { a: q.get("id") || "k13" }); },
  async "task-stuck"({ q }) { freshStore("morning"); return mount("task", { a: q.get("id") || "k6" }); },
};
