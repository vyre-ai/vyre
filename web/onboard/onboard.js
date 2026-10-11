// @ts-check
// The onboarding (spec section 1): six steps, one a screen, each skippable. The onboard
// workstream owns the onboard.* tools; this file owns the screens. History uses Recall and Projects, which
// are already on main. Board: docs/design/boards/Onboard.dc.html.

import { h, put, empty } from "../js/dom.js";
import { call, attempt, on, setHeader } from "../js/api.js";
import { icon, mark, wordmark } from "../js/icons.js";
import { base, when, plural } from "../js/fmt.js";
import { pairRequests } from "../js/pair.js";
import qrcode from "../vendor/qrcode.js";
import { LOCK, lockState, lockSteps } from "../js/lock.js";
import { canRelayJoin } from "../js/join-caps.js";
import { buildWinkCard } from "../js/wink-card.js";

// Reconciled with docs/design/onboarding-v2.md's 10-step table (the lead, 29 Sep): this array's
// order now matches it exactly, with two client screens standing in for the doc's single step 2
// ("Pair this device with the server" is tailscale then name here) and the doc's step 10
// ("A tour of Lumen") as its own final, non-skippable screen split out of the old
// "devices" step, which keeps Mac- and phone-pairing but is a normal, skippable middle step now.
// A step with no server-side counterpart still marks, skips and counts correctly: stepState() defaults an unknown
// id to "todo" and mark_() only tries the server for a real onboard.<id> tool. Screens that did nothing yet (secrets, agent
// computers, Vyre Drive) are not steps: nothing here is shown that does not work, and those live in Settings.
const STEPS = [
  { id: "you", title: "You" },                    // 1
  { id: "live", title: "Where should Vyre live?" }, // 1b, ahead of ADR 0039 (team/archive/work-journals/launch-surfaces.md "Where should Vyre live?")
  { id: "tailscale", title: "Tailscale" },         // 2a
  { id: "name", title: "Your address" },           // 2b
  { id: "claude", title: "Claude Code" },          // 3
  { id: "history", title: "Your history" },        // 4
  { id: "accounts", title: "Connect accounts" },   // 6
  { id: "devices", title: "Your devices" },        // 9
  { id: "capsule", title: "Lumen" },         // 10
];

/** The steps core/onboard knows by name (its STEPS). */
const SERVER_STEPS = new Set(["you", "claude", "tailscale", "name", "history", "devices"]);

// The session vyred gave for `vyre up`'s one-time link: the server redeems ?t= itself and
// redirects to /onboard#s=<session>. Kept for this tab only and taken out of the address bar, so
// it is not left in history or shown over a shoulder.
const ss = (() => { try { return window.sessionStorage; } catch { return null; } })();
const sid = new URLSearchParams(location.hash.slice(1)).get("s");
if (sid) {
  try { ss?.setItem("vyre.onboard", sid); } catch {}
  history.replaceState(null, "", location.pathname + location.search);
}
setHeader("x-vyre-onboard", (() => { try { return ss?.getItem("vyre.onboard"); } catch { return null; } })());

/** What the steps share: the status from onboard.status, and what the user typed. */
const state = {
  /** @type {any} */ status: null,
  /** @type {any} */ statusError: null,
  name: "",
  assistant: "",
  host: "",
  /** The "How will Vyre run?" step's choice, config.machine's three values ("solo"|"server"|
   * "device", docs/design/anywhere.md, ADR 0039 — not config.role, which is unrelated and
   * unchanged), fixture-backed until anywhere's and tailnet's onboard.* tools ship for real
   * (asked, team/archive/work-journals/launch-surfaces.md "Where should Vyre live?"). */
  /** @type {"solo"|"server"|"device"|null} */ live: null,
  /** The Device choice's "same Tailscale network" input: the existing server's tailnet name,
   * for the `verify{node}` call once Tailscale connects (tailnet, team/archive/work-journals/launch-surfaces.md
   * "Two separate paths for 'I have a server'"). Client-only. */
  serverNode: "",
  /** Which of Device's two real join mechanisms is selected: same Tailscale network (no code,
   * onboard.join{verify}) or pair with a code (one call, relay.join). */
  // Default "relay" (the user, 28 Sep, pivoted same day: Tailscale stays but auto-manages
  // itself once relay is allowed, so manually pointing at a tailnet name is now "Use my own
  // Tailscale setup," an Advanced fallback, not the default); the live() screen falls back to
  // "tailscale" itself while relay isn't allowed yet.
  /** @type {"tailscale"|"relay"} */ deviceVia: "relay",
};
/** Timers and listeners of the current screen, cleared when the screen changes. */
let cleanup = [];
const later = (fn, ms) => { const t = setTimeout(fn, ms); cleanup.push(() => clearTimeout(t)); };
const every = (fn, ms) => { const t = setInterval(fn, ms); cleanup.push(() => clearInterval(t)); };

const root = /** @type {HTMLElement} */ (document.getElementById("ob"));
/** Set by step 5's "Pair your Mac": step 6 opens scrolled to the Mac card. */
let toMac = false;

// Look only: the step bar, the spoken step, the finish burst and one small easter egg.
const calm = () => { try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };
/** The polite live region in index.html, outside #ob, so a re-render never swallows what it says. */
function say(/** @type {string} */ text) {
  const el = document.getElementById("ob-say");
  if (!el) return;
  el.textContent = "";
  setTimeout(() => { el.textContent = text; }, 50);
}
/** The bar's last width, so moving to the next step grows it from where it was. */
let lastPct = 0;
let lastStep = -1;
/** A step just marked "done" for real (not skipped), so the next render() can give it a quick,
 * silent pop: consumed once, then cleared, so a later poll-driven re-render of the same screen
 * does not replay it. Never delays navigation: it only decorates whatever renders next. */
let justDone = null;

async function boot() {
  // loopback (before an owner exists) serves only /onboard and the onboard.* tools; system.info
  // is not one of them, so the host comes from onboard.status.
  const st = await attempt("onboard.status");
  state.status = st.data || null;
  state.statusError = st.error || null;
  state.name = state.status?.name || "";
  state.assistant = state.status?.assistant || "";
  state.host = state.status?.host || location.host;
  if (!location.hash) {
    const first = STEPS.find(s => stepState(s.id) === "todo");
    history.replaceState(null, "", "#" + (first ? first.id : STEPS[0].id));
  }
  render();
}
window.addEventListener("hashchange", render);

function stepState(id) { return state.status?.steps?.[id] || "todo"; }
function current() { const id = location.hash.slice(1); return STEPS.findIndex(s => s.id === id) >= 0 ? STEPS.findIndex(s => s.id === id) : 0; }
function goto(i) { location.hash = STEPS[Math.max(0, Math.min(STEPS.length - 1, i))].id; }

/** Mark a step, locally at once and in onboard.status when that tool is there. */
async function mark_(id, s) {
  state.status ||= { steps: {} };
  state.status.steps ||= {};
  state.status.steps[id] = s;
  if (s === "done") justDone = id;
  // Only the steps the server knows (core/onboard STEPS): the Deck has screens of its own the server never heard of, and asking it to skip one is a 400 (#56).
  if (s === "skipped" && SERVER_STEPS.has(id)) await attempt("onboard.skip", { step: id });
}

function render() {
  for (const f of cleanup) f();
  cleanup = [];
  // Consumed once: a later re-render of the same screen (a status poll, devices' refresh()) must
  // not replay the pop. Decorative only, so it's fine to skip outright under reduced motion.
  const justId = calm() ? null : justDone;
  justDone = null;
  const i = current();
  const step = STEPS[i];
  const col = h("div", { class: "ob-col" });
  const screen = {
    i, step,
    /** Set the footer: the one primary action, and whether Skip shows. */
    foot: (/** @type {{ label: string, run: () => any, disabled?: boolean } | null} */ primary, { skip = true, secondary = null } = {}) => {
      const f = h("div", { class: "ob-foot" },
        i > 0 ? h("button", { type: "button", class: "btn btn-ghost", onclick: () => goto(i - 1) }, "Back") : null,
        h("div", { class: "grow" }),
        secondary,
        skip ? h("button", { type: "button", class: "btn btn-ghost", onclick: async () => { await mark_(step.id, "skipped"); goto(i + 1); } },
          i === STEPS.length - 1 ? "Skip and open the Deck" : "Skip for now") : null,
        primary ? h("button", { type: "button", class: "btn btn-primary", id: "primary", disabled: !!primary.disabled, onclick: primary.run }, primary.label) : null);
      col.querySelector(".ob-foot")?.replaceWith(f) || col.append(f);
    },
    /** Move on, marking this step done. */
    next: async () => { await mark_(step.id, "done"); if (i === STEPS.length - 1) return finish(col); goto(i + 1); },
  };

  put(root,
    h("header", { class: "ob-top" },
      h("span", { class: "brand", "aria-label": "vyre" }, mark(20), wordmark(22)),
      h("span", { class: "where" }, "Setting up ", h("b", null, state.host))),
    h("div", { class: "ob-dots", "aria-hidden": "true" }, STEPS.map((s, j) =>
      h("span", { class: (j === i ? "now" : stepState(s.id) !== "todo" ? "done" : "") + (s.id === justId ? " pop" : "") }))),
    h("div", { class: "ob-body" },
      h("nav", { class: "ob-steps", "aria-label": "Setup steps" },
        h("div", { class: "lbl" }, "Setup"),
        h("ol", null, STEPS.map((s, j) => {
          const st = stepState(s.id);
          return h("li", null, h("a", { class: "ob-step" + (st === "done" ? " done" : ""), href: "#" + s.id, "aria-current": j === i ? "step" : false },
            h("span", { class: "n" + (s.id === justId ? " pop" : "") }, st === "done" ? icon("check", 12) : String(j + 1)),
            h("span", { class: "t" }, h("span", null, s.title), st !== "todo" ? h("span", null, st === "done" ? "Done" : "Skipped") : null)));
        })),
        h("div", { class: "foot" }, "Skip anything you like. Every step can be finished later from Settings, or with a vyre command.")),
      h("main", { class: "ob-main" }, col)));

  const pct = Math.round(100 * (i + 1) / STEPS.length);
  const fill = h("span", { style: { width: lastPct + "%" } });
  const left = STEPS.length - i - 1;
  col.append(h("div", { class: "ob-stepbar" },
    h("div", { class: "ob-stepbar-row" },
      h("div", { class: "lbl", id: "ob-step-label" }, `Step ${i + 1} of ${STEPS.length} · ${step.title}`),
      h("span", { class: "ob-togo" }, left ? `${left} more after this` : "Last one")),
    h("div", { class: "ob-meter", role: "progressbar", "aria-labelledby": "ob-step-label", "aria-valuemin": "1",
      "aria-valuemax": String(STEPS.length), "aria-valuenow": String(i + 1), "aria-valuetext": `Step ${i + 1} of ${STEPS.length}` }, fill)));
  requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = pct + "%"; }));
  lastPct = pct;
  if (lastStep !== i) say(`Step ${i + 1} of ${STEPS.length}: ${step.title}`);
  lastStep = i;
  if (state.statusError?.missing && step.id !== "history") {
    col.append(h("div", { class: "need", style: { marginBottom: "24px" } },
      h("div", { class: "lbl beacon" }, "Setup is not running"),
      "The server module is not running on this machine, so this step cannot finish here yet. Run ", h("code", null, "vyre up"),
      " on the server, then reload this page. Until then, skip ahead to the steps that work."));
  }
  // A new browser, or the link already used here: the loopback door refuses every onboard.* call
  // without the session `vyre up`'s link carries (core/onboard/loopback.js answers 403 "denied").
  if (state.statusError?.code === "denied") {
    col.append(h("div", { class: "need", style: { marginBottom: "24px" } },
      h("div", { class: "lbl beacon" }, "Open your setup link"),
      "This page needs the one-time link ", h("code", null, "vyre up"), " printed, opened in this browser. Run ", h("code", null, "vyre up"),
      " on the server for a fresh link, then open it here."));
  }
  SCREENS[step.id](col, screen);
}

