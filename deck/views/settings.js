// @ts-check
// Settings: one column of quiet, rule-separated sections. No board of its own; built from
// TOKENS.md and the section style of DeckAgent and DeckVault, with the onboarding's look for the
// Setup list. Route /settings, with an optional #section.
//
// Every section loads on its own and shows its own empty state, so one missing module never
// blanks the page. Tools: onboard.status, onboard.claude, onboard.tailscale (box, also its read-only "lock"), agents.list and
// agents.update (switchboard), link.health (link), files.drive.status, files.drive.audit and files.drive.access (files), hooks.list and hooks.status (hooks),
// network.guests.list (network), computers.tailnet.status, computers.egress.status and computers.handback.status/set (computers), recall.status, recall.index, memory.stats, memory.curate,
// learn.lessons, learn.edit, learn.retire (learning), system.info, and GET /v1/modules.
// Connections is drawn by views/connections.js (the connectors workstream, ADR 0016). The registry's
// settings (settings.schema, settings.get/set/reset) are drawn by views/settings-keys.js, one section
// per group under "Sessions and Claude"; ?key=<key> scrolls to one and highlights it.

import { h, put, link, head, empty } from "../js/dom.js";
import { attempt, modules, canProve, on } from "../js/api.js";
import { pushState, subscribePush, unsubscribePush, enrollPasskey, passkeyState, deviceName, deniedHelp } from "../js/phone-setup.js";
import { icon, mark, wordmark } from "../js/icons.js";
import { personAvatar, readSystem } from "../js/avatars.js";
import { when, since, plural } from "../js/fmt.js";
import { personStatus, signOutHere } from "../js/person.js";
import { pathMark, statusMark } from "../js/status-mark.js";
import { LOCK, lockState, lockSteps } from "../js/lock.js";
import { linkLine, linkDot, handshakeLine, watchHealth } from "../js/health.js";
import { shareAccess, accessWord, flip, perShare, unsafeLines, mountHint } from "../js/drive-rows.js";
import { fmtBytes, pieceLabel, pieceLine, totalBytes, piecePct, readyToConfirm, allReady, mergeEvent, destinationName, forgetGate } from "../js/server-rows.js";
import { canRelayJoin } from "../js/join-caps.js";
import { buildWinkCard } from "../js/wink-card.js";
import { watchTrustAsks } from "../js/trust-ask.js";
import { buildAddPcCard } from "../js/add-pc-card.js";

const SECTIONS = [
  ["setup", "Setup"],
  ["you", "You and your address"],
  ["assistant", "The assistant"],
  ["claude", "Claude Code"],
  ["accounts", "AI accounts"],
  ["connections", "Connections"],
  ["network", "Network"],
  ["devices", "Your devices"],
  ["server", "Server"],
  ["history", "History and memory"],
  ["spend", "Spend"],
  ["permissions", "Standing permissions"],
  ["lessons", "Lessons"],
  ["notifications", "Notifications"],
  ["security", "Security"],
  ["modules", "Modules"],
  ["appearance", "Appearance"],
  ["machine", "This machine"],
  ["data", "Update, export and uninstall"],
];

/** The onboarding's steps (deck/onboard/onboard.js), each with the command that does the same.
 * `vyre up` picks up at the first step not finished; it has no flag for one step (asked polish-cli). */
const STEPS = [
  { id: "you", title: "You", cmd: "vyre up" },
  { id: "claude", title: "Claude Code", cmd: "vyre up" },
  { id: "tailscale", title: "Tailscale", cmd: "vyre up" },
  { id: "name", title: "Your address", cmd: "vyre up" },
  { id: "history", title: "Your history", cmd: "vyre index" },
  { id: "devices", title: "Your devices", cmd: "vyre up" },
];

const onTailnet = () => /\.vyre\.run$|\.ts\.net$/.test(location.hostname);

/** @param {any} ctx */
export default async function settings(ctx) {
  /** @type {Record<string, HTMLElement>} */
  const body = {};
  const secs = SECTIONS.map(([id, label]) => {
    body[id] = h("div", { class: "set-body" }, h("div", { class: "empty" }, "Loading."));
    return h("section", { class: "set-sec", id, "aria-labelledby": id + "-h" }, secHead(id, label), body[id]);
  });

  const navLink = (id, label) => h("a", { href: "#" + id, class: "set-nav-a", "data-sec": id,
    onclick: (/** @type {MouseEvent} */ e) => { e.preventDefault(); jump(id, true); } }, label);
  const navLinks = SECTIONS.map(([id, label]) => navLink(id, label));
  // The registry's settings (views/settings-keys.js) get their own sections after Claude Code,
  // under one heading in the rail, once settings.schema says which groups there are.
  const keysBody = h("div", { class: "set-keys" });
  const keysNav = h("div", { class: "set-nav-grp" });
  const at = SECTIONS.findIndex(([id]) => id === "claude") + 1;
  // Under 1180 px the rail is hidden; a select at the top jumps instead.
  const jumpSel = /** @type {HTMLSelectElement} */ (h("select", { class: "input set-select set-jump", "aria-label": "Go to a section" },
    SECTIONS.map(([id, label]) => h("option", { value: id }, label))));
  jumpSel.addEventListener("change", () => jump(jumpSel.value, true));

  put(ctx.root, h("div", { class: "set" },
    h("div", { class: "phone-head" }, h("span", { style: { display: "flex", gap: "8px", alignItems: "center" } }, mark(18), wordmark(20)),
      h("span", { class: "code" }, location.host)),
    h("div", { class: "set-wrap" },
      h("nav", { class: "set-nav", "aria-label": "Settings sections" }, navLinks.slice(0, at), keysNav, navLinks.slice(at)),
      h("div", { class: "set-col" },
        h("header", { class: "set-top" },
          h("h1", { class: "h2" }, "Settings"),
          h("p", { class: "muted" }, "Everything the setup did, and everything it skipped. Each part can be finished here or with a vyre command."),
          jumpSel),
        secs.slice(0, at), keysBody, secs.slice(at)))));

  // #section: scroll there without a history entry (a hash navigation would re-run the router).
  const jump = (id, record) => {
    const el = ctx.root.querySelector("#" + CSS.escape(id));
    if (!el) return;
    if (record) history.replaceState(null, "", location.pathname + location.search + "#" + id);
    el.scrollIntoView({ block: "start" });
    mark_(id);
  };
  const mark_ = id => {
    for (const a of ctx.root.querySelectorAll(".set-nav-a")) a.getAttribute("data-sec") === id ? a.setAttribute("aria-current", "true") : a.removeAttribute("aria-current");
    if (jumpSel.value !== id && [...jumpSel.querySelectorAll("option")].some(o => o.value === id)) jumpSel.value = id;
  };
  const spy = () => {
    const top = ctx.root.getBoundingClientRect().top + 80;
    const all = [...ctx.root.querySelectorAll(".set-sec")].filter(s => !s.hidden);
    let cur = SECTIONS[0][0];
    for (const s of all) if (s.getBoundingClientRect().top <= top) cur = s.id;
    if (ctx.root.scrollTop + ctx.root.clientHeight >= ctx.root.scrollHeight - 4 && all.length) cur = all[all.length - 1].id;
    mark_(cur);
  };
  ctx.root.addEventListener("scroll", spy, { passive: true });
  ctx.cleanup(() => ctx.root.removeEventListener("scroll", spy));
  mark_(SECTIONS[0][0]);
  // The rail's Devices is /settings#devices: a kept Settings page scrolls to it again on the way back.
  ctx.onShow?.(() => { const id = location.hash.slice(1); if (id && SECTIONS.some(([s]) => s === id)) jump(id, false); });

  /** @type {{ reveal: (key: string) => boolean } | null} */
  let keys = null;
  const loads = [
    drawSetup(body.setup), drawYou(body.you), drawAssistant(body.assistant, ctx), drawClaude(body.claude),
    // Imported on its own, so a problem in that file shows here and never blanks Settings.
    import("./connections.js").then(m => m.drawConnections(body.connections, ctx)).catch(e => put(body.connections, empty("Connections did not load.", e))),
    import("./settings-keys.js").then(m => m.drawKeys(keysBody, ctx, { taken: new Set(SECTIONS.map(([id]) => id)), skip: new Set(["notifications"]) })).then(k => {
      keys = k;
      if (!k.groups.length || !ctx.alive()) return;
      put(keysNav, h("div", { class: "set-nav-h lbl" }, "Sessions and Claude"), k.groups.map(g => navLink(g.id, g.label)));
      const og = h("optgroup", { label: "Sessions and Claude" }, k.groups.map(g => h("option", { value: g.id }, g.label)));
      const after = jumpSel.querySelector(`option[value="claude"]`);
      if (after && after.nextSibling) jumpSel.insertBefore(og, after.nextSibling); else jumpSel.append(og);
    }).catch(e => put(keysBody, empty("Sessions and Claude settings did not load.", e))),
    drawNetwork(body.network, ctx), drawDevices(body.devices, ctx), drawServer(body.server, ctx), drawHistory(body.history, ctx),
    import("./settings-accounts.js").then(m => m.drawAccounts(body.accounts, ctx)).catch(e => put(body.accounts, empty("AI accounts did not load.", e))),
    import("./settings-spend.js").then(m => m.drawSpend(body.spend, ctx)).catch(e => put(body.spend, empty("Spend did not load.", e))),
    import("./settings-permissions.js").then(m => m.drawPermissions(body.permissions, ctx)).catch(e => put(body.permissions, empty("Permissions did not load.", e))),
    drawLessons(body.lessons, ctx),
    drawNotifications(body.notifications, ctx), drawSecurity(body.security, ctx), drawModules(body.modules),
    drawAppearance(body.appearance), drawMachine(body.machine),
    import("./settings-data.js").then(m => m.drawData(body.data, ctx)).catch(e => put(body.data, empty("Update, export and uninstall did not load.", e))),
  ];
  // A push notification's path is a query (?section=lessons, a plain fetchable link), not a hash.
  // ?key=<key> goes to one of the registry's settings and highlights it.
  const hash = location.hash.slice(1) || ctx.query.get("section") || "";
  const known = () => hash && /^[A-Za-z0-9_-]+$/.test(hash) && ctx.root.querySelector("#" + CSS.escape(hash));
  if (known()) jump(hash, false);
  await Promise.all(loads);
  if (!ctx.alive()) return;
  const key = ctx.query.get("key");
  if (key && keys && keys.reveal(key)) return;
  if (known()) jump(hash, false);
}

