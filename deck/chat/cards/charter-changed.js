// @ts-check
// "Charter changed by <agent>": a quiet row in a teammate's thread when an agent (not the person)
// wrote a new version of the teammate's charter. A notice, never a prompt: nothing waits on it and
// nothing is blocked. It says who and which version, "Show changes" opens the diff (team.charter.diff)
// inline, and Revert is one tap (team.charter.revert to the version before, which is itself a new
// version, so a revert can be undone the same way). It leaves when the person dismisses it.
//
// Data, from the teammate.charter-changed event: { agent, project, version, previous, by, note, at? }.
// The person's own edits (Settings, the CLI) never draw this row: agentMade(by) is false for them.

import { h, put } from "../../js/dom.js";
import { attempt } from "../../js/api.js";
import { icon } from "../../js/icons.js";
import { renderUnified } from "../lib/diff.js";
import { ensureCss, problemText } from "./kit.js";

/** Who wrote a version when it was the person: a surface, not an agent. */
const PERSON = new Set(["", "deck", "cli", "local", "capsule", "phone", "vyre", "person"]);
/** Whether `by` names an agent, so the person should hear about the change. @param {any} by */
export const agentMade = by => !PERSON.has(String(by ?? "").trim().toLowerCase());

/**
 * @param {{ agent: string, project?: string|null, version: number, previous?: number|null, by: string, note?: string|null, at?: number|null }} data
 * @param {{ onDismiss?: () => void }} [ctx]
 * @returns {HTMLElement & { update: (d: any) => void }}
 */
export function charterChanged(data, ctx = {}) {
  ensureCss("charter-changed");
  const el = /** @type {any} */ (h("div", { class: "cv-row cv-charter", role: "status", "aria-live": "polite" }));
  el._kind = "assistant";
  el._ts = data?.at ?? null;
  const st = { open: false, diff: /** @type {any} */ (null), busy: false, error: /** @type {any} */ (null), reverted: /** @type {number|null} */ (null) };
  const ref = () => ({ teammate: data.agent });

  async function show() {
    st.open = !st.open;
    if (st.open && !st.diff) {
      st.busy = true; st.error = null; draw();
      const r = await attempt("team.charter.diff", { ...ref(), version: data.version });
      st.busy = false;
      if (r.error) { st.error = r.error; st.open = false; } else st.diff = r.data;
    }
    draw();
  }
  async function revert() {
    if (st.busy || st.reverted != null || !data.previous) return;
    st.busy = true; st.error = null; draw();
    const r = await attempt("team.charter.revert", { ...ref(), version: data.previous });
    st.busy = false;
    if (r.error) st.error = r.error; else st.reverted = data.previous;
    draw();
  }

  function draw() {
    const line = st.reverted != null ? `Charter back to version ${st.reverted} · was changed by ${data.by}` : `Charter changed by ${data.by}` + (data.note ? ` · ${data.note}` : "");
    const before = st.diff?.before?.text ?? "";
    put(el,
      h("div", { class: "cv-charter-row" },
        h("span", { class: "cv-charter-ico", "aria-hidden": "true" }, icon(st.reverted != null ? "check" : "edit", 16)),
        h("span", { class: "cv-charter-line ellipsis", title: line }, line),
        st.reverted == null && data.previous ? h("button", { class: "btn btn-ghost btn-sm cv-charter-revert", type: "button", "data-act": "revert", disabled: st.busy, "aria-busy": st.busy ? "true" : null, onclick: revert }, st.busy && !st.open ? "Reverting" : "Revert") : null,
        h("button", { class: "cv-charter-show", type: "button", "data-act": "show", "aria-expanded": String(st.open), onclick: show }, st.open ? "Hide changes" : "Show changes"),
        h("button", { class: "ibtn cv-charter-x", type: "button", "data-act": "dismiss", "aria-label": "Dismiss", onclick: () => { el.remove?.(); ctx.onDismiss?.(); } }, icon("close", 14))),
      st.open && st.diff ? h("div", { class: "cv-charter-diff", "aria-label": `Changes in version ${data.version}` }, renderUnified(before, String(st.diff.text ?? ""))) : null,
      st.error ? h("div", { class: "cv-charter-problem" }, "That did not go through. " + problemText(st.error)) : null);
  }
  el.update = (/** @type {any} */ d) => { data = { ...data, ...d }; draw(); };
  draw();
  return el;
}
