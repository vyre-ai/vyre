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
// Adding a Google account is "Sign in with Google" by default: grant the OAuth client item, call
// google.connect, open Google's page in a new tab, and wait for google.connected (or a pasted
// address, for a browser on another device). An open sign-in is cancelled when the form closes or
// the view goes away. A service account gets the admin console's two values to copy instead.
//
// Tools: mcp.servers, mcp.add, mcp.update, mcp.remove, mcp.test, mcp.restart, google.accounts,
// google.add, google.remove, google.test, google.connect, google.connect.finish,
// google.connect.cancel, vault.list, vault.grant, projects.list, agents.list, github.accounts,
// github.connect, github.connect.cancel, github.remove.
//
// GitHub (ADR 0041): "Sign in with GitHub" is a device code, not a redirect. github.connect
// returns a short code and GitHub's own page; the person types the code there (or opens
// verification_uri_complete, which fills it in), and Vyre polls on its own until github.connected
// or github.connect-failed arrives. No tab to catch, no address to paste, so its waiting panel is
// simpler than Google's: the code, a copy button, an "Open GitHub" link, and how long the code
// lasts. Nothing here ticks or polls; GitHub's own expiry ends the flow with github.connect-failed
// when the person runs out of time. github.remove only removes Vyre's own vault item and account row; it never
// revokes the token at GitHub (the card says so and where to do it).

import { h, put, empty } from "../js/dom.js";
import { icon } from "../js/icons.js";
import { attempt as apiAttempt } from "../js/api.js";
import { withPresence, PresenceError } from "./memory-presence.js";
import { showToast } from "../js/toast.js";
import { since, plural } from "../js/fmt.js";
import { statusMark, statusOf } from "../js/status-mark.js";
import { drawCatalog } from "./connectors.js";
import { redact } from "../js/redact.js";

/** Vault kinds that make sense for each way of using an item (ADR 0016, decision 2). */
export const ITEM_KINDS = {
  bearer: ["api-key", "secret"],
  env: ["api-key", "secret", "env-set"],
  oauth: ["env-set"],
  "service-account": ["note", "secret"],
  signin: ["env-set"],
};
const AUTH_WORDS = { none: "None", bearer: "Bearer token", env: "Env vars", oauth: "OAuth", "service-account": "Service account" };
/** The ways a Google account signs in, as the form's segment shows them. */
const SIGN_WORDS = [["signin", "Sign in with Google"], ["service-account", "Service account"], ["oauth", "Refresh token item"]];
/** How the OAuth client gets into the vault (core/cli/commands/vault.js); the values are typed at its prompts. */
export const CLIENT_PUT = "vyre vault put google-oauth-client --kind env-set --field client_id --field client_secret";
const MODE_WORDS = [["read", "Read"], ["write", "Held"], ["off", "Off"]];
const STATE_WORDS = { stopped: "stopped", starting: "starting", running: "running", failed: "failed" };
/** The events that change what this section shows. mcp.called is left out: it only moves lastUsed. */
export const EVENTS = ["mcp.added", "mcp.updated", "mcp.removed", "mcp.started", "mcp.stopped", "mcp.failed", "mcp.refreshed",
  "google.added", "google.removed", "google.connected", "google.connect-failed", "vault.granted",
  "vault.connection-added", "vault.connection-removed", "vault.connection-changed",
  "github.added", "github.removed", "github.connected", "github.connect-failed"];

const str = v => (typeof v === "string" ? v : "");
const strs = v => (Array.isArray(v) ? v.filter(x => typeof x === "string") : []);
const num = v => (typeof v === "number" && isFinite(v) ? v : null);
const isObj = v => Boolean(v) && typeof v === "object" && !Array.isArray(v);
/** Only https://github.com/... ever becomes a link's href (reviewer's LOW: verification_uri is
 * GitHub's own reply, passed through unchecked otherwise); anything else falls back to the plain
 * device page, which always works with the code shown beside it. */
const safeGithubUrl = u => (/^https:\/\/github\.com\//.test(String(u || "")) ? u : "https://github.com/login/device");

/** @typedef {{ id: string, name: string, url: string, over: boolean, stt: HTMLElement, win?: Window | null }} Flow */
/** @typedef {{ id: string, name: string, user_code: string, verification_uri: string, verification_uri_complete?: string, minutes: number, over: boolean, stt: HTMLElement }} GhFlow */

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
        agents: s.scope?.agents === "*" || !Array.isArray(s.scope?.agents) ? "*" : strs(s.scope.agents),
        // connectors' default for a server nobody widened: no project's agents, only the person and the assistant.
        assistant: s.scope?.assistant === true && Array.isArray(s.scope?.agents) && s.scope.agents.length === 0 },
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

/** github.accounts → rows with only the fields drawn: name, login and avatar, never a token. */
export function pickGithubAccounts(d) {
  const list = Array.isArray(d) ? d : [];
  return list.filter(a => a && typeof a.name === "string").map(a => ({ name: a.name, login: str(a.login), avatar_url: str(a.avatar_url) }));
}

/**
 * The surfaces vault.connections.grant/revoke know (ADR 0028 decision 9b). "Planner" is not
 * one yet: app-design's Connections board shows a Planner chip, and the lead's ask is for these
 * chips to grant real access, so this is a live question back to vault and app-design rather
 * than a chip this file invents (docs/work/connectors.md, Needs from others).
 */
export const SURFACE_NAMES = ["capsule", "chat", "agents", "phone"];
/** A provider name (core/vault/providers.js) to the word and card group the board draws. */
const PROVIDER_WORDS = {
  "google-oauth": { word: "Google", group: "google" }, "google-dwd": { word: "Google", group: "google" },
  "google-apps-script": { word: "Apps Script", group: "mail" }, "imap-smtp": { word: "Mail login", group: "mail" },
  mcp: { word: "MCP server", group: "mcp" },
};
const providerWord = p => (PROVIDER_WORDS[p] || { word: p || "Connection", group: "other" });

