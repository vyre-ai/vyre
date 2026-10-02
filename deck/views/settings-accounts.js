// @ts-check
// Settings, AI accounts: every account the box can run a session on (Claude, Codex, Grok, OpenRouter), who each is signed in as, which is the
// default, and a way to add one with the provider's own sign-in. sessions.accounts.list reads them; .signin starts and follows a sign-in (the box long
// waits on the flow, so this loops on it only while its panel is open and stops when the section closes or the person cancels); .bind makes one the
// provider's default; .remove takes one away; .set records a Grok privacy choice. Nothing here ever shows a token: a login's secret is written by the
// provider's own command into that account's own folder and never read. Words only: no ids, no tool names.

import { h, put, empty } from "../js/dom.js";
import { attempt as apiAttempt } from "../js/api.js";
import { providerMark, providerName } from "../js/provider-mark.js";

const KIND_WORDS = { login: "Signed in with the provider", "api-key": "API key", "setup-token": "Setup token" };
/** Providers a person can add by signing in from here. Claude signs in on the machine it runs on, so it is not offered. */
export const ADDABLE = Object.freeze(["codex", "grok"]);

/**
 * sessions.accounts.list's rows, reduced to what is drawn.
 * @param {any} d @returns {{ id: string, provider: string, label: string, kind: string, isDefault: boolean, pending: boolean, needs: string|null, signedIn: boolean, synthetic: boolean,
 *   who: string, item: string|null, privacy: boolean|null, privacyLabel: string, privacyNote: string }[]}
 */
export function accountsOf(d) {
  return (Array.isArray(d) ? d : Array.isArray(d?.accounts) ? d.accounts : []).filter((/** @type {any} */ a) => a && typeof a.id === "string" && typeof a.provider === "string").map((/** @type {any} */ a) => ({
    id: String(a.id), provider: String(a.provider), label: String(a.label || providerName(a.provider)), kind: String(a.kind || "login"), isDefault: a.is_default === true || a.default === true,
    pending: a.pending === true, needs: a.needs === "sign-in" || a.needs === "confirm" ? a.needs : null, signedIn: a.synthetic === true || a.signed_in_at != null || a.signed_in === true,
    synthetic: a.synthetic === true, who: [a.identity?.email, a.identity?.org].filter((/** @type {any} */ x) => typeof x === "string" && x).join(", "),
    item: typeof a.vault_item === "string" && a.vault_item ? a.vault_item : null, privacy: typeof a.privacy === "boolean" ? a.privacy : null,
    privacyLabel: typeof a.privacy_label === "string" ? a.privacy_label : "", privacyNote: typeof a.privacy_note === "string" ? a.privacy_note : "" }));
}

/** One line for an account's state. @param {ReturnType<typeof accountsOf>[number]} a */
export function stateWord(a) {
  if (a.needs === "confirm") return "Waiting for you to confirm it";
  if (a.needs === "sign-in") return "Needs signing in again";
  if (a.pending) return "Waiting for you to finish it";
  if (a.synthetic) return "Signed in on this machine";
  if (a.kind === "login") return a.signedIn ? (a.who ? `Signed in as ${a.who}` : "Signed in") : "Not signed in yet";
  return KIND_WORDS[/** @type {keyof typeof KIND_WORDS} */ (a.kind)] || a.kind;
}

/** Whether a sign-in address is safe to draw as a link: https, no credentials, no whitespace. @param {string} u */
export const safeUrl = u => { try { if (/[\s\\\u0000-\u001f]/.test(u)) return false; const x = new URL(u); return x.protocol === "https:" && !x.username && !x.password; } catch { return false; } };