function secHead(id, label) {
  const r = head(label);
  /** @type {HTMLElement} */ (r.firstChild).id = id + "-h";
  return r;
}

/** A settings row: a label on the left, the value or control on the right. */
function row(label, ...value) {
  return h("div", { class: "set-row" }, h("div", { class: "set-k" }, label), h("div", { class: "set-v" }, value));
}
const mono = s => h("span", { class: "mono set-mono" }, s);
const note = (...s) => h("p", { class: "set-note small muted" }, s);
const status = () => h("div", { class: "small muted set-status", role: "status" });
const foot = (...kids) => h("div", { class: "set-actions" }, kids);
const stateLbl = (text, cls = "") => h("span", { class: "set-state " + cls }, text);
const calm = () => { try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };
/** The onboarding is its own page, not a Deck route, so its links load it. */
const toOnboard = (step, label = "Finish") => h("a", { class: "btn btn-sm", href: "/onboard#" + step }, label);
const errText = e => (e?.missing ? `The ${e.module} module is not running, so this cannot be changed here yet.` : String(e?.message || e));

// ---- 1. Setup ------------------------------------------------------------------------------

async function drawSetup(el) {
  const r = await attempt("onboard.status");
  if (r.error) {
    put(el, empty("Setup progress is kept by the box module.", r.error),
      h("div", { class: "rows" }, STEPS.map(s => stepRow(s, null))));
    return;
  }
  const steps = r.data?.steps || {};
  const left = STEPS.filter(s => (steps[s.id] || "todo") !== "done").length;
  put(el,
    note(left ? `${plural(left, "step")} left. Each opens the same screen the setup showed.` : "Every step is done."),
    h("div", { class: "rows" }, STEPS.map(s => stepRow(s, steps[s.id] || "todo"))));
}

function stepRow(s, st) {
  const label = st === "done" ? "Done" : st === "skipped" ? "Skipped" : st ? "To do" : "";
  return h("div", { class: "set-step" },
    h("span", { class: "set-check" + (st === "done" ? " done" : ""), "aria-hidden": "true" }, st === "done" ? icon("check", 12) : null),
    h("div", { class: "set-step-main" },
      h("div", { class: "set-step-title" }, s.title, label ? stateLbl(label, st === "done" ? "" : "faint") : null),
      h("code", { class: "set-mono" }, s.cmd)),
    toOnboard(s.id, st === "done" ? "Open" : "Finish"));
}

// ---- 2. You and your address ---------------------------------------------------------------

/**
 * Your own avatar, large: the person's circle with its Vyre code ring (js/avatars.js; a theme
 * switch redraws it there). Without a real fingerprint (a box from before owner.id) the face
 * shows alone, never a ring made up from a name.
 */
function youAvatar(name) {
  return h("div", { class: "set-you-av" }, personAvatar({ size: 160, ring: true, label: name ? `Your avatar, ${name}` : "Your avatar" }));
}

