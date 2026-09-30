// @ts-check
// Settings, Connections: "Add a service", the catalog of vendor-hosted connectors (connectors module,
// CHAT.md 11:40). One list of presets grouped by `group`, a Connect on each, and the step the box
// answers with drawn in place:
//   open             the vendor's sign-in page (opened in a new tab, https only) and a paste box for a browser on
//                    another device (connectors.connect.finish {id, url}); Cancel is connectors.connect.cancel {id}
//   needs token      a hidden field and the preset's own `extra` fields; the value goes to connectors.connect once
//   needs client     the help text and a picker of vault item names (the OAuth client the vendor gave you)
//   via              a plain line: this one is connected through another connector
//   connected        done, with the tool count and any warning
// The page holds names, labels and the vendor's address only. A token is typed into a password field,
// sent, and forgotten. Nothing polls: it loads on open, after each action, and on the connectors.* events.

import { h, put, empty } from "../js/dom.js";
import { icon } from "../js/icons.js";
import { attempt as apiAttempt } from "../js/api.js";
import { plural } from "../js/fmt.js";

export const EVENTS = ["connectors.connected", "connectors.connect-failed", "connectors.disconnected"];
const httpsOnly = (/** @type {any} */ u) => (typeof u === "string" && /^https:\/\//i.test(u) ? u : null);
const words = (/** @type {any} */ e) => (e?.missing ? "Connectors are not running on this box yet." : String(e?.message || e || "That did not go through."));
const SETUP_WORD = { none: "", app: "Needs an app from the vendor", token: "Needs a token", via: "Comes through another connector" };

/** The catalog as groups, in the order the box sent them. @param {any} d @returns {{ group: string, presets: any[] }[]} */
export function groupsOf(d) {
  const list = Array.isArray(d?.presets) ? d.presets : [];
  /** @type {Map<string, any[]>} */ const by = new Map();
  for (const p of list) {
    if (!p || typeof p.id !== "string" || !p.label) continue;
    const row = { id: p.id, label: String(p.label), group: String(p.group || "Other"), who: p.who ? String(p.who) : "", note: p.note ? String(p.note) : "", setup: String(p.setup || "none"),
      via: p.via ? String(p.via) : "", connected: (Array.isArray(p.connected) ? p.connected : []).filter((/** @type {any} */ c) => c && c.name).map((/** @type {any} */ c) => ({ name: String(c.name), mode: c.mode ? String(c.mode) : "", label: c.label ? String(c.label) : "" })) };
    (by.get(row.group) || by.set(row.group, []).get(row.group))?.push(row);
  }
  return [...by].map(([group, presets]) => ({ group, presets }));
}

/**
 * @param {HTMLElement} el @param {{ alive: () => boolean, on: (type: string, fn: (e: any) => void) => void, cleanup?: (fn: () => void) => void }} ctx
 * @param {{ attempt?: typeof apiAttempt, open?: (url: string) => void }} [deps]
 */
export async function drawCatalog(el, ctx, deps = {}) {
  const attempt = deps.attempt || apiAttempt;
  const open = deps.open || (url => { try { window.open(url, "_blank", "noopener,noreferrer"); } catch { /* blocked: the link is shown */ } });
  const st = { groups: /** @type {ReturnType<typeof groupsOf>} */ ([]), error: /** @type {any} */ (null), items: /** @type {string[]} */ ([]),
    /** The preset with an open step: { preset, step, busy, error, values }. */
    flow: /** @type {any} */ (null), notice: /** @type {string|null} */ (null) };

  async function load() {
    const c = await attempt("connectors.catalog", {});
    if (!ctx.alive()) return;
    st.error = c.error || null;
    st.groups = c.error ? [] : groupsOf(c.data);
    draw();
  }
  /** The vault's item names, read only when a step asks for the OAuth client (never on open). */
  async function loadItems() {
    const v = await attempt("vault.list", {});
    if (!ctx.alive()) return;
    st.items = v.error ? [] : (Array.isArray(v.data) ? v.data : v.data?.items || []).map((/** @type {any} */ i) => String(i?.name ?? "")).filter(Boolean);
  }

  /** @param {string} preset @param {any} [extra] connectors.connect's own input */
  async function connect(preset, extra = {}) {
    st.flow = { ...(st.flow || {}), preset, busy: true, error: null, step: st.flow?.step || null };
    draw();
    const r = await attempt("connectors.connect", { preset, ...extra });
    if (!ctx.alive()) return;
    if (r.error) { st.flow = { preset, busy: false, error: words(r.error), step: st.flow?.step || null }; draw(); return; }
    const step = r.data || {};
    if (step.step === "connected") { st.flow = null; st.notice = `${st.groups.flatMap(g => g.presets).find(p => p.id === preset)?.label || preset} is connected` + (step.tools ? `, ${plural(Number(step.tools?.length ?? step.tools) || 0, "tool")}` : "") + (step.warning ? `. ${step.warning}` : "."); await load(); return; }
    st.flow = { preset, busy: false, error: null, step };
    // The vendor's page: opened for the person, and shown as a link when the browser blocked the tab.
    if (step.step === "open" && httpsOnly(step.url)) open(step.url);
    if (step.step === "needs" && step.needs === "client") await loadItems();
    draw();
  }

  async function cancel() {
    const f = st.flow;
    st.flow = null; draw();
    if (f?.step?.step === "open" && f.step.id) await attempt("connectors.connect.cancel", { id: f.step.id });
  }

  async function finish(/** @type {string} */ url) {
    const f = st.flow;
    if (!f?.step?.id) return;
    const pasted = String(url || "").trim();
    if (!pasted) { st.flow = { ...f, error: "Paste the address the page ended on." }; draw(); return; }
    st.flow = { ...f, busy: true, error: null }; draw();
    const r = await attempt("connectors.connect.finish", { id: f.step.id, url: pasted });
    if (!ctx.alive()) return;
    if (r.error) { st.flow = { ...f, busy: false, error: words(r.error) }; draw(); return; }
    st.flow = null; await load();
  }

  async function disconnect(/** @type {string} */ name) {
    const r = await attempt("connectors.disconnect", { name });
    if (!ctx.alive()) return;
    st.notice = r.error ? `Could not disconnect ${name}. ${words(r.error)}` : `${name} is disconnected.`;
    await load();
  }

  /** The panel under a preset with an open step. @param {any} f */
  function panel(f) {
    const s = f.step || {};
    const problem = f.error ? h("p", { class: "small muted", role: "alert" }, f.error) : null;
    const cancelBtn = h("button", { type: "button", class: "btn btn-ghost btn-sm", "data-act": "cancel", onclick: cancel }, "Cancel");
    if (!s.step) return h("div", { class: "cn-flow small muted", role: "status" }, "Asking " + f.preset + "…", problem, cancelBtn);
    if (s.step === "open") {
      const link = httpsOnly(s.url);
      const paste = /** @type {HTMLInputElement} */ (h("input", { class: "input", "aria-label": "Address the page ended on", autocomplete: "off", spellcheck: "false", placeholder: "http://127.0.0.1:…/callback?code=…" }));
      return h("div", { class: "cn-flow", role: "status" },
        h("p", { class: "small" }, "Approve it on the vendor's page, then come back. This finishes by itself."),
        link ? h("div", { class: "cn-paste" }, h("button", { type: "button", class: "btn btn-sm", "data-act": "open", onclick: () => open(link) }, "Open the sign-in page")) : null,
        h("div", { class: "set-row" }, h("div", { class: "set-k" }, "Another device"), h("div", { class: "set-v" }, h("p", { class: "small faint" }, "Signing in on a different browser? Paste the address it ends on."),
          h("div", { class: "cn-paste" }, paste, h("button", { type: "button", class: "btn btn-sm", "data-act": "finish", disabled: f.busy, onclick: () => finish(paste.value) }, "Finish")))),
        problem, cancelBtn);
    }
    if (s.step === "needs" && s.needs === "token") {
      const tok = /** @type {HTMLInputElement} */ (h("input", { class: "input", type: "password", "aria-label": s.label || "Token", autocomplete: "off", spellcheck: "false" }));
      const extras = (Array.isArray(s.extra) ? s.extra : []).map((/** @type {any} */ x) => ({ x, input: /** @type {HTMLInputElement} */ (h("input", { class: "input", "aria-label": String(x.label || x.name), autocomplete: "off", "data-extra": String(x.name) })) }));
      return h("form", { class: "cn-flow", onsubmit: (/** @type {Event} */ e) => {
        e.preventDefault();
        if (!tok.value.trim()) { st.flow = { ...f, error: "Paste the token first." }; draw(); return; }
        const missing = extras.find((/** @type {any} */ o) => o.x.required && !o.input.value.trim());
        if (missing) { st.flow = { ...f, error: `${missing.x.label || missing.x.name} is needed.` }; draw(); return; }
        const extra = Object.fromEntries(extras.filter((/** @type {any} */ o) => o.input.value.trim()).map((/** @type {any} */ o) => [o.x.name, o.input.value.trim()]));
        const token = tok.value.trim(); tok.value = "";
        void connect(f.preset, { token, ...(Object.keys(extra).length ? { extra } : {}) });
      } },
        s.help ? h("p", { class: "small" }, String(s.help)) : null,
        h("div", { class: "set-row" }, h("div", { class: "set-k" }, String(s.label || "Token")), h("div", { class: "set-v" }, tok)),
        extras.map((/** @type {any} */ o) => h("div", { class: "set-row" }, h("div", { class: "set-k" }, String(o.x.label || o.x.name) + (o.x.required ? "" : " (optional)")), h("div", { class: "set-v" }, o.input))),
        problem, h("div", { class: "cn-paste" }, h("button", { type: "submit", class: "btn btn-primary btn-sm", "data-act": "token", disabled: f.busy }, f.busy ? "Connecting" : "Connect"), cancelBtn));
    }
    if (s.step === "needs" && s.needs === "client") {
      const pick = /** @type {HTMLSelectElement} */ (h("select", { class: "input", "aria-label": "Vault item holding the client" }, h("option", { value: "" }, "Choose an item"), st.items.map(n => h("option", { value: n }, n))));
      return h("div", { class: "cn-flow" },
        s.help ? h("p", { class: "small" }, String(s.help)) : null,
        s.redirect ? h("p", { class: "small faint" }, "Redirect address to register: ", h("span", { class: "code" }, String(s.redirect))) : null,
        h("div", { class: "cn-paste" }, pick, h("button", { type: "button", class: "btn btn-primary btn-sm", "data-act": "client", disabled: f.busy, onclick: () => { if (!pick.value) { st.flow = { ...f, error: "Choose the vault item first." }; draw(); return; } void connect(f.preset, { client: pick.value }); } }, "Use it")),
        problem, cancelBtn);
    }
    if (s.step === "via") return h("div", { class: "cn-flow" }, h("p", { class: "small" }, String(s.message || `Connect this through ${s.via}.`)), cancelBtn);
    return h("div", { class: "cn-flow small muted" }, "Nothing more to do here.", cancelBtn);
  }

  /** @param {any} p */
  function presetRow(p) {
    const f = st.flow && st.flow.preset === p.id ? st.flow : null;
    return h("div", { class: "cn-row", "data-preset": p.id },
      h("div", { class: "cn-head" },
        h("strong", null, p.label),
        p.who ? h("span", { class: "small faint" }, p.who) : null,
        SETUP_WORD[p.setup] ? h("span", { class: "tag" }, SETUP_WORD[p.setup]) : null,
        h("span", { class: "cn-grow" }),
        p.setup === "via" && !p.connected.length ? null
          : h("button", { type: "button", class: "btn btn-sm" + (p.connected.length ? "" : " btn-primary"), "data-act": "connect", disabled: !!st.flow, onclick: () => connect(p.id) }, p.connected.length ? "Add another" : "Connect")),
      p.note ? h("p", { class: "small muted" }, p.note) : null,
      p.setup === "via" && p.via && !p.connected.length ? h("p", { class: "small muted" }, `Comes through ${p.via}.`) : null,
      p.connected.map((/** @type {any} */ c) => h("div", { class: "cn-meta-row" }, icon("check", 14), h("span", null, c.label || c.name), c.mode ? h("span", { class: "small faint" }, c.mode) : null,
        h("button", { type: "button", class: "btn btn-ghost btn-sm", "data-act": "disconnect", "aria-label": `Disconnect ${c.name}`, onclick: () => disconnect(c.name) }, "Disconnect"))),
      f ? panel(f) : null);
  }

  function draw() {
    if (st.error) { put(el, h("h3", { class: "h3" }, "Add a service"), empty(st.error?.missing ? "Connectors are not on this box yet." : "The catalog could not be read.", st.error)); return; }
    put(el,
      h("h3", { class: "h3" }, "Add a service"),
      h("p", { class: "small muted" }, "Sign in to a service the way its own site does. Vyre keeps the credential in the vault and agents use it without seeing it."),
      st.notice ? h("p", { class: "small", role: "status" }, st.notice) : null,
      st.groups.length ? st.groups.map(g => h("div", { class: "cn-group" }, h("p", { class: "lbl" }, g.group), g.presets.map(presetRow))) : h("div", { class: "empty" }, "No services to add on this box."));
  }

  for (const type of EVENTS) ctx.on(type, e => {
    if (type === "connectors.connect-failed" && st.flow) st.flow = { ...st.flow, busy: false, error: words(e.payload?.error || e.payload?.message || "The sign-in did not finish.") };
    if (type === "connectors.connected") st.flow = null;
    void load();
  });
  await load();
  ctx.cleanup?.(() => { const f = st.flow; if (f?.step?.step === "open" && f.step.id) void attempt("connectors.connect.cancel", { id: f.step.id }); });
}
