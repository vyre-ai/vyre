// @ts-check
// Settings, Connections: the MCP servers behind the hub and the Google accounts Vyre can use
// (ADR 0016). One section of deck/views/settings.js, drawn here so the connectors workstream owns
// it. No board of its own: the Settings rows and TOKENS.md, like the rest of that page.
//
// The page only ever holds vault item NAMES. mcp.servers and google.accounts carry names and
// never values, and the pickers below copy only the keys they draw, so a stray field in a reply
// cannot reach the screen. Adding a connection names an item; the value stays sealed and is
// fetched by the module under its own grant, which is asked for here with presence (the same
// passkey sheet Memory uses). When presence cannot be had, the exact `vyre vault grant` line is
// shown instead.
//
// Light: nothing on a timer. It loads when Settings opens, after each action, and on the mcp.* and
// google.* events that change what it shows (debounced, one redraw per burst). google.test makes
// real calls to Google, so it runs only when the person presses Test, never on open.
//
// Tools: mcp.servers, mcp.add, mcp.update, mcp.remove, mcp.test, mcp.restart, google.accounts,
// google.add, google.remove, google.test, vault.list, vault.grant, projects.list, agents.list.

import { h, put, empty } from "../js/dom.js";
import { attempt as apiAttempt } from "../js/api.js";
import { withPresence } from "./memory-presence.js";
import { since } from "../js/fmt.js";

/** Vault kinds that make sense for each way of using an item (ADR 0016, decision 2). */
export const ITEM_KINDS = {
  bearer: ["api-key", "secret"],
  env: ["api-key", "secret", "env-set"],
  oauth: ["env-set"],
  "service-account": ["note", "secret"],
};
const AUTH_WORDS = { none: "None", bearer: "Bearer token", env: "Env vars", oauth: "OAuth", "service-account": "Service account" };
const MODE_WORDS = [["read", "Read"], ["write", "Held"], ["off", "Off"]];
const STATE_WORDS = { stopped: "stopped", starting: "starting", running: "running", failed: "failed" };
/** The events that change what this section shows. mcp.called is left out: it only moves lastUsed. */
export const EVENTS = ["mcp.added", "mcp.updated", "mcp.removed", "mcp.started", "mcp.stopped", "mcp.failed", "mcp.refreshed",
  "google.added", "google.removed", "vault.granted"];

const str = v => (typeof v === "string" ? v : "");
const strs = v => (Array.isArray(v) ? v.filter(x => typeof x === "string") : []);
const num = v => (typeof v === "number" && isFinite(v) ? v : null);
const isObj = v => Boolean(v) && typeof v === "object" && !Array.isArray(v);

// ---- what the page reads, named fields only ------------------------------------------------------

/** A vault reference as the hub stores it: an item name, or { item, field }. */
const ref = v => (typeof v === "string" ? { item: v, field: "" } : isObj(v) ? { item: str(v.item), field: str(v.field) } : { item: "", field: "" });

/** mcp.servers → rows with only the fields drawn. */
export function pickServers(d) {
  const list = Array.isArray(d) ? d : [];
  return list.filter(s => s && typeof s.name === "string").map(s => {
    const env = isObj(s.env) ? Object.entries(s.env).map(([k, v]) => ({ var: k, ...ref(v) })).filter(e => e.item) : [];
    const mode = isObj(s.policy) && isObj(s.policy.mode) ? Object.fromEntries(Object.entries(s.policy.mode).filter(([, m]) => ["read", "write", "off"].includes(m))) : {};
    return {
      name: s.name, transport: str(s.transport), state: STATE_WORDS[s.state] || "stopped", error: str(s.error),
      tools: num(s.tools), lastUsed: num(s.lastUsed),
      auth: { type: str(s.auth?.type) || "none", item: str(s.auth?.item) }, env,
      scope: { projects: s.scope?.projects === "*" || !Array.isArray(s.scope?.projects) ? "*" : strs(s.scope.projects),
        agents: s.scope?.agents === "*" || !Array.isArray(s.scope?.agents) ? "*" : strs(s.scope.agents) },
      command: str(s.command), args: strs(s.args), url: str(s.url),
      policy: { ...(Array.isArray(s.policy?.allow) ? { allow: strs(s.policy.allow) } : {}), ...(Array.isArray(s.policy?.deny) ? { deny: strs(s.policy.deny) } : {}), mode },
    };
  });
}

/** google.accounts → rows with only the fields drawn. */
export function pickAccounts(d) {
  const list = Array.isArray(d) ? d : [];
  return list.filter(a => a && typeof a.name === "string").map(a => ({
    name: a.name, email: str(a.email),
    auth: { type: a.auth?.type === "service-account" ? "service-account" : "oauth", item: str(a.auth?.item), subject: str(a.auth?.subject) },
  }));
}