async function drawYou(el) {
  const [r] = await Promise.all([attempt("onboard.status"), readSystem(attempt)]);
  const here = row("This page", mono(location.host),
    h("div", { class: "small muted" }, onTailnet() ? "Served on your tailnet. Only your devices can open it." : "Served on this machine only, not on your tailnet."));
  if (r.error) { put(el, empty("Your name is kept by the box module.", r.error), h("div", { class: "rows" }, here)); return; }
  const name = r.data?.name || "";
  put(el, youAvatar(name), h("div", { class: "rows" },
    row("Name", name ? h("span", null, name) : h("span", { class: "muted" }, "Not chosen yet"), name ? null : toOnboard("you")),
    // The address it is served at: a ts.net name when there is no vyre.run name (ADR 0008).
    row("Address", r.data?.address ? mono(String(r.data.address).replace(/^https:\/\//, "")) : name ? mono(`${name}.vyre.run`) : h("span", { class: "muted" }, "None until you pick a name"),
      r.data?.steps?.name === "done" || !name ? null : toOnboard("name")),
    here));
}

// ---- 3. The assistant ----------------------------------------------------------------------

async function drawAssistant(el, ctx) {
  const r = await attempt("agents.list");
  if (!ctx.alive()) return;
  if (r.error) { put(el, empty("The assistant could not be read from the box.", r.error)); return; }
  const a = (Array.isArray(r.data) ? r.data : r.data?.agents || []).find(x => x.kind === "assistant");
  if (!a) { put(el, h("div", { class: "empty" }, "There is no assistant yet. The setup makes one."), foot(toOnboard("you"))); return; }
  const show = () => put(el, h("div", { class: "rows" },
      row("Name", h("span", { class: "set-inline" }, h("span", { class: "initial", "aria-hidden": "true" }, a.name.charAt(0).toLowerCase()), link(`/agents/${encodeURIComponent(a.name)}`, { class: "link quiet" }, a.name))),
      row("Instructions", h("p", { class: "set-prose" }, a.instructions || h("span", { class: "muted" }, "None"))),
      row("Skills", a.skills?.length ? h("div", { class: "set-tags" }, a.skills.map(s => h("span", { class: "tag" }, s))) : h("span", { class: "muted" }, "None"))),
    foot(h("button", { type: "button", class: "btn", onclick: edit }, icon("edit", 14), "Edit")));
  const edit = () => {
    const name = /** @type {HTMLInputElement} */ (h("input", { class: "input", value: a.name, "aria-label": "Assistant name", autocomplete: "off", spellcheck: "false" }));
    const ins = /** @type {HTMLTextAreaElement} */ (h("textarea", { class: "input", rows: "5", "aria-label": "Instructions" }));
    ins.value = a.instructions || "";
    const st = status();
    const save = h("button", { type: "submit", class: "btn btn-primary" }, "Save");
    put(el, h("form", { class: "set-form", onsubmit: async (/** @type {Event} */ e) => {
      e.preventDefault();
      const input = { agent: a.name };
      if (name.value.trim() && name.value.trim() !== a.name) input.name = name.value.trim();
      if (ins.value !== (a.instructions || "")) input.instructions = ins.value;
      if (Object.keys(input).length === 1) { show(); return; }
      /** @type {HTMLButtonElement} */ (save).disabled = true;
      const u = await attempt("agents.update", input, { presence: "asked" });
      if (u.error) { put(st, errText(u.error)); /** @type {HTMLButtonElement} */ (save).disabled = false; return; }
      Object.assign(a, u.data && u.data.name ? u.data : { name: input.name || a.name, instructions: input.instructions ?? a.instructions });
      show();
    } },
      h("div", { class: "rows" },
        row(h("label", { for: "as-name" }, "Name"), Object.assign(name, { id: "as-name" })),
        row(h("label", { for: "as-ins" }, "Instructions"), Object.assign(ins, { id: "as-ins" })),
        row("Skills", a.skills?.length ? h("div", { class: "set-tags" }, a.skills.map(s => h("span", { class: "tag" }, s))) : h("span", { class: "muted" }, "None"),
          h("div", { class: "small faint" }, "Skills are added from the assistant's page."))),
      foot(save, h("button", { type: "button", class: "btn btn-ghost", onclick: show }, "Cancel")), st));
    name.focus();
  };
  show();
}

// ---- 4. Claude Code ------------------------------------------------------------------------

async function drawClaude(el) {
  const r = await attempt("onboard.claude", { mode: "detect" });
  if (r.error) { put(el, empty("Claude Code is checked by the box module.", r.error), foot(toOnboard("claude", "Connect"))); return; }
  const c = r.data || {};
  const via = c.via === "setup-token" ? "Your Claude subscription (setup token)" : c.via === "api-key" ? "An Anthropic API key" : "Signed in";
  put(el, h("div", { class: "rows" },
      row("Installed", c.installed ? h("span", null, "Yes", c.version ? mono("  " + c.version) : null) : h("span", { class: "muted" }, "Not found on this machine"),
        c.path ? h("div", { class: "code" }, c.path) : null),
      row("Signed in", c.signedIn ? h("span", null, via) : h("span", { class: "muted" }, "Not signed in"),
        c.signedIn ? h("div", { class: "small faint" }, "Kept in the Vault. No screen shows it, this one included.") : null)),
    foot(toOnboard("claude", c.signedIn ? "Re-connect" : "Connect")));
}

// ---- 5. Network ----------------------------------------------------------------------------

async function drawNetwork(el, ctx) {
  const r = await attempt("onboard.tailscale", { action: "detect" });
  const t = r.data || {};
  const on = !r.error && t.state === "connected" && t.node;
  const conn = h("div");
  const lockRow = h("div");
  // The tailnet features below each load on their own; a tool not on this vyred leaves its row out.
  const extra = ["shares", "hooks", "guests", "agents", "egress", "handback", "hosted"].map(() => h("div"));
  put(el, r.error ? empty("Tailscale is checked by the box module.", r.error) : null,
    h("div", { class: "rows" },
      r.error ? null : row("Tailscale", on ? h("span", null, "Connected") : h("span", { class: "muted" }, !t.installed ? "Not installed" : t.state === "needs-login" ? "Waiting for sign-in" : "Not connected")),
      on ? row("Node", mono(t.node.dns || t.node.name || "")) : null,
      on ? row("Tailnet IP", mono(t.node.ip || "")) : null,
      conn,
      on ? lockRow : null,
      extra),
    on ? null : foot(toOnboard("tailscale", "Connect")));
  if (on) drawLink(conn, ctx);
  const [shares, hooks, guests, agents, egress, handback, hosted] = extra;
  await Promise.all([on ? drawLock(lockRow) : null, drawShares(shares, ctx), drawHooks(hooks), drawGuests(guests), drawAgentNodes(agents), drawEgress(egress), drawHandback(handback), drawHosted(hosted)]);
}

/**
 * The hosted app: which web origins may call this box from the owner's browser (system.info
 * network.origins, the effective list; [] is off). Read only; a box that does not say is left out.
 */
async function drawHosted(el) {
  const r = await attempt("system.info");
  const origins = r.data?.network?.origins;
  if (r.error || !Array.isArray(origins)) { put(el); return; }
  const hosts = origins.map(o => { try { return new URL(String(o)).host; } catch { return String(o); } });
  put(el, row("Hosted app", origins.length ? h("span", null, "On") : h("span", { class: "muted" }, "Off"),
    origins.length ? faint(`The app at ${hosts.join(", ")} can reach this box from your browser after you sign in.`)
      : faint("No hosted app can reach this box. The Deck at the box's own address still works."),
    faint("Set in the box's config:"), mono("network.origins")));
}

/** How the box reaches this device (link.health, the calling node), kept current by deck/js/health.js. */
function drawLink(el, ctx) {
  ctx.cleanup(watchHealth(x => {
    if (!ctx.alive()) return;
    // No link module on this vyred: the row is left out rather than shown empty.
    if (!x) { put(el); return; }
    const shook = handshakeLine(x);
    put(el, row("This device", h("span", { class: "set-inline" }, pathMark(linkDot(x)),
      h("span", x.path === "unknown" ? { class: "muted" } : null, linkLine(x))),
      shook ? h("div", { class: "small faint" }, shook) : null));
  }));
}

/** A command the person runs themselves, with a copy button. */
function cmd(text) {
  const b = h("button", { type: "button", class: "ibtn", "aria-label": "Copy command", title: "Copy", onclick: async () => {
    try { await navigator.clipboard.writeText(text); put(b, icon("check", 14)); setTimeout(() => put(b, icon("copy", 14)), 1500); } catch {}
  } }, icon("copy", 14));
  return h("div", { class: "set-cmd" }, h("code", { class: "set-mono" }, text), b);
}
const faint = (...s) => h("div", { class: "small faint" }, s);
const plainList = (items, draw) => h("ul", { class: "set-plain" }, items.map(x => h("li", null, draw(x))));
/** A tool's list, whether it came as an array or an object keyed by name. */
const listOf = (v, key) => Array.isArray(v) ? v : v && typeof v === "object" ? Object.entries(v).map(([k, x]) => ({ [key]: k, ...(x || {}) })) : [];

/**
 * One optional row: ask its tool, and draw it. A tool this vyred does not have leaves nothing
 * (its module may not be merged yet); any other failure is said in the row.
 */
async function optional(el, label, tool, draw) {
  const r = await attempt(tool);
  if (r.error) { put(el, r.error.missing ? null : row(label, h("span", { class: "muted" }, errText(r.error)))); return; }
  put(el, draw(r.data || {}));
}

const onOff = on => on ? h("span", null, "On") : h("span", { class: "muted" }, "Off");

/**
 * VyreDrive (Taildrive underneath): each folder the box offers, shared or not, its own access, and who the
 * tailnet policy lets reach them. The check runs on demand, and a drive.exposed event (after any
 * share) shows its findings here too, with any shared folder that holds secrets. Sharing stays
 * with the owner's terminal and Lumen; switching a share between read only and read and
 * write is the owner's own act (files.drive.access, no proof), offered only where the box has it.
 */
function drawShares(el, ctx) {
  const found = h("div");
  const st = status();
  const showAudit = (/** @type {any} */ a) => {
    const f = Array.isArray(a?.findings) ? a.findings : [];
    const bad = unsafeLines(a);
    put(found,
      bad.map(x => h("div", { class: "small set-warn" }, x.text)),
      f.length
        ? [h("div", { class: "small set-warn" }, `${plural(f.length, "device")} outside your paired Macs can reach these shares:`),
          plainList(f, x => [mono(x.node || "a device"), x.login ? h("span", { class: "small faint" }, ` ${x.login}`) : null]),
          faint("Only the tailnet policy decides this. Remove them in the Tailscale admin console, Access controls. Vyre does not change it.")]
        : a && !bad.length ? faint(`Only your paired Macs can reach them. ${a.checked != null ? `Checked ${plural(a.checked, "online device")}.` : ""}`.trim()) : null);
  };
  ctx.on("drive.exposed", (/** @type {any} */ e) => { if (ctx.alive()) showAudit(e.payload); });
  const check = h("button", { type: "button", class: "btn btn-sm", onclick: async () => {
    check.disabled = true; put(st, "Checking…");
    const a = await attempt("files.drive.audit");
    check.disabled = false; put(st);
    if (a.error) put(st, errText(a.error)); else showAudit(a.data);
  } }, "Check who can reach them");
  // Whether this box has files.drive.access: its status rows carry their own access, and a
  // no_such_tool answer turns the switches off for good.
  let canSwitch = true;
  const intro = () => faint("VyreDrive (built on Tailscale's Taildrive) opens your box's folders in Finder on your Mac.");
  return optional(el, "VyreDrive", "files.drive.status", d => {
    const shares = listOf(d.shares, "name");
    if (!d.enabled) return row("VyreDrive", onOff(false),
      intro(), d.why ? faint(`Not available: ${d.why}.`) : null, d.fix ? faint(d.fix) : null);
    const own = perShare(shares);
    const remount = h("div");
    const line = (/** @type {any} */ x) => {
      const li = h("div");
      let acc = shareAccess(x, d);
      const draw = () => put(li, mono(x.name), h("span", { class: "small " + (x.shared ? "muted" : "faint") }, x.shared ? " shared" : " not shared"),
        h("span", { class: "small faint" }, `, ${accessWord(acc).toLowerCase()}`),
        x.mounted ? h("span", { class: "small faint" }, ", mounted on this Mac") : null,
        own && canSwitch ? [" ", sw] : null);
      const sw = h("button", { type: "button", class: "btn btn-sm", onclick: async () => {
        sw.disabled = true;
        const r = await attempt("files.drive.access", { name: x.name, mode: flip(acc) });
        sw.disabled = false;
        if (r.error) {
          // An old box: no switch, and nothing said.
          if (r.error.missing) { canSwitch = false; for (const b of el.querySelectorAll("[data-drive-switch]")) b.remove(); return; }
          put(st, errText(r.error)); return;
        }
        put(st);
        acc = r.data?.access === "rw" ? "rw" : r.data?.access === "ro" ? "ro" : flip(acc);
        put(sw, acc === "rw" ? "Make read only" : "Make read and write");
        draw();
        const m = mountHint(r.data);
        put(remount, m ? [m.step ? cmd(m.step) : null, h("div", { class: "small set-warn" }, m.line)] : null);
      } }, acc === "rw" ? "Make read only" : "Make read and write");
      sw.setAttribute("data-drive-switch", "");
      draw();
      return li;
    };
    return row("VyreDrive", h("span", null, "On"), intro(),
      shares.length ? plainList(shares, line) : faint("The box offers no folders (files.drive.shares)."),
      remount,
      d.error ? faint(d.error) : null,
      shares.some(x => !x.shared) ? [faint("Share one from the box's terminal:"), cmd(`vyre call --tty files.drive.share '{"name":"${shares.find(x => !x.shared).name}"}'`)] : null,
      foot(check), st, found);
  });
}

/**
 * Webhooks: off, or the open routes (hooks.list) and where Funnel and Vyre disagree
 * (hooks.status). Turning hooks on and opening a route need you there (presence), so the Deck
 * shows the command rather than doing it; the Funnel commands are Tailscale's, which Vyre never runs.
 */
async function drawHooks(el) {
  const st = attempt("hooks.status");
  await optional(el, "Webhooks", "hooks.list", d => {
    const routes = listOf(d.routes, "name");
    if (!d.enabled) return row("Webhooks", onOff(false),
      faint("A webhook lets a service such as a payment processor tell Vyre that something happened. It is the one part of Vyre open to the internet, so it stays off until you turn it on from the box's terminal:"),
      cmd("vyre hooks on"));
    const mism = h("div");
    st.then(r => {
      const m = Array.isArray(r.data?.mismatches) ? r.data.mismatches : [];
      put(mism, m.length ? [h("div", { class: "small set-warn" }, "Funnel and Vyre disagree:"),
        plainList(m, x => [h("div", { class: "small" + (x.harmless ? " faint" : "") }, x.harmless ? `${x.message}. Harmless.` : `${x.message}.`),
          x.fix ? cmd(x.fix) : null])] : null);
    });
    return row("Webhooks", h("span", null, routes.length ? `On, ${plural(routes.length, "open route")}` : "On, no open routes"),
      d.listening === false ? h("div", { class: "small set-warn" }, `The hooks listener is not answering${d.error ? ` (${d.error})` : ""}.`) : null,
      routes.length ? plainList(routes, x => [
        h("div", null, mono(x.path || `/hooks/${x.name}`), h("span", { class: "small faint" },
          ` ${x.verify?.scheme || ""}${typeof x.deliveries === "number" ? `, ${plural(x.deliveries, "delivery", "deliveries")} kept` : ""}`)),
        x.funnel?.open ? [faint("Publish it with Funnel:"), cmd(x.funnel.open)] : null,
        x.funnel?.close ? [faint("Stop publishing it:"), cmd(x.funnel.close)] : null]) : null,
      mism,
      faint("Vyre never runs tailscale funnel. Run these yourself, on the box."),
      faint("Open a route from the box's terminal:"),
      cmd("vyre hooks open <name> --scheme hmac-sha256 --header <header> --secret <vault item>"),
      routes.length ? [faint("Close one:"), cmd(`vyre hooks close ${routes[0].name}`)] : null,
      faint("Turn webhooks off:"), cmd("vyre hooks off"));
  });
}

/** Guests: people from another tailnet this box is shared with, and the tools each may call. */
function drawGuests(el) {
  return optional(el, "Guests", "network.guests.list", d => {
    const people = listOf(d.people, "login");
    const safe = Array.isArray(d.safe) ? d.safe : [];
    const safeLine = safe.length ? faint(`A guest can only ever call these: ${safe.join(", ")}.`) : null;
    if (!d.enabled) return row("Guests", onOff(false),
      faint("A guest is someone on another tailnet you shared this box with. They may call only the tools you list for them, and never act as you."),
      safeLine, faint("Turn guests on from the box's terminal:"), cmd(`vyre call --tty network.guests.enable '{"on":true}'`));
    return row("Guests", h("span", null, people.length ? `On, ${plural(people.length, "person", "people")}` : "On, no one yet"),
      people.length ? plainList(people, x => {
        const allowed = Array.isArray(x.allowed) ? x.allowed : Array.isArray(x.tools) ? x.tools : [];
        const asked = Array.isArray(x.tools) ? x.tools.filter(t => !allowed.includes(t)) : [];
        return [mono(x.login), h("div", { class: "set-tags" }, allowed.map(t => h("span", { class: "tag" }, t))),
          asked.length ? faint(`Listed but not guest-safe, so refused: ${asked.join(", ")}.`) : null];
      }) : null,
      safeLine,
      faint("Add someone from the box's terminal:"),
      cmd(`vyre call --tty network.guests.add '{"login":"<login>","tools":["threads.list"]}'`),
      people.length ? [faint("Remove them:"), cmd(`vyre call --tty network.guests.remove '{"login":"${people[0].login}"}'`)] : null,
      faint("Turn guests off:"), cmd(`vyre call --tty network.guests.enable '{"on":false}'`));
  });
}

/** Agent nodes: whether each agent's computer joins the tailnet as its own tagged node. */
function drawAgentNodes(el) {
  return optional(el, "Agent nodes", "computers.tailnet.status", d => {
    const comps = listOf(d.computers, "agent");
    const tag = d.tag || "tag:vyre-agent";
    const v = d.vault || null;
    // Whether the auth key is in the Vault and granted: never its value.
    const key = v ? faint(`Auth key ${v.item || ""} in the Vault: ${v.exists == null ? "not known" : v.exists ? (v.granted ? "there, and granted" : "there, not granted yet") : "not there yet"}${v.why ? ` (${v.why})` : ""}.`) : null;
    const problem = d.problem ? h("div", { class: "small set-warn" }, d.problem) : null;
    if (!d.enabled) return row("Agent nodes", onOff(false),
      faint(`With this on, each agent's computer joins your tailnet as its own node, tagged ${tag}, so your tailnet policy can tell agents apart.`),
      problem, key, cmd(`vyre call --tty computers.tailnet.set '{"enabled":true}'`));
    return row("Agent nodes", h("span", null, "On"), faint(`Tagged ${tag}.`), problem, key,
      comps.length ? plainList(comps, x => [h("span", null, x.agent || "an agent"), x.node ? [" ", mono(x.node)] : null,
        h("span", { class: "small faint" }, x.running ? " running" : " not running")]) : faint("No agent has a computer yet."),
      d.applies ? faint(`This ${d.applies}.`) : null,
      cmd(`vyre call --tty computers.tailnet.set '{"enabled":false}'`));
  });
}

/** Glass egress: the listed sites leave an agent's Chrome through your Mac, when the sidecar answers. */
function drawEgress(el) {
  return optional(el, "Glass egress", "computers.egress.status", d => {
    const sites = Array.isArray(d.sites) ? d.sites : [];
    const side = d.sidecar || {};
    if (!d.enabled) return row("Glass egress", onOff(false),
      faint("Some sites refuse a datacenter address. The sites you list leave an agent's Chrome through your own Mac instead."),
      cmd(`vyre call --tty computers.egress.set '{"enabled":true,"sites":["example.com"]}'`));
    return row("Glass egress", h("span", null, sites.length ? `On, ${plural(sites.length, "site")}` : "On, no sites yet"),
      sites.length ? h("div", { class: "set-tags" }, sites.map(x => h("span", { class: "tag" }, String(x)))) : null,
      side.answers ? faint("The egress sidecar answers.")
        : h("div", { class: "small set-warn" }, `The egress sidecar does not answer${side.why ? ` (${side.why})` : ""}. The listed sites fail until it does, rather than show the box's address.`),
      d.problem ? h("div", { class: "small set-warn" }, d.problem) : null,
      d.applies ? faint(`This ${d.applies}.`) : null,
      cmd(`vyre call --tty computers.egress.set '{"enabled":false}'`));
  });
}

/** Glass hand-back: after how long without input a take-over goes back to the agent. */
function drawHandback(el) {
  return optional(el, "Glass hand-back", "computers.handback.status", d => {
    const choices = Array.isArray(d.choices) ? d.choices : [0, 2, 5, 15];
    const sel = /** @type {HTMLSelectElement} */ (h("select", { class: "input set-select", "aria-label": "Hand back after this long without input" },
      choices.map(m => h("option", { value: String(m), selected: Number(m) === Number(d.minutes) }, m ? `After ${m} min idle` : "Off"))));
    const said = h("div", { class: "small faint", role: "status" }, "");
    sel.onchange = async () => {
      sel.disabled = true;
      const r = await attempt("computers.handback.set", { minutes: Number(sel.value) });
      sel.disabled = false;
      if (r.error) { put(said, errText(r.error)); sel.value = String(d.minutes); return; }
      d.minutes = r.data?.minutes;
      put(said, "Saved. It applies to a take-over already running too.");
    };
    return row("Glass hand-back", sel,
      faint(`When you take over an agent's computer and stop typing and moving, the keyboard goes back to the agent. You get a ${d.warn_s || 10} s warning first.`),
      said);
  });
}

/** Tailnet Lock: on or off, read only. While it is off, the commands the person runs on their Mac. */
async function drawLock(el) {
  const r = await attempt("onboard.tailscale", { action: "lock" });
  if (r.error) { put(el, row("Tailnet Lock", h("span", { class: "muted" }, errText(r.error)))); return; }
  const d = r.data || {};
  const on = lockState(d);
  if (on) { put(el, row("Tailnet Lock", h("span", null, "On"), h("div", { class: "small faint" }, on))); return; }
  const steps = h("div");
  const toggle = h("button", { type: "button", class: "btn btn-sm" }, LOCK.show);
  toggle.addEventListener("click", () => {
    const open = !steps.childNodes.length;
    put(steps, open ? [
      h("ol", { class: "set-lock-steps" }, lockSteps(d).map(x => h("li", null, h("div", { class: "small" }, x.text), x.copy ? h("code", { class: "set-mono" }, x.copy) : null))),
      h("div", { class: "small faint" }, LOCK.never)] : null);
    put(toggle, open ? LOCK.hide : LOCK.show);
  });
  put(el, row("Tailnet Lock", h("span", { class: "muted" }, "Off"),
    h("div", { class: "small faint" }, LOCK.what), h("div", { class: "small faint" }, LOCK.cost), foot(toggle), steps));
}

// ---- 5b. Your devices ----------------------------------------------------------------------

/**
 * What a tailnet node is, by the OS Tailscale reports. Tailscale says iOS for an iPad too, so the
 * node's name tells them apart. handheld: a phone or tablet, the ones the offline line is for.
 * @param {string} os @param {string} [name]
 */
function deviceKind(os, name = "") {
  const o = String(os || "").toLowerCase();
  if (o === "ios") return { kind: /ipad/i.test(name) ? "iPad" : "iPhone", handheld: true };
  if (o === "android") return { kind: "Android phone", handheld: true };
  const k = { macos: "Mac", windows: "Windows PC", linux: "Linux computer" }[o];
  return { kind: k || os || "Device", handheld: false };
}

/** Wink (ADR 0043): the same live Vyre code ring onboarding's devices step uses (deck/js/
 * wink-card.js, shared — reviewer's pre-review points live in that file's header), added here so
 * a phone can be added later without re-running onboarding. Gated on onboard.status.can.
 * relayJoin, same as onboarding's — hidden on a Mac until vyre-core. `ctx.on`/`ctx.cleanup`/
 * `ctx.alive` (not onboard.js's own `on`/`cleanup`/`every`) since this runs in the main Deck, not
 * the onboarding loopback page; no "Next step" here (`onNext` omitted) since Settings isn't a
 * wizard. */
function winkCard(status, ctx) {
  const relay = canRelayJoin(status);
  if (!relay.allowed) return null;
  return buildWinkCard({
    attempt,
    subscribe: ctx.on,
    every: (fn, ms) => { const t = setInterval(fn, ms); ctx.cleanup(() => clearInterval(t)); },
    cleanup: ctx.cleanup,
    calm,
    alive: ctx.alive,
  });
}

/** "Add a Windows PC" (deck/js/add-pc-card.js): the code the PC's app shows, as words or a QR, has the box register its own ticket. Same gate as Wink. */
function addPcCard(status, ctx) {
  if (!canRelayJoin(status).allowed) return null;
  return buildAddPcCard({ attempt, cleanup: ctx.cleanup, alive: ctx.alive });
}

/** The owner's devices on the tailnet (onboard.status detail.devices.peers) and the paired Macs (link.peers). */
async function drawDevices(el, ctx) {
  // A browser asking for full access (tailnet's device.trust-asked): its key first, its name as its own claim.
  const asks = h("div");
  ctx.cleanup?.(watchTrustAsks(card => put(asks, card)));
  const [st, macs] = await Promise.all([attempt("onboard.status"), attempt("link.peers")]);
  if (!ctx.alive()) return;
  if (st.error) { put(el, empty("Your devices are read by the box module.", st.error), foot(toOnboard("devices", "Open"))); return; }
  const wink = winkCard(st.data, ctx);
  const addPc = addPcCard(st.data, ctx);
  const peers = st.data?.detail?.devices?.peers || [];
  const paired = Array.isArray(macs.data) ? macs.data : [];
  const same = (m, p) => (m.node && (m.node === p.dns || String(m.node).split(".")[0] === p.name)) || m.name === p.name;
  const pairedHere = p => paired.some(m => same(m, p));
  const order = p => (deviceKind(p.os, p.name).handheld ? 0 : 1) * 2 + (p.online ? 0 : 1);
  const rows = [...peers].sort((a, b) => order(a) - order(b)).map(p => {
    const { kind, handheld } = deviceKind(p.os, p.name);
    return row(kind,
      h("span", { class: "set-inline" }, mono(p.name), stateLbl(p.online ? "Online" : "Offline", p.online ? "" : "faint")),
      pairedHere(p) ? h("div", { class: "small muted" }, "Paired with this box") : null,
      handheld && !p.online ? h("div", { class: "set-off small" }, icon("phone", 14),
        h("span", null, `Your ${kind} is offline in Tailscale. Open the Tailscale app and turn it on.`)) : null);
  });
  // A paired Mac Tailscale did not list (Tailscale not running here, say) still shows.
  for (const m of paired) {
    if (peers.some(p => same(m, p))) continue;
    rows.push(row("Mac", h("span", { class: "set-inline" }, mono(m.name || m.node || "A Mac"), stateLbl("Paired", "faint"))));
  }
  put(el,
    asks,
    wink,
    addPc,
    rows.length ? h("div", { class: "rows" }, rows)
      : note("No other devices on your tailnet yet. The setup's last step adds your phone and pairs your Mac."),
    // Wink is the primary path now (relay.allowed); this link is the Advanced fallback the
    // onboarding side calls "Use my own Tailscale setup," and the only add-a-device path left
    // when Wink is hidden (a Mac, no vyre-core yet).
    foot(toOnboard("devices", wink ? "Use my own Tailscale setup" : "Add a device")));
}

// ---- 5c. Server ------------------------------------------------------------------------------

/** Settings > Server: config.machine ("solo"|"server"|"device", additive, ADR 0039 — NOT
 * config.role, which drawMachine below reads and is unrelated), and "Move to a server"
 * (docs/design/anywhere.md, work/anywhere 11328815). Reads onboard.status for machine, same
 * tool the "live" onboarding step already uses. Client-only against deck/fixtures/onboard.json
 * (machine) and deck/fixtures/federation.json (the move.* engine) until anywhere's onboard.
 * machine and federation's move.* tools land (asked, docs/work/launch-surfaces.md): the move.*
 * shapes here are launch's proposal, not yet confirmed. Only the Solo/Server -> Device direction
 * is built; "Move off this server" (the reverse move, back to Solo) is not, see the work doc's
 * Next. No auto-delete anywhere in this flow: the pre-move copy is only ever removed by the
 * person's own "Free up space" click, gated 24 hours per anywhere.md's forget guard. The
 * formatting and gating logic itself lives in ../js/server-rows.js, pure and unit-tested
 * (deck/test/settings-server.test.js), the way Drive's does in drive-rows.js.
 *
 * Move to a server is 0.1.2 (team/BACKLOG-0.1.2.md): no box in 0.1.1 registers a "federation"
 * module, so federation.move.* has nothing to answer it. Gated on that module actually being
 * there (checked live, never a build flag) so the flow turns itself back on the day 0.1.2 ships
 * it, with nothing here to revert. */
async function drawServer(el, ctx) {
  const [r, mods] = await Promise.all([attempt("onboard.status"), modules()]);
  if (r.error) {
    put(el, empty("The server role is read by the box module.", r.error),
      note("Once it's running, this is where you move your work to a server, or back."));
    return;
  }
  const machine = r.data?.machine || "solo";
  if (machine !== "solo" && machine !== "server") { drawAlreadyMoved(el, r.data || {}); return; }
  if (!mods.some(m => m.name === "federation")) {
    put(el, row("This computer", h("span", null, "Runs everything, on its own."),
      h("div", { class: "small muted" }, "No Tailscale, nothing else running.")),
      note("Moving your work to a server is coming in a later update."));
    return;
  }

  // app-design's #1 finding (ce9c4c5f screenshot pass): a consequential, multi-step flow (moving
  // the whole vault/projects/memory to another machine) needs its own weight, a card
  // (docs/design/system/components/card.md), separate from the plain status row above it.
  const panel = h("div", { class: "rows" });
  const st = status();
  put(el,
    row("This computer", h("span", null, machine === "server" ? "Is your server." : "Runs everything, on its own."),
      h("div", { class: "small muted" }, machine === "server"
        ? "Other devices can pair with it once you add one."
        : "No Tailscale, nothing else running, until you move to a server.")),
    h("div", { class: "set-server-card" }, panel, st));

  // Event-driven, not polled: federation's contract (docs/work/federation.md) emits move.progress/
  // move.piece.done/move.failed/move.confirmed over the same stream every other Deck view reads
  // (deck/js/api.js's on()), so watching a move never needs to poll faster than 60 s (SPEC
  // principle 8) the way onboarding's history step has to (its loopback door carries no stream
  // at all, a different situation). One move.status call establishes the baseline right after
  // start (in case an event fired before the listener was attached); everything live after that
  // is the event stream. No explicit "ready" event exists, so allReady (server-rows.js) infers it
  // from every named piece being done with no error, same information move.status's own `stage`
  // would give on a fresh load.
  let offEvents = null;
  ctx.cleanup(() => offEvents && offEvents());

  const point = () => {
    const dest = /** @type {HTMLInputElement} */ (h("input", { class: "input", placeholder: "Paste the setup code your server showed", "aria-label": "Server setup code" }));
    const go = async () => {
      const v = dest.value.trim();
      if (!v) { put(st, "Paste the code first."); return; }
      put(st, "Looking for that server.");
      const p = await attempt("federation.move.plan", { destination: v });
      if (!ctx.alive()) return;
      if (p.error) { put(st, errText(p.error)); return; }
      put(st);
      plan(p.data);
    };
    put(panel,
      h("div", { class: "rows" },
        row(h("label", { for: "move-code" }, "Point at a server"), Object.assign(dest, { id: "move-code" }),
          h("div", { class: "small faint" }, "From the new computer's own setup, or Settings > Your devices > Add a device."))),
      foot(h("button", { type: "button", class: "btn btn-primary", onclick: go }, "Continue")));
  };

  const plan = p => {
    const pieces = Object.entries(p.pieces || {});
    put(panel,
      row("Moving to", mono(destinationName(p)), h("span", { class: "small muted" }, p.destination?.address || "")),
      h("div", { class: "rows" }, pieces.map(([k, v]) => row(pieceLabel(k, v), h("span", null, pieceLine(v)),
        // app-design's #2 finding: the vault's own encryption promise (anywhere.md "The move-to-
        // server flow") needs to be visible right where it's being moved, not left to the doc.
        k === "vault" ? h("div", { class: "small muted set-vault-note" }, icon("lock", 12),
          h("span", null, "Encrypted end to end. Never written to disk unencrypted on either side.")) : null))),
      note(`${fmtBytes(totalBytes(p.pieces))} total. This computer keeps working, unchanged, until the move finishes and you confirm it.`),
      foot(h("button", { type: "button", class: "btn btn-primary", onclick: () => start(p.planId, Object.keys(p.pieces || {})) }, "Start moving"),
        h("button", { type: "button", class: "btn btn-ghost", onclick: point }, "Back")));
  };

  const start = async (planId, keys) => {
    put(panel, h("div", { class: "empty" }, "Starting."));
    const s = await attempt("federation.move.start", { planId });
    if (!ctx.alive()) return;
    if (s.error) { put(panel, empty("Could not start the move.", s.error), foot(h("button", { type: "button", class: "btn", onclick: point }, "Try again"))); return; }
    watch(s.data.moveId, keys);
  };

  const drawPieces = (moveId, keys, pieces) => {
    // app-design's #4 finding: use the shared status-mark vocabulary (statusMark, running/done)
    // instead of plain "Done"/"NN%" words, matching list-row.md's running ring elsewhere in the
    // Deck. A piece that hasn't started yet has no mark of its own in that model (only running,
    // done, needs, failed, unread), so "Waiting" stays plain text for that one case.
    put(panel, h("div", { class: "rows" }, keys.map(k => {
      const v = pieces[k] || {};
      return h("div", { class: "set-move-row" },
        h("div", { class: "set-move-main" }, h("div", null, pieceLabel(k, v)), h("div", { class: "set-meter" }, h("span", { style: { width: piecePct(v) + "%" } }))),
        v.error ? statusMark("failed", { word: true })
          : v.done ? statusMark("done", { word: true })
          : v.bytes ? statusMark("running", { word: `${piecePct(v)}%` })
          : h("span", { class: "small faint" }, "Waiting"));
    })));
    if (allReady(pieces, keys)) ready(moveId);
  };

  const watch = async (moveId, keys) => {
    // reviewer-2's finding: attaching the listener only after move.status resolves leaves a
    // window (the round trip itself) where a fast-finishing piece's event is missed for good,
    // with no poll left to self-correct. Attach first, buffer until the baseline lands, replay
    // the buffer onto it, then switch to live — closes the window either way the race lands.
    let pieces = null, live = false;
    const buffered = [];
    offEvents?.();
    offEvents = on("move.*", e => {
      if (e.payload?.moveId !== moveId) return;
      if (!live) { buffered.push(e); return; }
      pieces = mergeEvent(pieces, e);
      drawPieces(moveId, keys, pieces);
    });
    const s = await attempt("federation.move.status", { moveId });
    if (!ctx.alive()) return;
    if (s.error) { put(panel, empty("Lost track of the move.", s.error)); return; }
    pieces = s.data.pieces || {};
    for (const e of buffered.splice(0)) pieces = mergeEvent(pieces, e);
    live = true;
    drawPieces(moveId, keys, pieces);
    if (readyToConfirm(s.data)) ready(moveId);
  };

  const ready = moveId => {
    offEvents?.(); offEvents = null;
    panel.append(note("The copy is verified and ready. This computer stays as it is until you confirm."),
      foot(h("button", { type: "button", class: "btn btn-primary", onclick: () => confirmFlip(moveId) }, "Confirm: make this a device"),
        h("button", { type: "button", class: "btn btn-ghost", onclick: () => cancelMove(moveId) }, "Undo")));
  };

  const cancelMove = async moveId => {
    put(panel, h("div", { class: "empty" }, "Undoing."));
    offEvents?.(); offEvents = null;
    await attempt("federation.move.cancel", { moveId });
    if (!ctx.alive()) return;
    point();
  };

  const confirmFlip = async moveId => {
    put(panel, h("div", { class: "empty" }, "Finishing up."));
    const c = await attempt("federation.move.confirm", { moveId });
    if (!ctx.alive()) return;
    if (c.error) { put(panel, empty("Could not finish the move.", c.error)); return; }
    drawAlreadyMoved(el, { movedAt: Date.now(), ...c.data }, true);
  };

  point();
}

/** After the flip: the celebration line once, the steady state after, and "Free up space" —
 * never automatic, gated 24 hours (anywhere.md's forget guard), the person's own click. */
function drawAlreadyMoved(el, d, justMoved = false) {
  // d is either onboard.status (machine: "device", a real server's identity not shaped yet by
  // anywhere) or federation.move.confirm's own data (destination.name) right after the flip.
  const dest = destinationName(d);
  const panel = h("div");
  put(el,
    justMoved ? note(`This computer is now a device. Your server is ${dest}.`) : null,
    row("This computer", h("span", null, "Is a device."), h("div", { class: "small muted" }, `Your server is ${dest}.`)),
    panel);
  const gate = forgetGate(d.movedAt || Date.now());
  if (!gate.ready) {
    put(panel, note(`The copy this computer kept during the move stays for ${gate.hoursLeft} more hours, in case anything looks off. After that, free it up any time.`));
    return;
  }
  const idle = () => put(panel, row("Old local copy", h("span", { class: "small muted" }, "Still here, from the move.")),
    foot(h("button", { type: "button", class: "btn", onclick: confirm_ }, "Free up space on this laptop")));
  const confirm_ = () => put(panel, note("This deletes the local copy the move kept. Your server already has everything."),
    foot(h("button", { type: "button", class: "btn btn-primary", onclick: run }, "Delete it"),
      h("button", { type: "button", class: "btn btn-ghost", onclick: idle }, "Cancel")));
  const run = async () => {
    put(panel, h("div", { class: "empty" }, "Freeing up space."));
    const r = await attempt("federation.move.forget");
    put(panel, r.error ? empty("Could not free up space.", r.error) : note(`Freed up ${fmtBytes(r.data?.freedBytes || 0)}.`));
  };
  idle();
}

// ---- 6. History and memory -----------------------------------------------------------------

async function drawHistory(el, ctx) {
  const recallBox = h("div");
  const memBox = h("div", { class: "set-sub" });
  put(el, recallBox, memBox);

  const drawRecall = async () => {
    const r = await attempt("recall.status");
    if (!ctx.alive()) return;
    if (r.error) { put(recallBox, h("h3", { class: "set-h3" }, "History"), empty("History search is not available.", r.error)); return; }
    const s = r.data || {};
    const st = status();
    const btn = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "btn btn-primary", disabled: !!s.indexing }, s.indexing ? "Indexing" : "Re-index now"));
    btn.addEventListener("click", async () => {
      btn.disabled = true; put(btn, "Indexing");
      const x = await attempt("recall.index");
      if (!ctx.alive()) return;
      if (x.error) { put(st, errText(x.error)); btn.disabled = false; put(btn, "Re-index now"); return; }
      drawRecall();
    });
    const last = s.last;
    const v = s.vectors || {};
    put(recallBox,
      h("h3", { class: "set-h3" }, "History"),
      h("div", { class: "rows" },
        row("Indexed", h("span", null, plural(s.sessions || 0, "session"), h("span", { class: "faint" }, " · "), plural(s.turns || 0, "turn"))),
        row("Folders", (s.folders || []).length ? h("div", { class: "set-list" }, s.folders.map(f => h("code", { class: "set-mono", title: f }, f))) : h("span", { class: "muted" }, "None")),
        row("Last pass", last?.at ? h("span", null, `${since(last.at)} ago`, h("span", { class: "faint" }, ` · ${when(last.at)}`)) : h("span", { class: "muted" }, "Not yet"),
          last?.at ? h("div", { class: "small faint" }, [last.added ? `${last.added} added` : "", last.appended ? `${last.appended} appended` : "",
            `${last.skipped || 0} unchanged`, last.failed ? `${last.failed} failed` : ""].filter(Boolean).join(" · ")) : null,
          s.every ? h("div", { class: "small faint" }, `Checks for new sessions every ${s.every} min.`) : null),
        row("Vectors", v.on ? h("span", null, "On", h("span", { class: "faint" }, ` · ${v.embedded || 0} embedded, ${v.pending || 0} waiting`))
          : h("span", null, "Off", v.why ? h("div", { class: "small faint" }, cap(v.why) + ".") : null)),
        s.error ? row("Problem", h("span", null, String(s.error))) : null),
      foot(btn, h("span", { class: "small faint" }, "Reads new and changed sessions now.")), st);
  };

  const drawMemory = async () => {
    const r = await attempt("memory.stats");
    if (!ctx.alive()) return;
    if (r.error) { put(memBox, h("h3", { class: "set-h3" }, "Memory"), empty("Memory is not available.", r.error)); return; }
    const m = r.data || {};
    const st = status();
    const actions = h("div", { class: "set-actions" });
    const idle = () => put(actions, h("button", { type: "button", class: "btn", onclick: confirm_ }, "Rebuild memory"),
      h("span", { class: "small faint" }, "Rereads every turn from the start."));
    const confirm_ = () => put(actions,
      h("span", { class: "small" }, `This rereads all ${plural(m.turns || m.lastRun?.turns || 0, "turn")} and rebuilds the graph. Pins and mutes stay.`),
      h("button", { type: "button", class: "btn", onclick: run }, "Rebuild"),
      h("button", { type: "button", class: "btn btn-ghost", onclick: idle }, "Cancel"));
    const run = async () => {
      put(actions, h("span", { class: "small muted" }, "Rebuilding memory."));
      const x = await attempt("memory.curate", { full: true });
      if (!ctx.alive()) return;
      if (x.error) { put(st, errText(x.error)); idle(); return; }
      drawMemory();
    };
    idle();
    put(memBox,
      h("h3", { class: "set-h3" }, "Memory"),
      h("div", { class: "rows" },
        row("Holds", h("span", null, plural(m.nodes || 0, "node"), h("span", { class: "faint" }, " · "), plural(m.facts || 0, "fact"),
          h("span", { class: "faint" }, " · "), plural(m.edges || 0, "link"))),
        row("Last curator run", m.lastRun?.at ? h("span", null, `${since(m.lastRun.at)} ago`, h("span", { class: "faint" }, ` · ${when(m.lastRun.at)}`))
          : h("span", { class: "muted" }, "Not yet"),
          m.lastRun?.at ? h("div", { class: "small faint" }, `${plural(m.lastRun.turns || 0, "turn")} read in ${m.lastRun.ms || 0} ms`) : null)),
      actions, st);
  };

  let t1 = 0, t2 = 0;
  ctx.on("session.indexed", () => { clearTimeout(t1); t1 = window.setTimeout(drawRecall, 400); });
  ctx.on("memory.curated", () => { clearTimeout(t2); t2 = window.setTimeout(drawMemory, 400); });
  ctx.cleanup(() => { clearTimeout(t1); clearTimeout(t2); });
  await Promise.all([drawRecall(), drawMemory()]);
}
const cap = s => String(s).charAt(0).toUpperCase() + String(s).slice(1);

