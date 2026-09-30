// @ts-check
// The land cards: the first screens after setup (PLAN.md C21). Setup lands the person in the
// assistant's thread, and the assistant's first message is assistant.welcome:
//   { text, cards: [{ id, title, body, href? }] }
// A card is present only while its onboarding step is open, so an empty list means all set. A card
// carries an id and words, never a tool to run (reviewer-2's BLOCKER on a model-written action):
// this file maps each known id to its own handler, so the message can name what to show and never
// what to do. An id it does not know is not drawn, unless it carries an https link, which opens as
// a plain link.
//   claude     onboard.claude {mode:"setup-token"} -> {url, needsCode}; then {mode, code}
//   tailscale  the card's own https href (a sign-in link), opened in a new tab
//   history    import.scan -> pick folders -> import.plan -> mode and pace -> import.start
//   import     import.status and the import.progress event: what is searchable, understood, learned
//   phone      Settings > Devices, where the live Vyre code ring already is (one card, two homes)
// Colours come from the theme variables; a card never writes a hex value.

import { h, put } from "../../js/dom.js";
import { attempt, on } from "../../js/api.js";
import { icon } from "../../js/icons.js";
import { plural } from "../../js/fmt.js";
import { ensureCss, shell, head, chip, problemText } from "./kit.js";

/** The ids this file has a handler for. */
export const KNOWN = ["claude", "tailscale", "history", "import", "phone"];

