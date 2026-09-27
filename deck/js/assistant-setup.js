// @ts-check
// Create your assistant: the card Now and Agents show when there is no agent of kind "assistant",
// which happens when the person skipped onboarding's first step (or finished before Claude was
// signed in, so onboard.finish had nothing to run it on).
//
// Onboarding's step 1 only saves names (onboard.you); the assistant itself is made at the end, by
// onboard.finish, which calls agents.create once. After onboarding has finished, calling
// onboard.you again makes nothing, so this card calls agents.create itself, with the input
// onboard.finish sends: the name slugged from the display name, kind "assistant", every project,
// the Vault items the Claude step stored, and the same instructions. Nothing here polls.
//
//   assistantCard({ onCreated })   the card; onCreated(agent) runs once agents.create succeeds

import { h, put } from "./dom.js";
import { attempt } from "./api.js";

const VAULT_SUB = "claude-setup-token";
const VAULT_KEY = "anthropic-api-key";

/** core/onboard's slug(): "Juno Two" becomes "juno-two"; too short becomes "assistant". */
const slug = (/** @type {string} */ s) => {
  const v = String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^[^a-z]+|-+$/g, "").slice(0, 31).replace(/-+$/, "");
  return v.length >= 2 ? v : "assistant";
};

/**
 * The credentials onboard.finish gives the assistant, from what the Claude step stored. With no
 * Claude sign-in yet, none: the agent runs on this machine's own Claude Code login.
 * @param {string | null} via "subscription", "api-key" or null
 */
const authFor = via => via === "subscription" ? { vault: VAULT_SUB, fallback: VAULT_KEY }
  : via === "api-key" ? { fallback: VAULT_KEY } : {};

/** An error from a tool call, in plain words. */
const problem = (/** @type {any} */ e) => e?.missing ? `The ${e.module} module is not running on this machine, so the assistant cannot be made here yet.`
  : String(e?.message || e || "Something went wrong.");

/**
 * @param {{ onCreated?: (agent: any) => void }} [opts]
 * @returns {HTMLElement}
 */
export function assistantCard({ onCreated } = {}) {
  const id = "asst-name-" + Math.random().toString(36).slice(2, 8);
  const status = h("p", { class: "asst-status small", id: id + "-status", role: "status", "aria-live": "polite" });
  const nameIn = /** @type {HTMLInputElement} */ (h("input", { class: "input", id, required: true, autocomplete: "off", spellcheck: "false",
    autocapitalize: "none", placeholder: "juno", maxlength: "40", "aria-describedby": id + "-status" }));
  // The same offer as a new agent's form (views/agents.js): a computer from the pool, which the
  // assistant can browse and use, and the user can watch and take over in Glass.
  const computer = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox" }));
  const create = /** @type {HTMLButtonElement} */ (h("button", { type: "submit", class: "btn btn-primary asst-go" }, "Create"));

  const submit = async (/** @type {Event} */ e) => {
    e.preventDefault();
    const display = nameIn.value.trim();
    // onboard.you's rule for the assistant's name: one line of up to 40 characters.
    if (!display) { put(status, "Give your assistant a name."); nameIn.focus(); return; }
    if (display.length > 40 || /[\u0000-\u001f]/.test(display)) { put(status, "The name is one line of up to 40 characters."); nameIn.focus(); return; }
    create.disabled = true;
    nameIn.disabled = true;
    computer.disabled = true;
    put(status, "Creating.");
    // Who the person is and how Claude is signed in, as onboard.finish reads them.
    const st = await attempt("onboard.status");
    const person = st.data?.person || null;
    const via = st.data?.detail?.claude?.auth || null;
    const input = { name: slug(display), kind: "assistant", projects: "*", auth: authFor(via), computer: computer.checked,
      instructions: `Your name is ${display}.${person ? ` You work for ${person}.` : ""} You are their assistant in Vyre: you can see every project and start, drive and stop any session.` };
    const r = await attempt("agents.create", input, { presence: true });
    create.disabled = false;
    nameIn.disabled = false;
    computer.disabled = false;
    if (r.error) { put(status, problem(r.error)); nameIn.focus(); return; }
    put(status);
    const a = r.data && typeof r.data === "object" ? r.data : input;
    onCreated?.({ status: "new", doing: "not started", thread: null, ...a });
  };
  nameIn.addEventListener("input", () => { if (status.textContent) put(status); });

  return h("section", { class: "asst-card", "aria-labelledby": id + "-h" },
    h("h2", { class: "asst-title", id: id + "-h" }, "Create your assistant"),
    h("p", { class: "asst-lede muted" }, "It sees every project, runs your week, and asks before anything goes out."),
    h("form", { class: "asst-form", onsubmit: submit, novalidate: true },
      h("label", { class: "asst-label small", for: id }, "Its name"),
      h("div", { class: "asst-row" }, nameIn, create),
      h("label", { class: "asst-check small" }, computer, h("span", null, "Give it its own computer, from the pool. ",
        h("span", { class: "faint" }, "It can browse and use apps there, and you can watch or take over in Glass."))),
      status));
}