/** A labelled command, shown alone, with a copy button. */
function command(text) {
  const b = h("button", { type: "button", class: "ibtn", "aria-label": "Copy command", onclick: async () => {
    try { await navigator.clipboard.writeText(text); put(b, icon("check")); later(() => put(b, icon("copy")), 1500); } catch {}
  } }, icon("copy"));
  return h("div", { class: "cmd" }, h("code", null, text), b);
}

/** One numbered step inside a device card. */
function devStep(n, title, ...body) {
  return h("li", null, typeof n === "string" ? h("span", { class: "n" }, n) : n, h("div", { class: "x" }, h("span", { class: "t" }, title), body));
}

const LOOPBACK = /^(127\.|localhost$|\[?::1\]?$)/;

/** Whether an address (with or without https://) is the one this page is open at. */
function here(/** @type {string} */ address) {
  try { return new URL(/^https?:\/\//.test(address) ? address : "https://" + address).host === location.host; } catch { return false; }
}

/**
 * A phone or tablet, by the OS Tailscale reports: "iPhone", "iPad" or "Android phone"; null for
 * anything else. Tailscale says iOS for an iPad too, so the node's name tells them apart.
 * @param {string} os @param {string} [name]
 */
function handheld(os, name = "") {
  const o = String(os || "").toLowerCase();
  if (o === "ios") return /ipad/i.test(name) ? "iPad" : "iPhone";
  if (o === "android") return "Android phone";
  return null;
}


/** Tailnet Lock's steps, each with its command or key to copy. The person runs them; Vyre never does. */
function lockCommands(d) {
  return [h("ol", { class: "ob-lock-steps" }, lockSteps(d).map(x => h("li", null, h("p", { class: "small" }, x.text), x.copy ? command(x.copy) : null))),
    h("p", { class: "notice" }, icon("lock", 14), LOCK.never)];
}

/**
 * The optional Tailnet Lock card, shown on the address step once this machine is on the tailnet,
 * after the HTTPS step so a person turns HTTPS on before deciding about the lock. Made once per
 * screen, so a poll redrawing the panel keeps what the person opened or dismissed.
 */
function lockCard() {
  const card = h("div", { class: "ob-lock" });
  (async () => {
    const r = await attempt("onboard.tailscale", { action: "lock" });
    if (r.error) { card.remove(); return; }
    const d = r.data || {};
    const on = lockState(d);
    if (on) { put(card, h("div", { class: "found" }, icon("lock"), h("span", { class: "what" }, on))); return; }
    const steps = h("div");
    const toggle = h("button", { type: "button", class: "btn" }, LOCK.show);
    toggle.addEventListener("click", () => {
      const open = !steps.childNodes.length;
      put(steps, open ? lockCommands(d) : null);
      put(toggle, open ? LOCK.hide : LOCK.show);
    });
    put(card,
      h("div", { class: "lbl" }, "Optional"),
      h("h3", { class: "h3" }, LOCK.title),
      h("p", { class: "small muted" }, LOCK.what),
      h("p", { class: "small muted" }, LOCK.cost),
      h("div", { class: "ob-lock-act" }, toggle,
        h("button", { type: "button", class: "btn btn-ghost", onclick: () => put(card, h("p", { class: "notice" }, LOCK.laterNote)) }, LOCK.later)),
      steps);
  })();
  return card;
}

/** The HTTPS step's words: a ts.net address needs HTTPS on in the tailnet, which only the person can turn on. */
const HTTPS = {
  title: "Turn on HTTPS for your tailnet",
  what: "Your address is a ts.net name, and Tailscale gives its certificate. Tailscale does that only once HTTPS is on for your tailnet, and it starts off.",
  open: "Open the DNS page of the Tailscale admin console:",
  click: "Under HTTPS Certificates, click Enable HTTPS.",
  back: "Come back here and click Check again.",
  cost: "Turning it on publishes this machine's name in public Certificate Transparency logs.",
  never: "Vyre never changes your tailnet's settings. This one is yours to turn on.",
  button: "Open the admin console",
};
const ADMIN_DNS = "https://login.tailscale.com/admin/dns";

/** One row of a live checklist. state: todo | doing | done | failed */
function progressRow(label, st, note, since) {
  const glyph = st === "done" ? icon("check", 14) : st === "doing" ? h("span", { class: "busy" }) : h("span", { class: "ring" });
  // A slow line says how long it has been going, so a minute of waiting never looks stuck.
  const took = st === "doing" && since ? `working, ${Math.max(0, Math.round((Date.now() - since) / 1000))} s` : "working";
  return h("li", { class: st },
    h("span", { class: "st" }, glyph),
    h("span", { class: "x" }, h("span", null, label), note ? h("span", null, note) : null),
    st === "failed" ? h("span", { class: "state" }, "failed") : st === "doing" ? h("span", { class: "state" }, took) : null);
}

const NAME_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;


/** @type {Record<string, (col: HTMLElement, s: any) => void>} */
const SCREENS = {
  you(col, s) {
    col.append(
      h("h1", { class: "h1" }, "What should we call you?"),
      // ADR 0008 section 4: step 1 no longer reserves a name or promises "<you>.vyre.run" — v0.1
      // defaults to a ts.net address, decided in the address step, and onboard.you no longer
      // checks availability itself (that is still asked for, live, as the person types, so a
      // name they cannot have is caught early; it just isn't shown as a domain here).
      h("p", { class: "lead" }, "Let's start with names: yours, and your assistant's. Only your own devices will be able to reach what you set up here."));
    const status = h("div", { class: "check-line", "aria-live": "polite" });
    const nameIn = h("input", { class: "input", id: "name", value: state.name, autocomplete: "off", spellcheck: "false", autocapitalize: "none",
      "aria-describedby": "name-status", placeholder: "Your name" });
    status.id = "name-status";
    const asst = h("input", { class: "input", id: "assistant", value: state.assistant, autocomplete: "off", placeholder: "Your assistant's name" });
    let ok = false, seq = 0;
    const check = async () => {
      const v = /** @type {HTMLInputElement} */ (nameIn).value.trim().toLowerCase();
      state.name = v;
      ok = false;
      if (!v) { put(status); return sync(); }
      if (!NAME_RE.test(v)) { put(status, "Lowercase letters, numbers and hyphens, 3 to 32 long, starting with a letter."); return sync(); }
      put(status, h("span", { class: "faint" }, "Checking."));
      const n = ++seq;
      const r = await attempt("onboard.name", { name: v, action: "check" });
      if (n !== seq) return;
      if (r.error?.missing) { ok = true; put(status, h("span", { class: "faint" }, "Availability is checked when the server module runs.")); }
      else if (r.error) put(status, String(r.error.message));
      // No vyre.run token (the usual box): the address is this machine's ts.net name, set up in step 4.
      else if (r.data.via === "ts.net" && r.data.available) { ok = true; put(status, h("span", { class: "faint" }, r.data.address ? `Your address will be ${r.data.address.replace(/^https:\/\//, "")}.` : "Your address will be on your tailnet, set up in step 4.")); }
      else if (r.data.available) { ok = true; put(status, icon("check", 14), "Available."); }
      else put(status, `That name is not free${r.data.why ? ": " + r.data.why : "."} Try another.`);
      sync();
    };
    let t = 0;
    nameIn.addEventListener("input", () => { clearTimeout(t); t = window.setTimeout(check, 300); });
    col.append(h("div", { class: "ob-panel" },
      h("div", { class: "field" }, h("label", { for: "name" }, "Your name"), nameIn, status),
      h("div", { class: "field" }, h("label", { for: "assistant" }, "Your assistant's name"), asst,
        h("span", { class: "hint" }, "Your assistant sees every project and can drive any session, so you never have to start from a blank page. You can rename it, and change its voice and instructions, later."))));
    const sync = () => s.foot({ label: "Continue", disabled: !ok, run: async () => {
      state.assistant = /** @type {HTMLInputElement} */ (asst).value.trim();
      const r = await attempt("onboard.you", { name: state.name, assistant: state.assistant || undefined });
      if (r.error && !r.error.missing) { put(status, String(r.error.message)); return; }
      s.next();
    } });
    sync();
    if (state.name) check();
    later(() => nameIn.focus(), 0);
  },

  // New (28 Sep, user decision "Vyre anywhere"): a role choice ahead of the pairing screens.
  // Copy and the three choices are anywhere's (docs/design/anywhere.md, work/anywhere 11328815,
  // ADR 0039), which owns them; this screen is launch's build of that spec. The field is
  // config.machine ("solo"|"server"|"device", additive, ADR 0039) — NOT config.role, which
  // stays "box"|"local" and is untouched by this screen.
  //
  // Unified per the lead (the user was explicit: Move to server is the SAME flow in onboarding
  // and later): "name" (reserving this machine's own address) never runs for Device — a device
  // never reserves an address, only a server does. "tailscale" DOES still run for Device (a
  // device joining IS "a second device joining", the case the lead said triggers it), just not
  // for Solo or Server, which both skip both screens and defer to Settings > Your devices > Add
  // a device later.
  //   - Solo: onboard.machine{machine:"solo"} (a safe no-op per anywhere, called anyway so the
  //     server has it on record), then straight to Claude sign-in. Real tool, sha 73d03d39 —
  //     `service` always comes back null for now (anywhere's own launchd installer isn't built
  //     yet), so nothing here reads it.
  //   - Server: onboard.machine{machine:"server"}, same real tool. `service.warning` is not
  //     surfaced yet either, for the same reason; will add once anywhere says it's populated.
  //   - Device: two real paths, per tailnet, both built now (team/archive/work-journals/launch-surfaces.md
  //     "Concrete answer: relay.join for the code, onboard.join for Tailscale"), each its own
  //     inner radio under "device", not one made-up "setup code" field:
  //       - Same Tailscale network: this machine's own Tailscale connect (the existing
  //         `tailscale` screen, reused as-is, `onboard.tailscale`), then
  //         `onboard.join{action:"verify", node:<the server's tailnet name>, becomeDevice:true}`
  //         once connected. No code exchanged; the person supplies the server's tailnet name,
  //         since verify has to be told which server to check reachability against.
  //       - Pair with a code: one call, `relay.join{url, becomeDevice:true}`, straight from this
  //         screen — no separate verify step, since a successful pairing already proves
  //         reachability. `url` is the pairing code/link (relay.pair.start or
  //         onboard.join{action:"relay"}, minted on the server side, pasted here). Shown only
  //         when `onboard.status.can.relayJoin` is true (see js/join-caps.js): false on a Mac
  //         until vyre-core (relay.join itself also refuses there, as a backstop), a missing
  //         field treated as false. Not shipped by anywhere yet, so this hides unconditionally
  //         today — no guessed platform check stands in for the real signal.
  //     Both paths pass `becomeDevice:true` and land the same way. Neither existed as real
  //     tools when this screen was first built (28 Sep); onboard.join is real-shaped but not on
  //     main yet, relay.join is real-shaped and not on main yet either.
  // Fixture-backed (web/fixtures/onboard.json, web/fixtures/relay.json): onboard.machine is
  // the only one of these four tools actually shipped on main so far.
  live(col, s) {
    col.append(
      h("h1", { class: "h1" }, "How will Vyre run?"),
      h("p", { class: "lead" }, "You can change this later without losing anything."));
    const body = h("div", { class: "ob-panel" });
    const st = h("div", { class: "check-line", "aria-live": "polite" });
    col.append(body, st);
    let choice = state.live;
    // Server-decided (the lead, 28 Sep): can.relayJoin, false on a Mac until vyre-core, a
    // missing field treated the same as false (see web/js/join-caps.js). Not shipped by
    // anywhere yet, so this reads false today on every machine — the option stays hidden until
    // it lands, not a guess at what platform this is.
    const relay = canRelayJoin(state.status);
    // PIVOT (the user, 28 Sep, same day as the first decision below): Tailscale itself stays —
    // Vyre sets it up automatically once relay is allowed, so there is no manual Tailscale step
    // in the normal flow at all. "Pair with a code" is the default (state.deviceVia's own
    // default, below); manually pointing this device at a tailnet name is now "Use my own
    // Tailscale setup," an Advanced fallback for someone who already runs their own Tailscale
    // account, not the default path. Before relay is allowed, that manual field is still the
    // only path that actually works, so it's shown plainly, not hidden behind a toggle with
    // nothing on the other side of it.
    let via = !relay.allowed ? "tailscale" : state.deviceVia;
    const nodeIn = /** @type {HTMLInputElement} */ (h("input", { class: "input", id: "server-node", placeholder: "The server's name", autocomplete: "off",
      value: state.serverNode, oninput: () => { state.serverNode = nodeIn.value; } }));
    const codeIn = /** @type {HTMLInputElement} */ (h("input", { class: "input", id: "pair-code", placeholder: "Paste the code your server showed", autocomplete: "off" }));

    const toClaude = () => goto(STEPS.findIndex(x => x.id === "claude"));
    const label = () => choice !== "device" ? "Continue" : via === "relay" ? "Pair" : "Connect";

    const syncFoot = () => s.foot({ label: label(), disabled: !choice, run: async () => {
      if (choice === "solo") {
        // Order matters: onboard.skip's tailscale/name calls are boxOnly() (core/onboard/index.js),
        // refused once the machine is actually "solo" (config.isServer("solo") is false, correctly,
        // since neither step applies to a solo machine at all). Skip them first, while this
        // machine still counts as a server for that check, then flip it to solo - the other order
        // silently failed the skip server-side, leaving onboard.status().steps stuck at "todo"
        // forever even though the page had already moved on to Claude sign-in.
        await mark_("tailscale", "skipped"); await mark_("name", "skipped");
        await attempt("onboard.machine", { machine: "solo" });
        await mark_("live", "done"); toClaude();
        return;
      }
      if (choice === "server") {
        put(st, "Setting this computer up as your server.");
        const r = await attempt("onboard.machine", { machine: "server" });
        if (r.error && !r.error.missing) { put(st, String(r.error.message)); return; }
        put(st, "");
        await mark_("live", "done"); await mark_("tailscale", "skipped"); await mark_("name", "skipped"); toClaude();
        return;
      }
      if (via === "relay") {
        // A single call, no verify step: relay.join proves reachability by pairing. presence:
        // "asked" so the box name, relay host and key fingerprint the real tool's own presence
        // summary names (core/relay/index.js, reviewer's MEDIUM on 93754fa2, fixed 6cd9c02d) show
        // in the confirmation before it pairs — this device is joining a box a phishing message
        // could otherwise name convincingly, so the person needs to see which one for real.
        const v = codeIn.value.trim();
        if (!v) { put(st, "Paste the code first."); return; }
        put(st, "Pairing.");
        const r = await attempt("relay.join", { url: v, becomeDevice: true }, { presence: "asked" });
        if (r.error && !r.error.missing) { put(st, String(r.error.message)); return; }
        put(st, "");
        await mark_("live", "done"); await mark_("tailscale", "skipped"); await mark_("name", "skipped"); toClaude();
        return;
      }
      // device, same Tailscale network: this machine still needs to join it (the "tailscale"
      // screen is real and does that), so it runs, unlike Solo/Server above. "name" never
      // applies to a device, wherever this flow lands next (see SCREENS.name's own skip).
      const v = nodeIn.value.trim();
      if (!v) { put(st, "Your server's tailnet name first (the same one its own setup showed)."); return; }
      state.serverNode = v;
      await mark_("live", "done");
      goto(STEPS.findIndex(x => x.id === "tailscale"));
    } });
    const opt = (value, title, more) => h("label", { class: value === choice ? "on" : "" },
      h("input", { type: "radio", name: "live", value, checked: value === choice, onchange: () => { choice = state.live = value; put(body, choiceEl()); syncFoot(); } }),
      h("span", { class: "t" }, h("b", null, title)),
      value === choice && more ? h("div", { class: "more" }, more) : null);
    const viaOpt = (value, title, more) => h("label", { class: value === via ? "on" : "" },
      h("input", { type: "radio", name: "device-via", value, checked: value === via, onchange: () => { via = state.deviceVia = value; put(body, choiceEl()); syncFoot(); } }),
      h("span", { class: "t" }, h("b", null, title)),
      value === via ? h("div", { class: "more" }, more) : null);
    const choiceEl = () => h("div", { class: "choice", role: "radiogroup", "aria-label": "How Vyre runs" },
      opt("solo", "Just on this computer"),
      opt("server", "This computer stays on for me, and I'll use other devices too"),
      opt("device", "I already have a Vyre server",
        relay.allowed
          ? h("div", { class: "choice", role: "radiogroup", "aria-label": "How to join it" },
              viaOpt("relay", "Pair with a code",
                h("div", { class: "field" }, h("label", { for: "pair-code" }, "Pairing code"), codeIn)),
              h("details", { class: "ob-collapse" },
                h("summary", null, "Use my own Tailscale setup"),
                viaOpt("tailscale", "Same Tailscale network",
                  h("div", { class: "field" }, h("label", { for: "server-node" }, "Your server's tailnet name"), nodeIn))))
          : [
              h("div", { class: "field" }, h("label", { for: "server-node" }, "Your server's tailnet name"), nodeIn),
              relay.reason ? h("p", { class: "small muted" }, relay.reason) : null,
            ]));
    put(body, choiceEl());
    syncFoot();
  },

  claude(col, s) {
    col.append(
      h("h1", { class: "h1" }, "Sign in to Claude."),
      h("p", { class: "lead" }, "Vyre works on your own Claude subscription or API key, so your work stays yours. It all happens on this page: no terminal needed."));
    const panel = h("div", { class: "ob-panel" }, h("div", { class: "found" }, h("span", { class: "faint" }, "Looking for claude on this machine")));
    col.append(panel);
    s.foot(null);
    (async () => {
      const d = await attempt("onboard.claude", { mode: "detect" });
      if (d.error) { put(panel, empty("Vyre could not look for Claude Code on this machine. Skip for now and sign in later from Settings, or reload to try again.", d.error)); s.foot(null); return; }
      const info = d.data;
      if (!info.installed) {
        put(panel,
          h("div", { class: "found" }, icon("terminal"), h("span", { class: "what" }, "Claude Code is not on this machine yet.")),
          h("div", { class: "field" }, h("label", null, "Install it with this command, then press Check again"), command(info.install || "npm install -g @anthropic-ai/claude-code")));
        s.foot({ label: "Check again", run: () => render() });
        return;
      }
      const found = h("div", { class: "found" }, icon("terminal"),
        h("span", { class: "what" }, "Claude Code is installed.", info.version ? h("span", { class: "code" }, info.version) : null));
      if (info.signedIn) {
        put(panel, found, h("div", { class: "found" }, icon("check"), h("span", { class: "what" },
          info.via === "api-key" ? "Signed in with an API key. It is in the Vault." : "Signed in with your Claude subscription. The token is in the Vault.")));
        s.foot({ label: "Continue", run: s.next });
        return;
      }
      let mode = "setup-token";
      const keyIn = /** @type {HTMLInputElement} */ (h("input", { class: "input", type: "password", autocomplete: "off", id: "api-key", placeholder: "sk-ant-…", "aria-label": "Anthropic API key" }));
      const msg = h("div", { class: "check-line", "aria-live": "polite" });
      const opt = (value, title, desc, more) => {
        const r = h("input", { type: "radio", name: "auth", value, checked: value === mode, onchange: () => { mode = value; draw(); } });
        return [h("label", { class: value === mode ? "on" : "" }, r, h("span", { class: "t" }, h("b", null, title), h("span", null, desc))),
          value === mode && more ? h("div", { class: "more" }, more) : null];
      };
      const choice = h("div", { class: "choice", role: "radiogroup", "aria-label": "How Vyre signs in" });
      const draw = () => {
        put(choice,
          opt("setup-token", "Your Claude subscription", "Opens Claude's sign-in in a new tab. Vyre keeps the token it gets in the Vault."),
          opt("api-key", "An Anthropic API key", "Billed to your Anthropic account. Stored in the Vault, and no screen shows it again, this one included.",
            [keyIn]));
        s.foot(mode === "api-key"
          ? { label: "Save key", run: saveKey }
          : { label: "Sign in with Claude", run: signIn });
      };
      const saveKey = async () => {
        const key = keyIn.value.trim();
        if (!key) { put(msg, "Paste a key first."); return; }
        keyIn.value = "";
        const r = await attempt("onboard.claude", { mode: "api-key", key });
        if (r.error) { put(msg, String(r.error.message)); return; }
        render();
      };
      // Claude's own sign-in page hands back a code, which this machine's `claude setup-token`
      // pty is waiting to read; there is nothing to poll for, so it is typed here and sent back.
      const signIn = async () => {
        put(msg, h("span", { class: "busy-inline faint" }, "Starting Claude's sign-in. This takes a few seconds."));
        const r = await attempt("onboard.claude", { mode: "setup-token" });
        if (r.error) { put(msg, String(r.error.message)); return; }
        if (r.data.url) window.open(r.data.url, "_blank", "noopener");
        if (!r.data.needsCode) { put(msg, h("span", { class: "busy-inline faint" }, "Waiting for you to finish signing in, in the other tab.")); return; }
        const codeErr = h("div", { class: "check-line", "aria-live": "polite" });
        const codeIn = h("input", { class: "input", id: "setup-code", autocomplete: "off", spellcheck: "false", autocapitalize: "none",
          placeholder: "Paste the code Claude gave you", "aria-label": "Claude sign-in code" });
        // msg is normally a one-line .check-line; this step needs a small stack, so it gets one
        // block child instead of several flex siblings.
        put(msg, h("div", { style: { display: "flex", flexDirection: "column", gap: "10px", width: "100%" } },
          h("p", { class: "small muted", style: { margin: "0" } }, "Finish signing in at Claude's page, then paste the code it gives you below.",
            r.data.url ? [" ", h("a", { class: "link", href: r.data.url, target: "_blank", rel: "noopener" }, "Open it again")] : null),
          h("div", { class: "field" }, h("label", { for: "setup-code" }, "Code"), codeIn),
          codeErr));
        const submit = async () => {
          const code = /** @type {HTMLInputElement} */ (codeIn).value.trim();
          if (!code) { put(codeErr, "Paste the code first."); return; }
          put(codeErr, h("span", { class: "busy-inline faint" }, "Checking the code with Claude. This takes a few seconds."));
          const p = await attempt("onboard.claude", { mode: "setup-token", code });
          put(codeErr);
          if (p.error) { put(codeErr, String(p.error.message)); return; }
          if (p.data?.signedIn) render(); else put(codeErr, "That code did not work. Try again.");
        };
        s.foot({ label: "Continue", run: submit }, { secondary: h("button", { type: "button", class: "btn btn-ghost", onclick: draw }, "Try another way") });
        later(() => /** @type {HTMLInputElement} */ (codeIn).focus(), 0);
      };
      put(panel, found, choice, msg);
      draw();
    })();
  },

  tailscale(col, s) {
    col.append(
      h("h1", { class: "h1" }, "Put this machine on your tailnet."),
      h("p", { class: "lead" }, "Tailscale lets your phone and laptop reach Vyre, and nothing else can. You sign in on Tailscale's own page, so Vyre never sees your password."),
      h("p", { class: "small muted", style: { marginTop: "8px" } }, "No Tailscale account? Sign in with Google, GitHub, Apple or Microsoft; that makes one, free for personal use. Use the same account as your Mac."));
    const panel = h("div", { class: "ob-panel" }, h("div", { class: "found" }, h("span", { class: "faint" }, "Looking for Tailscale")));
    const st = h("div", { class: "check-line", "aria-live": "polite" });
    col.append(panel, st);
    s.foot(null);
    const toClaude = () => goto(STEPS.findIndex(x => x.id === "claude"));
    const verifyDevice = async () => {
      put(st, "Checking your server.");
      s.foot({ label: "Checking", disabled: true, run: () => {} });
      const j = await attempt("onboard.join", { action: "verify", node: state.serverNode, becomeDevice: true });
      if (j.error && !j.error.missing) { put(st, String(j.error.message)); s.foot({ label: "Continue", run: verifyDevice }); return; }
      // A tool that answers without erroring still says whether it actually found the server:
      // verify forwards to link.health, whose real shape (core/link/health.js) is `online` (and
      // `path: "unknown"` with a `why`), not `ok`/`reachable` — reviewer-2 caught this being
      // skipped entirely (the real bug: any node, right or wrong, always proceeded).
      if (j.data && j.data.online === false) { put(st, j.data.why || `Could not reach ${state.serverNode}. Check the name and try again.`); s.foot({ label: "Continue", run: verifyDevice }); return; }
      put(st, "");
      await mark_("tailscale", "done"); await mark_("name", "skipped"); toClaude();
    };

    // The merged policy snippet (tailnet, ecd89c0c): one JSON object for Taildrive, Taildrop,
    // egress (when on) and the SSH rule, replacing the four separate placeholders in ADR 0014.
    // Fetched once, only after signing in; a person who onboarded before this shipped finds the
    // same panel later in Settings > Network (not yet built).
    let policyDrawn = false;
    const drawPolicy = async () => {
      if (policyDrawn) return;
      policyDrawn = true;
      const box = h("div", null, h("span", { class: "faint" }, "Reading your tailnet policy…"));
      panel.append(h("details", { class: "ob-collapse" }, h("summary", null, "Advanced: your tailnet policy"), box));
      const r = await attempt("onboard.tailscale", { action: "policy" });
      if (r.error || !r.data.ready) { put(box, h("p", { class: "small muted" }, r.data?.why || "Not ready yet. Reload this page to try again.")); return; }
      const text = JSON.stringify(r.data.policy, null, 2);
      const copyBtn = h("button", { type: "button", class: "btn btn-line btn-sm", onclick: async () => {
        try { await navigator.clipboard.writeText(text); put(copyBtn, "Copied"); later(() => put(copyBtn, "Copy"), 1500); } catch {}
      } }, "Copy");
      put(box,
        h("p", { class: "small muted" }, "Paste this into your tailnet's access policy (the admin console's Access Controls tab) to turn on Taildrive, Taildrop, egress and SSH between your devices."),
        h("pre", { class: "code", style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: "8px 0" } }, text),
        copyBtn,
        r.data.notes?.length ? h("ul", { class: "small muted", style: { marginTop: "8px" } }, r.data.notes.map(n => h("li", null, n))) : null);
    };
    const show = (/** @type {any} */ t) => {
      if (!t.installed) {
        put(panel,
          h("div", { class: "found" }, icon("terminal"), h("span", { class: "what" }, "Tailscale is not on this machine yet.")),
          h("div", { class: "field" }, h("label", null, "Install it with this one command, then check again"), command(t.install || "curl -fsSL https://tailscale.com/install.sh | sh")),
          h("p", { class: "notice" }, icon("lock", 14), "Vyre does not install software for you. Run it yourself, where you can see what it does."));
        s.foot({ label: "Check again", run: () => render() });
        return;
      }
      if (t.state === "blocked") {
        put(panel,
          h("div", { class: "found" }, icon("lock"), h("span", { class: "what" }, t.why || "Your tailnet will not let this machine join.")),
          t.operator?.fix ? h("p", { class: "notice" }, t.operator.fix) : null);
        s.foot({ label: "Check again", run: () => render() });
        return;
      }
      const opened = t.state !== "off" || !!t.loginUrl;
      const signed = t.state === "connected";
      put(panel, h("ol", { class: "progress" },
        progressRow("Open Tailscale's sign-in", opened ? "done" : "todo", t.loginUrl && !signed ? null : null),
        progressRow("Sign in with your Tailscale account", signed ? "done" : opened ? "doing" : "todo",
          opened && !signed ? "Waiting for you, in the other tab." : null),
        progressRow("This machine joins your tailnet", signed ? "done" : "todo",
          signed && t.node ? `${t.node.dns || state.host} at ${t.node.ip}` : null)),
        t.loginUrl && !signed ? h("p", { class: "notice" }, "The sign-in page did not open? ",
          h("a", { class: "link", href: t.loginUrl, target: "_blank", rel: "noopener" }, "Open it here")) : null,
        null);
      if (signed) {
        // A device joining an existing server (the "live" step's Device choice, above): verify
        // reachability and flip config.machine before moving on, instead of the plain s.next()
        // every other path here uses. becomeDevice:true per tailnet's design call — only the
        // connecting device's own verify should ever flip the machine.
        s.foot({ label: "Continue", run: state.live === "device" ? verifyDevice : s.next });
        drawPolicy();
      }
      else if (opened) s.foot({ label: "Waiting for Tailscale", disabled: true, run: () => {} });
      else s.foot({ label: "Connect", run: connect });
    };
    const poll = () => every(async () => {
      const r = await attempt("onboard.tailscale", { action: "poll" });
      if (r.data) { show(r.data); if (r.data.state === "connected") for (const f of cleanup.splice(0)) f(); }
    }, 2000);
    const connect = async () => {
      s.foot({ label: "Starting Tailscale's sign-in", disabled: true, run: () => {} });
      put(panel, h("p", { class: "small muted" }, h("span", { class: "busy-inline faint" }, "Starting Tailscale's sign-in. This takes up to ten seconds.")));
      const r = await attempt("onboard.tailscale", { action: "connect" });
      if (r.error) { put(panel, empty("Tailscale's sign-in did not start. Reload this page to try again, or skip for now.", r.error)); return; }
      if (r.data.loginUrl) window.open(r.data.loginUrl, "_blank", "noopener");
      show(r.data);
      poll();
    };
    (async () => {
      const r = await attempt("onboard.tailscale", { action: "detect" });
      if (r.error) { put(panel, empty("Vyre could not look for Tailscale on this machine. Reload to try again, or skip for now.", r.error)); return; }
      show(r.data);
      if (r.data.state === "needs-login" && r.data.loginUrl) poll();
    })();
  },

  name(col, s) {
    // A device never reserves its own address, only a server does (the "live" step's Device
    // choice already routes around this screen via its own verify step; this is the safety net
    // for anything that lands here anyway — a reload mid-flow, say).
    if (state.live === "device") { mark_("name", "skipped").then(() => goto(STEPS.findIndex(x => x.id === "claude"))); return; }
    col.append(
      h("h1", { class: "h1" }, "Your address."),
      // ADR 0008 section 4: v0.1 defaults to a ts.net address (tailscale cert), not <you>.vyre.run;
      // "your own domain" is a collapsed, secondary choice, below.
      h("p", { class: "lead" }, "This is where your Deck lives. Vyre gets a certificate for an address on your own tailnet, and only your tailnet can open it."),
      h("p", { class: "small muted" }, "This can take about a minute: each line below shows how it is going."));
    const addr = h("div", { class: "address-big" }, h("span", { class: "faint" }, "Not reserved yet."));
    const list = h("ol", { class: "progress" });
    const note = h("div");
    col.append(h("div", { class: "ob-panel" }, addr, list, note));
    // Tailnet Lock comes after the HTTPS step, never before it.
    if (stepState("tailscale") === "done") col.append(lockCard());
    // A line break is allowed only after a dot, never inside a name (onboard.css .address-big).
    const drawAddr = (/** @type {string|null} */ address) => put(addr, address
      ? [h("i", null, "https://"), h("wbr"), address.replace(/^https?:\/\//, "").replace(/\/$/, "").split(".").map((p, j, all) => j < all.length - 1 ? [p + ".", h("wbr")] : p)]
      : h("span", { class: "faint" }, "Not reserved yet."));
    const LABELS = { reserve: "Reserve your address", dns: "Point it at this machine on your tailnet", cert: "Get the certificate" };
    /** @type {Record<string, number>} when each line started working */
    const since = {};
    const draw = (/** @type {any[]} */ steps) => put(list, ["reserve", "dns", "cert"].map(id => {
      const st = steps.find(x => x.id === id) || { state: "todo" };
      if (st.state === "doing") since[id] ||= Date.now();
      return progressRow(LABELS[id], st.state, st.note, since[id]);
    }));
    draw([]);
    if (stepState("tailscale") !== "done") put(note, h("p", { class: "notice" }, icon("lock", 14),
      "This needs this machine on your tailnet. If you skipped Tailscale, the address waits until it is connected."));
    // HTTPS certificates are off for the tailnet by default (ADR 0008 section 4): one admin
    // click fixes it, and it is worth a heads-up before reserving, not just after it fails.
    const blocked = (/** @type {any} */ d) => {
      if (!d || d.state !== "blocked" || d.code !== "https_off") return false;
      const url = d.adminUrl || ADMIN_DNS;
      put(note, h("div", { class: "ob-https" },
        h("h3", { class: "h3" }, HTTPS.title),
        h("p", { class: "small muted" }, HTTPS.what),
        h("ol", { class: "ob-lock-steps" },
          h("li", null, h("p", { class: "small" }, HTTPS.open), h("p", { class: "small" }, h("a", { class: "link", href: url, target: "_blank", rel: "noopener" }, url))),
          h("li", null, h("p", { class: "small" }, HTTPS.click)),
          h("li", null, h("p", { class: "small" }, HTTPS.back))),
        h("p", { class: "small muted" }, HTTPS.cost),
        h("p", { class: "notice" }, icon("lock", 14), HTTPS.never)));
      s.foot({ label: "Check again", run: () => reserve() },
        { secondary: h("a", { class: "btn", href: url, target: "_blank", rel: "noopener" }, HTTPS.button) });
      return true;
    };
    const done = (/** @type {any} */ r) => {
      draw(r.steps || []);
      drawAddr(r.address || null);
      if (r.url) {
        put(note, h("p", { class: "notice" }, "From here the loopback link stops working. The rest of the setup continues at your address."));
        s.foot({ label: `Switch to ${r.url.replace(/^https?:\/\//, "")}`, run: async () => {
          await mark_("name", "done");
          // onboard.passkey hands back a passkey link only when it is called with the loopback
          // session still good (box: caller onboard/cli/local, never a tailnet caller) — which
          // this is, one moment longer, and the https address after this redirect never will be:
          // the session lives in this origin's sessionStorage, and does not follow a page to a
          // new origin. It changes nothing else (unlike onboard.finish, which marks onboarding
          // finished and would end the loopback door before history/devices ever run), so the
          // passkey detour is asked for here, before leaving; onboard.finish still runs once, at
          // the real ending.
          const p = await attempt("onboard.passkey");
          const next = p.data?.passkeyUrl || r.url.replace(/\/$/, "") + "/onboard#history";
          location.href = next;
        } });
        return true;
      }
      if (blocked({ state: r.phase, why: r.why, code: r.code, adminUrl: r.adminUrl })) return true;
      if ((r.steps || []).some(x => x.state === "failed")) s.foot({ label: "Try again", run: () => reserve() });
      return false;
    };
    // A vyre.run name is public DNS: it is claimed only when the person typed it and pressed
    // Continue in step 1, or says yes here. Otherwise this asks, or uses the tailnet's own name.
    const ask = () => {
      const n = state.name && NAME_RE.test(state.name) ? state.name : null;
      put(note, h("p", { class: "notice" }, n
        ? [`Use ${n}.vyre.run? `, "It is a public name: anyone can look it up, though only your tailnet can open it."]
        : "You have not picked a name. Pick one in step 1, or use this machine's own tailnet name."));
      s.foot(n ? { label: `Use ${n}.vyre.run`, run: () => reserve(true) } : { label: "Use my tailnet name", run: () => reserve(false, "ts.net") },
        { secondary: h("span", null,
          h("button", { type: "button", class: "btn btn-ghost", onclick: () => goto(0) }, n ? "Change it" : "Pick a name"),
          n ? h("button", { type: "button", class: "btn btn-ghost", onclick: () => reserve(false, "ts.net") }, "Use my tailnet name") : null) });
    };
    const watch = () => every(async () => {
      const p = await attempt("onboard.name", { name: state.name, action: "status" });
      if (p.data && done(p.data)) for (const f of cleanup.splice(0)) f();
    }, 1500);
    const reserve = async (/** @type {boolean} */ confirm = false, action = "reserve") => {
      const st = await attempt("onboard.status");
      if (blocked(st.data?.detail?.name)) return;
      if (action === "reserve" && st.data?.detail?.name?.via === "vyre.run" && stepState("you") !== "done" && !confirm) return ask();
      put(note);
      s.foot({ label: "Reserving", disabled: true, run: () => {} });
      const r = await attempt("onboard.name", { ...(state.name ? { name: state.name } : {}), action, ...(confirm ? { confirm: true } : {}) });
      if (r.error) { put(note, empty("The address was not reserved. Press Try again.", r.error)); s.foot({ label: "Try again", run: () => reserve() }); return; }
      if (done(r.data)) return;
      watch();
    };
    s.foot({ label: "Get your address", run: () => reserve() });
    // Coming back to this step: read where the address is now, so one that already serves shows
    // as done (not "Not reserved yet"), and one still being set up keeps its progress lines.
    (async () => {
      const r = await attempt("onboard.name", { action: "status" });
      if (!r.data || !addr.isConnected) return;
      const rows = Array.isArray(r.data.steps) ? r.data.steps : [];
      if (r.data.url && here(r.data.url)) {
        // Already on this address: nothing to switch to.
        draw(rows);
        drawAddr(r.data.address || r.data.url);
        put(note);
        s.foot({ label: "Continue", run: s.next });
        return;
      }
      if (!r.data.url && !rows.some((/** @type {any} */ x) => x.state !== "todo")) return;
      if (!done(r.data) && rows.some((/** @type {any} */ x) => x.state === "doing")) watch();
    })();
    col.append(h("details", { class: "ob-collapse" }, h("summary", null, "Your own domain"),
      h("p", { class: "small muted" }, "Point a domain you already own at this server instead of a ts.net address: a Cloudflare API token scoped to one zone, and a hostname in it. Set this in the server's own configuration, then come back and reserve again.")));
  },

  // Import your sessions: discover, choose, watch Vyre Memory learn (docs/design/import.md,
  // memory-iq; docs/design/onboarding-v2.md step 4). Three phases in one step: discover (scan,
  // nothing leaves the device), choose (a plan, "keep in sync" unticked, a Fast/Gentle reading
  // pace with neither preselected), watch (live progress in three plain-language stages, and a
  // question box as soon as the first sessions are searchable). Every call degrades gracefully
  // (empty()'s missing-module message) if memory-iq's import.* tools are not running yet.
  // Shapes are core/import/index.js's real ones (memory-iq, work/memory-iq 959e8e2f), not a
  // guess: import.scan groups by source, each source's folders carry their own suggested/why;
  // import.plan's `folders` is the array of folder paths, not a count; import.status has no
  // "upload" stage and graph is a live count, not a done/total (docs/design/import.md).
  history(col, s) {
    col.append(
      h("h1", { class: "h1" }, "Your history."),
      h("p", { class: "lead" }, "Vyre finds the Claude Code sessions already on this machine, so you can search and ask about your own work as soon as it reads them."));
    const body = h("div", { class: "ob-panel" });
    col.append(body);
    attempt("onboard.history", { action: "start" });

    /** @typedef {{ cwd: string|null, sessions: number, bytes: number, from: number, to: number, project?: string, name?: string, suggested: boolean, why?: string }} Folder */
    /** @typedef {{ id: string, path: string, kind: string, sessions: number, bytes: number, from?: number, to?: number, folders: Folder[] }} Source */
    /** Folder cwds ticked for the plan (or the source path itself, for a folder with no cwd). Suggested folders start ticked, dev/Vyre/temp folders start unticked. */
    const picked = new Set();
    let pace = /** @type {"fast"|"gentle"|null} */ (null);
    let sync = false;
    const fmtBytes = n => n < 1e6 ? Math.round(n / 1e3) + " KB" : (n / 1e6).toFixed(1) + " MB";
    const key = (/** @type {Source} */ src, /** @type {Folder} */ f) => f.cwd || src.path;

    let claudeKeepsDays = 30;

    const drawDiscover = async () => {
      const r = await attempt("import.scan");
      if (r.error) {
        put(body, empty("Your history cannot be read yet. Continue, and it shows up here once Vyre can read it.", r.error));
        s.foot({ label: "Continue", run: s.next });
        return;
      }
      /** @type {Source[]} */
      const sources = r.data.sources || [];
      if (Number.isInteger(r.data.claude_keeps_days)) claudeKeepsDays = r.data.claude_keeps_days;
      const leftOut = r.data.left_out || {};
      const leftCount = (leftOut.vyre || 0) + (leftOut.excluded || 0);
      for (const src of sources) for (const f of src.folders) if (f.suggested) picked.add(key(src, f));
      const syncFoot = () => s.foot({ label: "Continue", disabled: !picked.size, run: () => drawChoose(sources) });
      put(body,
        h("p", { class: "lbl" }, "What Vyre found"),
        sources.length === 0 || sources.every(src => !src.folders.length)
          ? empty("No Claude Code sessions found on this machine yet. Start one with claude and come back.")
          : sources.filter(src => src.folders.length).map(src => h("div", { style: { marginBottom: "16px" } },
            h("p", { class: "small muted", style: { padding: "8px 0 0" } }, src.path),
            h("div", { class: "rows" }, src.folders.map(f => {
              const k = key(src, f);
              const box = h("input", { type: "checkbox", checked: picked.has(k), onchange: (/** @type {any} */ e) => {
                e.target.checked ? picked.add(k) : picked.delete(k); syncFoot(); } });
              return h("label", { class: "pick" }, box,
                h("span", { class: "x" },
                  h("span", { class: "ellipsis" }, f.name || f.cwd || "unknown folder"),
                  h("span", { class: "code ellipsis" }, `${plural(f.sessions, "session")} · ${fmtBytes(f.bytes)} · ${when(f.from)}–${when(f.to)}`
                    + (f.why ? ` · ${f.why}` : "")))); })))),
        leftCount ? h("p", { class: "small muted", style: { marginTop: "4px" } },
          `${plural(leftCount, "session")} from Vyre's own development and excluded folders never left the device and aren't listed.`) : null);
      syncFoot();
    };

    const drawChoose = async (/** @type {Source[]} */ sources) => {
      s.foot({ label: "Building your plan", disabled: true, run: () => {} });
      const r = await attempt("import.plan", { include: [...picked] });
      if (r.error) { put(body, empty("Could not build the plan. Try again.", r.error)); s.foot({ label: "Try again", run: () => drawChoose(sources) }); return; }
      const plan = r.data;
      const p = plan.pace || {};
      const syncBox = h("input", { type: "checkbox", checked: sync, onchange: (/** @type {any} */ e) => { sync = e.target.checked; } });
      const syncConfirm = () => s.foot({ label: "Import", disabled: !pace, run: () => start(plan.plan) });
      const opt = (value, title, desc) => h("label", { class: value === pace ? "on" : "" },
        h("input", { type: "radio", name: "pace", value, checked: value === pace, onchange: () => { pace = value; syncConfirm(); } }),
        h("span", { class: "t" }, h("b", null, title), h("span", null, desc)));
      put(body,
        h("div", { class: "meter" }, h("span", { class: "big" },
          `${plural(plan.sessions, "session")} · ${fmtBytes(plan.bytes)} · from ${plural(plan.folders.length, "folder")}, to your server`)),
        h("label", { class: "pick", style: { padding: "12px 0" } }, syncBox,
          h("span", { class: "x" }, h("span", null, "Keep them in sync"),
            h("span", { class: "code" }, "New sessions import automatically too, from now on."))),
        h("p", { class: "lbl", style: { marginTop: "12px" } }, "How fast"),
        h("div", { class: "choice", role: "radiogroup", "aria-label": "How fast Vyre reads" },
          // memory-iq's copy rule (the lead): plan terms, never dollars. Nothing is a charge;
          // memory reads on the person's own Claude plan.
          opt("fast", "Fast", p.fast ? `Understood in about ${plural(p.fast.hours, "hour")} (uses more of your Claude plan today).` : "Understood in a few hours (uses more of your Claude plan today)."),
          opt("gentle", "Gentle", p.gentle ? `Over about ${plural(p.gentle.days, "day")} (barely touches your plan).` : "Over a few days (barely touches your plan).")),
        h("p", { class: "small muted", style: { marginTop: "12px" } },
          `Claude Code keeps sessions for ${claudeKeepsDays} days, so import now while they last. Vyre never changes Claude Code's own settings.`));
      syncConfirm();
    };

    const start = async (/** @type {string} */ plan) => {
      s.foot({ label: "Starting", disabled: true, run: () => {} });
      const r = await attempt("import.start", { plan, mode: sync ? "sync" : "once", pace });
      if (r.error) {
        // memory-iq's error codes: not_found (the plan expired or was already used), busy, and
        // unavailable (no server to send to yet: the device still indexes its own local copy).
        const msg = r.error.code === "not_found" ? "That plan expired. Go back and choose again."
          : r.error.code === "busy" ? "An import is already running. Try again in a moment."
          : r.error.code === "unavailable" ? null // not an error: shows its own local-only note below
          : String(r.error.message);
        if (msg) { put(body, empty(msg, r.error)); s.foot({ label: "Try again", run: () => drawChoose(sources) }); return; }
      }
      drawWatch(r.error?.code === "unavailable");
    };

    const drawWatch = (/** @type {boolean} */ localOnly) => {
      const list = h("ul", { class: "progress" });
      const ask = h("div");
      put(body,
        h("p", { class: "lbl" }, "Reading your history"),
        localOnly ? h("p", { class: "small muted" }, "No server to send this to yet, so this device is indexing its own copy for now.") : null,
        list, ask);
      s.foot({ label: "Continue", run: s.next });
      let asked = false;
      const poll = async () => {
        const r = await attempt("import.status");
        if (r.error) return;
        const st = r.data;
        // Vyre Memory's own stages, in plain language (memory-iq): upload gets it to the server
        // (skipped when local-only); search makes it findable; meaning makes it understood
        // (personal facts keep reading in the background for days, so they never gate this
        // checkmark); graph keeps growing after, with no total to reach.
        const state = c => !c || !(c.total > 0) ? "todo" : c.done >= c.total ? "done" : "doing";
        const g = st.graph || {};
        const personalNote = st.personal && st.personal.total > st.personal.done
          ? `, still reading ${plural(st.personal.total - st.personal.done, "turn")} for personal facts` : "";
        const up = st.upload;
        const upNote = up?.quarantined ? `${plural(up.quarantined, "session")} set aside: they looked like they held a secret` : null;
        put(list,
          up ? progressRow("Sending to your server", up.state === "done" ? "done" : up.state === "stopped" ? "failed" : "doing", upNote, undefined) : null,
          progressRow("Searchable now", state(st.search), null, undefined),
          progressRow("Understood", state(st.meaning), personalNote || null, undefined),
          progressRow("The graph growing", g.sessions > 0 ? "doing" : "todo",
            g.sessions > 0 ? `${plural(g.people, "person")} · ${plural(g.orgs, "org")} · ${plural(g.facts, "fact")}` : null, undefined));
        if (!asked && (st.searchable_sessions || 0) > 0) { asked = true; drawAsk(ask); }
      };
      poll();
      every(poll, 5000);
    };

    // "a way to ask IQ right there", as soon as the first sessions are searchable. memory.ask, not
    // memory.answer: memory.answer knows only personal facts, and right after an import it could
    // not answer from the sessions just read, which is the whole point of this box (memory-iq).
    // No stream: true here, a plain request/reply is enough for onboarding.
    const drawAsk = (/** @type {HTMLElement} */ ask) => {
      const qIn = /** @type {HTMLInputElement} */ (h("input", { class: "input", placeholder: "Ask about your own history", "aria-label": "Ask Vyre Memory" }));
      const out = h("div", { class: "small muted", style: { marginTop: "8px" } });
      const go = async () => {
        const q = qIn.value.trim();
        if (!q) return;
        put(out, h("span", { class: "busy-inline faint" }, "Thinking…"));
        const r = await attempt("memory.ask", { question: q });
        if (r.error) { put(out, String(r.error.message)); return; }
        const d = r.data;
        if (d.limited) { put(out, d.message || "Vyre Memory has reached today's limit. Try again tomorrow."); return; }
        if (d.abstained) {
          put(out, "Not sure yet.", d.known ? h("span", null, " ", d.known) : null);
          return;
        }
        put(out, h("span", null, d.answer),
          d.sources?.length ? h("div", { class: "code", style: { marginTop: "4px" } },
            d.sources.map(src => src.name || src.session).join(", ")) : null);
      };
      qIn.addEventListener("keydown", e => { if (e.key === "Enter") go(); });
      put(ask, h("p", { class: "lbl", style: { marginTop: "16px" } }, "Ask it something"),
        h("div", { class: "bar-top" }, qIn, h("button", { type: "button", class: "btn", onclick: go }, "Ask")),
        out);
    };

    drawDiscover();
  },

  // Stub (docs/design/onboarding-v2.md step 5, lead 29 Sep): vault owns the engine and hasn't
  // sent tool shapes yet. This slot exists so the step count, the celebration and the summary
  // are right once it's real; the board (VaultImport.dc.html, work/app-design 19a96abd) already
  // shows the masked/grouped list, the Touch ID moment and the per-key animate-in this becomes.
  // Google/email/MCP (docs/design/onboarding-v2.md step 6): connectors/vault own the engine,
  // spec not sent yet, so those stay a "coming soon" note; Settings > Connections works today
  // outside onboarding. GitHub (ADR 0041, github.connect/.accounts/.connect.cancel) is real and
  // built here: a card with its own state (connect, waiting on the device code, connected),
  // matching Settings' own GitHub card (the app's Connections) but simpler, since onboarding
  // has no vault-item picker to skip. Optional: Continue or Skip both move on regardless of
  // whether an account is connected.
  accounts(col, s) {
    col.append(
      h("h1", { class: "h1" }, "Connect accounts."),
      h("p", { class: "lead" }, "GitHub now; Google, email and MCP servers connect from Settings for now. Connect once, and every agent can use it with your permission."));
    const ghBox = h("div", { class: "ob-panel" });
    col.append(ghBox);
    col.append(h("p", { class: "small muted" }, "Google, email and other services connect from Settings, Connections, whenever you want them."));
    s.foot({ label: "Continue", run: s.next });

    /** @typedef {{ id: string, user_code: string, verification_uri: string, verification_uri_complete?: string, minutes: number, over: boolean }} GhFlow */
    /** @type {GhFlow | null} */ let flow = null;
    /** @type {{ name: string, login: string }[]} */ let accounts = [];
    let starting = false;

    // Only https://github.com/... ever becomes a link's href (reviewer's LOW: verification_uri
    // is GitHub's own reply, passed through unchecked otherwise); the plain device page always
    // works with the code shown beside it.
    const safeGithubUrl = (/** @type {string | undefined} */ u) => (/^https:\/\/github\.com\//.test(String(u || "")) ? /** @type {string} */ (u) : "https://github.com/login/device");

    const draw = () => {
      if (flow) { put(ghBox, waiting()); return; }
      put(ghBox, h("div", { class: "lbl" }, "GitHub"),
        accounts.length
          ? h("div", { class: "dev-ok" }, icon("check", 14), h("span", null, "Connected: ", h("b", null, accounts.map(a => a.login || a.name).join(", "))))
          : [h("p", { class: "small muted" }, "Clone your repos and give an agent its own worktree and branch, one per session."),
            h("button", { type: "button", class: "btn btn-sm", disabled: starting, onclick: start }, starting ? "Starting…" : "Connect GitHub")]);
    };

    /** The open device-code sign-in: the code, an Open GitHub link, how long it lasts, Cancel. */
    const waiting = () => {
      const f = /** @type {GhFlow} */ (flow);
      return h("div", null,
        h("div", { class: "lbl" }, "GitHub"),
        h("p", { class: "small muted" }, "Enter this code at github.com/login/device:"),
        command(f.user_code),
        h("p", { style: { marginTop: "10px" } },
          h("a", { class: "btn btn-sm", href: safeGithubUrl(f.verification_uri_complete || f.verification_uri), target: "_blank", rel: "noopener noreferrer" }, "Open GitHub")),
        h("p", { class: "small muted" }, `Good for about ${plural(f.minutes, "minute")}.`),
        h("button", { type: "button", class: "btn btn-ghost btn-sm", style: { marginTop: "6px" }, onclick: cancel }, "Cancel"));
    };

    async function start() {
      // A guard against a double tap: the button disables at once, before the await, and its
      // busy label replaces the click handler until this call settles one way or the other.
      if (starting || flow) return;
      starting = true;
      draw();
      const r = await attempt("github.connect", { name: "github" });
      starting = false;
      // The step was left while this was in flight. A successful connect still opened a real
      // sign-in at GitHub; cancel it the same way leaving the step does once it's already shown
      // (cleanup.push(cancel) below), rather than leaving it to poll until it expires on its own
      // (reviewer's nit on c3c830eb).
      if (!alive()) { if (r.data?.id) attempt("github.connect.cancel", { id: r.data.id }); return; }
      const d = r.data || {};
      if (r.error || !d.id || !d.user_code || !d.verification_uri) {
        put(ghBox, h("div", { class: "lbl" }, "GitHub"), h("p", { class: "small muted" }, r.error ? (r.error.message || "Could not start GitHub sign-in.") : "GitHub did not return a code. Try again."));
        return;
      }
      flow = { id: d.id, user_code: d.user_code, verification_uri: d.verification_uri, verification_uri_complete: d.verification_uri_complete,
        minutes: Math.max(1, Math.round((d.expires_in || 900) / 60)), over: false };
      draw();
    }
    function cancel() {
      if (!flow || flow.over) return;
      flow.over = true;
      attempt("github.connect.cancel", { id: flow.id });
      flow = null;
      draw();
    }
    // No timer: GitHub's own expiry ends an unfinished sign-in with github.connect-failed. But
    // leaving this step (Back, Skip, Continue, or another onboarding step entirely) cancels an
    // open sign-in rather than letting the server keep polling for a code the person can no
    // longer see or finish (reviewer's LOW).
    cleanup.push(cancel);
    cleanup.push(on("github.connected", e => {
      if (!flow || flow.over || e.payload?.id !== flow.id) return;
      flow.over = true;
      flow = null;
      load();
    }));
    cleanup.push(on("github.connect-failed", e => {
      if (!flow || flow.over || e.payload?.id !== flow.id) return;
      flow.over = true;
      flow = null;
      put(ghBox, h("div", { class: "lbl" }, "GitHub"), h("p", { class: "small muted" }, e.payload?.error || "The sign-in ended without an account."));
    }));

    async function load() {
      const r = await attempt("github.accounts", {}, { ifPresent: true });
      if (!alive()) return;
      accounts = Array.isArray(r.data) ? r.data : [];
      draw();
    }
    /** True while this step's own render is still the one on screen (render() clears `cleanup`
     * and rebuilds `col` on every navigation, so a stale async reply from a step already left
     * must not touch a `ghBox`/`flow` that belong to whatever screen replaced it). */
    const alive = () => col.isConnected;
    load();
  },

  // Full build (lead, 29 Sep): Off / Browser only / Browser + desktops. Glass owns the backend
  // (docs/design/agent-browsers.md, coming) and the actual server-size numbers; this step's own
  // choice is kept locally only until a real tool exists to save it to, same degrade-gracefully
  // shape as every other step here.
  devices(col, s) {
    // A card a device (ADR 0008 section 6, reworked). The Mac installs Vyre with two commands and
    // is approved right here, with pairRequests; the phone gets Tailscale, then this address, then
    // the home screen. What Tailscale says about the owner's phones and tablets comes from
    // onboard.status (detail.devices.peers), refreshed on onboard.stepped, when the page is shown
    // again, and at most once a minute while this step is open and visible.
    const d = state.status?.detail?.devices || {};
    const owner = state.status?.detail?.tailscale?.owner || null;
    // Never a QR to 127.0.0.1: before the address serves, the phone has nowhere to go yet.
    const addr = d.phoneUrl || state.status?.address || (LOOPBACK.test(location.hostname) ? null : location.origin);
    const phoneUrl = addr ? addr.replace(/\/$/, "") + "/now" : null;
    const tsUrl = "https://tailscale.com/download";
    col.classList.add("wide");
    col.append(
      h("h1", { class: "h1" }, "Your devices."),
      h("p", { class: "lead" }, "Pair your Mac and open Vyre on your phone. Both reach this server over your tailnet, and nothing else can. One more step after this."));

    // Mac: install, `vyre up`, then approve the request it makes, in this card.
    const macState = h("div", { class: "dev-state", "aria-live": "polite" });
    const pairs = pairRequests({ onPaired: r => paired(r.name) });
    cleanup.push(pairs.stop);
    let macName = d.mac?.connected ? (d.mac.name || "your Mac") : null;
    const drawMac = () => put(macState, macName
      ? [h("div", { class: "dev-ok" }, icon("check", 14), h("span", null, "Mac paired: ", h("b", null, macName))),
        h("p", { class: "small muted" }, "Press ⌥Space to open Lumen.")]
      : h("div", { class: "dev-wait" }, h("span", { class: "busy", "aria-hidden": "true" }), "Waiting for your Mac"));
    const paired = (/** @type {string} */ name) => {
      if (macName) return;
      macName = name || "your Mac";
      if (state.status?.detail?.devices) state.status.detail.devices.mac = { connected: true, name: macName };
      pairs.stop();
      pairs.el.remove();
      drawMac();
    };
    const macCard = h("section", { class: "dev-card", id: "dev-mac", tabindex: "-1", "aria-labelledby": "dev-mac-h" },
      h("div", { class: "lbl" }, "Mac"),
      h("h2", { class: "h3", id: "dev-mac-h" }, "Pair this Mac"),
      h("ol", { class: "dev-steps" },
        devStep("1", "Install Vyre", command("npm i -g https://vyre.run/box/vyre.tgz")),
        devStep("2", "Pair it with this server", command("vyre up"),
          h("p", { class: "small muted" }, "It finds this server on your tailnet and shows a code. Type that code here to approve the Mac."))),
      macName ? null : pairs.el,
      macState);
    if (macName) pairs.stop();
    drawMac();

    // Phone: Tailscale, this address, the home screen.
    const net = h("div", { class: "dev-net", "aria-live": "polite" });
    const tsN = h("span", { class: "n" }, "1");
    const phoneCard = h("section", { class: "dev-card", "aria-labelledby": "dev-phone-h" },
      h("div", { class: "lbl" }, "Phone"),
      h("h2", { class: "h3", id: "dev-phone-h" }, "Open Vyre on your phone"),
      net,
      h("ol", { class: "dev-steps" },
        devStep(tsN, "Install Tailscale",
          h("div", { class: "qr", role: "img", "aria-label": "QR code for the Tailscale app" }, qr(tsUrl)),
          h("div", { class: "code" }, tsUrl.replace(/^https?:\/\//, "")),
          h("p", { class: "small muted" }, owner ? `Sign in as ${owner}.` : "Sign in with the same account as this setup.")),
        devStep("2", phoneUrl ? ["Open ", h("span", { class: "dev-addr" }, phoneUrl.replace(/^https?:\/\//, ""))] : "Open your address",
          phoneUrl
            ? h("div", { class: "qr", role: "img", "aria-label": "QR code for " + phoneUrl }, qr(phoneUrl))
            : h("div", { class: "qr-later" }, "After Tailscale and your address")),
        devStep("3", "Add to Home Screen", h("p", { class: "small muted" }, "Share, then Add to Home Screen. It opens like an app."))));

    const drawNet = () => {
      const peers = (state.status?.detail?.devices?.peers || []).filter((/** @type {any} */ p) => handheld(p.os));
      put(net, peers.map((/** @type {any} */ p) => p.online
        ? h("div", { class: "dev-ok" }, icon("check", 14), h("span", null, "Already on your tailnet: ", h("b", null, p.name)))
        : h("div", { class: "dev-off" }, icon("phone", 14), h("span", null,
          `Your ${handheld(p.os, p.name)} is offline in Tailscale. Open the Tailscale app and turn it on, then scan.`,
          h("span", { class: "code" }, p.name)))));
      put(tsN, peers.some((/** @type {any} */ p) => p.online) ? icon("check", 12) : "1");
    };
    drawNet();

    // "Wink" (the user's decision, 28 Sep, ADR 0043): a live Vyre code ring the person's phone
    // scans to connect, instead of the Tailscale-QR path above (superseded by it once relay is
    // allowed — this card is the primary phone path, not an alternative to it). PIVOT, same day:
    // Tailscale itself stays, but only as the relay's own auto-managed transport and an optional
    // later "Faster connection" upgrade (Settings > Devices, not built here yet) — the phone
    // path here never asks the person to touch Tailscale at all, pivot or not.
    // Same gate as "Pair with a code" (web/js/join-caps.js) — hidden on a Mac until vyre-core.
    // relay.pair.ticket is built (tailnet, work/tailnet 2990a810, sent to their reviewer, "safe
    // to build against"): mint {} -> {ticket, expiresAt, connected}, HUMAN_ONLY (Touch ID at the
    // mint, matching relay.pair.start), single-use, refuses on darwin same as relay.join. Not
    // merged to main yet, so `attempt` answers from web/fixtures/relay.json's fallback until it
    // is — same "missing tool" pattern every other real-but-unmerged tool in this file uses.
    // relay.paired {device, name, fingerprint} fires the instant a ticket pairing completes: no
    // separate pending/confirm step, so this reacts to the event directly rather than polling,
    // and never shows a "Pair <phone>?" screen of its own (Touch ID already happened, at the
    // mint). The card itself (minting only on an explicit tap, blanking on hidden/blur/expiry/
    // redemption, the raw ticket never touching the DOM as text or persisting anywhere) is
    // web/js/wink-card.js, shared with Settings > Devices — see reviewer's pre-review points
    // there.
    const relay = canRelayJoin(state.status);
    const phoneCodeCard = relay.allowed ? buildWinkCard({
      attempt,
      subscribe: (event, fn) => cleanup.push(on(event, fn)),
      every,
      cleanup: fn => cleanup.push(fn),
      calm,
      onNext: s.next,
    }) : null;
    col.append(h("div", { class: "ob-panel" }, h("div", { class: "dev-grid" }, macCard, phoneCard, phoneCodeCard)));

    let asking = false;
    const refresh = async () => {
      if (asking || document.visibilityState !== "visible") return;
      asking = true;
      const r = await attempt("onboard.status");
      asking = false;
      if (!r.data) return;
      state.status = r.data;
      const m = r.data.detail?.devices?.mac;
      if (m?.connected) paired(m.name);
      drawNet();
    };
    cleanup.push(on("onboard.stepped", refresh));
    cleanup.push(on("link.paired", e => paired(e.payload?.name)));
    const shown = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", shown);
    cleanup.push(() => document.removeEventListener("visibilitychange", shown));
    every(refresh, 60_000);
    refresh();

    if (toMac) {
      toMac = false;
      later(() => { macCard.scrollIntoView({ block: "start" }); macCard.focus({ preventScroll: true }); }, 0);
    }
    // No longer the mandatory final step (Lumen tour is, now): normal Continue and Skip.
    s.foot({ label: "Continue", run: s.next });
  },

  // Lumen tour (docs/design/onboarding-v2.md step 10), split out of "devices" so the
  // mandatory, non-skippable final screen is this one, not Mac/phone pairing. capsule-pro owns
  // the real, signed-in tour; this reuses the landing page's copy and hotkey
  // (site/index.html, team/archive/work-journals/launch-surfaces.md) as a starting shape.
  capsule(col, s) {
    col.append(
      h("h1", { class: "h1" }, "A tour of Lumen."),
      h("p", { class: "lead" }, "Press ⌥Space over any app, a call or a doc, on your Mac, and Lumen opens. Say what you need. It's gone when you're done."));
    col.append(h("div", { class: "ob-panel" },
      h("p", { class: "small muted" }, "Try it now if your Mac is already paired: press ⌥Space anywhere. Not paired yet? Pair it from the devices step, or open the Deck and pair it any time.")));
    s.foot({ label: "Open Vyre", run: s.next }, { skip: false });
  },
};

/** @param {HTMLElement} [col] where to say so if there is nowhere to go */
async function finish(col) {
  const r = await attempt("onboard.finish");
  if (!r.data?.url) {
    // No address yet: loopback (before an owner exists) serves only /onboard, never /now, so
    // there is nothing to fall back to. Say so instead of sending the user to a dead link.
    col?.append(h("p", { class: "notice" }, r.error ? String(r.error.message) :
      "Your address is not set up yet, so this page cannot open the Deck. Finish the address step, then come back here."));
    return;
  }
  showEnding(r.data);
}

/**
 * The one ending screen, the same everywhere (ADR 0008 section 6): the assistant's greeting
 * streaming at the top, three ticks (Mac, phone, history), one button, "Open Vyre".
 * @param {{ url: string, thread?: string|null, passkeyUrl?: string|null, assistant?: { name: string|null, display?: string|null, why?: string } | null }} d
 */
function showEnding(d) {
  for (const f of cleanup) f();
  cleanup = [];
  const greet = h("p", { class: "lead", "aria-live": "polite" }, h("span", { class: "busy-inline faint" }, "Saying hello…"));
  const ticks = h("ol", { class: "progress" });
  const home = d.url.replace(/\/$/, "");
  const mac = !!state.status?.detail?.devices?.mac?.connected;
  const rows = [
    { id: "mac", label: "Your Mac", done: mac,
      note: mac ? "Press ⌥Space on your Mac to open Lumen." : "Pair it any time: run vyre up on the Mac." },
    { id: "phone", label: "Your phone", done: stepState("devices") !== "todo",
      note: `Open ${home.replace(/^https?:\/\//, "")}/now on your phone, then Add to Home Screen.` },
    { id: "history", label: "Your history", done: stepState("history") !== "todo",
      note: stepState("history") !== "todo" ? "Every session is searchable in the Deck." : "Vyre keeps reading your sessions in the background." },
  ];
  put(ticks, rows.map(t => progressRow(t.label, t.done ? "done" : "todo", t.note)));
  // The passkey detour already happened earlier, at the address step (onboard.finish only hands
  // back passkeyUrl to the loopback session, which is gone by now); this is a defensive fallback,
  // not the usual path.
  const open = d.passkeyUrl || (home + "/now");
  const who = state.name ? `, ${state.name}` : "";
  const title = h("h1", { class: "h1", tabindex: "-1" }, `You're all set${who}. Let's get to work.`);
  const assistant = d.assistant?.name ? (d.assistant.display || state.assistant || d.assistant.name) : null;
  put(root, h("div", { class: "ob-end" },
    h("span", { class: "brand", "aria-label": "vyre" }, endMark(assistant), wordmark(26)),
    h("div", { class: "lbl" }, "Vyre is ready"),
    title,
    greet,
    h("div", { class: "ob-panel" }, h("div", { class: "lbl" }, "What's next"), ticks),
    h("a", { class: "btn btn-primary ob-end-open", href: open }, d.passkeyUrl ? "Add a passkey" : "Open Vyre"),
    d.passkeyUrl ? h("p", { class: "small faint", style: { marginTop: "10px" } }, h("a", { class: "link", href: home + "/now" }, "Skip for now")) : null));
  // The button the person pressed is gone: focus goes to the heading, and the live region says it.
  title.focus({ preventScroll: true });
  say(`You're all set${who}. Vyre is ready.`);
  // onboard.finish makes the assistant only with a Claude sign-in: assistant is null without one,
  // and { name: null, why } when making it failed. Say so rather than greet someone who is not there.
  if (!d.assistant?.name) {
    put(greet, d.assistant?.why
      ? `Your assistant was not made: ${String(d.assistant.why).replace(/\.$/, "")}. Create it on Now.`
      : "Your assistant is not made yet: sign in to Claude Code, then Create your assistant on Now.");
    return;
  }
  if (!d.thread) { put(greet, `${d.assistant.display || state.assistant || d.assistant.name} is ready when you are.`); return; }
  let text = "";
  const draw = () => put(greet, text || h("span", { class: "busy-inline faint" }, "Saying hello…"));
  cleanup.push(on("thread.text", e => {
    if (e.thread !== d.thread) return;
    const p = e.payload || {};
    if (typeof p.text === "string") text = p.text; else if (typeof p.delta === "string") text += p.delta;
    draw();
  }));
}

/**
 * The ending's mark: a short burst of signal dots leaves the mark's dot, once, under 1.5 s. Held
 * (hover or focus) for two seconds, a tiny line says the assistant is already listening. Both are
 * off under prefers-reduced-motion, and the line only shows when there is an assistant to name.
 * @param {string|null} assistant
 */
function endMark(assistant) {
  const wrap = h("span", { class: "ob-mark" }, mark(24));
  if (calm()) return wrap;
  const burst = h("span", { class: "ob-burst", "aria-hidden": "true" });
  const N = 14;
  for (let k = 0; k < N; k++) {
    const a = (k / N) * Math.PI * 2 + (k % 2 ? 0.2 : 0);
    const r = 26 + (k % 3) * 10;
    burst.append(h("i", { style: `--dx:${Math.round(Math.cos(a) * r)}px;--dy:${Math.round(Math.sin(a) * r)}px;--delay:${(k % 4) * 40}ms;--size:${3 + (k % 3)}px` }));
  }
  wrap.append(burst);
  later(() => burst.remove(), 1400);
  if (!assistant) return wrap;
  const egg = h("span", { class: "ob-egg", role: "status" });
  let t = 0;
  const hold = () => { clearTimeout(t); t = window.setTimeout(() => { egg.textContent = `${assistant} is already taking notes.`; egg.classList.add("on"); }, 2000); };
  const drop = () => { clearTimeout(t); egg.classList.remove("on"); };
  wrap.setAttribute("tabindex", "0");
  wrap.setAttribute("aria-label", "vyre mark");
  wrap.addEventListener("mouseenter", hold);
  wrap.addEventListener("focus", hold);
  wrap.addEventListener("mouseleave", drop);
  wrap.addEventListener("blur", drop);
  cleanup.push(() => clearTimeout(t));
  wrap.append(egg);
  return wrap;
}

/** A QR code as SVG squares, drawn from the vendored encoder's module grid. */
function qr(text) {
  const q = qrcode(0, "M");
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${n} ${n}`);
  svg.setAttribute("shape-rendering", "crispEdges");
  const path = document.createElementNS(NS, "path");
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
  path.setAttribute("d", d);
  path.setAttribute("fill", "#0E0D0C");
  svg.append(path);
  return svg;
}

boot();