/** @param {HTMLElement} el @param {{ alive: () => boolean }} ctx @param {{ attempt?: typeof apiAttempt }} [deps] */
export async function drawAccounts(el, ctx, deps = {}) {
  const attempt = deps.attempt || apiAttempt;
  const st = { rows: /** @type {ReturnType<typeof accountsOf>} */ ([]), error: /** @type {any} */ (null), confirming: "", busy: "", problem: /** @type {string|null} */ (null), adding: false,
    flow: /** @type {{ id: string, step: string, url?: string, code?: string, message?: string, account?: string, provider: string }|null} */ (null), run: 0 };

  async function load() {
    const r = await attempt("sessions.accounts.list", {});
    if (!ctx.alive()) return;
    st.error = r.error || null; st.rows = r.error ? [] : accountsOf(r.data);
    draw();
  }
  const fail = (/** @type {any} */ e) => { st.problem = e?.missing ? "This box has no AI accounts yet." : String(e?.message || "That did not go through."); };
  async function act(/** @type {string} */ id, /** @type {string} */ tool, /** @type {any} */ input) {
    st.busy = id; st.problem = null; draw();
    const r = await attempt(tool, input);
    st.busy = ""; st.confirming = "";
    if (r.error) { fail(r.error); draw(); return; }
    await load();
  }

  /** Follow a sign-in until it ends. The box holds each status call open for a while, so this is not a tight loop; it ends with the section, a Cancel, or an end state. */
  async function follow(/** @type {string} */ flow, /** @type {string} */ provider, /** @type {number} */ run) {
    while (ctx.alive() && st.run === run) {
      const r = await attempt("sessions.accounts.signin", { flow });
      if (!ctx.alive() || st.run !== run) return;
      if (r.error) { st.flow = null; fail(r.error); draw(); return; }
      const d = /** @type {any} */ (r.data) || {};
      st.flow = { id: flow, step: String(d.step || "waiting"), url: typeof d.url === "string" ? d.url : undefined, code: typeof d.code === "string" ? d.code : undefined, message: typeof d.message === "string" ? d.message : undefined, provider };
      draw();
      if (d.step === "done") { st.flow = null; st.adding = false; await load(); return; }
      if (d.step === "failed") return;
      if (d.step === "url") return; // waits for a pasted code: submit() takes it from here
    }
  }
  async function start(/** @type {string} */ provider, /** @type {string} */ label, /** @type {string} */ account = "") {
    st.problem = null; const run = ++st.run;
    st.flow = { id: "", step: "waiting", provider }; draw();
    const r = await attempt("sessions.accounts.signin", { provider, ...(label ? { label } : {}), ...(account ? { account } : {}) });
    if (!ctx.alive() || st.run !== run) return;
    if (r.error) { st.flow = null; fail(r.error); draw(); return; }
    const d = /** @type {any} */ (r.data) || {};
    st.flow = { id: String(d.flow || ""), step: String(d.step || "waiting"), url: typeof d.url === "string" ? d.url : undefined, code: typeof d.code === "string" ? d.code : undefined, provider };
    draw();
    if (d.flow) void follow(String(d.flow), provider, run);
  }
  function cancel() { st.run++; st.flow = null; st.adding = false; st.problem = null; draw(); void load(); }

  function flowPanel() {
    const f = st.flow; if (!f) return null;
    const name = providerName(f.provider);
    if (f.step === "failed") return h("div", { class: "set-actions", role: "alert" }, h("span", { class: "small" }, `Signing in to ${name} did not finish. ${f.message || ""}`.trim()),
      h("button", { class: "btn btn-sm", type: "button", "data-act": "flow-close", onclick: cancel }, "Close"));
    const paste = /** @type {HTMLInputElement} */ (h("input", { class: "input", "aria-label": "The code the page showed", autocomplete: "off", spellcheck: "false", placeholder: "Paste the code here" }));
    return h("div", { class: "set-flow", role: "status" },
      h("p", { class: "small" }, f.url ? `Open this page, sign in to ${name}, and approve.` : `Starting the ${name} sign-in…`),
      f.url && safeUrl(f.url) ? h("p", null, h("a", { href: f.url, target: "_blank", rel: "noopener noreferrer", "data-act": "flow-open" }, f.url)) : null,
      f.code ? h("p", null, "Code: ", h("span", { class: "mono", "data-flow-code": "1" }, f.code)) : null,
      f.step === "url" ? h("div", { class: "set-actions" }, paste, h("button", { class: "btn btn-sm", type: "button", "data-act": "flow-paste", onclick: async () => {
        const r = await attempt("sessions.accounts.signin", { flow: f.id, code: paste.value.trim() });
        if (r.error) { st.problem = String(r.error.message || "That did not look like the code."); draw(); return; }
        st.problem = null; if (st.flow) st.flow.step = "waiting"; draw(); void follow(f.id, f.provider, st.run);
      } }, "Continue")) : h("p", { class: "small muted" }, "Waiting for you to approve it."),
      h("button", { class: "btn btn-ghost btn-sm", type: "button", "data-act": "flow-cancel", onclick: cancel }, "Cancel"));
  }

  function row(/** @type {ReturnType<typeof accountsOf>[number]} */ a, /** @type {number} */ same) {
    const sure = st.confirming === a.id;
    return h("div", { class: "set-row", "data-account": a.id },
      h("div", { class: "set-k" }, providerMark(a.provider, 20), " ", providerName(a.provider)),
      h("div", { class: "set-v tm-col" },
        h("span", null, a.label, a.isDefault ? h("span", { class: "chip" }, "Default") : null),
        h("span", { class: "small faint" }, stateWord(a)),
        a.provider === "grok" && a.privacyLabel ? h("span", { class: "small muted" }, a.privacyLabel, " ", a.privacyNote) : null,
        sure
          ? h("span", { class: "set-actions" }, h("span", { class: "small" }, `Remove ${a.label}? Sessions already on it keep running; the next one asks for another account.`),
            h("button", { class: "btn btn-sm", type: "button", "data-act": "remove-yes", disabled: st.busy === a.id, onclick: () => act(a.id, "sessions.accounts.remove", { id: a.id }) }, "Remove"),
            h("button", { class: "btn btn-ghost btn-sm", type: "button", "data-act": "remove-no", onclick: () => { st.confirming = ""; draw(); } }, "Keep"))
          : h("span", { class: "set-actions" },
            a.kind === "login" && !a.synthetic && (!a.signedIn || a.needs === "sign-in") ? h("button", { class: "btn btn-sm", type: "button", "data-act": "signin", onclick: () => start(a.provider, "", a.id) }, "Sign in") : null,
            same > 1 && !a.isDefault ? h("button", { class: "btn btn-ghost btn-sm", type: "button", "data-act": "default", disabled: st.busy === a.id, onclick: () => act(a.id, "sessions.accounts.bind", { id: a.id, is_default: true }) }, "Make default") : null,
            a.provider === "grok" && a.privacy !== null ? h("button", { class: "btn btn-ghost btn-sm", type: "button", "data-act": "privacy", disabled: st.busy === a.id,
              onclick: () => act(a.id, "sessions.accounts.set", { account: a.id, privacy: !a.privacy }) }, a.privacy ? "I turned privacy mode off" : "I turned privacy mode on") : null,
            a.synthetic ? null : h("button", { class: "btn btn-ghost btn-sm", type: "button", "data-act": "remove", onclick: () => { st.confirming = a.id; draw(); } }, "Remove"))));
  }

  function addForm() {
    const which = /** @type {HTMLSelectElement} */ (h("select", { class: "input set-select", "aria-label": "Which AI", "data-f": "provider" }, ADDABLE.map(p => h("option", { value: p }, providerName(p)))));
    const label = /** @type {HTMLInputElement} */ (h("input", { class: "input", "aria-label": "A name for it", placeholder: "A name, like work (optional)", autocomplete: "off", "data-f": "label" }));
    return h("form", { class: "set-form", "data-form": "account", onsubmit: (/** @type {Event} */ e) => { e.preventDefault(); void start(which.value, label.value.trim()); } },
      h("div", { class: "set-actions" }, which, label, h("button", { class: "btn btn-primary", type: "submit", "data-act": "add-go" }, "Sign in"),
        h("button", { class: "btn btn-ghost", type: "button", "data-act": "add-cancel", onclick: cancel }, "Cancel")));
  }

  function draw() {
    if (st.error) { put(el, empty(st.error?.missing ? "This box has no AI accounts yet." : "Your AI accounts could not be read.", st.error)); return; }
    const count = (/** @type {string} */ p) => st.rows.filter(r => r.provider === p).length;
    put(el,
      h("p", { class: "small muted" }, "The AI accounts sessions can run on. Each signs in with its own provider, and Vyre never sees the password or token."),
      st.problem ? h("p", { class: "small muted", role: "alert" }, st.problem) : null,
      st.rows.length ? h("div", { class: "rows" }, st.rows.map(a => row(a, count(a.provider)))) : h("div", { class: "empty" }, "No AI accounts yet."),
      flowPanel(),
      st.adding && !st.flow ? addForm() : st.flow ? null : h("div", { class: "set-actions" }, h("button", { class: "btn btn-sm", type: "button", "data-act": "add", onclick: () => { st.adding = true; draw(); } }, "Add an account")));
  }
  await load();
}
