// @ts-check
// UI lab scenarios for the project page and Projects, on the mock store (see lab.js). The clock is fixed to Thursday 1 October 2026, 13:00, as in the prototype's shots.
//   project       the Doe estate plan (m1) as a project: the stage strip, its tasks by stage, the team and what each teammate is doing    project?id=m3 opens another
//   project-paid  the same page after "client pays" has run: the new matter, Research done, the Welcome email waiting for one tap
//   projects      every record of a type that holds work, in one list
// The project scenario has a Play button: it finishes the Engagement stage (the letter is checked and sent, the review is decided), and the page moves on by itself.
import { h, put } from "../../js/dom.js";
import { createMockStore } from "../mock-store.js";
import { getStore, setStore } from "../store.js";
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

/** Finish the Engagement stage of the Doe estate plan, step by step: the draft is checked and sent, the review is decided, and the stage moves on. */
async function finishEngagement(/** @type {any} */ store, /** @type {(ms: number) => Promise<void>} */ sleep, /** @type {(s: string) => void} */ say) {
  const tasks = await store.tasks({ record: "m1" });
  const letter = tasks.find((/** @type {any} */ t) => t.title === "Engagement letter"), review = tasks.find((/** @type {any} */ t) => t.title.startsWith("Review the draft"));
  say("Drafting finished the letter. It waits for Alex Rivera.");
  await store.updateTask(letter.id, { result: { draft: { subject: "Engagement letter, Doe estate plan", body: "Client: Jane Doe\nMatter: Doe estate plan\n\nThis letter confirms that Harlow Legal will act for you in this matter.\n\nHarlow Legal", sources: 1 } }, state: "needs_check" }, "drafting");
  await sleep(1400);
  say("Alex approved and sent the letter.");
  await store.approveTask(letter.id, { method: "face_id" });
  await sleep(1400);
  say("Alex reviewed it with Jane Doe. The last required task is done.");
  await store.updateTask(review.id, { result: { decision: { answer: "yes", reason: "Jane approved the letter as written." } }, state: "done" }, "alex");
  await sleep(300);
  say("The matter moved to Drafting by itself.");
}

export const scenarios = {
  async project({ q }) {
    const store = freshStore("morning");
    const wrap = h("div", { class: "un-lab" });
    const ribbon = h("p", { class: "un-hint", role: "status" }, "Local sample data. Nothing is sent.");
    const screen = h("div");
    const play = button({ label: "Play: finish Engagement", kind: "primary", size: "sm", onclick: async () => {
      play.disabled = true;
      await finishEngagement(getStore(), ms => new Promise(r => setTimeout(r, ms)), s => { ribbon.textContent = s; });
      play.disabled = false;
    } });
    void store;
    put(wrap, h("div", { class: "un-lab-bar" }, play, ribbon), screen);
    put(screen, await mount("project", { a: q.get("id") || "m1" }));
    return wrap;
  },
  async "project-paid"({ q }) {
    const store = freshStore("payday");
    const made = await runClientPays(store, {});
    return mount("project", { a: q.get("id") || made.matter });
  },
  async projects() { freshStore("morning"); return mount("projects", { a: "" }); },
};