/**
 * vault.connections.list → one card's fields per connection, named only, whatever the source
 * (Google, mail, Apps Script or an MCP server): the shape every mcp-native card in
 * docs/design/mcp-native.md and app-design's Connections board (db3dbbfa) draws from. A
 * multi-account server (two Gmail MCPs, one per inbox) is already two rows here, each its own
 * card and its own grant, since the vault resyncs one connection per mcp.servers row.
 * @param {any} d
 */
export function pickConnections(d) {
  const list = Array.isArray(d) ? d : Array.isArray(d?.connections) ? d.connections : [];
  return list.filter(c => c && typeof c.id === "string").map(c => {
    const { word, group } = providerWord(str(c.provider));
    const surfaces = SURFACE_NAMES.filter(s => Array.isArray(c.surfaces) && c.surfaces.includes(s));
    const caps = strs(c.capabilities);
    const defaultFor = strs(c.default).filter(cap => caps.includes(cap));
    return {
      id: c.id, provider: str(c.provider), providerWord: word, group,
      account: str(c.account), label: str(c.label) || str(c.account),
      ready: c.state === "ready", needs: Array.isArray(c.needs) ? c.needs.map(n => ({ module: str(n?.module), need: str(n?.need) })) : [],
      capabilities: caps, surfaces, defaultFor,
      lastUsed: num(c.last_used), connected: num(c.added),
    };
  });
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
 * A tool that sends can be Held or Off, never Read (the hub refuses it), so its Read is disabled.
 * @param {{ tool: string, outward: boolean, sends?: boolean }[]} tools @param {Record<string, string>} mode
 */
export function toolModes(tools, mode = {}) {
  const out = tools.map(t => ({ tool: t.tool, mode: mode[t.tool] || (t.outward ? "write" : "read"), set: Boolean(mode[t.tool]), sends: Boolean(t.sends) }));
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
    connections: /** @type {ReturnType<typeof pickConnections>} */ ([]), connectionsErr: /** @type {any} */ (null),
    githubAccounts: /** @type {ReturnType<typeof pickGithubAccounts>} */ ([]), githubErr: /** @type {any} */ (null),
    items: /** @type {ReturnType<typeof pickItems>} */ ([]),
    projects: /** @type {{ slug: string, name: string }[]} */ ([]), agents: /** @type {string[]} */ ([]),
    /** What Test found, kept across redraws so a refresh does not close it. */
    tested: new Map(), gtested: new Map(),
    /** A row asking "Remove?" */
    confirming: "",
    form: /** @type {"" | "mcp" | "google" | "github"} */ (""),
    /** The open "Sign in with Google", if any. */
    flow: /** @type {Flow | null} */ (null),
    /** The open "Sign in with GitHub" device code, if any. */
    ghFlow: /** @type {GhFlow | null} */ (null),
  };

  const top = h("div");
  const cardsBox = h("div", { class: "cn-cards" });
  const catalogBox = h("div", { class: "cn-group" });
  const mcpBox = h("div", { class: "cn-group" });
  const googleBox = h("div", { class: "cn-group" });
  const githubBox = h("div", { class: "cn-group" });
  const formBox = h("div");
  put(el, top, cardsBox, catalogBox, mcpBox, googleBox, githubBox, formBox);
  void drawCatalog(catalogBox, ctx, { attempt, projects: () => (st.projects.length ? st.projects.map(x => ({ slug: x.slug, name: x.name })) : null) });

  async function load() {
    const [s, g, c, gh] = await Promise.all([attempt("mcp.servers"), attempt("google.accounts"), attempt("vault.connections.list"), attempt("github.accounts", {}, { ifPresent: true })]);
    if (!ctx.alive()) return;
    st.serverErr = s.error || null;
    st.servers = s.error ? [] : pickServers(s.data);
    st.accountErr = g.error || null;
    st.accounts = g.error ? [] : pickAccounts(g.data);
    st.connectionsErr = c.error || null;
    st.connections = c.error ? [] : pickConnections(c.data);
    st.githubErr = gh.error || null;
    st.githubAccounts = gh.error ? [] : pickGithubAccounts(gh.data);
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
    drawCards();
    const both = st.serverErr?.missing && st.accountErr?.missing;
    if (both) {
      put(top, h("div", { class: "empty cn-empty" }, "No connectors are running on this machine.",
        h("span", { class: "code" }, "The mcp and google modules are not running. When they are, MCP servers and Google accounts are added here or with vyre connect add.")));
      put(mcpBox); put(googleBox); put(githubBox); put(formBox);
      return;
    }
    put(top, h("p", { class: "set-note small muted" },
      "MCP servers and Google accounts Vyre can use. Each one names a vault item; the value stays sealed in the vault and never comes to this page."));
    drawServers();
    drawAccounts();
    drawGithub();
  }

  // ---- Connections cards (vault.connections.list) --------------------------------------------
  //
  // One card per connection, whatever the source (Google, mail, Apps Script, an MCP server), same
  // shape (card.md's "Connections card" variant, account-row.md, chip.md's surface-grant chip,
  // all finished by app-design f65d51e5/47030189; mcp-native gap 2). Two accounts of one MCP
  // server are already two vault_connections rows, so already two cards, each its own grants.
  // "Wrong account?" and a problem row's fix action are not wired yet (need a real reconnect flow
  // per provider from app-design/vault); the toggle chips and "Connect another account" are real.

  // Icon names from deck/js/icons.js's set: "globe" for an OAuth sign-in account (icons.md has no
  // per-provider glyph yet, account-row.md's own Gaps), "mail" for a mail login or Apps Script,
  // "agents" for an MCP server (the board's own choice, no MCP glyph exists either), "key" for
  // anything else the catalog names.
  const GROUP_ICON = { google: "globe", mail: "mail", mcp: "agents", other: "key" };
  /** Surface name to the chip's label and icon, in the order the board draws them. */
  const SURFACE_META = { capsule: { label: "Lumen", icon: "capsule" }, chat: { label: "Chat", icon: "chat" },
    agents: { label: "Agents", icon: "agents" }, phone: { label: "Phone", icon: "phone" } };

  function drawCards() {
    if (st.connectionsErr) {
      // A missing vault module: say nothing extra here, the group below already explains a
      // missing mcp/google module, and vault.connections.list not existing yet on this box is
      // not a fault to alarm over (older Vyre; the two groups below still work standalone).
      put(cardsBox);
      return;
    }
    if (!st.connections.length) { put(cardsBox); return; }
    put(cardsBox, h("h3", { class: "set-h3" }, "Connections"),
      h("div", { class: "cn-card-list" }, st.connections.map(connectionCard)),
      h("div", { class: "cn-add", tabindex: "0", role: "button", onclick: () => chooseAdd() },
        h("span", { class: "cn-avatar" }, icon("plus", 16)),
        h("div", { class: "cn-add-t" }, h("span", { class: "cn-name" }, "Connect another account"),
          h("span", { class: "cn-meta" }, "Google, a mail login, or any MCP server"))));
  }

  /** The existing add flow: MCP server or Google account (mail's own Deck row is not built yet). */
  function chooseAdd() {
    openForm(st.servers.length <= st.accounts.length ? "mcp" : "google");
  }

  /** account-row.md's meta line: "label · provider", or the provider alone with no custom label. */
  function metaLine(c) {
    return c.label && c.label !== c.account ? `${c.label} · ${c.providerWord}` : c.providerWord;
  }

  /** account-row.md's Trailing, priority order: a default beats Last used beats nothing. */
  function trailing(c) {
    if (c.defaultFor.length) return "Default";
    if (c.lastUsed) return `Last used ${since(c.lastUsed)} ago`;
    return "";
  }

  function connectionCard(c) {
    if (!c.ready) {
      return h("div", { class: "cn-card cn-card-problem", "data-connection": c.id },
        h("span", { class: "cn-avatar" }, icon(GROUP_ICON[c.group] || GROUP_ICON.other, 16)),
        h("div", { class: "cn-card-t" }, h("span", { class: "cn-name" }, c.account),
          h("span", { class: "cn-meta" }, "Needs sign-in")),
        h("button", { type: "button", class: "btn btn-sm" }, "Sign in"));
    }
    const trail = trailing(c);
    return h("div", { class: "cn-card", "data-connection": c.id },
      h("div", { class: "cn-card-top" },
        h("span", { class: "cn-avatar" }, icon(GROUP_ICON[c.group] || GROUP_ICON.other, 16)),
        h("div", { class: "cn-card-t" }, h("span", { class: "cn-name" }, c.account), h("span", { class: "cn-meta" }, metaLine(c))),
        trail ? h("span", { class: "cn-trailing" }, trail) : null),
      h("div", { class: "cn-granted" },
        h("span", { class: "cn-granted-l" }, "Granted to"),
        ...SURFACE_NAMES.map(s => chip(c, s))),
      h("div", { class: "cn-card-f" },
        h("span", { class: "cn-steplink", role: "button", tabindex: "0", onclick: () => chooseAdd() }, "Wrong account?"),
        h("span", { class: "cn-connected" }, c.connected ? `Connected ${since(c.connected)} ago` : "")));
  }

  function chip(c, surface) {
    const on = c.surfaces.includes(surface);
    const { label, icon: iconName } = SURFACE_META[surface];
    // Granting Agents hands a credential to an autonomous session, so it asks for Touch ID or a
    // passkey first (chip.md's Asking state); the shield glyph trails the label whenever it is
    // off, showing the affordance rather than leaving it to be discovered on tap. Every other
    // grant, and every revoke, is one tap (card.md's Connections card, the lead's call
    // 2026-09-28).
    let shieldIcon = null;
    if (!on && surface === "agents") {
      shieldIcon = icon("shield", 12);
      shieldIcon.setAttribute("class", "cn-chip-shield");
    }
    return h("button", { type: "button", class: "cn-chip" + (on ? " cn-chip-on" : ""), "aria-pressed": on ? "true" : "false",
      onclick: (/** @type {Event} */ e) => toggleSurface(c, surface, !on, e) },
      icon(iconName, 12), label, shieldIcon);
  }

  /**
   * Grant or revoke one surface. Revoke, and a grant to anything but Agents, is optimistic
   * (cohesion's docs/design/interaction.md): the chip flips and redraws before the call settles,
   * then a toast either confirms with Undo (call the opposite action again) or, on error, reverts
   * the chip and says why. Granting Agents does not flip until vault's own presence gate on
   * `vault.connections.grant` (core/vault/tools/connections.js, `when: surface === "agents"`)
   * resolves: withPresence (this file's `presence`, the same helper vault.grant already uses
   * below) shows the system's Touch ID or passkey sheet, retries once proven, and a refusal
   * leaves the chip Off with nothing shown but the system's own cancel (chip.md's Asking state;
   * reusing vault's existing gate, not a new check, per the lead).
   * @param {ReturnType<typeof pickConnections>[number]} c @param {string} surface @param {boolean} next
   * @param {Event} [e]
   */
  async function toggleSurface(c, surface, next, e) {
    const label = SURFACE_META[surface].label;
    if (next && surface === "agents") {
      const btn = /** @type {HTMLButtonElement} */ (e && e.currentTarget);
      if (btn) btn.setAttribute("aria-busy", "true");
      try {
        await presence("vault.connections.grant", { id: c.id, surface }, { summary: `Let Agents use "${c.label}"` });
      } catch (err) {
        // Cancelled, no passkey, expired or refused: withPresence's own sheet already shows why
        // (memory-presence.js), so nothing more here (chip.md: "nothing shown but the system's
        // own cancel"). Only a plain tool error (not a PresenceError: the connection failed
        // outright) gets a toast of its own.
        if (btn) btn.removeAttribute("aria-busy");
        if (!ctx.alive()) return;
        if (!(err instanceof PresenceError)) showToast({ text: `Could not let Agents use ${c.label}: ${errText(err)}` });
        return;
      }
      if (!ctx.alive()) return;
      if (btn) btn.removeAttribute("aria-busy");
      c.surfaces = [...new Set([...c.surfaces, surface])];
      drawCards();
      showToast({ text: `${label} granted for ${c.label}`, undo: () => toggleSurface(c, surface, false) });
      return;
    }
    const before = c.surfaces;
    c.surfaces = next ? [...new Set([...before, surface])] : before.filter(s => s !== surface);
    drawCards();
    const r = await attempt(next ? "vault.connections.grant" : "vault.connections.revoke", { id: c.id, surface });
    if (!ctx.alive()) return;
    if (r.error) {
      c.surfaces = before;
      drawCards();
      showToast({ text: `Could not change ${label} for ${c.label}: ${errText(r.error)}` });
      return;
    }
    if (next) showToast({ text: `${label} granted for ${c.label}`, undo: () => toggleSurface(c, surface, false) });
  }

  // ---- MCP servers ----

  function drawServers() {
    const add = h("button", { type: "button", class: "btn btn-sm" + (st.servers.length ? "" : " btn-primary"), "data-act": "add-mcp", disabled: !!st.serverErr, onclick: () => openForm("mcp") }, "Add MCP server");
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
        h("span", { class: "set-state cn-state" + (s.state === "running" || failed ? "" : " faint"), "data-state": s.state },
          statusOf(s.state) === "running" || failed ? statusMark(s.state, { beside: true }) : null, s.state)),
      failed && s.error ? h("div", { class: "small cn-err" }, s.error) : null,
      h("dl", { class: "cn-meta" },
        meta("Runs", h("code", { class: "set-mono" }, how || "")),
        meta("Tools", s.tools === null ? h("span", { class: "muted" }, "Not listed yet. Test lists them.") : String(s.tools)),
        meta("Auth", authWords(s)),
        meta("Scope", s.scope.assistant ? "Just you and the assistant" : `${scopeWords(s.scope.projects, "Every project", "project")} · ${scopeWords(s.scope.agents, "every agent", "agent")}`),
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
      MODE_WORDS.map(([m, word]) => h("button", { type: "button", "aria-pressed": String(r.mode === m), "data-mode": m,
        ...(m === "read" && r.sends ? { disabled: true, title: "It sends as you, so it is always held" } : {}), onclick: async () => {
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
    const add = h("button", { type: "button", class: "btn btn-sm" + (st.accounts.length ? "" : " btn-primary"), "data-act": "add-google", disabled: !!st.accountErr, onclick: () => openForm("google") }, "Add Google account");
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
      t && a.auth.type === "service-account" ? adminBlock(t) : null,
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
            await testAccount(a.name);
            if (!ctx.alive()) return;
            drawAccounts();
          } }, "Test"),
          h("button", { type: "button", class: "btn btn-ghost btn-sm", "data-act": "remove", onclick: () => { st.confirming = `google:${a.name}`; drawAccounts(); } }, "Remove")),
      status);
  }
  function sayG(name, text) {
    const r = googleBox.querySelector(`[data-account="${name}"] .set-status`);
    if (r) put(/** @type {HTMLElement} */ (r), text);
  }

  // ---- GitHub accounts ----

  function drawGithub() {
    const add = h("button", { type: "button", class: "btn btn-sm" + (st.githubAccounts.length ? "" : " btn-primary"), "data-act": "add-github", disabled: !!st.githubErr, onclick: () => openForm("github") }, "Add GitHub account");
    if (st.githubErr) { put(githubBox, h("h3", { class: "set-h3" }, "GitHub accounts"), empty("GitHub accounts are kept by the github module.", st.githubErr)); return; }
    put(githubBox, h("h3", { class: "set-h3" }, "GitHub accounts"),
      st.githubAccounts.length ? h("div", { class: "rows" }, st.githubAccounts.map(githubRow))
        : h("div", { class: "empty" }, "No GitHub account yet. Connect one and an agent can clone your repos and work in its own worktree, one branch per session."),
      h("div", { class: "set-actions" }, add));
  }

  function githubRow(a) {
    const status = h("div", { class: "small muted set-status", role: "status" });
    return h("div", { class: "cn-row", "data-github": a.name },
      h("div", { class: "cn-head" },
        a.avatar_url ? h("img", { class: "cn-avatar-img", src: a.avatar_url, alt: "", width: "20", height: "20" }) : null,
        h("span", { class: "mono cn-name" }, a.name), h("span", { class: "muted" }, a.login)),
      st.confirming === `github:${a.name}`
        ? h("div", { class: "set-actions cn-confirm" },
          h("span", { class: "small" }, `Disconnect ${a.name}? This removes its token from your vault and the account from Vyre. It does not revoke the token at GitHub. To do that, delete it at `,
            h("a", { href: "https://github.com/settings/applications", target: "_blank", rel: "noopener noreferrer" }, "github.com/settings/applications"), " (signed in with GitHub) or ",
            h("a", { href: "https://github.com/settings/tokens", target: "_blank", rel: "noopener noreferrer" }, "github.com/settings/tokens"), " (a token you pasted)."),
          h("button", { type: "button", class: "btn btn-sm", "data-act": "remove-yes", onclick: async () => {
            const r = await attempt("github.remove", { name: a.name });
            if (!ctx.alive()) return;
            st.confirming = "";
            if (r.error) { drawGithub(); sayGh(a.name, errText(r.error)); return; }
            if (r.data?.warning) { await load(); if (!ctx.alive()) return; sayGh(a.name, r.data.warning); return; }
            await load();
          } }, "Disconnect"),
          h("button", { type: "button", class: "btn btn-ghost btn-sm", "data-act": "remove-no", onclick: () => { st.confirming = ""; drawGithub(); } }, "Cancel"))
        : h("div", { class: "set-actions cn-acts" },
          h("button", { type: "button", class: "btn btn-ghost btn-sm", "data-act": "remove", onclick: () => { st.confirming = `github:${a.name}`; drawGithub(); } }, "Disconnect")),
      status);
  }
  function sayGh(name, text) {
    const r = githubBox.querySelector(`[data-github="${name}"] .set-status`);
    if (r) put(/** @type {HTMLElement} */ (r), text);
  }

  /** "Connect a GitHub account": a name, then Sign in with GitHub (the device flow, ADR 0041). */
  function githubForm() {
    const name = /** @type {HTMLInputElement} */ (h("input", { class: "input", id: "cgh-name", autocomplete: "off", spellcheck: "false", placeholder: "work" }));
    const stt = h("div", { class: "small muted set-status", role: "status" });
    const save = /** @type {HTMLButtonElement} */ (h("button", { type: "submit", class: "btn btn-primary" }, "Sign in with GitHub"));
    // The second way in: a token the person made at GitHub. A secret: a password field, sent once, never shown, logged or kept here.
    const token = /** @type {HTMLInputElement} */ (h("input", { class: "input", id: "cgh-token", type: "password", autocomplete: "off", spellcheck: "false", "aria-label": "GitHub token" }));
    const tokBtn = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "btn btn-sm", "data-act": "github-token", onclick: async () => {
      const n = name.value.trim(), t = token.value.trim();
      if (!n) { put(stt, "Give the account a name, like work or personal."); return; }
      if (!t) { put(stt, "Paste the token first."); return; }
      tokBtn.disabled = true; save.disabled = true;
      put(stt, "Checking the token.");
      const r = await attempt("github.connect", { name: n, token: t });
      token.value = "";
      if (!ctx.alive()) return;
      tokBtn.disabled = false; save.disabled = false;
      // GitHub's own message is shown as it came (a bad token is a 401 with its words); nothing is made up.
      if (r.error) { put(stt, redact(r.error.message || r.error.code || "GitHub did not take that token.", [t])); return; }
      const login = str(r.data?.login), repos = num(r.data?.repos);
      st.form = ""; put(formBox);
      showToast({ text: login ? `Connected ${login}${repos != null ? `, reaches ${plural(repos, "repo")}` : ""}` : "Connected the GitHub account." });
      await load();
    } }, "Connect with this token"));
    const form = h("form", { class: "set-form cn-form", "data-form": "github", onsubmit: async (/** @type {Event} */ e) => {
      e.preventDefault();
      const n = name.value.trim();
      if (!n) { put(stt, "Give the account a name, like work or personal."); return; }
      save.disabled = true;
      put(stt, "Starting.");
      const r = await attempt("github.connect", { name: n });
      if (!ctx.alive()) return;
      const id = str(r.data?.id), user_code = str(r.data?.user_code), verification_uri = str(r.data?.verification_uri);
      if (r.error || !id || !user_code || !verification_uri) { save.disabled = false; put(stt, r.error ? errText(r.error) : "GitHub did not return a code. Try again."); return; }
      if (st.form !== "github") { attempt("github.connect.cancel", { id }); return; }
      const verification_uri_complete = str(r.data?.verification_uri_complete) || undefined;
      const minutes = Math.max(1, Math.round((num(r.data?.expires_in) || 900) / 60));
      githubWaiting({ id, name: n, user_code, verification_uri, verification_uri_complete, minutes, over: false, stt: h("div") });
    } },
      h("h3", { class: "set-h3" }, "Add a GitHub account"),
      h("div", { class: "rows" },
        frow("cgh-name", "Name", name, "What the assistant calls it, like work or personal.")),
      h("p", { class: "small faint" }, "GitHub asks for repo access, full read/write on every repo the account can reach. Its device sign-in has no narrower option; a later release narrows this to the repos you pick."),
      h("div", { class: "set-actions" }, save, h("button", { type: "button", class: "btn btn-ghost", onclick: closeForm }, "Cancel")),
      h("details", { class: "cn-token" }, h("summary", { class: "small" }, "Paste a token instead"),
        h("div", { class: "rows" }, frow("cgh-token", "Token", token, "A token you made at GitHub. A fine-grained token can reach fewer repos than signing in does.")),
        h("div", { class: "set-actions" }, tokBtn)), stt);
    put(formBox, form);
    name.focus();
  }

  /**
   * The open device-code sign-in: the code shown large with Copy, an "Open GitHub" link (or the
   * verification_uri_complete address when GitHub sent one, which fills the code in for you), how
   * long it lasts, and Cancel. Vyre polls GitHub on its own; nothing here polls or ticks, GitHub's
   * own expiry ends the flow with github.connect-failed when the person runs out of time.
   * @param {GhFlow} flow
   */
  function githubWaiting(flow) {
    st.ghFlow = flow;
    const codeEl = h("div", { class: "cn-gh-code", "aria-label": "Your code" }, flow.user_code);
    const copyBtn = h("button", { type: "button", class: "btn btn-sm", "data-act": "copy-code", onclick: async () => {
      try { await navigator.clipboard.writeText(flow.user_code); put(copyBtn, "Copied"); } catch { put(copyBtn, "Copy"); }
    } }, "Copy");
    const openHref = safeGithubUrl(flow.verification_uri_complete || flow.verification_uri);
    put(formBox, h("div", { class: "set-form cn-form cn-wait", "data-form": "github", "data-signin": "waiting" },
      h("h3", { class: "set-h3" }, "Add a GitHub account"),
      h("p", { class: "cn-wait-t" }, "Enter this code at github.com/login/device:"),
      h("div", { class: "cn-gh-code-row" }, codeEl, copyBtn),
      h("div", { class: "set-actions" }, h("a", { class: "btn btn-primary", href: openHref, target: "_blank", rel: "noopener noreferrer", "data-act": "open-github" }, "Open GitHub")),
      h("p", { class: "small muted" }, `Good for about ${plural(flow.minutes, "minute")}.`),
      h("div", { class: "set-actions" }, h("button", { type: "button", class: "btn btn-ghost", "data-act": "cancel-signin", onclick: () => closeForm() }, "Cancel")),
      h("div", { class: "small muted set-status", role: "status" }, flow.stt)));
  }

  /** The device sign-in finished: reload and close. */
  async function githubConnected(flow) {
    if (flow.over) return;
    flow.over = true;
    st.ghFlow = null;
    st.form = "";
    put(formBox);
    await load();
  }

  /** The device sign-in ended without an account: say why, and offer to start again. */
  function githubFailed(flow, error) {
    if (flow.over) return;
    flow.over = true;
    st.ghFlow = null;
    put(formBox, h("div", { class: "set-form cn-form cn-wait", "data-form": "github", "data-signin": "failed" },
      h("h3", { class: "set-h3" }, "Add a GitHub account"),
      h("p", { class: "small cn-err", "data-hint": "signin-failed" }, error || "The sign-in ended without an account."),
      h("div", { class: "set-actions" },
        h("button", { type: "button", class: "btn btn-sm", "data-act": "again", onclick: () => openForm("github") }, "Start again"),
        h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => closeForm() }, "Close"))));
  }

  /** Cancel the open GitHub sign-in, if any. Nothing waits on the answer. */
  function cancelGithubFlow() {
    const flow = st.ghFlow;
    if (!flow || flow.over) return;
    flow.over = true;
    st.ghFlow = null;
    attempt("github.connect.cancel", { id: flow.id });
  }

  /** github.connected and github.connect-failed, for the open sign-in only. */
  function onGithubFlow(type, e) {
    const flow = st.ghFlow;
    const p = isObj(e?.payload) ? e.payload : {};
    if (!flow || flow.over || p.id !== flow.id || !ctx.alive()) return;
    if (type === "github.connected") githubConnected(flow);
    else if (type === "github.connect-failed") githubFailed(flow, str(p.error));
  }

  /**
   * What a Workspace admin pastes to let a service account act for people: its client ID and the
   * scope line, each with Copy. Both are public identifiers, never a key.
   */
  function adminBlock(t) {
    return h("div", { class: "cn-admin", "data-admin": "delegation" },
      h("div", { class: "small" }, "Allow it in the Google Workspace admin console. Under Security, API controls, Domain-wide delegation, add a new client with this client ID and these scopes."),
      h("div", { class: "cn-copies" },
        t.client_id ? copyRow("Client ID", t.client_id, "client_id")
          : h("div", { class: "small muted" }, "The client ID is the client_id in the service account's JSON."),
        t.admin_scopes ? copyRow("Scopes", t.admin_scopes, "admin_scopes") : null));
  }

  /** A label, the value in a read-only box, and Copy. When the clipboard is not allowed, the value is selected instead. */
  function copyRow(label, value, key) {
    const box = /** @type {HTMLInputElement} */ (h("input", { class: "input set-mono cn-copy-v", readonly: true, value, "aria-label": label, spellcheck: "false" }));
    const b = h("button", { type: "button", class: "btn btn-sm", "data-copy": key, onclick: async () => {
      try {
        await navigator.clipboard.writeText(value);
        put(b, "Copied");
      } catch {
        box.focus();
        box.select();
        put(b, "Selected. Copy it with your keyboard.");
      }
    } }, "Copy");
    return h("div", { class: "cn-copy", "data-value": key }, h("span", { class: "cn-k" }, label), box, b);
  }

  function scopeList(t) {
    const names = Object.keys(t.scopes);
    if (!names.length) return h("span", { class: "muted" }, t.ok ? "None" : "Not checked");
    return h("div", { class: "set-tags" }, names.map(s => h("span", { class: "tag cn-scope" + (t.scopes[s] ? "" : " refused"), "data-scope": s },
      s, " ", t.scopes[s] ? "granted" : "refused")));
  }

  // ---- add forms ----

  async function openForm(kind) {
    cancelFlow();
    cancelGithubFlow();
    st.form = kind;
    // GitHub's sign-in names no vault item itself (it makes its own), so it needs none of the
    // vault/project/agent choices the other two forms pick from.
    if (kind === "github") { githubForm(); return; }
    put(formBox, h("div", { class: "empty" }, "Loading your vault's item names."));
    const { vaultErr } = await loadChoices();
    if (!ctx.alive() || st.form !== kind) return;
    if (kind === "mcp") mcpForm(vaultErr); else googleForm(vaultErr);
  }
  const closeForm = () => { cancelFlow(); cancelGithubFlow(); st.form = ""; put(formBox); };

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
    const args = /** @type {HTMLInputElement} */ (h("input", { class: "input", id: "cn-args", autocomplete: "off", spellcheck: "false", placeholder: "Arguments, if any" }));
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
    let type = "signin";
    const name = /** @type {HTMLInputElement} */ (h("input", { class: "input", id: "cg-name", autocomplete: "off", spellcheck: "false", placeholder: "work" }));
    const email = /** @type {HTMLInputElement} */ (h("input", { class: "input", id: "cg-email", type: "email", autocomplete: "off", spellcheck: "false", placeholder: "Your email address" }));
    const subject = /** @type {HTMLInputElement} */ (h("input", { class: "input", id: "cg-subject", type: "email", autocomplete: "off", spellcheck: "false", placeholder: "The address above" }));
    const seg = h("div", { class: "seg cn-seg", role: "group", "aria-label": "How it signs in" });
    const rest = h("div", { class: "rows" });
    const subjectRow = h("div");
    const stt = h("div", { class: "small muted set-status", role: "status" });
    let item = itemSelect("signin", "cg-item");
    const save = /** @type {HTMLButtonElement} */ (h("button", { type: "submit", class: "btn btn-primary", "data-act": "save" }));
    const drawSeg = () => put(seg, SIGN_WORDS.map(([v, t]) =>
      h("button", { type: "button", "aria-pressed": String(type === v), "data-auth": v, onclick: () => { type = v; put(stt); drawSeg(); drawRest(); } }, t)));
    const drawRest = () => {
      item = itemSelect(type, "cg-item");
      const hint = type === "signin"
        ? [h("span", { class: "small faint" }, "A Desktop app OAuth client from Google Cloud console, kept in the vault as an env set with client_id and client_secret:"),
          h("code", { class: "set-mono cn-cmd" }, CLIENT_PUT)]
        : h("span", { class: "small faint" }, type === "oauth" ? "An env set with client_id, client_secret, refresh_token and token_uri."
          : "A note or secret holding the service account's JSON. It acts as the address below through domain-wide delegation.");
      put(rest,
        type === "signin" ? null : frow("cg-email", "Address", email),
        h("div", { class: "set-row" }, h("div", { class: "set-k" }, h("label", { for: "cg-item" }, type === "signin" ? "OAuth client" : "Vault item")),
          h("div", { class: "set-v" }, item, hint)));
      put(subjectRow, type === "service-account" ? h("div", { class: "rows" }, frow("cg-subject", "Acts as", subject, "Leave empty to act as the account's own address.")) : null);
      put(save, type === "signin" ? "Sign in with Google" : "Add account");
    };
    const form = h("form", { class: "set-form cn-form", "data-form": "google", onsubmit: async (/** @type {Event} */ e) => {
      e.preventDefault();
      if (type === "signin") return signIn();
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
        await testAccount(input.name);
        if (!ctx.alive()) return;
      }
      done(left, input.name, "google");
      await load();
    } },
      h("h3", { class: "set-h3" }, "Add a Google account"),
      vaultErr ? empty("The vault did not list its items, so none can be picked.", vaultErr) : null,
      h("div", { class: "rows" },
        frow("cg-name", "Name", name, "What the assistant calls it, like work or home."),
        h("div", { class: "set-row" }, h("div", { class: "set-k" }, "Signs in with"), h("div", { class: "set-v" }, seg))),
      rest,
      subjectRow,
      h("div", { class: "set-actions" }, save, h("button", { type: "button", class: "btn btn-ghost", onclick: closeForm }, "Cancel")), stt);

    /** Sign in with Google: grant the client item, start the sign-in, open Google's page, wait. */
    async function signIn() {
      const input = { name: name.value.trim(), client: item.value };
      if (!input.name) { put(stt, "Give the account a name."); return; }
      if (!input.client) { put(stt, "Choose the vault item that holds your OAuth client."); return; }
      save.disabled = true;
      // The tab opens now, before any await, while the press still counts as the person's own
      // action, so the browser does not block it. It gets Google's address once there is one.
      const w = window.open("", "_blank");
      if (w) try { w.opener = null; } catch {}
      const shut = () => { if (w) try { w.close(); } catch {} };
      const left = await grantAll([input.client], "google", stt);
      if (!ctx.alive()) { shut(); return; }
      if (left.length) {
        shut();
        save.disabled = false;
        put(stt, "The google module cannot read the OAuth client yet. Run this on your server, then press Sign in with Google again: ",
          h("code", { class: "set-mono" }, grantCommand(input.client, "google")));
        return;
      }
      put(stt, "Opening Google.");
      const r = await attempt("google.connect", input);
      const id = str(r.data?.id), url = str(r.data?.url);
      if (!ctx.alive()) { shut(); if (id) attempt("google.connect.cancel", { id }); return; }
      if (r.error || !id || !/^https:\/\//.test(url)) { shut(); save.disabled = false; put(stt, r.error ? errText(r.error) : "Vyre did not return Google's address. Try again."); return; }
      if (st.form !== "google") { shut(); attempt("google.connect.cancel", { id }); return; }
      if (w && !w.closed) w.location.href = url;
      waiting({ id, name: input.name, url, over: false, stt: h("div"), win: w }, !w);
    }

    drawSeg(); drawRest();
    put(formBox, form);
    name.focus();
  }

  /**
   * The open sign-in's panel: waiting for Google, a paste box for a browser on another device,
   * and Cancel. Google's address is not a secret (the client ID and a PKCE challenge), so when
   * the browser blocked the tab it is shown as a link, and only then.
   * @param {Flow} flow @param {boolean} blocked
   */
  function waiting(flow, blocked) {
    st.flow = flow;
    const paste = /** @type {HTMLInputElement} */ (h("input", { class: "input", id: "cg-paste", autocomplete: "off", spellcheck: "false", placeholder: "http://127.0.0.1:…/google/callback?state=…" }));
    const finish = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "btn btn-sm", "data-act": "finish", onclick: async () => {
      const url = paste.value.trim();
      if (!url) { put(flow.stt, "Paste the whole address from the browser's address bar."); return; }
      finish.disabled = true;
      put(flow.stt, "Finishing.");
      const r = await attempt("google.connect.finish", { id: flow.id, url });
      if (!ctx.alive() || flow.over) return;
      if (r.error) { finish.disabled = false; put(flow.stt, errText(r.error)); return; }
      await connected(flow, str(r.data?.name) || flow.name, str(r.data?.email));
    } }, "Finish"));
    put(formBox, h("div", { class: "set-form cn-form cn-wait", "data-form": "google", "data-signin": "waiting" },
      h("h3", { class: "set-h3" }, "Add a Google account"),
      h("p", { class: "cn-wait-t" }, blocked ? "Waiting for Google." : "Waiting for Google. Finish in the tab that opened."),
      blocked ? h("p", { class: "small", "data-hint": "blocked" }, "Your browser blocked the new tab: ",
        h("a", { href: flow.url, target: "_blank", rel: "noopener noreferrer", "data-act": "open-google" }, "open Google's sign-in page")) : null,
      h("div", { class: "rows" },
        h("div", { class: "set-row" }, h("div", { class: "set-k" }, h("label", { for: "cg-paste" }, "Another device")),
          h("div", { class: "set-v" },
            h("span", { class: "small faint" }, "Signed in on another device? Paste the address the browser landed on."),
            h("div", { class: "cn-paste" }, paste, finish)))),
      h("div", { class: "set-actions" }, h("button", { type: "button", class: "btn btn-ghost", "data-act": "cancel-signin", onclick: () => closeForm() }, "Cancel")),
      h("div", { class: "small muted set-status", role: "status" }, flow.stt)));
  }

  /** The sign-in finished, by the loopback (an event) or a paste: check scopes, then close. */
  async function connected(flow, name, email) {
    if (flow.over) return;
    flow.over = true;
    st.flow = null;
    put(flow.stt, email ? `Signed in as ${email}. Checking scopes with Google.` : "Signed in. Checking scopes with Google.");
    await testAccount(name);
    if (!ctx.alive()) return;
    done([], name, "google");
    await load();
  }

  /** The sign-in ended without an account: say why, and offer to start again. */
  function failed(flow, error) {
    if (flow.over) return;
    flow.over = true;
    st.flow = null;
    put(formBox, h("div", { class: "set-form cn-form cn-wait", "data-form": "google", "data-signin": "failed" },
      h("h3", { class: "set-h3" }, "Add a Google account"),
      h("p", { class: "small cn-err", "data-hint": "signin-failed" }, error || "The sign-in ended without an account."),
      h("div", { class: "set-actions" },
        h("button", { type: "button", class: "btn btn-sm", "data-act": "again", onclick: () => openForm("google") }, "Start again"),
        h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => closeForm() }, "Close"))));
  }

  /** Cancel the open sign-in, if any. Nothing waits on the answer. */
  function cancelFlow() {
    const flow = st.flow;
    if (!flow || flow.over) return;
    flow.over = true;
    st.flow = null;
    if (flow.win) try { flow.win.close(); } catch {}
    attempt("google.connect.cancel", { id: flow.id });
  }

  /** google.connected and google.connect-failed, for the open sign-in only. */
  function onFlow(type, e) {
    const flow = st.flow;
    const p = isObj(e?.payload) ? e.payload : {};
    if (!flow || flow.over || p.id !== flow.id || !ctx.alive()) return;
    if (type === "google.connected") connected(flow, str(p.name) || flow.name, str(p.email));
    else if (type === "google.connect-failed") failed(flow, str(p.error));
  }

  /** google.test for one account, kept for its row. */
  async function testAccount(name) {
    const t = await attempt("google.test", { name });
    if (!ctx.alive()) return;
    st.gtested.set(name, t.error ? { ok: false, scopes: {}, error: errText(t.error), client_id: "", admin_scopes: "" } : pickGoogleTest(t.data));
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
      h("p", { class: "small" }, `${name} is added, but ${module} cannot use ${left.length === 1 ? "its vault item" : "its vault items"} yet. Run this on your server, then press Test:`),
      left.map(it => h("code", { class: "set-mono cn-cmd" }, grantCommand(it, module))),
      h("div", { class: "set-actions" }, h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => put(formBox) }, "Done"))));
  }

  let t = 0;
  for (const type of EVENTS) ctx.on(type, e => { onFlow(type, e); onGithubFlow(type, e); clearTimeout(t); t = setTimeout(load, 400); });
  ctx.cleanup(() => { clearTimeout(t); cancelFlow(); cancelGithubFlow(); });
  await load();
}

/** mcp.test → what the panel draws. */
export function pickTest(d) {
  return { ok: d?.ok === true, ms: num(d?.ms) ?? 0, error: str(d?.error),
    tools: (Array.isArray(d?.tools) ? d.tools : []).filter(t => t && typeof t.tool === "string").map(t => ({ tool: t.tool, outward: t.outward !== false, sends: t.sends === true })),
    stderr: strs(d?.stderr).slice(-8) };
}

/** google.test → what the row draws. */
export function pickGoogleTest(d) {
  const scopes = {};
  if (isObj(d?.scopes)) for (const [k, v] of Object.entries(d.scopes)) scopes[k] = v === true;
  // A service account's two admin console values: a numeric client ID and Google scope URLs only.
  const client_id = /^\d{5,30}$/.test(str(d?.client_id)) ? str(d?.client_id) : "";
  const admin_scopes = str(d?.admin_scopes).split(",").filter(x => /^https:\/\/www\.googleapis\.com\/auth\/[\w.]+$/.test(x)).join(",");
  return { ok: d?.ok === true, scopes, error: str(d?.error), client_id, admin_scopes };
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
