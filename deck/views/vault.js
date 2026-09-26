// @ts-check
// Vault: keys and logins, listed by name. Board: DeckVault. Spec section 7.5, floor rule 8.
//
// No value from the Vault ever reaches this page. No tool returns one, and this view reads only
// the named fields it draws (see the pick* functions): names, kinds, holders, passes, times.
// Values only go in, through password inputs that are read once, cleared at once, and sent once
// with vault.put. There is no reveal, no masked preview and no length.
//
// Tools: vault.list, vault.pass.list, vault.usage, vault.put, vault.grant, vault.revoke,
// vault.pass.create, vault.pass.revoke, vault.offboard, agents.list, system.info.
// ?item=<name> opens the side panel (a full-screen sheet on a phone).

import { h, put, empty } from "../js/dom.js";
import { attempt, call } from "../js/api.js";
import { icon } from "../js/icons.js";
import { clock, startOfToday, initial, plural } from "../js/fmt.js";

const KIND = { secret: "Secret", "api-key": "API key", login: "Login", card: "Card", note: "Secure note", "env-set": "Env set" };
const NEW_KINDS = [["secret", "Secret"], ["login", "Login"], ["card", "Card"], ["note", "Note"]];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const EVENTS = ["vault.item-added", "vault.item-changed", "vault.item-deleted", "vault.granted", "vault.revoked", "pass.created", "pass.revoked", "person.offboarded"];

// ---- reading what the tools return: named fields only ---------------------------------------

const str = v => (typeof v === "string" ? v : "");
const num = v => (typeof v === "number" && isFinite(v) ? v : null);

/** @returns {any[]} */
function pickItems(d) {
  const list = Array.isArray(d) ? d : Array.isArray(d?.items) ? d.items : [];
  return list.filter(x => x && typeof x.name === "string").map(x => ({
    name: x.name,
    kind: str(x.kind) || "secret",
    label: str(x.label),
    description: str(x.description),
    holders: pickHolders(x),
    passes: num(x.passes) || 0,
    last_used: num(x.last_used),
    set_at: num(x.set_at) ?? num(x.updated),
    set_by: str(x.set_by),
    rotate: x.rotate === true,
  }));
}
function pickHolders(x) {
  if (Array.isArray(x.holders)) {
    return x.holders.map(g => ({ agent: str(g?.agent), module: str(g?.module), pass: str(g?.pass), scope: str(g?.scope), watcher: str(g?.watcher) }))
      .filter(g => g.agent || g.module || g.pass);
  }
  // vault.list as the vault branch has it today: grants to modules, with an optional watcher.
  if (Array.isArray(x.grants)) return x.grants.map(g => ({ agent: str(g?.agent), module: str(g?.module), pass: "", scope: str(g?.watcher), watcher: str(g?.watcher) })).filter(g => g.agent || g.module);
  return [];
}
function pickPasses(d) {
  const list = Array.isArray(d) ? d
    : [...(Array.isArray(d?.passes) ? d.passes.map(p => ({ ...p, direction: "to" })) : []),
       ...(Array.isArray(d?.held) ? d.held.map(p => ({ ...p, direction: "from", holder: p.owner })) : [])];
  return list.filter(p => p && (typeof p.id === "string" || typeof p.id === "number")).map(p => ({
    id: String(p.id),
    direction: p.direction === "from" ? "from" : "to",
    holder: str(p.holder),
    person: str(p.person),
    items: Array.isArray(p.items) ? p.items.filter(n => typeof n === "string") : [],
    scope: str(p.scope) || str(p.note),
    service: str(p.service),
    mode: p.mode === "sealed" ? "sealed" : "relayed",
    state: p.state === "waiting" || p.status === "pending" ? "waiting" : p.status === "revoked" ? "revoked" : "active",
    expires: typeof p.expires === "number" || typeof p.expires === "string" ? p.expires : null,
  })).filter(p => p.state !== "revoked");
}
function pickUsage(d) {
  const list = Array.isArray(d) ? d : Array.isArray(d?.entries) ? d.entries : [];
  return list.filter(u => u && num(u.at)).map(u => ({
    at: /** @type {number} */ (num(u.at)),
    agent: str(u.agent),
    pass: str(u.pass),
    who: str(u.who),
    action: str(u.action),
    project: str(u.project),
    relayed_by: str(u.relayed_by),
  }));
}
const pickNames = v => (Array.isArray(v) ? v.filter(n => typeof n === "string") : []);

// ---- small formatters -----------------------------------------------------------------------