const kb = (/** @type {number} */ n) => (n < 1e6 ? Math.max(1, Math.round(n / 1e3)) + " KB" : (n / 1e6).toFixed(1) + " MB");
const httpsOnly = (/** @type {any} */ u) => (typeof u === "string" && /^https:\/\//i.test(u) ? u : null);

/** Which of a welcome's cards get drawn: a known id, or an unknown one that carries an https link. @param {any} welcome */
export function drawable(welcome) {
  const list = Array.isArray(welcome?.cards) ? welcome.cards : [];
  return list.filter((/** @type {any} */ c) => c && typeof c.id === "string" && typeof c.title === "string" && (KNOWN.includes(c.id) || httpsOnly(c.href)));
}

/** A line under the header: the card's own words. @param {any} c */
const words = c => h("p", { class: "cv-land-body" }, String(c.body ?? ""));
/** A quiet problem line in plain words. @param {any} e */
const problem = e => (e ? h("p", { class: "cv-land-problem", role: "alert" }, problemText(e)) : null);

/**
 * One land card. @param {{ id: string, title: string, body?: string, href?: string }} c
 * @param {{ open?: (href: string) => void, phone?: boolean }} [ctx]
 * @returns {HTMLElement & { update: (c: any) => void, stop: () => void }}
 */
export function landCard(c, ctx = {}) {
  ensureCss("land");
  const el = /** @type {any} */ (shell("cv-land cv-land-" + c.id, c.title));
  el.setAttribute?.("data-card", c.id);
  const open = (/** @type {string} */ href) => ctx.open?.(href);
  /** @type {(() => void)[]} */ const offs = [];
  const state = { done: false };

  const frame = (/** @type {any[]} */ ...rest) => put(el,
    head({ icon: c.id === "phone" ? "phone" : c.id === "claude" ? "key" : c.id === "tailscale" ? "devices" : "search", title: c.title,
      meta: state.done ? chip("done", "Done") : null }),
    h("div", { class: "cv-land-main" }, words(c), ...rest));

  // ---- claude: the sign-in link and the code the page shows back ----------------------------
  function claude() {
    let url = /** @type {string|null} */ (null), busy = false, err = /** @type {any} */ (null);
    const draw = () => {
      if (state.done) return frame(h("p", { class: "cv-land-note" }, "Signed in."));
      if (!url) {
        return frame(problem(err), h("div", { class: "cv-land-actions" },
          h("button", { class: "btn btn-primary btn-sm", type: "button", "data-act": "start", disabled: busy, onclick: start }, busy ? "Opening" : "Sign in")));
      }
      const code = /** @type {HTMLInputElement} */ (h("input", { class: "input cv-land-code", placeholder: "Paste the code from the page", "aria-label": "Code from the Claude page", autocomplete: "off", spellcheck: "false" }));
      return frame(
        h("p", { class: "cv-land-note" }, "Open the sign-in page, approve, then paste the code it shows."),
        h("div", { class: "cv-land-actions" },
          h("button", { class: "btn btn-sm", type: "button", "data-act": "open", onclick: () => open(/** @type {string} */ (url)) }, "Open sign-in page")),
        h("div", { class: "cv-land-actions" }, code,
          h("button", { class: "btn btn-primary btn-sm", type: "button", "data-act": "finish", disabled: busy, onclick: () => finish(code.value) }, busy ? "Checking" : "Finish")),
        problem(err));
    };
    async function start() {
      busy = true; err = null; draw();
      const r = await attempt("onboard.claude", { mode: "setup-token" });
      busy = false;
      if (r.error) err = r.error;
      else if (httpsOnly(r.data?.url)) url = r.data.url;
      else if (r.data?.state === "done") state.done = true;
      else err = "Claude did not give a sign-in page. Try again.";
      draw();
    }
    async function finish(/** @type {string} */ raw) {
      const code = String(raw || "").trim();
      if (!code) { err = "Paste the code first."; draw(); return; }
      busy = true; err = null; draw();
      const r = await attempt("onboard.claude", { mode: "setup-token", code });
      busy = false;
      if (r.error) err = r.error; else state.done = r.data?.state === "done" || r.data?.needsCode === false;
      if (!r.error && !state.done) err = "That code did not work. Open the page again for a new one.";
      draw();
    }
    return draw;
  }

  // ---- tailscale and any other link card: the person's own sign-in page ---------------------
  function link() {
    const href = httpsOnly(c.href);
    return () => frame(h("div", { class: "cv-land-actions" },
      h("button", { class: "btn btn-primary btn-sm", type: "button", "data-act": "link", disabled: !href, onclick: () => href && open(href) },
        c.id === "tailscale" ? "Open Tailscale" : "Open")));
  }

  // ---- phone: the ring lives in Settings > Devices --------------------------------------------
  function phone() {
    return () => frame(h("div", { class: "cv-land-actions" },
      h("button", { class: "btn btn-primary btn-sm", type: "button", "data-act": "phone", onclick: () => open("/settings#devices") }, "Show the code")));
  }

  // ---- history: discover, choose, confirm, start ------------------------------------------------
  function history() {
    /** @type {"idle"|"scan"|"choose"|"plan"|"start"|"running"} */ let phase = "idle";
    let err = /** @type {any} */ (null), sources = /** @type {any[]} */ ([]), plan = /** @type {any} */ (null), keepsDays = 30, left = 0;
    const picked = new Set(), keyOf = (/** @type {any} */ s, /** @type {any} */ f) => f.cwd || s.path;
    let sync = false, pace = /** @type {"fast"|"gentle"|null} */ (null);

    const draw = () => {
      if (phase === "running") return runningDraw();
      if (phase === "idle" || phase === "scan") {
        return frame(problem(err), h("div", { class: "cv-land-actions" },
          h("button", { class: "btn btn-primary btn-sm", type: "button", "data-act": "scan", disabled: phase === "scan", "aria-busy": phase === "scan" ? "true" : null, onclick: scan },
            phase === "scan" ? "Looking" : "Find my sessions"),
          h("span", { class: "cv-land-fine" }, "Nothing leaves this device until you choose.")));
      }
      if (phase === "choose") {
        const rows = sources.flatMap(s => s.folders.map((/** @type {any} */ f) => {
          const k = keyOf(s, f);
          return h("label", { class: "cv-land-pick" },
            h("input", { type: "checkbox", checked: picked.has(k), onchange: (/** @type {any} */ e) => { e.target.checked ? picked.add(k) : picked.delete(k); draw(); } }),
            h("span", { class: "cv-land-pick-x" },
              h("span", { class: "cv-land-pick-t ellipsis" }, f.name || f.cwd || "Unknown folder"),
              h("span", { class: "cv-land-fine ellipsis" }, `${plural(f.sessions, "session")} · ${kb(f.bytes)}` + (f.why ? ` · ${f.why}` : ""))));
        }));
        return frame(
          rows.length ? h("div", { class: "cv-land-picks" }, rows) : h("p", { class: "cv-land-note" }, "No sessions found on this device yet. Start one and come back."),
          left ? h("p", { class: "cv-land-fine" }, `${plural(left, "session")} from Vyre's own development and excluded folders are left out.`) : null,
          problem(err),
          h("div", { class: "cv-land-actions" },
            h("button", { class: "btn btn-primary btn-sm", type: "button", "data-act": "plan", disabled: !picked.size, onclick: makePlan }, "Continue")));
      }
      if (phase === "plan" || phase === "start") {
        const p = plan?.pace || {};
        const opt = (/** @type {"fast"|"gentle"} */ v, /** @type {string} */ t, /** @type {string} */ d) => h("label", { class: "cv-land-opt" + (pace === v ? " on" : "") },
          h("input", { type: "radio", name: "pace", value: v, checked: pace === v, onchange: () => { pace = v; draw(); } }),
          h("span", { class: "cv-land-pick-x" }, h("span", { class: "cv-land-pick-t" }, t), h("span", { class: "cv-land-fine" }, d)));
        return frame(
          h("p", { class: "cv-land-note" }, `${plural(plan.sessions, "session")} · ${kb(plan.bytes)} · from ${plural(plan.folders?.length || 0, "folder")}, to your server.`),
          h("label", { class: "cv-land-pick" },
            h("input", { type: "checkbox", checked: sync, onchange: (/** @type {any} */ e) => { sync = e.target.checked; } }),
            h("span", { class: "cv-land-pick-x" }, h("span", { class: "cv-land-pick-t" }, "Keep them in sync"), h("span", { class: "cv-land-fine" }, "New sessions come along too, from now on."))),
          h("div", { class: "cv-land-opts", role: "radiogroup", "aria-label": "How fast Vyre reads" },
            opt("fast", "Fast", p.fast ? `Understood in about ${plural(p.fast.hours, "hour")}. Uses more of your Claude plan today.` : "Understood in a few hours. Uses more of your Claude plan today."),
            opt("gentle", "Gentle", p.gentle ? `Over about ${plural(p.gentle.days, "day")}. Barely touches your plan.` : "Over a few days. Barely touches your plan.")),
          h("p", { class: "cv-land-fine" }, `Search works right away either way. Claude Code keeps sessions for ${keepsDays} days, so import now while they last.`),
          problem(err),
          h("div", { class: "cv-land-actions" },
            h("button", { class: "btn btn-sm", type: "button", "data-act": "back", onclick: () => { phase = "choose"; err = null; draw(); } }, "Back"),
            h("button", { class: "btn btn-primary btn-sm", type: "button", "data-act": "start", disabled: !pace || phase === "start", onclick: start }, phase === "start" ? "Starting" : "Import")));
      }
      return frame();
    };
    async function scan() {
      phase = "scan"; err = null; draw();
      const r = await attempt("import.scan");
      if (r.error) { phase = "idle"; err = r.error; draw(); return; }
      sources = (r.data?.sources || []).filter((/** @type {any} */ s) => s.folders?.length);
      if (Number.isInteger(r.data?.claude_keeps_days)) keepsDays = r.data.claude_keeps_days;
      left = (r.data?.left_out?.vyre || 0) + (r.data?.left_out?.excluded || 0);
      picked.clear();
      for (const s of sources) for (const f of s.folders) if (f.suggested) picked.add(keyOf(s, f));
      phase = "choose"; draw();
    }
    async function makePlan() {
      err = null;
      const r = await attempt("import.plan", { include: [...picked] });
      if (r.error) { err = r.error; draw(); return; }
      plan = r.data; phase = "plan"; draw();
    }
    async function start() {
      if (!pace || !plan) return;
      phase = "start"; err = null; draw();
      const r = await attempt("import.start", { plan: plan.plan, mode: sync ? "sync" : "once", pace });
      if (r.error) {
        phase = "plan";
        err = r.error.code === "not_found" ? "That plan expired. Go back and choose again." : r.error.code === "busy" ? "An import is already running. Try again in a moment." : r.error;
        draw(); return;
      }
      phase = "running"; draw();
    }
    const runningDraw = () => frame(h("p", { class: "cv-land-note" }, "Started. Progress shows below as it goes."));
    return draw;
  }

  // ---- import: what Vyre has read so far ------------------------------------------------------------
  function progress() {
    /** @type {any} */ let st = null;
    const stage = (/** @type {string} */ label, /** @type {string} */ mark, /** @type {string|null} */ note) => h("li", { class: "cv-land-stage" },
      h("span", { class: `cv-mark cv-mark-${mark}`, "aria-hidden": "true" }), h("span", { class: "cv-land-stage-t" }, label), note ? h("span", { class: "cv-land-fine" }, note) : null);
    const mark = (/** @type {any} */ s) => (!s || !(s.total > 0) ? "neutral" : s.done >= s.total ? "done" : "running");
    const draw = () => {
      if (!st) return frame(h("p", { class: "cv-land-note" }, "Reading your sessions."));
      const g = st.graph || {}, up = st.upload;
      const waiting = st.personal && st.personal.total > st.personal.done ? `still reading ${plural(st.personal.total - st.personal.done, "turn")} for personal facts` : null;
      return frame(h("ul", { class: "cv-land-stages" },
        up ? stage("Sending to your server", up.state === "done" ? "done" : up.state === "stopped" ? "failed" : "running",
          up.quarantined ? `${plural(up.quarantined, "session")} set aside because they looked like they held a secret` : null) : null,
        stage("Searchable now", mark(st.search), st.searchable_sessions ? plural(st.searchable_sessions, "session") : null),
        stage("Understood", mark(st.meaning), waiting),
        stage("What it learned", g.sessions > 0 ? "running" : "neutral", g.sessions > 0 ? `${plural(g.people || 0, "person", "people")} · ${plural(g.orgs || 0, "org")} · ${plural(g.facts || 0, "fact")}` : null)));
    };
    const read = async () => { const r = await attempt("import.status"); if (!r.error) { st = r.data; draw(); } };
    offs.push(on("import.progress", e => { st = e.payload; draw(); }));
    read();
    return draw;
  }

  const draw = ({ claude, tailscale: link, history, import: progress, phone }[c.id] || link)();
  draw();
  el.update = (/** @type {any} */ nc) => { c = { ...c, ...nc }; draw(); };
  el.stop = () => { for (const off of offs.splice(0)) off(); };
  return el;
}

/**
 * The assistant's first message: its words, then the cards that still have something to do.
 * .update(welcome) redraws in place (a step done makes its card leave); .stop() drops the listeners.
 * @param {any} welcome assistant.welcome's data
 * @param {{ open?: (href: string) => void, phone?: boolean, avatar?: any }} [ctx]
 */
export function welcomeRow(welcome, ctx = {}) {
  ensureCss("land");
  const el = /** @type {any} */ (h("div", { class: "cv-row cv-welcome" }));
  el._kind = "assistant";
  el._ts = null;
  /** @type {Map<string, any>} */ let cards = new Map();
  const draw = (/** @type {any} */ w) => {
    const keep = new Map();
    const list = drawable(w).map((/** @type {any} */ c) => {
      const old = cards.get(c.id);
      const card = old || landCard(c, ctx);
      if (old) old.update?.(c);
      keep.set(c.id, card);
      return card;
    });
    for (const [id, card] of cards) if (!keep.has(id)) card.stop?.();
    cards = keep;
    put(el, h("p", { class: "cv-welcome-text" }, String(w?.text ?? "")), list.length ? h("div", { class: "cv-welcome-cards" }, list) : null);
  };
  el.update = draw;
  el.stop = () => { for (const card of cards.values()) card.stop?.(); cards.clear(); };
  draw(welcome);
  return el;
}

/** The welcome for the assistant's thread: assistant.welcome, or null when it cannot be read
 * (a box without the assistant module shows the plain empty thread, never an error). */
export async function loadWelcome() {
  const r = await attempt("assistant.welcome");
  const d = r.data;
  return !r.error && d && typeof d.text === "string" ? d : null;
}