// ---- 7. Lessons ----------------------------------------------------------------------------

const LEVELS = ["remind", "ask", "block"];
const SCOPES = [["all", "Everywhere"], ["project", "One project"], ["agent", "One agent"]];

async function drawLessons(el, ctx) {
  const draw = async () => {
    const [r, p] = await Promise.all([attempt("learn.lessons", {}), attempt("projects.list")]);
    for (const x of p.data?.projects || []) projectNames.set(x.slug, x.name);
    if (!ctx.alive()) return;
    if (r.error) { put(el, empty("Lessons are kept by the learning module.", r.error)); return; }
    const list = Array.isArray(r.data) ? r.data : r.data?.lessons || [];
    if (!list.length) { put(el, h("div", { class: "empty" }, "No lessons yet. When you correct Vyre, what it learned shows here.")); return; }
    put(el,
      note("What Vyre learned from your corrections. A lesson with a check is enforced by hooks; one broken again moves up a level."),
      h("div", { class: "rows set-lessons" }, list.map(l => lessonRow(l, () => draw()))));
  };
  ctx.on("lesson.learned", draw);
  ctx.on("lesson.escalated", draw);
  await draw();
}

const projectNames = new Map();
function scopeText(l) {
  if (l.scope === "project") return l.target ? `Only in ${projectNames.get(l.target) || l.target}` : "One project";
  if (l.scope === "agent") return l.target ? `Only for ${l.target}` : "One agent";
  return "Everywhere";
}
const SOURCE = { correction: "your correction", remember: "you asked me to remember", "draft-edit": "your edit to a draft", denied: "a call you denied", revert: "a change you reverted" };