const day = t => { const d = new Date(t); return `${d.getDate()} ${MON[d.getMonth()]}`; };
function lastUsed(t) {
  if (!t) return "Never";
  const t0 = startOfToday();
  if (t >= t0) return clock(t);
  if (t >= t0 - 86_400_000) return "Yesterday";
  return day(t);
}
function expiry(p) {
  if (p.expires === null || p.expires === "") return "No end date";
  if (typeof p.expires === "number") return `Until ${day(p.expires)}`;
  const t = /^\d{4}-\d\d-\d\d/.test(p.expires) ? Date.parse(p.expires) : NaN;
  return isFinite(t) ? `Until ${day(t)}` : p.expires;
}
const kindLabel = it => it.label || KIND[it.kind] || it.kind;
const holderName = g => g.agent || g.module || g.pass;
const tile = (name, size = 22) => h("span", { class: "initial vt-tile", "aria-hidden": "true", style: { width: size + "px", height: size + "px" } }, initial(name));
const kindIcon = kind => (kind === "login" ? icon("login") : kind === "note" ? icon("lines") : kind === "card" ? cardIcon() : icon("key"));

/** A card outline; icons.js has none. Built with DOM calls, no markup. */
function cardIcon() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  for (const [k, v] of Object.entries({ width: "16", height: "16", viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round", "aria-hidden": "true" })) svg.setAttribute(k, v);
  const r = document.createElementNS(ns, "rect");
  for (const [k, v] of Object.entries({ x: "2", y: "4", width: "12", height: "8.5", rx: "1.5" })) r.setAttribute(k, v);
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", "M2 7h12M4.5 10.2h2.5");
  svg.append(r, p);
  return svg;
}

/** A password input for a value going in. Nothing ever sets its value but the person typing. */
function secretInput(label, id, optional = false) {
  return /** @type {HTMLInputElement} */ (h("input", { type: "password", autocomplete: "off", class: "input", id, "aria-label": label,
    spellcheck: "false", autocapitalize: "off", "data-lpignore": "true", "data-1p-ignore": "true", required: !optional }));
}
/** Empty every password input under el. Called after each send, on every redraw and on leaving. */
function clearSecrets(el) {
  for (const i of el.querySelectorAll('input[type="password"]')) /** @type {HTMLInputElement} */ (i).value = "";
}
const field = (label, input, hint) => h("label", { class: "vt-field" }, h("span", { class: "lbl" }, label), input, hint ? h("span", { class: "small faint" }, hint) : null);
const errText = e => (e && e.missing ? `The ${e.module} module is not running on this machine.` : String(e?.message || e));

/** A button that asks once more before it acts. */
function confirmButton(label, confirmLabel, cls, act) {
  let armed = false, t = 0;
  const b = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: cls, onclick: async () => {
    if (!armed) { armed = true; put(b, confirmLabel); t = window.setTimeout(() => { armed = false; put(b, label); }, 4000); return; }
    clearTimeout(t); armed = false; b.disabled = true;
    try { await act(); } finally { b.disabled = false; put(b, label); }
  } }, label));
  return b;
}

// ---- the view -------------------------------------------------------------------------------

