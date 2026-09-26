// @ts-check
// The onboarding (spec section 1): six steps, one a screen, each skippable. The box workstream
// owns the onboard.* tools; this file owns the screens. History uses Recall and Projects, which
// are already on main. Board: docs/design/boards/Onboard.dc.html.

import { h, put, empty } from "../js/dom.js";
import { call, attempt, on, setHeader } from "../js/api.js";
import { icon, mark, wordmark } from "../js/icons.js";
import { base, when, plural } from "../js/fmt.js";
import qrcode from "../vendor/qrcode.js";

const STEPS = [
  { id: "you", title: "You" },
  { id: "claude", title: "Claude Code" },
  { id: "tailscale", title: "Tailscale" },
  { id: "name", title: "Your address" },
  { id: "history", title: "Your history" },
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
        h("div", { class: "foot" }, "Every step can be finished later from Settings, or with a vyre command.")),
      h("main", { class: "ob-main" }, col)));

  col.append(h("div", { class: "lbl" }, `Step ${i + 1} of ${STEPS.length} · ${step.title}`));
  if (state.statusError?.missing && i !== 4) {
    col.append(h("div", { class: "need", style: { marginBottom: "24px" } },
      h("div", { class: "lbl beacon" }, "Setup is not running"),
      "The box module is not running on this machine, so this step cannot finish here. Run ", h("code", null, "vyre up"),
      " again, or skip to the steps that work."));
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

/** One row of a live checklist. state: todo | doing | done | failed */
function progressRow(label, st, note) {
  const glyph = st === "done" ? icon("check", 14) : st === "doing" ? h("span", { class: "busy" }) : h("span", { class: "ring" });
  return h("li", { class: st },
    h("span", { class: "st" }, glyph),
    h("span", { class: "x" }, h("span", null, label), note ? h("span", null, note) : null),
    st === "failed" ? h("span", { class: "state" }, "failed") : st === "doing" ? h("span", { class: "state" }, "working") : null);
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
      h("p", { class: "lead" }, "Just your name and your assistant's. Only your own devices will be able to reach it."));
    const status = h("div", { class: "check-line", "aria-live": "polite" });
    const nameIn = h("input", { id: "name", value: state.name, autocomplete: "off", spellcheck: "false", autocapitalize: "none",
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
      if (r.error?.missing) { ok = true; put(status, h("span", { class: "faint" }, "Availability is checked when the box module runs.")); }
      else if (r.error) put(status, String(r.error.message));
      else if (r.data.available) { ok = true; put(status, icon("check", 14), "Available."); }
      else put(status, `That name is not free${r.data.why ? ": " + r.data.why : "."} Try another.`);
      sync();
    };
    let t = 0;
    nameIn.addEventListener("input", () => { clearTimeout(t); t = window.setTimeout(check, 300); });
    col.append(h("div", { class: "ob-panel" },
      h("div", { class: "field" }, h("label", { for: "name" }, "Your name"), nameIn, status),
      h("div", { class: "field" }, h("label", { for: "assistant" }, "Your assistant's name"), asst,
        h("span", { class: "hint" }, "The assistant can see every project and drive any session. You can rename it, and change its voice and instructions, later."))));
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
      h("h1", { class: "h1" }, "Connect Claude Code."),
      h("p", { class: "lead" }, "Vyre runs your sessions and agents on your own Claude subscription or an API key. Nothing is typed into a terminal."));
    const panel = h("div", { class: "ob-panel" }, h("div", { class: "found" }, h("span", { class: "faint" }, "Looking for claude on this machine")));
    col.append(panel);
    s.foot(null);
    (async () => {
      const d = await attempt("onboard.claude", { mode: "detect" });
      if (d.error) { put(panel, empty("Could not look for Claude Code here.", d.error)); s.foot(null); return; }
      const info = d.data;
      if (!info.installed) {
        put(panel,
          h("div", { class: "found" }, icon("terminal"), h("span", { class: "what" }, "Claude Code is not installed on this machine.")),
          h("div", { class: "field" }, h("label", null, "Install it, then check again"), command(info.install || "npm install -g @anthropic-ai/claude-code")));
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
          const p = await attempt("onboard.claude", { mode: "setup-token", code });
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
      h("p", { class: "lead" }, "Tailscale makes your Vyre reachable from your phone and laptop, and from nothing else. You sign in with Tailscale's own page; Vyre never sees your password."),
      h("p", { class: "small muted", style: { marginTop: "8px" } }, "No Tailscale account? Sign in with Google, GitHub, Apple or Microsoft; that makes one, free for personal use. Use the same account as your Mac."));
    const panel = h("div", { class: "ob-panel" }, h("div", { class: "found" }, h("span", { class: "faint" }, "Looking for Tailscale")));
    col.append(panel);
    s.foot(null);
    const show = (/** @type {any} */ t) => {
      if (!t.installed) {
        put(panel,
          h("div", { class: "found" }, icon("terminal"), h("span", { class: "what" }, "Tailscale is not installed on this machine.")),
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
          h("a", { class: "link", href: t.loginUrl, target: "_blank", rel: "noopener" }, "Open it here")) : null);
      if (signed) s.foot({ label: "Continue", run: s.next });
      else if (opened) s.foot({ label: "Waiting for Tailscale", disabled: true, run: () => {} });
      else s.foot({ label: "Connect", run: connect });
    };
    const poll = () => every(async () => {
      const r = await attempt("onboard.tailscale", { action: "poll" });
      if (r.data) { show(r.data); if (r.data.state === "connected") for (const f of cleanup.splice(0)) f(); }
    }, 2000);
    const connect = async () => {
      const r = await attempt("onboard.tailscale", { action: "connect" });
      if (r.error) { put(panel, empty("Could not start Tailscale's sign-in.", r.error)); return; }
      if (r.data.loginUrl) window.open(r.data.loginUrl, "_blank", "noopener");
      show(r.data);
      poll();
    };
    (async () => {
      const r = await attempt("onboard.tailscale", { action: "detect" });
      if (r.error) { put(panel, empty("Could not look for Tailscale here.", r.error)); return; }
      show(r.data);
      if (r.data.state === "needs-login" && r.data.loginUrl) poll();
    })();
  },

  name(col, s) {
    col.append(
      h("h1", { class: "h1" }, "Your address."),
      // ADR 0008 section 4: v0.1 defaults to a ts.net address (tailscale cert), not <you>.vyre.run;
      // "your own domain" is a collapsed, secondary choice, below.
      h("p", { class: "lead" }, "Vyre gets a certificate for an address on your own tailnet. Only your tailnet can open it."));
    const addr = h("div", { class: "address-big" }, h("span", { class: "faint" }, "Not reserved yet."));
    const list = h("ol", { class: "progress" });
    const note = h("div");
    col.append(h("div", { class: "ob-panel" }, addr, list, note));
    const drawAddr = (/** @type {string|null} */ address) => put(addr, address
      ? [h("i", null, "https://"), address.replace(/^https?:\/\//, "")]
      : h("span", { class: "faint" }, "Not reserved yet."));
    const LABELS = { reserve: "Reserve your address", dns: "Point it at this machine on your tailnet", cert: "Get the certificate" };
    const draw = (/** @type {any[]} */ steps) => put(list, ["reserve", "dns", "cert"].map(id => {
      const st = steps.find(x => x.id === id) || { state: "todo" };
      return progressRow(LABELS[id], st.state, st.note);
    }));
    draw([]);
    if (!state.name) {
      put(note, h("p", { class: "notice" }, "Pick your name in step 1 first."));
      s.foot({ label: "Go to step 1", run: () => goto(0) });
      return;
    }
    if (stepState("tailscale") !== "done") put(note, h("p", { class: "notice" }, icon("lock", 14),
      "This needs this machine on your tailnet. If you skipped Tailscale, the address waits until it is connected."));
    // HTTPS certificates are off for the tailnet by default (ADR 0008 section 4): one admin
    // click fixes it, and it is worth a heads-up before reserving, not just after it fails.
    const blocked = (/** @type {any} */ d) => {
      if (!d || d.state !== "blocked" || d.code !== "https_off") return false;
      put(note, h("p", { class: "notice" }, d.why || "HTTPS certificates are off for your tailnet."),
        h("p", { class: "small muted" }, "Turning it on publishes this machine's name in public Certificate Transparency logs."));
      s.foot({ label: "Check again", run: reserve },
        { secondary: d.adminUrl ? h("a", { class: "btn", href: d.adminUrl, target: "_blank", rel: "noopener" }, "Turn on HTTPS") : null });
      return true;
    };
    const done = (/** @type {any} */ r) => {
      draw(r.steps || []);
      drawAddr(r.address || null);
      if (r.url) {
        put(note, h("p", { class: "notice" }, "From here the loopback link stops working. The rest of the setup continues at your address."));
        s.foot({ label: `Switch to ${r.url.replace(/^https?:\/\//, "")}`, run: async () => {
          await mark_("name", "done");
          location.href = r.url.replace(/\/$/, "") + "/onboard#history";
        } });
        return true;
      }
      if (blocked({ state: r.phase, why: r.why, code: r.code, adminUrl: r.adminUrl })) return true;
      if ((r.steps || []).some(x => x.state === "failed")) s.foot({ label: "Try again", run: reserve });
      return false;
    };
    const reserve = async () => {
      const st = await attempt("onboard.status");
      if (blocked(st.data?.detail?.name)) return;
      s.foot({ label: "Reserving", disabled: true, run: () => {} });
      const r = await attempt("onboard.name", { name: state.name, action: "reserve" });
      if (r.error) { put(note, empty("Could not reserve the address.", r.error)); s.foot({ label: "Try again", run: reserve }); return; }
      if (done(r.data)) return;
      every(async () => {
        const p = await attempt("onboard.name", { name: state.name, action: "status" });
        if (p.data && done(p.data)) for (const f of cleanup.splice(0)) f();
      }, 1500);
    };
    s.foot({ label: "Get your address", run: reserve });
    col.append(h("details", { class: "ob-collapse" }, h("summary", null, "Your own domain"),
      h("p", { class: "small muted" }, "Point a domain you already own at this box instead of a ts.net address: a Cloudflare API token scoped to one zone, and a hostname in it. Set this in the box's own configuration, then come back and reserve again.")));
  },

  history(col, s) {
    col.append(
      h("h1", { class: "h1" }, "Your history."),
      h("p", { class: "lead" }, "Vyre reads the Claude Code sessions already on this machine, so you can search every one and group them into projects. It keeps reading in the background; you do not have to wait."));
    const meter = h("div", { class: "meter", "aria-live": "polite" });
    const made = h("div", { class: "rows" });
    const picker = h("div");
    col.append(h("div", { class: "ob-panel" }, meter, h("div", { class: "lbl", style: { marginTop: "8px" } }, "Make your first projects"),
      h("p", { class: "small muted", style: { marginTop: "-12px" } }, "A project is a client or a piece of work: pick the sessions that belong to it. A session can be in several."),
      made, picker));
    s.foot({ label: "Continue", run: s.next });
    attempt("onboard.history", { action: "start" });

    const drawMeter = async () => {
      const r = await attempt("recall.status");
      if (r.error) { put(meter, empty("Your history cannot be read yet.", r.error)); return; }
      const st = r.data;
      const v = st.vectors || {};
      const reading = !!st.indexing;
      const pct = v.on && st.turns ? Math.round(100 * (v.embedded || 0) / st.turns) : 100;
      put(meter,
        h("div", { class: "row" },
          h("span", { class: "big" }, `${(st.sessions || 0).toLocaleString()} sessions`),
          h("span", { class: "code" }, `${(st.turns || 0).toLocaleString()} turns`)),
        h("div", { class: "bar live" + (reading ? " moving" : ""), role: "progressbar", "aria-label": "Reading your history",
          "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": reading ? false : String(pct) },
          h("span", { style: { width: (reading ? 30 : pct) + "%" } })),
        h("div", { class: "row" },
          h("span", { class: "small muted" }, reading ? "Reading sessions" : st.sessions ? "Every session is searchable by what was said." : "No Claude Code sessions found on this machine yet."),
          h("span", { class: "code" }, v.on ? `${pct}% ranked by meaning` : reading ? "" : "full-text search")));
      return st;
    };
    drawMeter();
    // The loopback stream (before an owner exists) carries only onboard.* events, not the
    // switchboard/Recall ones like session.indexed; core reports reading progress as
    // onboard.stepped, and every() below covers the rest with a poll.
    let t = 0;
    const soon = () => { clearTimeout(t); t = window.setTimeout(drawMeter, 400); };
    cleanup.push(on("onboard.stepped", soon));
    cleanup.push(on("onboard.finished", soon));
    every(drawMeter, 5000);

    /** Project names by slug, so the picker says "in Harlow Legal", not "in harlow-legal". */
    const names = new Map();
    const drawMade = async () => {
      const r = await attempt("projects.list");
      const list = r.data?.projects || [];
      for (const p of list) names.set(p.slug, p.name);
      put(made, list.map(p => h("div", { class: "made", style: { padding: "10px 0" } }, icon("projects"),
        h("span", null, h("b", null, p.name), ` · ${plural(p.threads, "thread")}`))));
    };

    // The picker: name, search, sessions with checkboxes, Make project.
    const chosen = new Set();
    const nameIn = /** @type {HTMLInputElement} */ (h("input", { class: "input", placeholder: "Project name, e.g. Harlow Legal", "aria-label": "Project name", oninput: () => syncMake() }));
    const qIn = /** @type {HTMLInputElement} */ (h("input", { class: "input", type: "search", placeholder: "Search sessions by what was said", "aria-label": "Search sessions" }));
    const list = h("div", { class: "list" });
    const count = h("span", { class: "small muted" });
    const makeBtn = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "btn", onclick: async () => {
      const r = await attempt("projects.create", { name: nameIn.value.trim(), threads: [...chosen] });
      if (r.error) { put(count, String(r.error.message)); return; }
      chosen.clear(); nameIn.value = ""; drawMade(); load(); syncMake();
    } }, icon("plus", 14), "Make project"));
    const syncMake = () => { makeBtn.disabled = !nameIn.value.trim() || !chosen.size; put(count, chosen.size ? plural(chosen.size, "session") + " picked" : "Pick sessions below"); };
    let seq = 0;
    const load = async () => {
      const n = ++seq;
      const r = await attempt("projects.catalog", { q: qIn.value.trim() || undefined, limit: 60 });
      if (n !== seq) return;
      if (r.error) { put(list, h("div", { style: { padding: "0 14px" } }, empty("The session catalogue is not available.", r.error))); return; }
      const rows = r.data.sessions || [];
      if (!rows.length) { put(list, h("div", { style: { padding: "0 14px" } }, empty(qIn.value ? "No session mentions that." : "No sessions yet."))); return; }
      put(list, rows.map(ses => {
        const box = h("input", { type: "checkbox", checked: chosen.has(ses.id), onchange: (/** @type {any} */ e) => {
          e.target.checked ? chosen.add(ses.id) : chosen.delete(ses.id); syncMake(); } });
        return h("label", { class: "pick" }, box,
          h("span", { class: "x" }, h("span", { class: "ellipsis" }, ses.label || ses.title || ses.id),
            h("span", { class: "code ellipsis" }, base(ses.cwd), ses.projects?.length ? `  ·  in ${ses.projects.map(p => names.get(p) || p).join(", ")}` : "")),
          h("span", { class: "w" }, when(ses.last)));
      }));
    };
    let qt = 0;
    qIn.addEventListener("input", () => { clearTimeout(qt); qt = window.setTimeout(load, 250); });
    put(picker, h("div", { class: "picker" },
      h("div", { class: "bar-top" }, nameIn),
      h("div", { class: "bar-top" }, qIn),
      list,
      h("div", { class: "bar-bottom" }, count, h("div", { style: { flexGrow: "1" } }), makeBtn)));
    syncMake();
    drawMade().then(load);
  },

  devices(col, s) {
    // ADR 0008 section 6: two QR codes side by side (Tailscale's app, and this address), the
    // login they should share named under them, and a Mac card that already says "Connected"
    // through door A rather than always offering a download.
    const d = state.status?.detail?.devices || {};
    const owner = state.status?.detail?.tailscale?.owner || null;
    const phoneUrl = d.phoneUrl || (state.name && stepState("name") === "done" ? `https://${state.name}` : location.origin) + "/now";
    const tsUrl = "https://tailscale.com/download";
    col.append(
      h("h1", { class: "h1" }, "Your devices."),
      h("p", { class: "lead" }, "Open Vyre on your phone, and put the Capsule on your Mac. Both reach this machine over your tailnet."));
    col.append(h("div", { class: "ob-panel" },
      h("div", { class: "devices" },
        h("div", null,
          h("div", { class: "lbl" }, "Tailscale"),
          h("div", { class: "qr", role: "img", "aria-label": "QR code for the Tailscale app" }, qr(tsUrl)),
          h("div", { class: "code" }, tsUrl.replace(/^https?:\/\//, "")),
          h("p", { class: "small muted" }, owner ? `Sign in as ${owner}.` : "Sign in with the same account as this setup.")),
        h("div", null,
          h("div", { class: "lbl" }, "Phone"),
          h("div", { class: "qr", role: "img", "aria-label": "QR code for " + phoneUrl }, qr(phoneUrl)),
          h("div", { class: "code" }, phoneUrl.replace(/^https?:\/\//, "")),
          h("p", { class: "small muted" }, owner ? `Sign in as ${owner}. ` : "", "Add it to the home screen to use it like an app.")),
        h("div", null,
          h("div", { class: "lbl" }, "Mac"),
          h("p", { class: "h3" }, "The Capsule"),
          d.mac?.connected
            ? h("p", { class: "small" }, icon("check", 14), ` Connected: ${d.mac.name || "this Mac"}.`)
            : [h("p", { class: "small muted" }, "Press Control twice anywhere on your Mac to talk to your assistant, an agent or any session. Works offline for your own Mac."),
              h("div", null, h("a", { class: "btn", href: d.macDownload || "https://github.com/vyre-ai/vyre/releases/latest", target: "_blank", rel: "noopener" }, icon("laptop", 14), "Download for Mac"))]))));
    s.foot({ label: "Open the Deck", run: s.next }, { skip: false });
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
 * @param {{ url: string, thread?: string|null }} d
 */
function showEnding(d) {
  for (const f of cleanup) f();
  cleanup = [];
  const greet = h("p", { class: "lead", "aria-live": "polite" }, h("span", { class: "busy-inline faint" }, "Saying hello…"));
  const ticks = h("ol", { class: "progress" });
  const rows = [
    { id: "mac", label: "Your Mac", done: !!state.status?.detail?.devices?.mac?.connected },
    { id: "phone", label: "Your phone", done: stepState("devices") !== "todo" },
    { id: "history", label: "Your history", done: stepState("history") !== "todo" },
  ];
  put(ticks, rows.map(t => progressRow(t.label, t.done ? "done" : "todo")));
  // A passkey (ADR 0004) proves a person is present for a Gate approval or a Glass take-over;
  // with none enrolled yet, onboard.finish's passkeyUrl sends the person to set one up first.
  const open = d.passkeyUrl || (d.url.replace(/\/$/, "") + "/now");
  put(root, h("div", { class: "ob-end" },
    h("span", { class: "brand", "aria-label": "vyre" }, mark(24), wordmark(26)),
    h("h1", { class: "h1" }, "Vyre is ready."),
    greet,
    h("div", { class: "ob-panel" }, ticks),
    h("a", { class: "btn btn-primary ob-end-open", href: open }, d.passkeyUrl ? "Add a passkey" : "Open Vyre"),
    d.passkeyUrl ? h("p", { class: "small faint", style: { marginTop: "10px" } }, h("a", { class: "link", href: d.url.replace(/\/$/, "") + "/now" }, "Skip for now")) : null));
  if (!d.thread) { put(greet, `${state.assistant || "Your assistant"} is ready when you are.`); return; }
  let text = "";
  const draw = () => put(greet, text || h("span", { class: "busy-inline faint" }, "Saying hello…"));
  cleanup.push(on("thread.text", e => {
    if (e.thread !== d.thread) return;
    const p = e.payload || {};
    if (typeof p.text === "string") text = p.text; else if (typeof p.delta === "string") text += p.delta;
    draw();
  }));
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