/** vault.list → { name, kind, fields, grants } per live item: names only. */
export function pickItems(d) {
  const list = Array.isArray(d) ? d : Array.isArray(d?.items) ? d.items : [];
  return list.filter(x => x && typeof x.name === "string" && x.state !== "trashed" && x.state !== "archived" && !x.trashed && !x.archived).map(x => ({
    name: x.name, kind: str(x.kind) || "secret", fields: strs(x.fields),
    grants: (Array.isArray(x.grants) ? x.grants : []).map(g => str(g?.module)).filter(Boolean),
  }));
}

/** The items that fit one auth type, by kind. */
export const itemsFor = (items, type) => items.filter(i => (ITEM_KINDS[type] || []).includes(i.kind));

/**
 * One row per tool for the mode picker: the tools mcp.test listed (read or held, from the hub's
 * own classification) and the ones the person turned off, which the hub no longer lists.
 * @param {{ tool: string, outward: boolean }[]} tools @param {Record<string, string>} mode
 */
export function toolModes(tools, mode = {}) {
  const out = tools.map(t => ({ tool: t.tool, mode: mode[t.tool] || (t.outward ? "write" : "read"), set: Boolean(mode[t.tool]) }));
  for (const [tool, m] of Object.entries(mode)) if (m === "off" && !out.some(t => t.tool === tool)) out.push({ tool, mode: "off", set: true });
  return out.sort((a, b) => a.tool.localeCompare(b.tool));
}

/** Every vault item a server uses. */
export const itemsOf = s => [...new Set([s.auth.item, ...s.env.map(e => e.item)].filter(Boolean))];

export const grantCommand = (item, module) => `vyre vault grant ${item} ${module}`;

/** "Every project" or the names. */
function scopeWords(v, every, one) {
  if (v === "*") return every;
  if (!v.length) return `No ${one}`;
  return v.join(", ");
}

function authWords(s) {
  if (s.auth.type === "env") return s.env.length ? s.env.map(e => `${e.var} from ${e.item}${e.field ? `.${e.field}` : ""}`).join(", ") : "Env vars";
  if (s.auth.type === "none") return "None";
  return `${AUTH_WORDS[s.auth.type] || s.auth.type}, from ${s.auth.item}`;
}

// ---- the section --------------------------------------------------------------------------------

/**
 * Draw the Connections section into `el`. It loads on its own and never throws out of here, so a
 * missing module shows its own empty state and the rest of Settings is untouched.
 * @param {HTMLElement} el
 * @param {{ on: (type: string, fn: (e: any) => void) => void, cleanup: (fn: () => void) => void, alive: () => boolean }} ctx
 * @param {{ attempt?: typeof apiAttempt, presence?: typeof withPresence }} [deps] for tests; api.js and the passkey sheet by default
 */