function lessonRow(l, reload) {
  const el = h("div", { class: "set-lesson" });
  const st = status();
  const show = () => {
    const src = l.source || {};
    const from = SOURCE[src.kind] || src.kind || "a thread";
    put(el,
      h("div", { class: "set-lesson-main" },
        h("div", { class: "set-lesson-rule" }, l.rule),
        h("div", { class: "set-lesson-meta small" },
          h("span", { class: "tag set-level" + (l.level === "block" ? " strong" : "") }, l.level),
          l.check ? h("span", { class: "tag" }, "check") : null,
          h("span", { class: "muted" }, scopeText(l)),
          l.when ? h("span", { class: "faint" }, `when ${l.when}`) : null),
        h("div", { class: "set-lesson-meta small faint" },
          h("span", null, `Applied ${l.applied || 0}, broken ${l.broken || 0}`),
          h("span", null, "From ", src.thread ? link(`/threads/${encodeURIComponent(src.thread)}`, { class: "link", style: { color: "var(--text-2)" } }, from) : from,
            src.at ? `, ${when(src.at)}` : ""))),
      h("div", { class: "set-lesson-act" },
        h("button", { type: "button", class: "ibtn", "aria-label": "Edit lesson: " + l.rule, onclick: edit }, icon("edit")),
        h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: retire }, "Retire")),
      st);
  };
  const retire = () => put(el,
    h("div", { class: "set-lesson-main" }, h("div", { class: "set-lesson-rule" }, l.rule),
      h("div", { class: "small muted" }, "Retire this lesson? Vyre stops applying it.")),
    h("div", { class: "set-lesson-act" },
      h("button", { type: "button", class: "btn btn-sm", onclick: async () => {
        const x = await attempt("learn.retire", { id: l.id });
        if (x.error) { show(); put(st, errText(x.error)); return; }
        el.remove(); reload();
      } }, "Retire"),
      h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: show }, "Cancel")), st);
  const edit = () => {
    const rule = /** @type {HTMLTextAreaElement} */ (h("textarea", { class: "input", rows: "2", "aria-label": "Rule" }));
    rule.value = l.rule;
    let level = l.level;
    const seg = h("div", { class: "seg", role: "group", "aria-label": "Level" });
    const drawSeg = () => put(seg, LEVELS.map(v => h("button", { type: "button", "aria-pressed": String(v === level), onclick: () => { level = v; drawSeg(); } }, cap(v))));
    drawSeg();
    const scope = /** @type {HTMLSelectElement} */ (h("select", { class: "input set-select", "aria-label": "Scope" },
      SCOPES.map(([v, t]) => h("option", { value: v, selected: v === l.scope }, v === l.scope && l.target ? scopeText(l) : t))));
    const save = /** @type {HTMLButtonElement} */ (h("button", { type: "submit", class: "btn btn-sm" }, "Save"));
    put(el, h("form", { class: "set-lesson-edit", onsubmit: async (/** @type {Event} */ e) => {
      e.preventDefault();
      const input = { id: l.id };
      if (rule.value.trim() && rule.value.trim() !== l.rule) input.rule = rule.value.trim();
      if (level !== l.level) input.level = level;
      if (scope.value !== l.scope) input.scope = scope.value;
      if (Object.keys(input).length === 1) { show(); return; }
      save.disabled = true;
      const x = await attempt("learn.edit", input);
      if (x.error) { save.disabled = false; put(st, errText(x.error)); return; }
      Object.assign(l, x.data && x.data.id ? x.data : input);
      if (input.scope && input.scope !== "all" && !(x.data && x.data.id)) delete l.target;
      show();
    } },
      rule,
      h("div", { class: "set-lesson-fields" }, seg, scope),
      h("div", { class: "set-actions" }, save, h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: show }, "Cancel")), st));
    rule.focus();
  };
  show();
  return el;
}