/** @param {any} ctx */
export default async function vault(ctx) {
  const st = {
    host: "", me: "",
    items: /** @type {any[]} */ ([]), listErr: /** @type {any} */ (null),
    passes: /** @type {any[]} */ ([]), passErr: /** @type {any} */ (null),
    pass: /** @type {string|null} */ (null),
    flash: /** @type {{ where: string, text: string } | null} */ (null),
    panel: /** @type {null | { mode: "item", name: string } | { mode: "add" | "pass" | "offboard" }} */ (null),
  };
  const item0 = ctx.query.get("item");
  if (item0) st.panel = { mode: "item", name: item0 };

  const lede = h("p", { class: "vt-lede" }, " ");
  const addBtn = h("button", { type: "button", class: "btn btn-primary", onclick: () => open({ mode: "add" }) }, icon("plus", 14), "Add item");
  const itemsBox = h("section", { class: "vt-items", "aria-label": "Items" });
  const passesBox = h("section", { class: "vt-passes", "aria-labelledby": "vt-passes-h" });
  const main = h("div", { class: "vt-main" },
    h("div", { class: "vt-head" }, h("div", { class: "vt-head-text" }, h("h1", { class: "h2" }, "Vault"), lede), h("div", { style: { flexGrow: "1" } }), addBtn),
    itemsBox, passesBox);
  const panel = h("aside", { class: "vt-panel", hidden: true });
  const wrap = h("div", { class: "vt" }, main, panel);
  put(ctx.root, wrap);
  ctx.cleanup(() => clearSecrets(wrap));

  const onKey = e => { if (e.key === "Escape" && st.panel) close(); };
  document.addEventListener("keydown", onKey);
  ctx.cleanup(() => document.removeEventListener("keydown", onKey));

  const info = await attempt("system.info");
  if (!ctx.alive()) return;
  st.host = str(info.data?.host) || location.hostname;
  st.me = /\.vyre\.run$/.test(location.hostname) ? location.hostname : st.host;
  put(lede, `Keys and logins, listed by name. Values stay sealed on ${st.host}. Agents use them without reading them, and no screen shows them, this one included.`);

  // ---- data ----
  async function load() {
    const [l, p] = await Promise.all([attempt("vault.list"), attempt("vault.pass.list")]);
    if (!ctx.alive()) return;
    st.listErr = l.error || null;
    st.items = l.error ? [] : pickItems(l.data);
    st.passErr = p.error || null;
    st.passes = p.error ? [] : pickPasses(p.data);
    if (!st.passes.some(x => x.id === st.pass)) st.pass = null;
    drawItems();
    drawPasses();
    if (st.panel?.mode === "item") drawPanel();
  }
  let lt = 0;
  for (const t of EVENTS) ctx.on(t, () => { clearTimeout(lt); lt = window.setTimeout(load, 250); });

  // ---- navigation within the view ----
  function open(p, push = true) {
    st.panel = p;
    if (push) history.pushState(null, "", p.mode === "item" ? `/vault?item=${encodeURIComponent(p.name)}` : "/vault");
    if (p.mode === "item") { const hit = st.passes.find(x => x.items.includes(p.name)); if (hit) st.pass = hit.id; drawPasses(); }
    drawItems();
    drawPanel(true);
  }
  function close() {
    st.panel = null;
    if (location.search) history.pushState(null, "", "/vault");
    drawItems();
    drawPanel();
  }

  // ---- items ----
  function drawItems() {
    addBtn.toggleAttribute("disabled", !!st.listErr?.missing);
    if (st.listErr) { put(itemsBox, empty("No items to list.", st.listErr)); return; }
    if (!st.items.length) { put(itemsBox, h("div", { class: "empty" }, "The vault is empty. Add a key or a login and it is listed here by name.")); return; }
    const sel = st.panel?.mode === "item" ? st.panel.name : null;
    put(itemsBox,
      h("div", { class: "vt-grid vt-thead lbl", "aria-hidden": "true" }, h("span"), h("span", null, "Name"), h("span", null, "Kind"), h("span", null, "Held by"), h("span", { class: "vt-r" }, "Last used")),
      h("ul", { class: "vt-list", role: "list" }, st.items.map(it => {
        const agents = it.holders.filter(g => g.agent);
        const others = it.holders.filter(g => !g.agent && !g.pass);
        const held = [...agents, ...others].map(holderName);
        const a = h("a", { href: `/vault?item=${encodeURIComponent(it.name)}`, class: "vt-grid vt-row", "aria-current": it.name === sel ? "true" : false,
          onclick: (/** @type {MouseEvent} */ e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); open({ mode: "item", name: it.name }); } },
          h("span", { class: "vt-kicon" }, kindIcon(it.kind)),
          h("span", { class: "vt-name" }, h("span", { class: "ellipsis vt-name-t" }, it.name),
            it.passes ? h("span", { class: "vt-passbadge" }, icon("pass", 12), plural(it.passes, "pass", "passes")) : null,
            it.rotate ? h("span", { class: "tag" }, "Rotate") : null),
          h("span", { class: "vt-kind" }, kindLabel(it)),
          h("span", { class: "vt-held" }, held.length
            ? [agents.map(g => tile(g.agent)), h("span", { class: "vt-held-names ellipsis" }, held.join(", "))]
            : h("span", { class: "faint" }, "Nobody")),
          h("span", { class: "vt-used vt-r" }, lastUsed(it.last_used)));
        return h("li", null, a);
      })));
  }

  // ---- passes ----
  function drawPasses() {
    if (st.listErr?.missing && st.passErr?.missing) { put(passesBox); passesBox.hidden = true; return; }
    passesBox.hidden = false;
    const sel = st.passes.find(p => p.id === st.pass) || st.passes.find(p => p.direction === "to" && p.state === "active") || st.passes[0];
    const newBtn = h("button", { type: "button", class: "btn", onclick: () => open({ mode: "pass" }), disabled: !st.items.length }, icon("pass", 14), "New pass");
    const offBtn = h("button", { type: "button", class: "btn btn-ghost vt-off", onclick: () => open({ mode: "offboard" }) }, "Offboard a person");
    put(passesBox,
      h("div", { class: "vt-phead" },
        h("div", { class: "vt-head-text" },
          h("h2", { class: "h3", id: "vt-passes-h" }, "Passes"),
          h("p", { class: "vt-plede" }, `A pass lets another person's Vyre use one item. Passes are relayed: their Vyre asks yours, yours makes the call, and the value never leaves ${st.host}.`),
          sel ? flow(sel) : null),
        h("div", { style: { flexGrow: "1" } }),
        h("div", { class: "vt-pacts" }, offBtn, newBtn)),
      st.passErr ? empty("No passes to list.", st.passErr)
        : !st.passes.length ? h("div", { class: "empty" }, "No passes. Nobody else's Vyre can use anything here.")
        : h("ul", { class: "vt-list", role: "list" }, st.passes.map(p => passRow(p, p === sel))));
  }
  function flow(p) {
    const service = p.service || p.items[0] || "the service";
    const [asker, caller] = p.direction === "to" ? [p.holder, st.me] : [st.me, p.holder];
    const mine = caller === st.me;
    return h("div", { class: "vt-flow", role: "img", "aria-label": `${asker} asks ${caller}, which calls ${service}` },
      h("span", { class: "vt-chip" + (mine ? "" : " on") }, mine ? null : icon("lock", 11), asker),
      h("span", { class: "faint" }, "asks"), icon("right", 12),
      h("span", { class: "vt-chip" + (mine ? " on" : "") }, mine ? icon("lock", 11) : null, caller),
      h("span", { class: "faint" }, "calls"), icon("right", 12),
      h("span", { class: "vt-chip" }, service));
  }
  function passRow(p, on) {
    const status = h("span", { class: "vt-pstatus small", role: "status" });
    const act = p.direction === "from" ? "Remove" : p.state === "waiting" ? "Cancel" : "Revoke";
    const btn = confirmButton(act, act === "Remove" ? "Remove it" : act === "Cancel" ? "Cancel it" : "Revoke now", "btn btn-ghost btn-sm vt-pbtn", async () => {
      const r = await attempt("vault.pass.revoke", { id: p.id });
      if (!ctx.alive()) return;
      if (r.error) { put(status, errText(r.error)); return; }
      const rot = pickNames(r.data?.rotate);
      put(status, rot.length ? `Ended. Rotate ${rot.join(", ")}.` : "Ended.");
      load();
    });
    return h("li", { class: "vt-pgrid vt-prow" + (on ? " on" : "") },
      h("span", { class: "lbl" }, p.direction === "to" ? "To" : "From"),
      h("button", { type: "button", class: "vt-pwho", "aria-pressed": on ? "true" : "false", "aria-label": `Show how the pass ${p.direction} ${p.holder} works`,
        onclick: () => { st.pass = p.id; drawPasses(); } },
        h("span", { class: "mono vt-addr ellipsis" }, p.holder), p.person ? h("span", { class: "vt-sub ellipsis" }, p.person) : null),
      h("span", { class: "vt-pitem" }, h("span", { class: "ellipsis" }, p.items.join(", ")), p.scope ? h("span", { class: "vt-sub ellipsis" }, p.scope) : null),
      h("span", null, h("span", { class: "vt-mode" }, p.state === "waiting" ? "Waiting" : p.mode === "sealed" ? "Sealed" : "Relayed")),
      h("span", { class: "vt-exp" }, expiry(p)),
      h("span", { class: "vt-pact" }, btn, status));
  }

  // ---- the side panel ----
  function drawPanel(focus = false) {
    clearSecrets(panel);
    const p = st.panel;
    wrap.classList.toggle("has-panel", !!p);
    if (!p) { put(panel); panel.hidden = true; return; }
    panel.hidden = false;
    const title = p.mode === "item" ? p.name : p.mode === "add" ? "Add item" : p.mode === "pass" ? "New pass" : "Offboard a person";
    const kicker = p.mode === "item" ? (st.items.find(i => i.name === p.name) ? kindLabel(st.items.find(i => i.name === p.name)) : "Item") : p.mode === "add" ? "New item" : p.mode === "pass" ? "Share an item" : "Someone left";
    const h2 = h("h2", { class: "vt-ptitle", tabindex: "-1", id: "vt-panel-h" }, title);
    panel.setAttribute("aria-labelledby", "vt-panel-h");
    const body = h("div", { class: "vt-pbody" });
    put(panel,
      h("div", { class: "vt-ptop" }, h("span", { class: "lbl" }, kicker), h("button", { type: "button", class: "ibtn", "aria-label": "Close panel", onclick: close }, icon("close", 14))),
      h2, body,
      h("div", { style: { flexGrow: "1" } }),
      h("p", { class: "vt-foot" }, "Only your tailnet can open this page."));
    if (p.mode === "item") itemPanel(body, p.name);
    else if (p.mode === "add") addPanel(body);
    else if (p.mode === "pass") passPanel(body);
    else offboardPanel(body);
    if (focus) h2.focus({ preventScroll: true });
  }

  function itemPanel(body, name) {
    const it = st.items.find(i => i.name === name);
    if (!it) {
      put(body, st.listErr ? empty(`${name} cannot be shown.`, st.listErr) : h("div", { class: "empty" }, `There is no item called ${name}.`));
      return;
    }
    // A message from before the reload that redrew this panel.
    const flash = st.flash; st.flash = null;
    const said = where => (flash && flash.where === where ? flash.text : null);
    const tell = (where, el, text, reload) => { put(el, text); if (reload) { st.flash = { where, text }; load(); } };
    // Sealed
    const status = h("p", { class: "small muted", role: "status" }, said("sealed"));
    const replaceRow = h("div", { class: "vt-replace", hidden: true });
    const replaceBtn = h("button", { type: "button", class: "btn btn-sm", "aria-expanded": "false", onclick: () => {
      const on = replaceRow.hidden;
      replaceRow.hidden = !on;
      replaceBtn.setAttribute("aria-expanded", String(on));
      if (on) { put(status); drawReplace(); } else clearSecrets(replaceRow);
    } }, "Replace value");
    const drawReplace = () => {
      clearSecrets(replaceRow);
      const inp = secretInput(`New value for ${it.name}`, "vt-replace-in");
      const form = h("form", { class: "vt-replace-form", autocomplete: "off", onsubmit: async (/** @type {Event} */ e) => {
        e.preventDefault();
        const value = inp.value;
        inp.value = "";
        if (!value) { put(status, "Type the new value first."); return; }
        const r = await attempt("vault.put", { name: it.name, kind: it.kind, value });
        inp.value = "";
        if (!ctx.alive()) return;
        tell("sealed", status, r.error ? errText(r.error) : "Replaced. The new value is sealed.", !r.error);
      } }, inp, h("button", { type: "submit", class: "btn btn-sm" }, "Seal"));
      put(replaceRow, form);
      inp.focus();
    };
    const revokeAll = confirmButton("Revoke", "Revoke from all", "btn btn-ghost btn-sm", async () => {
      const fails = [];
      for (const g of it.holders.filter(x => !x.pass)) {
        const r = await attempt("vault.revoke", revokeInput(it.name, g));
        if (r.error) fails.push(errText(r.error));
      }
      for (const ps of st.passes.filter(x => x.direction === "to" && x.items.includes(it.name))) {
        const r = await attempt("vault.pass.revoke", { id: ps.id });
        if (r.error) fails.push(errText(r.error));
      }
      if (!ctx.alive()) return;
      tell("sealed", status, fails.length ? fails[0] : "Nobody holds it now.", true);
    });
    const set = it.set_at ? `Set ${day(it.set_at)}${it.set_by ? ` by ${it.set_by}` : ""}` : "";
    const sealed = h("div", { class: "vt-sealed" },
      h("div", { class: "vt-sealed-top" }, icon("lock", 14), h("span", { class: "vt-sealed-l" }, "Sealed"), set ? h("span", { class: "vt-set" }, set) : null),
      h("p", { class: "vt-sealed-p" }, "Nobody can read this value back, you included. It is used inside the holder's computer and never written to a thread or a log."),
      it.description ? h("p", { class: "small faint" }, it.description) : null,
      h("div", { class: "vt-sealed-acts" }, replaceBtn, revokeAll),
      replaceRow, status);

    // Held by
    const heldStatus = h("p", { class: "small muted", role: "status" }, said("held"));
    const picker = h("div", { class: "vt-picker", hidden: true });
    const addHolder = h("button", { type: "button", class: "btn btn-ghost vt-add", "aria-expanded": "false", onclick: async () => {
      const on = picker.hidden;
      picker.hidden = !on;
      addHolder.setAttribute("aria-expanded", String(on));
      if (on) await drawPicker();
    } }, icon("plus", 12), "Add");
    const drawPicker = async () => {
      put(picker, h("div", { class: "small faint" }, "Loading agents"));
      const r = await attempt("agents.list");
      if (!ctx.alive()) return;
      const list = (Array.isArray(r.data) ? r.data : Array.isArray(r.data?.agents) ? r.data.agents : []).filter(a => a && typeof a.name === "string");
      const have = new Set(it.holders.map(g => g.agent).filter(Boolean));
      const free = list.filter(a => !have.has(a.name));
      if (r.error) { put(picker, empty("No agents to choose from.", r.error)); return; }
      if (!free.length) { put(picker, h("div", { class: "small faint" }, list.length ? "Every agent holds it already." : "There are no agents yet.")); return; }
      put(picker, h("div", { class: "lbl" }, "Give it to"), free.map(a => h("button", { type: "button", class: "vt-pick", onclick: async () => {
        const g = await attempt("vault.grant", { name: it.name, agent: a.name, module: "agents" });
        if (!ctx.alive()) return;
        picker.hidden = true; addHolder.setAttribute("aria-expanded", "false");
        tell("held", heldStatus, g.error ? errText(g.error) : g.data?.grant?.status === "pending" ? `Asked. ${a.name} holds it once you approve.` : `${a.name} holds it now.`, !g.error);
      } }, tile(a.name), h("span", null, a.name), str(a.role) ? h("span", { class: "small faint" }, str(a.role)) : null)));
    };
    const holders = it.holders.map(g => g.pass
      ? h("li", { class: "vt-hrow" }, h("span", { class: "vt-hicon" }, icon("pass", 14)), h("span", { class: "mono vt-addr" }, g.pass), h("span", { class: "vt-sub" }, g.scope || "by pass"))
      : h("li", { class: "vt-hrow" },
          g.agent ? tile(g.agent) : h("span", { class: "tag" }, "module"),
          h("span", { class: "vt-hname" }, holderName(g)), g.scope ? h("span", { class: "vt-sub ellipsis" }, g.scope) : null,
          h("button", { type: "button", class: "ibtn vt-x", "aria-label": `Remove ${holderName(g)}`, onclick: async () => {
            const r = await attempt("vault.revoke", revokeInput(it.name, g));
            if (!ctx.alive()) return;
            tell("held", heldStatus, r.error ? errText(r.error) : `${holderName(g)} no longer holds it.`, !r.error);
          } }, icon("close", 12))));

    // Used today
    const used = h("ul", { class: "vt-used-list", role: "list" }, h("li", { class: "small faint vt-urow" }, "Loading"));
    put(body,
      sealed,
      h("div", { class: "vt-shead" }, h("h3", { class: "lbl" }, "Held by"), addHolder),
      picker,
      holders.length ? h("ul", { class: "vt-hlist", role: "list" }, holders) : h("div", { class: "empty vt-none" }, "Nobody holds it. No agent can use it until you add one."),
      heldStatus,
      h("div", { class: "vt-shead" }, h("h3", { class: "lbl" }, "Used today")),
      used);
    drawUsage(used, it.name);
  }

  async function drawUsage(el, name) {
    let r = await attempt("vault.usage", { name });
    // The vault branch calls this vault.audit and returns { entries: [{at, action, who}] }.
    if (r.error?.missing) { const a = await attempt("vault.audit", { name, limit: 50 }); if (!a.error) r = a; }
    if (!ctx.alive() || !el.isConnected) return;
    if (r.error) { put(el, h("li", null, empty("No usage to show.", r.error))); return; }
    const t0 = startOfToday();
    const rows = pickUsage(r.data).filter(u => u.at >= t0).sort((a, b) => b.at - a.at);
    if (!rows.length) { put(el, h("li", { class: "vt-urow small faint" }, "Nobody used it today.")); return; }
    put(el, rows.map(u => {
      const who = u.agent || u.pass || u.who;
      return h("li", { class: "vt-urow" },
        u.agent ? tile(u.agent, 20) : h("span", { class: "vt-hicon" }, icon(u.pass ? "pass" : "key", 14)),
        h("span", { class: "vt-utext" }, `${who} ${u.action}`, u.project ? h("span", { class: "faint" }, ` for ${u.project}`) : null,
          u.pass ? h("span", { class: "faint" }, ` relayed by ${u.relayed_by || st.host}`) : null),
        h("span", { class: "vt-ut" }, clock(u.at)));
    }));
  }

  function addPanel(body) {
    let kind = "secret";
    const status = h("p", { class: "small muted", role: "status" });
    const nameIn = /** @type {HTMLInputElement} */ (h("input", { type: "text", class: "input", id: "vt-add-name", autocomplete: "off", required: true, placeholder: "Harlow Google Drive" }));
    const descIn = /** @type {HTMLInputElement} */ (h("input", { type: "text", class: "input", id: "vt-add-desc", autocomplete: "off", placeholder: "What it is for" }));
    const urlIn = /** @type {HTMLInputElement} */ (h("input", { type: "url", class: "input", id: "vt-add-url", autocomplete: "off", placeholder: "https://accounts.example.com" }));
    const values = h("div", { class: "vt-values" });
    const seg = h("div", { class: "seg", role: "group", "aria-label": "Kind" });
    const drawKind = () => {
      clearSecrets(values);
      put(seg, NEW_KINDS.map(([k, l]) => h("button", { type: "button", "aria-pressed": k === kind ? "true" : "false", onclick: () => { kind = k; drawKind(); } }, l)));
      put(values,
        kind === "secret" ? field("Value", secretInput("Value", "vt-v-value"))
        : kind === "note" ? field("Note", secretInput("Note", "vt-v-note"))
        : kind === "card" ? [field("Card number", secretInput("Card number", "vt-v-number")), h("div", { class: "vt-two" },
            field("Expiry", secretInput("Expiry", "vt-v-expiry")), field("Security code", secretInput("Security code", "vt-v-cvc")))]
        : [field("Address", urlIn, "Where this login is used. Not secret."), field("Username", secretInput("Username", "vt-v-username")),
           field("Password", secretInput("Password", "vt-v-password")), field("TOTP secret", secretInput("TOTP secret", "vt-v-totp", true), "Optional. Vyre makes the codes.")]);
    };
    drawKind();
    const form = h("form", { class: "vt-form", autocomplete: "off", onsubmit: async (/** @type {Event} */ e) => {
      e.preventDefault();
      // Read every value once, then clear the inputs before anything is sent.
      const got = {};
      for (const i of values.querySelectorAll('input[type="password"]')) {
        const inp = /** @type {HTMLInputElement} */ (i);
        if (inp.value) got[inp.id.slice(5)] = inp.value;
        inp.value = "";
      }
      const name = nameIn.value.trim();
      if (!name) { put(status, "Give it a name."); return; }
      const need = kind === "login" ? ["username", "password"] : kind === "card" ? ["number"] : [kind === "note" ? "note" : "value"];
      const missing = need.filter(k => !got[k]);
      if (missing.length) { put(status, `Type the ${missing.join(" and ")} again. Nothing was sent.`); return; }
      const input = { name, kind, ...(descIn.value.trim() ? { description: descIn.value.trim() } : {}) };
      const r = await attempt("vault.put", kind === "secret" ? { ...input, value: got.value }
        : kind === "note" ? { ...input, value: got.note }
        : kind === "card" ? { ...input, fields: { number: got.number, ...(got.expiry ? { expiry: got.expiry } : {}), ...(got.cvc ? { cvc: got.cvc } : {}) } }
        : { ...input, ...(urlIn.value.trim() ? { url: urlIn.value.trim() } : {}), fields: { username: got.username, password: got.password, ...(got.totp ? { totp: got.totp } : {}) } });
      clearSecrets(form);
      if (!ctx.alive()) return;
      if (r.error) { put(status, errText(r.error)); return; }
      nameIn.value = ""; descIn.value = ""; urlIn.value = "";
      put(status, `Added ${name}. The value is sealed on ${st.host}.`);
      load();
    } },
      field("Name", nameIn, "Agents ask for it by this name."),
      h("div", { class: "vt-field" }, h("span", { class: "lbl" }, "Kind"), seg),
      field("Description", descIn),
      values,
      h("p", { class: "small faint" }, "What you type here is sealed and never shown again, here or anywhere."),
      h("div", { class: "vt-form-acts" }, h("button", { type: "submit", class: "btn" }, icon("lock", 14), "Seal it"), h("button", { type: "button", class: "btn btn-ghost", onclick: close }, "Cancel")),
      status);
    put(body, form);
  }

  function passPanel(body) {
    let mode = "relayed";
    const status = h("p", { class: "small muted", role: "status" });
    const holderIn = /** @type {HTMLInputElement} */ (h("input", { type: "text", class: "input", id: "vt-pass-holder", autocomplete: "off", required: true, placeholder: "dana.vyre.run", spellcheck: "false" }));
    const personIn = /** @type {HTMLInputElement} */ (h("input", { type: "text", class: "input", id: "vt-pass-person", autocomplete: "off", placeholder: "Dana Reyes" }));
    const itemSel = /** @type {HTMLSelectElement} */ (h("select", { class: "input", id: "vt-pass-item" }, st.items.map(i => h("option", { value: i.name }, i.name))));
    const scopeIn = /** @type {HTMLInputElement} */ (h("input", { type: "text", class: "input", id: "vt-pass-scope", autocomplete: "off", placeholder: "Read the Reports folder" }));
    const expSel = /** @type {HTMLSelectElement} */ (h("select", { class: "input", id: "vt-pass-exp" },
      [["7d", "7 days"], ["30d", "30 days"], ["90d", "90 days"], ["", "No end date"]].map(([v, l]) => h("option", { value: v }, l))));
    const seg = h("div", { class: "seg", role: "group", "aria-label": "Mode" });
    const note = h("p", { class: "small faint" });
    const drawMode = () => {
      put(seg, [["relayed", "Relayed"], ["sealed", "Sealed"]].map(([m, l]) => h("button", { type: "button", "aria-pressed": m === mode ? "true" : "false", onclick: () => { mode = m; drawMode(); } }, l)));
      put(note, mode === "relayed" ? `Their Vyre asks yours and ${st.host} makes the call. The value never leaves. Revoking ends it at once.`
        : "An encrypted copy goes to their Vyre. Revoking it means rotating the value.");
    };
    drawMode();
    put(body, h("form", { class: "vt-form", autocomplete: "off", onsubmit: async (/** @type {Event} */ e) => {
      e.preventDefault();
      const holder = holderIn.value.trim();
      if (!holder) { put(status, "Give their address."); return; }
      const scope = scopeIn.value.trim();
      const r = await attempt("vault.pass.create", { holder, ...(personIn.value.trim() ? { person: personIn.value.trim() } : {}), items: [itemSel.value], mode,
        ...(scope ? { scope, note: scope } : {}), ...(expSel.value ? { expires: expSel.value } : {}) });
      if (!ctx.alive()) return;
      if (r.error) { put(status, errText(r.error)); return; }
      put(status, r.data?.pass?.status === "pending" ? `Asked. The pass to ${holder} waits for your approval.` : `Made a pass for ${holder}.`);
      load();
    } },
      field("Their Vyre", holderIn, "The address of the person's Vyre."),
      field("Person", personIn),
      field("Item", itemSel),
      field("What they may do", scopeIn),
      h("div", { class: "vt-field" }, h("span", { class: "lbl" }, "Mode"), seg, note),
      field("Ends", expSel),
      h("div", { class: "vt-form-acts" }, h("button", { type: "submit", class: "btn" }, icon("pass", 14), "Make pass"), h("button", { type: "button", class: "btn btn-ghost", onclick: close }, "Cancel")),
      status));
  }

  function offboardPanel(body) {
    const people = [...new Map(st.passes.map(p => [p.holder, p.person])).entries()].filter(([a]) => a);
    const out = h("div", { class: "vt-off-out", role: "status" });
    const whoIn = /** @type {HTMLInputElement} */ (h("input", { type: "text", class: "input", id: "vt-off-who", autocomplete: "off", list: "vt-off-list", placeholder: "theo.vyre.run", spellcheck: "false" }));
    const go = confirmButton("Offboard", "Offboard now", "btn", async () => {
      const holder = whoIn.value.trim();
      if (!holder) { put(out, h("p", { class: "small muted" }, "Say who left.")); return; }
      const r = await attempt("vault.offboard", { holder, person: holder });
      if (!ctx.alive()) return;
      if (r.error) { put(out, h("p", { class: "small muted" }, errText(r.error))); return; }
      const ended = Array.isArray(r.data?.revoked) ? r.data.revoked.length : num(r.data?.revoked) || 0;
      const rot = pickNames(r.data?.rotate);
      put(out,
        h("p", { class: "small" }, `${holder} holds nothing here now. Ended ${plural(ended, "pass", "passes")}.`),
        rot.length
          ? [h("div", { class: "lbl vt-rot-l" }, "Rotate these"), h("ul", { class: "vt-hlist", role: "list" }, rot.map(n => h("li", { class: "vt-hrow" }, h("span", { class: "vt-hicon" }, icon("key", 14)), h("span", null, n)))),
             h("p", { class: "small faint" }, "They had a sealed copy. Replace each value to finish.")]
          : h("p", { class: "small faint" }, "Nothing to rotate. Every pass they held was relayed."));
      load();
    });
    put(body, h("div", { class: "vt-form" },
      h("p", { class: "small muted" }, "Ends every pass a person holds, forgets their Vyre, and lists what must be rotated. It is one action and cannot be undone."),
      field("Who left", whoIn),
      h("datalist", { id: "vt-off-list" }, people.map(([a, n]) => h("option", { value: a }, n || a))),
      people.length ? h("div", { class: "vt-people" }, people.map(([a, n]) => h("button", { type: "button", class: "vt-pick", onclick: () => { whoIn.value = a; } },
        h("span", { class: "mono vt-addr" }, a), n ? h("span", { class: "small faint" }, n) : null))) : null,
      h("div", { class: "vt-form-acts" }, go, h("button", { type: "button", class: "btn btn-ghost", onclick: close }, "Cancel")),
      out));
  }

  const revokeInput = (name, g) => ({ name, holder: holderName(g), ...(g.agent ? { agent: g.agent, module: "agents" } : { module: g.module }), ...(g.watcher ? { watcher: g.watcher } : {}) });

  drawPanel();
  await load();
}