export async function drawConnections(el, ctx, deps = {}) {
  const attempt = deps.attempt || apiAttempt;
  const presence = deps.presence || withPresence;
  style();

  const st = {
    servers: /** @type {ReturnType<typeof pickServers>} */ ([]), serverErr: /** @type {any} */ (null),
    accounts: /** @type {ReturnType<typeof pickAccounts>} */ ([]), accountErr: /** @type {any} */ (null),
    items: /** @type {ReturnType<typeof pickItems>} */ ([]),
    projects: /** @type {{ slug: string, name: string }[]} */ ([]), agents: /** @type {string[]} */ ([]),
    /** What Test found, kept across redraws so a refresh does not close it. */
    tested: new Map(), gtested: new Map(),
    /** A row asking "Remove?" */
    confirming: "",
    form: /** @type {"" | "mcp" | "google"} */ (""),
  };

  const top = h("div");
  const mcpBox = h("div", { class: "cn-group" });
  const googleBox = h("div", { class: "cn-group" });
  const formBox = h("div");
  put(el, top, mcpBox, googleBox, formBox);

  async function load() {
    const [s, g] = await Promise.all([attempt("mcp.servers"), attempt("google.accounts")]);
    if (!ctx.alive()) return;
    st.serverErr = s.error || null;
    st.servers = s.error ? [] : pickServers(s.data);
    st.accountErr = g.error || null;
    st.accounts = g.error ? [] : pickAccounts(g.data);
    draw();
  }

  /** The pickers' lists, loaded when a form opens (the vault listing is not needed otherwise). */
  async function loadChoices() {
    const [v, p, a] = await Promise.all([attempt("vault.list"), attempt("projects.list"), attempt("agents.list")]);
    st.items = v.error ? [] : pickItems(v.data);
    st.projects = (Array.isArray(p.data?.projects) ? p.data.projects : []).filter(x => x && typeof x.slug === "string").map(x => ({ slug: x.slug, name: str(x.name) || x.slug }));
    const al = Array.isArray(a.data) ? a.data : Array.isArray(a.data?.agents) ? a.data.agents : [];
    st.agents = al.map(x => str(x?.name)).filter(Boolean);
    return { vaultErr: v.error || null };
  }

  function draw() {
    const both = st.serverErr?.missing && st.accountErr?.missing;
    if (both) {
      put(top, h("div", { class: "empty cn-empty" }, "No connectors are running on this machine.",
        h("span", { class: "code" }, "The mcp and google modules are not running. When they are, MCP servers and Google accounts are added here or with vyre connect add.")));
      put(mcpBox); put(googleBox); put(formBox);
      return;
    }
    put(top, h("p", { class: "set-note small muted" },
      "MCP servers and Google accounts Vyre can use. Each one names a vault item; the value stays sealed in the vault and never comes to this page."));
    drawServers();
    drawAccounts();
  }

  // ---- MCP servers ----

  function drawServers() {
    const add = h("button", { type: "button", class: "btn btn-sm", "data-act": "add-mcp", disabled: !!st.serverErr, onclick: () => openForm("mcp") }, "Add MCP server");
    if (st.serverErr) { put(mcpBox, h("h3", { class: "set-h3" }, "MCP servers"), empty("MCP servers are kept by the mcp module.", st.serverErr)); return; }
    put(mcpBox, h("h3", { class: "set-h3" }, "MCP servers"),
      st.servers.length ? h("div", { class: "rows" }, st.servers.map(serverRow))
        : h("div", { class: "empty" }, "No MCP servers yet. Add one and its tools reach every session through the one vyre entry."),
      h("div", { class: "set-actions" }, add));
  }

  function serverRow(s) {
    const status = h("div", { class: "small muted set-status", role: "status" });
    const how = s.transport === "stdio" ? [s.command, ...s.args].join(" ") : s.url;
    const failed = s.state === "failed";
    const row = h("div", { class: "cn-row", "data-server": s.name },
      h("div", { class: "cn-head" },
        h("span", { class: "mono cn-name" }, s.name),
        h("span", { class: "tag" }, s.transport),
        h("span", { class: "set-state cn-state" + (s.state === "running" ? "" : " faint"), "data-state": s.state },
          s.state === "running" ? h("span", { class: "dot signal", "aria-hidden": "true" }) : null, s.state)),
      failed && s.error ? h("div", { class: "small cn-err" }, s.error) : null,
      h("dl", { class: "cn-meta" },
        meta("Runs", h("code", { class: "set-mono" }, how || "")),
        meta("Tools", s.tools === null ? h("span", { class: "muted" }, "Not listed yet. Test lists them.") : String(s.tools)),
        meta("Auth", authWords(s)),
        meta("Scope", `${scopeWords(s.scope.projects, "Every project", "project")} · ${scopeWords(s.scope.agents, "every agent", "agent")}`),
        meta("Last used", s.lastUsed ? `${since(s.lastUsed)} ago` : h("span", { class: "muted" }, "Never"))),
      st.tested.has(s.name) ? testedPanel(s) : null,
      st.confirming === `mcp:${s.name}`
        ? h("div", { class: "set-actions cn-confirm" },
          h("span", { class: "small" }, `Remove ${s.name}? Its process stops. Its vault items and grants stay as they are.`),
          h("button", { type: "button", class: "btn btn-sm", "data-act": "remove-yes", onclick: async () => {
            const r = await attempt("mcp.remove", { name: s.name });
            if (!ctx.alive()) return;
            st.confirming = "";
            if (r.error) { drawServers(); say(s.name, errText(r.error)); return; }
            st.tested.delete(s.name);
            await load();
          } }, "Remove"),
          h("button", { type: "button", class: "btn btn-ghost btn-sm", "data-act": "remove-no", onclick: () => { st.confirming = ""; drawServers(); } }, "Cancel"))
        : h("div", { class: "set-actions cn-acts" },
          h("button", { type: "button", class: "btn btn-sm", "data-act": "test", onclick: async (/** @type {Event} */ e) => {
            busy(e, "Testing");
            const r = await attempt("mcp.test", { name: s.name });
            if (!ctx.alive()) return;
            st.tested.set(s.name, r.error ? { ok: false, tools: [], error: errText(r.error) } : pickTest(r.data));
            await load();
          } }, "Test"),
          h("button", { type: "button", class: "btn btn-sm", "data-act": "restart", onclick: async (/** @type {Event} */ e) => {
            busy(e, "Restarting");
            const r = await attempt("mcp.restart", { name: s.name });
            if (!ctx.alive()) return;
            await load();
            if (r.error) say(s.name, errText(r.error));
          } }, "Restart"),
          h("button", { type: "button", class: "btn btn-ghost btn-sm", "data-act": "remove", onclick: () => { st.confirming = `mcp:${s.name}`; drawServers(); } }, "Remove")),
      status);
    return row;
  }

  /** Put a message under one server's row. */
  function say(name, text) {
    const r = mcpBox.querySelector(`[data-server="${name}"] .set-status`);
    if (r) put(/** @type {HTMLElement} */ (r), text);
  }

  function testedPanel(s) {
    const t = st.tested.get(s.name);
    if (!t.ok) {
      return h("div", { class: "cn-test", "data-test": "failed" },
        h("div", { class: "small" }, "The test failed: ", t.error || "no reason given"),
        t.stderr.length ? h("pre", { class: "cn-stderr code" }, t.stderr.join("\n")) : null);
    }
    const rows = toolModes(t.tools, s.policy.mode);
    return h("div", { class: "cn-test", "data-test": "ok" },
      h("div", { class: "small muted" }, `Answered in ${t.ms} ms with ${rows.length === 1 ? "one tool" : `${rows.length} tools`}. A held tool waits at the Gate for you before anything reaches the server.`),
      rows.length ? h("div", { class: "rows cn-tools" }, rows.map(r => h("div", { class: "cn-tool", "data-tool": r.tool },
        h("span", { class: "mono cn-tool-n ellipsis", title: r.tool }, r.tool),
        modeSeg(s, r)))) : null);
  }

  function modeSeg(s, r) {
    return h("div", { class: "seg", role: "group", "aria-label": `Mode for ${r.tool}` },
      MODE_WORDS.map(([m, word]) => h("button", { type: "button", "aria-pressed": String(r.mode === m), "data-mode": m, onclick: async () => {
        if (r.mode === m) return;
        const mode = { ...s.policy.mode, [r.tool]: m };
        const x = await attempt("mcp.update", { name: s.name, tools: { ...s.policy, mode } });
        if (!ctx.alive()) return;
        if (x.error) { say(s.name, errText(x.error)); return; }
        s.policy.mode = mode;
        drawServers();
      } }, word)));
  }

  // ---- Google accounts ----

  function drawAccounts() {
    const add = h("button", { type: "button", class: "btn btn-sm", "data-act": "add-google", disabled: !!st.accountErr, onclick: () => openForm("google") }, "Add Google account");
    if (st.accountErr) { put(googleBox, h("h3", { class: "set-h3" }, "Google accounts"), empty("Google accounts are kept by the google module.", st.accountErr)); return; }
    put(googleBox, h("h3", { class: "set-h3" }, "Google accounts"),
      st.accounts.length ? h("div", { class: "rows" }, st.accounts.map(accountRow))
        : h("div", { class: "empty" }, "No Google account yet. Add one and the assistant can read your calendar and mail; sends and invites wait for you."),
      h("div", { class: "set-actions" }, add));
  }

  function accountRow(a) {
    const status = h("div", { class: "small muted set-status", role: "status" });
    const t = st.gtested.get(a.name);
    return h("div", { class: "cn-row", "data-account": a.name },
      h("div", { class: "cn-head" }, h("span", { class: "mono cn-name" }, a.name), h("span", { class: "muted" }, a.email)),
      h("dl", { class: "cn-meta" },
        meta("Auth", a.auth.type === "service-account" ? `Service account acting as ${a.auth.subject || a.email}` : "OAuth"),
        meta("Vault item", h("code", { class: "set-mono" }, a.auth.item)),
        meta("Scopes", t ? scopeList(t) : h("span", { class: "muted" }, "Not checked yet. Test asks Google for each one."))),
      t && t.error ? h("div", { class: "small cn-err", "data-hint": "scopes" }, t.error) : null,
      st.confirming === `google:${a.name}`
        ? h("div", { class: "set-actions cn-confirm" },
          h("span", { class: "small" }, `Disconnect ${a.name}? Its vault item stays, and so does its grant.`),
          h("button", { type: "button", class: "btn btn-sm", "data-act": "remove-yes", onclick: async () => {
            const r = await attempt("google.remove", { name: a.name });
            if (!ctx.alive()) return;
            st.confirming = "";
            if (r.error) { drawAccounts(); sayG(a.name, errText(r.error)); return; }
            st.gtested.delete(a.name);
            await load();
          } }, "Remove"),
          h("button", { type: "button", class: "btn btn-ghost btn-sm", "data-act": "remove-no", onclick: () => { st.confirming = ""; drawAccounts(); } }, "Cancel"))
        : h("div", { class: "set-actions cn-acts" },
          h("button", { type: "button", class: "btn btn-sm", "data-act": "test", onclick: async (/** @type {Event} */ e) => {
            busy(e, "Testing");
            const r = await attempt("google.test", { name: a.name });
            if (!ctx.alive()) return;
            st.gtested.set(a.name, r.error ? { ok: false, scopes: {}, error: errText(r.error) } : pickGoogleTest(r.data));
            drawAccounts();
          } }, "Test"),
          h("button", { type: "button", class: "btn btn-ghost btn-sm", "data-act": "remove", onclick: () => { st.confirming = `google:${a.name}`; drawAccounts(); } }, "Remove")),
      status);
  }
  function sayG(name, text) {
    const r = googleBox.querySelector(`[data-account="${name}"] .set-status`);
    if (r) put(/** @type {HTMLElement} */ (r), text);
  }

  function scopeList(t) {
    const names = Object.keys(t.scopes);
    if (!names.length) return h("span", { class: "muted" }, t.ok ? "None" : "Not checked");
    return h("div", { class: "set-tags" }, names.map(s => h("span", { class: "tag cn-scope" + (t.scopes[s] ? "" : " refused"), "data-scope": s },
      s, " ", t.scopes[s] ? "granted" : "refused")));
  }

  // ---- add forms ----

  async function openForm(kind) {
    st.form = kind;
    put(formBox, h("div", { class: "empty" }, "Loading your vault's item names."));
    const { vaultErr } = await loadChoices();
    if (!ctx.alive() || st.form !== kind) return;
    if (kind === "mcp") mcpForm(vaultErr); else googleForm(vaultErr);
  }
  const closeForm = () => { st.form = ""; put(formBox); };

  /** The vault item select for one auth type, or a note when there is none of that kind. */
  function itemSelect(type, id, current = "") {
    const fit = itemsFor(st.items, type);
    return /** @type {HTMLSelectElement} */ (h("select", { class: "input set-select cn-item", id, "aria-label": "Vault item" },
      h("option", { value: "" }, fit.length ? "Choose an item" : `No ${ITEM_KINDS[type].join(" or ")} items in the vault`),
      fit.map(i => h("option", { value: i.name, selected: i.name === current }, `${i.name} (${i.kind})`))));
  }

  /** Every project / these, and every agent / these, as checkboxes. */
  function scopePicker() {
    const pick = (label, all, list) => {
      const every = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", checked: true, "data-scope-every": label }));
      const boxes = list.map(([v]) => /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", value: v, disabled: true, "data-scope-one": label })));
      every.addEventListener("change", () => { for (const b of boxes) b.disabled = every.checked; });
      const el = h("div", { class: "cn-scope-pick" },
        h("label", { class: "cn-check" }, every, all),
        list.map(([, t], i) => h("label", { class: "cn-check" }, boxes[i], t)));
      return { el, value: () => (every.checked ? "*" : boxes.filter(b => b.checked).map(b => b.value)) };
    };
    const p = pick("projects", "Every project", st.projects.map(x => [x.slug, x.name]));
    const a = pick("agents", "Every agent", st.agents.map(n => [n, n]));
    return { p, a };
  }

  function mcpForm(vaultErr) {
    let transport = "stdio";
    const name = /** @type {HTMLInputElement} */ (h("input", { class: "input", id: "cn-name", autocomplete: "off", spellcheck: "false", placeholder: "tracker" }));
    const command = /** @type {HTMLInputElement} */ (h("input", { class: "input", id: "cn-command", autocomplete: "off", spellcheck: "false", placeholder: "npx" }));
    const args = /** @type {HTMLInputElement} */ (h("input", { class: "input", id: "cn-args", autocomplete: "off", spellcheck: "false", placeholder: "-y @northwind/tracker-mcp" }));
    const url = /** @type {HTMLInputElement} */ (h("input", { class: "input", id: "cn-url", autocomplete: "off", spellcheck: "false", placeholder: "https://mcp.example.com/mcp" }));
    const auth = /** @type {HTMLSelectElement} */ (h("select", { class: "input set-select", id: "cn-auth", "aria-label": "Auth" }));
    const itemBox = h("div", { class: "set-v" });
    const envBox = h("div", { class: "cn-env" });
    const where = h("div");
    const seg = h("div", { class: "seg", role: "group", "aria-label": "Transport" });
    const scope = scopePicker();
    const stt = h("div", { class: "small muted set-status", role: "status" });
    /** @type {{ var: HTMLInputElement, item: HTMLSelectElement, field: HTMLSelectElement }[]} */
    const envRows = [];
    let item = itemSelect("bearer", "cn-item");

    const drawSeg = () => put(seg, [["stdio", "stdio"], ["http", "HTTP"], ["sse", "SSE"]].map(([v, t]) =>
      h("button", { type: "button", "aria-pressed": String(transport === v), "data-transport": v, onclick: () => { transport = v; drawSeg(); drawWhere(); drawAuth(); } }, t)));
    const drawWhere = () => put(where, transport === "stdio"
      ? h("div", { class: "rows" }, frow("cn-command", "Command", command), frow("cn-args", "Arguments", args, "Separated by spaces. No secrets here; they go in env below."))
      : h("div", { class: "rows" }, frow("cn-url", "URL", url, transport === "sse" ? "The SSE stream's address." : "The server's streamable HTTP address.")));
    const drawAuth = () => {
      const types = transport === "stdio" ? ["none", "env"] : ["none", "bearer", "oauth", "service-account"];
      const cur = types.includes(auth.value) ? auth.value : "none";
      put(auth, types.map(t => h("option", { value: t, selected: t === cur }, AUTH_WORDS[t])));
      auth.value = cur;
      drawItem();
    };
    const drawItem = () => {
      const t = auth.value;
      if (t === "none") { put(itemBox, h("span", { class: "small faint" }, "The server needs no credential.")); put(envBox); return; }
      if (t === "env") {
        put(itemBox, h("span", { class: "small faint" }, "Each variable is set from a vault item, for this server's own process only."));
        if (!envRows.length) addEnv();
        drawEnv();
        return;
      }
      put(envBox);
      item = itemSelect(t, "cn-item");
      put(itemBox, item, h("span", { class: "small faint" }, t === "oauth" ? "An env set with client_id, client_secret, refresh_token and token_uri."
        : t === "service-account" ? "A note or secret holding the service account's JSON." : "Sent as Authorization: Bearer on each request."));
    };
    const addEnv = () => {
      const v = /** @type {HTMLInputElement} */ (h("input", { class: "input cn-env-var", autocomplete: "off", spellcheck: "false", placeholder: "TRACKER_TOKEN", "aria-label": "Variable" }));
      const it = itemSelect("env", "", "");
      const field = /** @type {HTMLSelectElement} */ (h("select", { class: "input set-select cn-env-field", "aria-label": "Field", hidden: true }));
      it.addEventListener("change", () => {
        const found = st.items.find(i => i.name === it.value);
        const fields = found && found.kind === "env-set" ? found.fields : [];
        put(field, fields.map(f => h("option", { value: f }, f)));
        field.hidden = !fields.length;
      });
      envRows.push({ var: v, item: it, field });
    };
    const drawEnv = () => put(envBox, envRows.map((r, i) => h("div", { class: "cn-env-row" }, r.var, r.item, r.field,
      h("button", { type: "button", class: "btn btn-ghost btn-sm", "aria-label": "Remove this variable", onclick: () => { envRows.splice(i, 1); drawEnv(); } }, "Remove"))),
      h("button", { type: "button", class: "btn btn-ghost btn-sm", "data-act": "add-env", onclick: () => { addEnv(); drawEnv(); } }, "Add a variable"));
    auth.addEventListener("change", drawItem);

    const save = /** @type {HTMLButtonElement} */ (h("button", { type: "submit", class: "btn btn-primary" }, "Add server"));
    const form = h("form", { class: "set-form cn-form", "data-form": "mcp", onsubmit: async (/** @type {Event} */ e) => {
      e.preventDefault();
      const input = /** @type {Record<string, any>} */ ({ name: name.value.trim(), transport });
      if (transport === "stdio") {
        input.command = command.value.trim();
        const a = args.value.trim();
        if (a) input.args = a.split(/\s+/);
      } else input.url = url.value.trim();
      const t = auth.value;
      if (t === "env") {
        const env = {};
        for (const r of envRows) {
          const k = r.var.value.trim();
          if (!k && !r.item.value) continue;
          if (!k || !r.item.value) { put(stt, "Each variable needs a name and a vault item."); return; }
          env[k] = !r.field.hidden && r.field.value ? { item: r.item.value, field: r.field.value } : r.item.value;
        }
        if (!Object.keys(env).length) { put(stt, "Name at least one variable and its vault item, or choose None."); return; }
        input.env = env;
        input.auth = { type: "env" };
      } else if (t !== "none") {
        if (!item.value) { put(stt, "Choose the vault item this server uses."); return; }
        input.auth = { type: t, item: item.value };
      } else input.auth = { type: "none" };
      const sp = scope.p.value(), sa = scope.a.value();
      if (Array.isArray(sp) && !sp.length || Array.isArray(sa) && !sa.length) { put(stt, "Choose at least one project and one agent, or leave it at every one."); return; }
      input.scope = { projects: sp, agents: sa };
      if (!input.name) { put(stt, "Give the server a name."); return; }

      save.disabled = true;
      put(stt, "Adding.");
      const r = await attempt("mcp.add", input);
      if (!ctx.alive()) return;
      if (r.error) { save.disabled = false; put(stt, errText(r.error)); return; }
      const items = [...new Set([input.auth.item, ...Object.values(input.env || {}).map(v => (typeof v === "string" ? v : v.item))].filter(Boolean))];
      const left = await grantAll(items, "mcp", stt);
      if (!ctx.alive()) return;
      // mcp.add tried the server once, before the grant existed; with the grant, try again.
      if (items.length && !left.length) {
        put(stt, "Testing.");
        const t2 = await attempt("mcp.test", { name: input.name });
        if (!ctx.alive()) return;
        if (!t2.error) st.tested.set(input.name, pickTest(t2.data));
      } else if (r.data?.test) st.tested.set(input.name, pickTest(r.data.test));
      done(left, input.name, "mcp");
      await load();
    } },
      h("h3", { class: "set-h3" }, "Add an MCP server"),
      vaultErr ? empty("The vault did not list its items, so none can be picked.", vaultErr) : null,
      h("div", { class: "rows" },
        frow("cn-name", "Name", name, "Lowercase letters, digits and dashes. Tools show as <name>__<tool>."),
        h("div", { class: "set-row" }, h("div", { class: "set-k" }, "Transport"), h("div", { class: "set-v" }, seg))),
      where,
      h("div", { class: "rows" },
        h("div", { class: "set-row" }, h("div", { class: "set-k" }, h("label", { for: "cn-auth" }, "Auth")), h("div", { class: "set-v" }, auth, itemBox, envBox)),
        h("div", { class: "set-row" }, h("div", { class: "set-k" }, "Projects"), h("div", { class: "set-v" }, scope.p.el)),
        h("div", { class: "set-row" }, h("div", { class: "set-k" }, "Agents"), h("div", { class: "set-v" }, scope.a.el))),
      h("div", { class: "set-actions" }, save, h("button", { type: "button", class: "btn btn-ghost", onclick: closeForm }, "Cancel")), stt);
    drawSeg(); drawWhere(); drawAuth();
    put(formBox, form);
    name.focus();
  }

  function googleForm(vaultErr) {
    let type = "oauth";
    const name = /** @type {HTMLInputElement} */ (h("input", { class: "input", id: "cg-name", autocomplete: "off", spellcheck: "false", placeholder: "work" }));
    const email = /** @type {HTMLInputElement} */ (h("input", { class: "input", id: "cg-email", type: "email", autocomplete: "off", spellcheck: "false", placeholder: "alex@harlowlegal.com" }));
    const subject = /** @type {HTMLInputElement} */ (h("input", { class: "input", id: "cg-subject", type: "email", autocomplete: "off", spellcheck: "false", placeholder: "The address above" }));
    const seg = h("div", { class: "seg", role: "group", "aria-label": "How it signs in" });
    const itemBox = h("div", { class: "set-v" });
    const subjectRow = h("div");
    const stt = h("div", { class: "small muted set-status", role: "status" });
    let item = itemSelect("oauth", "cg-item");
    const drawSeg = () => put(seg, [["oauth", "OAuth"], ["service-account", "Service account"]].map(([v, t]) =>
      h("button", { type: "button", "aria-pressed": String(type === v), "data-auth": v, onclick: () => { type = v; drawSeg(); drawRest(); } }, t)));
    const drawRest = () => {
      item = itemSelect(type, "cg-item");
      put(itemBox, item, h("span", { class: "small faint" }, type === "oauth" ? "An env set with client_id, client_secret, refresh_token and token_uri."
        : "A note or secret holding the service account's JSON. It acts as the address below through domain-wide delegation."));
      put(subjectRow, type === "service-account" ? h("div", { class: "rows" }, frow("cg-subject", "Acts as", subject, "Leave empty to act as the account's own address.")) : null);
    };
    const save = /** @type {HTMLButtonElement} */ (h("button", { type: "submit", class: "btn btn-primary" }, "Add account"));
    const form = h("form", { class: "set-form cn-form", "data-form": "google", onsubmit: async (/** @type {Event} */ e) => {
      e.preventDefault();
      const input = { name: name.value.trim(), email: email.value.trim(), auth: /** @type {Record<string, string>} */ ({ type, item: item.value }) };
      if (!input.name || !input.email) { put(stt, "Give the account a name and its address."); return; }
      if (!item.value) { put(stt, "Choose the vault item this account uses."); return; }
      if (type === "service-account" && subject.value.trim()) input.auth.subject = subject.value.trim();
      save.disabled = true;
      put(stt, "Adding.");
      const r = await attempt("google.add", input);
      if (!ctx.alive()) return;
      if (r.error) { save.disabled = false; put(stt, errText(r.error)); return; }
      const left = await grantAll([item.value], "google", stt);
      if (!ctx.alive()) return;
      if (!left.length) {
        put(stt, "Checking scopes with Google.");
        const t = await attempt("google.test", { name: input.name });
        if (!ctx.alive()) return;
        st.gtested.set(input.name, t.error ? { ok: false, scopes: {}, error: errText(t.error) } : pickGoogleTest(t.data));
      }
      done(left, input.name, "google");
      await load();
    } },
      h("h3", { class: "set-h3" }, "Add a Google account"),
      vaultErr ? empty("The vault did not list its items, so none can be picked.", vaultErr) : null,
      h("div", { class: "rows" },
        frow("cg-name", "Name", name, "What the assistant calls it, like work or home."),
        frow("cg-email", "Address", email),
        h("div", { class: "set-row" }, h("div", { class: "set-k" }, "Signs in with"), h("div", { class: "set-v" }, seg)),
        h("div", { class: "set-row" }, h("div", { class: "set-k" }, h("label", { for: "cg-item" }, "Vault item")), itemBox)),
      subjectRow,
      h("div", { class: "set-actions" }, save, h("button", { type: "button", class: "btn btn-ghost", onclick: closeForm }, "Cancel")), stt);
    drawSeg(); drawRest();
    put(formBox, form);
    name.focus();
  }

  /**
   * Grant each item to the module with presence, skipping ones it already holds. Returns the
   * items still not granted, whose `vyre vault grant` lines the page then shows.
   * @param {string[]} items @param {"mcp"|"google"} module @param {HTMLElement} stt
   */
  async function grantAll(items, module, stt) {
    const left = [];
    for (const it of items) {
      if (st.items.find(i => i.name === it)?.grants.includes(module)) continue;
      put(stt, `Letting ${module} use ${it}. Confirm it's you.`);
      try {
        await presence("vault.grant", { name: it, module }, { summary: `Let ${module} use “${it}”`, command: grantCommand(it, module) });
      } catch { left.push(it); }
      if (!ctx.alive()) return left;
    }
    return left;
  }

  /** After an add: close the form, and when a grant is still missing, say how to make it. */
  function done(left, name, module) {
    st.form = "";
    if (!left.length) { put(formBox); return; }
    put(formBox, h("div", { class: "cn-grant", "data-grant": "left" },
      h("p", { class: "small" }, `${name} is added, but ${module} cannot use ${left.length === 1 ? "its vault item" : "its vault items"} yet. Run this on the box, then press Test:`),
      left.map(it => h("code", { class: "set-mono cn-cmd" }, grantCommand(it, module))),
      h("div", { class: "set-actions" }, h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => put(formBox) }, "Done"))));
  }

  let t = 0;
  for (const type of EVENTS) ctx.on(type, () => { clearTimeout(t); t = setTimeout(load, 400); });
  ctx.cleanup(() => clearTimeout(t));
  await load();
}