// ---- notifications ---------------------------------------------------------------------------
// Subscribing, unsubscribing and "is this device on" live in js/phone-setup.js, shared with the
// phone's setup card, so there is one implementation.

async function drawNotifications(el, ctx) {
  const deviceBox = h("div");
  const settingsBox = h("div");
  const st = status();

  const draw = async () => {
    const p = await pushState();
    if (!ctx.alive()) return;
    // iOS only delivers Web Push to the Home Screen app; asking from a Safari tab cannot work, so
    // say why instead of showing a switch that does nothing.
    if (!p.ok && p.why === "install") {
      put(el, note("iOS only delivers notifications to the Home Screen app (iOS 16.4 or later). Add Vyre to your Home Screen: tap Share, then Add to Home Screen. Open it from there and turn notifications on here."));
      return;
    }
    if (!p.ok) { put(el, note("This browser does not support push notifications.")); return; }
    if (!el.contains(deviceBox)) put(el, deviceBox, settingsBox, st);
    if (p.error) { put(deviceBox, empty("Push is kept by its own module.", p.error)); put(settingsBox); return; }
    const sub = p.sub;
    const mine = p.device;

    // Called straight from the click: subscribePush asks for permission before it awaits
    // anything, which iOS needs.
    const subscribe = () => {
      put(st, "Asking for permission.");
      subscribePush(deviceName()).then(() => { put(st, ""); draw(); }, e => put(st, errText(e)));
    };
    // "This device" unsubscribes by the id push.subscribe gave; if that was lost (another tab,
    // cleared storage) but the browser still holds a live subscription, the endpoint still
    // identifies it on the box. A listed device unsubscribes by its id.
    const unsubscribe = async (device, endpoint) => {
      put(st, "Turning off.");
      try { await unsubscribePush({ device, endpoint, sub }); } catch (e) { put(st, errText(e)); return; }
      put(st, "");
      draw();
    };

    put(deviceBox, h("div", { class: "rows" },
      sub
        ? row("This device", stateLbl("On"), h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => unsubscribe(mine, sub.endpoint) }, "Turn off"))
        : p.permission === "denied"
          ? row("This device", stateLbl("Blocked", "faint"), h("div", { class: "small muted" }, deniedHelp()))
          : row("This device", h("button", { type: "button", class: "btn btn-sm btn-primary", onclick: subscribe }, "Turn on notifications"),
            h("div", { class: "small faint" }, "Only that something needs you, never what: asks and held drafts.")),
      ...p.devices.filter(d => d.device !== mine).map(d => row(d.label || "A device",
        h("span", { class: "small faint" }, d.fails ? "failing" : d.last_ok ? `last delivered ${since(d.last_ok)} ago` : "not tried yet"),
        h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => unsubscribe(d.device) }, "Remove")))));

    const settingsR = await attempt("push.settings");
    if (!ctx.alive()) return;
    if (settingsR.error) { put(settingsBox); return; }
    const s = settingsR.data || {};
    const quietOn = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", checked: !!s.quiet }));
    const start = /** @type {HTMLInputElement} */ (h("input", { type: "time", class: "input", value: s.quiet?.start || "22:00" }));
    const end = /** @type {HTMLInputElement} */ (h("input", { type: "time", class: "input", value: s.quiet?.end || "07:00" }));
    const syncQuiet = () => { start.disabled = end.disabled = !quietOn.checked; };
    const saveQuiet = () => attempt("push.settings", { quiet: quietOn.checked
      ? { start: start.value, end: end.value, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } : null });
    syncQuiet();
    for (const el2 of [quietOn, start, end]) el2.addEventListener("change", () => { syncQuiet(); saveQuiet(); });
    const KINDS = [["ask", "Permission questions"], ["draft", "Held drafts"], ["watch", "Threads you're watching"], ["lesson", "Lessons"],
      ["planner", "Alarms, timers and reminders"]];
    const words = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", checked: s.planner_label === true,
      onchange: () => attempt("push.settings", { planner_label: words.checked }) }));
    put(settingsBox, h("div", { class: "rows" },
      row("Quiet hours", quietOn, start, h("span", { class: "small faint" }, "to"), end)),
      h("div", { class: "rows" }, KINDS.map(([k, label]) => {
        const box = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", checked: s.kinds?.[k] !== false,
          onchange: () => attempt("push.settings", { kinds: { [k]: box.checked } }) }));
        return row(label, box);
      }), row("Show a reminder's own words on the lock screen", words)),
      sub ? foot(h("button", { type: "button", class: "btn btn-sm", onclick: async () => {
        put(st, "Sending."); const t = await attempt("push.test");
        put(st, t.error ? errText(t.error) : t.data?.sent ? "Sent." : "Not sent.");
      } }, "Send a test")) : null);
  };
  await draw();
}

