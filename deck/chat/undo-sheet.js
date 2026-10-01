// @ts-check
// Undo a session's changes (/undo): the commits this session made on its own branch, newest first. Pick
// the one to go back past ("this and everything after it come off"), or take off all of it. Nothing is
// deleted: the box saves the tip first and "Put back" returns it (github.session.undo / .redo), and
// anything not yet committed is kept with it. Drawn in the rewind sheet's box, with its look.
//
// Pure helpers first (tested without a DOM), then the sheet. The caller says how to talk to the box, so
// this file holds no tool names but the three it is given.
import { h, put } from "../js/dom.js";
import { plural } from "../js/fmt.js";

/** @typedef {{ sha: string, subject: string }} Commit */

/** The commits as the box lists them (newest first), cleaned. @param {any} d github.session.history's answer @returns {{ commits: Commit[], dirty: number }} */
export function historyOf(d) {
  const commits = (Array.isArray(d?.commits) ? d.commits : []).filter((/** @type {any} */ c) => c && typeof c.sha === "string" && c.sha)
    .map((/** @type {any} */ c) => ({ sha: String(c.sha), subject: String(c.subject || "(no message)") }));
  return { commits, dirty: Number(d?.dirty) > 0 ? Number(d.dirty) : 0 };
}

/** How many commits come off if the person goes back past this one: it and all the newer ones. @param {Commit[]} commits @param {string|null} sha null = everything */
export function takesOff(commits, sha) {
  if (sha === null) return commits.length;
  const i = commits.findIndex(c => c.sha === sha);
  return i < 0 ? 0 : i + 1;
}

/** One line for what an undo did. @param {any} out github.session.undo's answer */
export function undoneLine(out) {
  const n = Number(out?.undone) || 0;
  return `${n === 0 ? "Nothing to take off" : "Took off " + plural(n, "change")}${out?.kept_unsaved ? ", and kept your unsaved work with it" : ""}.`;
}

/**
 * @param {{ load: () => Promise<{ data?: any, error?: any }>, undo: (to: string|null) => Promise<{ data?: any, error?: any }>, redo: (n: number) => Promise<{ data?: any, error?: any }>,
 *   onClose: () => void, say?: (e: any) => string }} o
 * @returns {{ el: HTMLElement, load: () => Promise<void> }}
 */
export function undoSheet(o) {
  const say = o.say || ((/** @type {any} */ e) => String(e?.message || e?.code || "That did not work."));
  const st = { commits: /** @type {Commit[]} */ ([]), dirty: 0, busy: false, note: "", done: /** @type {{ n: number }|null} */ (null), gone: false };
  const el = h("div", { class: "cv-rewind cv-undo", role: "dialog", "aria-label": "Undo changes" });

  function draw() {
    const row = (/** @type {string|null} */ sha, /** @type {string} */ title, /** @type {string} */ sub) => h("button", { class: "cv-rewind-pt", type: "button", disabled: st.busy, "data-undo": sha ?? "all",
      onclick: () => go(sha) }, h("span", { class: "cv-rewind-t" }, title), h("span", { class: "cv-rewind-s" }, sub));
    put(el,
      h("div", { class: "cv-rewind-head" }, h("span", null, "Undo changes"), h("span", { class: "kbd" }, "Esc")),
      st.gone ? h("div", { class: "empty" }, "This session has no changes of its own to undo.")
        : st.done ? h("div", { class: "cv-rewind-note" }, h("p", null, undoneLine(st.done)), h("p", { class: "small muted" }, "Nothing was deleted."),
          h("div", { class: "cv-rewind-acts" }, h("button", { class: "btn", type: "button", "data-act": "redo", disabled: st.busy, onclick: putBack }, "Put back")))
          : st.commits.length || st.dirty ? h("div", { class: "cv-rewind-list", role: "list" },
            ...st.commits.map((c, i) => row(c.sha, c.subject, i === 0 ? "Take off just this" : `Take off this and ${plural(i, "newer change")}`)),
            st.commits.length > 1 ? row(null, "Everything this session did", `Take off all ${st.commits.length} changes`) : null)
            : h("div", { class: "empty" }, "Nothing to undo yet."),
      !st.gone && !st.done && st.dirty ? h("p", { class: "small muted" }, `${plural(st.dirty, "file")} not yet saved will be kept first, and come back with Put back.`) : null,
      h("div", { class: "cv-rewind-note", role: "status" }, st.note));
  }

  async function go(/** @type {string|null} */ sha) {
    if (st.busy) return;
    st.busy = true; st.note = "Taking it off…"; draw();
    const r = await o.undo(sha);
    st.busy = false;
    if (r.error) { st.note = say(r.error); draw(); return; }
    st.note = ""; st.done = { n: Number(r.data?.n) || 0, ...(r.data || {}) }; draw();
  }
  async function putBack() {
    if (st.busy || !st.done) return;
    st.busy = true; st.note = "Putting it back…"; draw();
    const r = await o.redo(st.done.n);
    st.busy = false;
    // Refused when the session moved on since: the saved changes stay kept, and the box says why.
    if (r.error) { st.note = say(r.error); draw(); return; }
    st.done = null; st.note = "Put back."; await load();
  }
  async function load() {
    const r = await o.load();
    if (r.error) { st.gone = true; st.note = say(r.error); draw(); return; }
    const d = historyOf(r.data);
    st.commits = d.commits; st.dirty = d.dirty; st.gone = false;
    draw();
  }
  draw();
  return { el, load };
}