/** mcp.test → what the panel draws. */
export function pickTest(d) {
  return { ok: d?.ok === true, ms: num(d?.ms) ?? 0, error: str(d?.error),
    tools: (Array.isArray(d?.tools) ? d.tools : []).filter(t => t && typeof t.tool === "string").map(t => ({ tool: t.tool, outward: t.outward !== false })),
    stderr: strs(d?.stderr).slice(-8) };
}

/** google.test → what the row draws. */
export function pickGoogleTest(d) {
  const scopes = {};
  if (isObj(d?.scopes)) for (const [k, v] of Object.entries(d.scopes)) scopes[k] = v === true;
  return { ok: d?.ok === true, scopes, error: str(d?.error) };
}

// ---- small parts --------------------------------------------------------------------------------

const meta = (k, v) => h("div", { class: "cn-meta-row" }, h("dt", { class: "cn-k" }, k), h("dd", { class: "cn-v" }, v));
function frow(id, label, input, hint) {
  return h("div", { class: "set-row" }, h("div", { class: "set-k" }, h("label", { for: id }, label)),
    h("div", { class: "set-v" }, input, hint ? h("span", { class: "small faint" }, hint) : null));
}
const errText = e => (e?.missing ? `The ${e.module} module is not running, so this cannot be changed here yet.` : String(e?.message || e));
function busy(e, word) {
  const b = /** @type {HTMLButtonElement} */ (e && e.currentTarget);
  if (b && "disabled" in b) { b.disabled = true; put(b, word); }
}

/** This section's stylesheet, added once (Settings' own sheet is the deck workstream's). */
let styled = false;
function style() {
  if (styled || typeof document === "undefined" || !document.head) return;
  styled = true;
  document.head.append(h("link", { rel: "stylesheet", href: "/css/views/connections.css" }));
}