// ---- security (passkeys, ADR 0004) -------------------------------------------------------------

/**
 * Add a passkey: proves a person is here for a Gate approval or a vault secret (ADR 0004).
 * The first one needs a one-time code from `vyre presence code`, typed on the box, since there
 * is no passkey yet to prove with. The enrollment itself is js/phone-setup.js's enrollPasskey,
 * shared with the phone's setup card.
 */
function drawSecurity(el, ctx) {
  const signedIn = h("div");
  drawSignedIn(signedIn, ctx);
  if (!canProve()) { put(el, note("This browser cannot create or use a passkey. Open the Deck in Safari or Chrome over your tailnet."), signedIn); return; }
  const codeIn = /** @type {HTMLInputElement} */ (h("input", { class: "input", id: "sec-code", autocomplete: "one-time-code", spellcheck: "false",
    autocapitalize: "off", placeholder: "from vyre presence code, on the box" }));
  const nameIn = /** @type {HTMLInputElement} */ (h("input", { class: "input", id: "sec-name", autocomplete: "off", placeholder: deviceName() }));
  const st = status();
  const keysBox = h("div");
  const btn = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "btn btn-sm btn-primary", onclick: enroll }, "Add a passkey"));
  // Called straight from the click: Safari makes a passkey only inside a user gesture.
  function enroll() {
    if (!codeIn.value.trim()) { put(st, "Paste the code first."); return; }
    btn.disabled = true;
    put(st, "Waiting for your passkey.");
    enrollPasskey({ name: nameIn.value, code: codeIn.value }).then(() => {
      codeIn.value = "";
      btn.disabled = false;
      put(st, "Passkey added.");
      drawKeys();
    }, e => { btn.disabled = false; put(st, errText(e)); });
  }
  const drawKeys = async () => {
    const k = await passkeyState();
    if (!ctx.alive()) return;
    put(keysBox, k.keys.length ? h("div", { class: "rows" }, row("Passkeys", h("div", { class: "set-list" }, k.keys.map(x =>
      h("span", null, x.name || "A passkey", h("span", { class: "small faint" }, x.last_used ? `  used ${since(x.last_used)} ago` : "  not used yet")))))) : null);
  };
  put(el,
    note("A passkey (Touch ID, Face ID, a security key) proves you are the one approving a Gate item or opening a vault secret. It is never typed, so it cannot be phished."),
    keysBox,
    h("div", { class: "rows" },
      row("Code", codeIn),
      row("Name this device", nameIn)),
    foot(btn), st, signedIn);
  drawKeys();
}

