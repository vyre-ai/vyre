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

// Steps beyond the original six are client-side stubs for now (onboarding-v2.md): stepState()
// defaults an unknown id to "todo" and mark_() only tries the server for a real onboard.<id>
// tool, so a step with no server-side counterpart yet still marks, skips and counts correctly.
const STEPS = [
  { id: "you", title: "You" },
  { id: "claude", title: "Claude Code" },
  { id: "tailscale", title: "Tailscale" },
  { id: "name", title: "Your address" },
  { id: "history", title: "Your history" },
  { id: "secrets", title: "Your secrets" },
  { id: "computers", title: "Agent computers" },
  { id: "drive", title: "Vyre Drive" },
  { id: "devices", title: "Your devices" },
];

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
  if (s === "skipped") await attempt("onboard.skip", { step: id });
}

function render() {
  for (const f of cleanup) f();
  cleanup = [];
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
      h("span", { class: j === i ? "now" : stepState(s.id) !== "todo" ? "done" : "" }))),
    h("div", { class: "ob-body" },
      h("nav", { class: "ob-steps", "aria-label": "Setup steps" },
        h("div", { class: "lbl" }, "Setup"),
        h("ol", null, STEPS.map((s, j) => {
          const st = stepState(s.id);
          return h("li", null, h("a", { class: "ob-step" + (st === "done" ? " done" : ""), href: "#" + s.id, "aria-current": j === i ? "step" : false },
            h("span", { class: "n" }, st === "done" ? icon("check", 12) : String(j + 1)),
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
  if (state.statusError?.missing && i !== 4) {
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
      "aria-describedby": "name-status", placeholder: "alex" });
    status.id = "name-status";
    const asst = h("input", { class: "input", id: "assistant", value: state.assistant, autocomplete: "off", placeholder: "juno" });
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
    col.append(panel);
    s.foot(null);

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
      if (signed) { s.foot({ label: "Continue", run: s.next }); drawPolicy(); }
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

  // Import your sessions: discover, choose, watch Vyre IQ learn (docs/design/import.md,
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
          opt("fast", "Fast", p.fast ? `Done in about ${plural(p.fast.hours, "hour")}. Uses more of today's Claude usage.` : "Done in a few hours. Uses more of today's Claude usage."),
          opt("gentle", "Gentle", p.gentle ? `Spread over about ${plural(p.gentle.days, "day")}.` : "Spread over a few days.")),
        h("p", { class: "small muted", style: { marginTop: "12px" } },
          `Claude Code keeps sessions for ${claudeKeepsDays} days, so import now while they last. Vyre never changes Claude Code's own settings.`));
      syncConfirm();
    };

    const start = async (/** @type {string} */ plan) => {
      s.foot({ label: "Starting", disabled: true, run: () => {} });
      const r = await attempt("import.start", { plan, mode: sync ? "sync" : "once", pace });
      if (r.error) { put(body, empty("Could not start the import. Try again.", r.error)); s.foot({ label: "Try again", run: () => start(plan) }); return; }
      drawWatch();
    };

    const drawWatch = () => {
      const list = h("ul", { class: "progress" });
      const ask = h("div");
      put(body, h("p", { class: "lbl" }, "Reading your history"), list, ask);
      s.foot({ label: "Continue", run: s.next });
      let asked = false;
      const poll = async () => {
        const r = await attempt("import.status");
        if (r.error) return;
        const st = r.data;
        // Vyre IQ's own stages, in plain language (memory-iq): search makes a session findable;
        // meaning makes it understood (personal facts keep reading in the background for days,
        // so they never gate this checkmark); graph keeps growing after, with no total to reach.
        const state = c => !c || !(c.total > 0) ? "todo" : c.done >= c.total ? "done" : "doing";
        const g = st.graph || {};
        const personalNote = st.personal && st.personal.total > st.personal.done
          ? `, still reading ${plural(st.personal.total - st.personal.done, "turn")} for personal facts` : "";
        put(list,
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
      const qIn = /** @type {HTMLInputElement} */ (h("input", { class: "input", placeholder: "Ask about your own history", "aria-label": "Ask Vyre IQ" }));
      const out = h("div", { class: "small muted", style: { marginTop: "8px" } });
      const go = async () => {
        const q = qIn.value.trim();
        if (!q) return;
        put(out, h("span", { class: "busy-inline faint" }, "Thinking…"));
        const r = await attempt("memory.ask", { question: q });
        if (r.error) { put(out, String(r.error.message)); return; }
        const d = r.data;
        if (d.limited) { put(out, d.message || "Vyre IQ has reached today's limit. Try again tomorrow."); return; }
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
  secrets(col, s) {
    col.append(
      h("h1", { class: "h1" }, "Your secrets."),
      h("p", { class: "lead" }, "Vyre finds the keys already on this machine, from .env files, shell exports, your password manager, Chrome and SSH, shows them to you masked and grouped by project, and brings them into the vault with one Touch ID."));
    col.append(h("div", { class: "need" },
      h("div", { class: "lbl" }, "Coming soon"),
      "This step isn't built yet. Skip it for now, and bring your keys into the vault later from Settings."));
    s.foot({ label: "Continue", run: s.next });
  },

  // Full build (lead, 29 Sep): Off / Browser only / Browser + desktops. Glass owns the backend
  // (docs/design/agent-browsers.md, coming) and the actual server-size numbers; this step's own
  // choice is kept locally only until a real tool exists to save it to, same degrade-gracefully
  // shape as every other step here.
  computers(col, s) {
    col.append(
      h("h1", { class: "h1" }, "Agent computers."),
      h("p", { class: "lead" }, "Each agent can work from its own computer, the way a coworker would: a browser to look things up in, or a whole desktop to work on. More capable, and more for your server to run."));
    const body = h("div", { class: "ob-panel" });
    col.append(body);
    let choice = /** @type {"off"|"browser"|"desktop"|null} */ (null);
    const syncFoot = () => s.foot({ label: "Continue", disabled: !choice, run: s.next });
    const opt = (value, title, desc, size) => h("label", { class: value === choice ? "on" : "" },
      h("input", { type: "radio", name: "computers", value, checked: value === choice, onchange: () => { choice = value; put(body, choiceEl()); syncFoot(); } }),
      h("span", { class: "t" }, h("b", null, title), h("span", null, desc), h("span", { class: "code" }, size)));
    const choiceEl = () => h("div", { class: "choice", role: "radiogroup", "aria-label": "Agent computers" },
      opt("off", "Off", "Agents work from the terminal only, no browser or desktop of their own.", "Nothing extra to run."),
      opt("browser", "Browser only", "Each agent gets a Chrome it can look things up and click through in, that you can watch live.", "Size: still measuring."),
      opt("desktop", "Browser + desktops", "Each agent gets a full desktop too, for anything a browser alone can't do.", "Size: still measuring, more than browser only."));
    put(body, choiceEl());
    syncFoot();
  },

  // Stub (lead, 29 Sep): federation is drafting the options (what to sync, how, where it shows
  // up, agent access per folder, conflicts) with the user; nothing to choose yet.
  drive(col, s) {
    col.append(
      h("h1", { class: "h1" }, "Vyre Drive."),
      h("p", { class: "lead" }, "Your files, synced to every device: drag one in on your Mac, and watch it show up on your phone."));
    col.append(h("div", { class: "need" },
      h("div", { class: "lbl" }, "Coming soon"),
      "This step isn't built yet. Skip it for now."));
    s.foot({ label: "Continue", run: s.next });
  },

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
      h("p", { class: "lead" }, "Pair your Mac and open Vyre on your phone. Both reach this server over your tailnet, and nothing else can. Last step, nearly there."));

    // Mac: install, `vyre up`, then approve the request it makes, in this card.
    const macState = h("div", { class: "dev-state", "aria-live": "polite" });
    const pairs = pairRequests({ onPaired: r => paired(r.name) });
    cleanup.push(pairs.stop);
    let macName = d.mac?.connected ? (d.mac.name || "your Mac") : null;
    const drawMac = () => put(macState, macName
      ? [h("div", { class: "dev-ok" }, icon("check", 14), h("span", null, "Mac paired: ", h("b", null, macName))),
        h("p", { class: "small muted" }, "Press ⌥Space to open the Capsule.")]
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

    col.append(h("div", { class: "ob-panel" }, h("div", { class: "dev-grid" }, macCard, phoneCard)));

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
      note: mac ? "Press ⌥Space on your Mac to open the Capsule." : "Pair it any time: run vyre up on the Mac." },
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