/**
 * Signed-in devices (person sessions): every browser and app signed in as you, when, and a
 * Revoke for each; "Sign out here" ends this one. A box without person sessions shows nothing.
 * Revoking asks no passkey unless this box still wants one (presence "asked").
 */
function drawSignedIn(el, ctx) {
  const draw = async () => {
    const me = await personStatus();
    if (!ctx.alive()) return;
    await optional(el, "Signed-in devices", "presence.person.sessions", d => {
      const list = Array.isArray(d.sessions) ? d.sessions : [];
      const st = status();
      const rows = list.map(x => {
        const here = !!me?.id && x.id === me.id;
        const btn = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "btn btn-sm", "data-act": "revoke", onclick: async () => {
          btn.disabled = true;
          const r = await attempt("presence.person.revoke", { id: x.id }, { presence: "asked" });
          if (!ctx.alive()) return;
          if (r.error) { btn.disabled = false; put(st, errText(r.error)); return; }
          if (here) { location.reload(); return; }
          draw();
        } }, "Revoke"));
        return h("div", { class: "set-list-row", "data-session": x.id },
          h("span", null, x.label || x.node || "A device",
            h("span", { class: "small faint" }, `  ${x.kind === "bearer" ? "app" : "browser"}`),
            here ? h("span", { class: "small" }, "  This device") : null),
          h("div", { class: "small faint" }, `Signed in ${when(x.created)}`, x.last_used ? `, last used ${since(x.last_used)} ago` : ", not used yet"),
          btn);
      });
      return [h("div", { class: "rows" }, row("Signed-in devices",
        rows.length ? h("div", { class: "set-list" }, rows) : h("span", { class: "muted" }, "None yet."))),
        me?.signed ? foot(h("button", { type: "button", class: "btn btn-sm", "data-act": "sign-out", onclick: () => signOutHere() }, "Sign out here")) : null,
        st];
    });
  };
  ctx.on("presence.signed-in", draw);
  ctx.on("presence.signed-out", draw);
  return draw();
}

// ---- 8. Modules ----------------------------------------------------------------------------

const STATE = { running: "running", failed: "failed", invalid: "failed", off: "disabled", disabled: "disabled", pending: "starting" };

async function drawModules(el) {
  const list = await modules();
  if (!list.length) { put(el, h("div", { class: "empty" }, "The box did not list its modules.", h("span", { class: "code" }, "It may not be running. Start it with vyre up."))); return; }
  const order = { failed: 0, starting: 1, running: 2, disabled: 3 };
  const rows = [...list].sort((a, b) => (order[STATE[a.state] || "disabled"] - order[STATE[b.state] || "disabled"]) || a.name.localeCompare(b.name));
  const bad = rows.filter(m => STATE[m.state] === "failed").length;
  put(el,
    note(`${plural(rows.filter(m => m.state === "running").length, "module")} running${bad ? `, ${bad} failed` : ""}. A module that fails is turned off and reported here; it never stops the box.`),
    h("table", { class: "set-table" },
      h("thead", null, h("tr", null, h("th", { class: "lbl", scope: "col" }, "Module"), h("th", { class: "lbl", scope: "col" }, "Version"), h("th", { class: "lbl", scope: "col" }, "State"))),
      h("tbody", null, rows.map(m => {
        const s = STATE[m.state] || m.state || "unknown";
        return h("tr", null,
          h("td", null, h("div", { class: "mono set-mod" }, m.name), m.error ? h("div", { class: "small muted set-problem" }, m.error) : null),
          h("td", { class: "code" }, m.version || ""),
          h("td", null, stateLbl(s, s === "running" ? "" : "faint")));
      }))));
}

// ---- 9. Appearance -------------------------------------------------------------------------

function drawAppearance(el) {
  const seg = h("div", { class: "seg", role: "group", "aria-label": "Theme" });
  const cur = () => document.documentElement.dataset.theme === "paper" ? "paper" : "dark";
  // Painted at once and kept in this browser; with the hub (ADR 0035) it is also this device's
  // appearance.scheme, so the device's other surfaces follow and settings.changed repaints them.
  let device = /** @type {string|null} */ (null), hub = false;
  attempt("settings.snapshot", {}).then(r => { device = r && r.data && r.data.device ? String(r.data.device) : null; hub = Boolean(r && r.data && device && "appearance.scheme" in (r.data.values || {})); draw(); }).catch(() => {});
  const set = v => {
    if (v === "paper") document.documentElement.dataset.theme = "paper"; else delete document.documentElement.dataset.theme;
    try { if (v === "paper") localStorage.setItem("vyre.theme", "paper"); else localStorage.removeItem("vyre.theme"); } catch {}
    if (hub && device) attempt("settings.set", { key: "appearance.scheme", value: v, level: "device", device }).catch(() => {});
    draw();
  };
  const hint = h("div", { class: "small faint" });
  const draw = () => {
    put(seg, [["dark", "Dark"], ["paper", "Paper"]].map(([v, t]) =>
      h("button", { type: "button", "aria-pressed": String(cur() === v), onclick: () => set(v) }, t)));
    put(hint, hub ? "Kept for this device. Your other devices keep their own." : "Kept in this browser only. Your other devices keep their own.");
  };
  draw();
  put(el, h("div", { class: "rows" }, row("Theme", seg, hint)));
}

// ---- 10. This machine ----------------------------------------------------------------------

async function drawMachine(el) {
  const r = await attempt("system.info");
  if (r.error) { put(el, empty("The box did not say what it runs on.", r.error)); return; }
  const s = r.data || {};
  put(el, h("div", { class: "rows" },
    row("Host", mono(s.host || "")),
    row("Role", h("span", null, s.role === "box" ? "Box" : s.role === "local" ? "Local" : s.role || ""),
      h("div", { class: "small faint" }, s.role === "box" ? "Always on. Runs the agents and serves your address." : "Your own computer. Connects to your box over the tailnet.")),
    row("Vyre", mono(s.version || "")),
    row("Platform", mono(s.platform || "")),
    row("Node", mono(s.node || ""))));
}

