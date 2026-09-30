// @ts-check
// presence: what the person sees while Vyre works in their Chrome (team/0.2/chrome-ux.md, section 1).
//
//   - the tabs Vyre opens go in a grey tab group titled "Vyre" ("Vyre, your turn" while it waits for the person, "Vyre, done" after),
//   - the toolbar icon animates (12 frames, 5 fps) only while a run is active and a badge "1" shows only when it is the person's turn,
//   - a dark glass pill in the tab Vyre is working in says "Step 12 of 20", the step in plain words and "Esc to stop".
// (Built to team/0.2/chrome-ux.html. One departure: no one-second lead-in before each action, because speed is a goal; the ring flashes as it acts.)
//
// It watches every op the shell runs (around()), so background API calls show too. It changes no page state the agent reads:
// the pill lives in a closed shadow root on an element the snapshot skips, takes no pointer events except its Stop button, and is
// removed when the run goes quiet. Every browser call is best effort: a missing API (an older Chrome, a fake) never fails an op.

/** Ops that advance the step count: each one is a thing the person could have done by hand. */
const STEP = /^(page\.(act|fill)|tabs\.(open|navigate|use)|api\.call|dev\.console\.eval|ghl\.section)/;
/** Ops that say nothing about work in progress. */
const QUIET = /^(caps|status|hello|presence|tabs\.(list|query)|frames\.list|dev\.state)/;
/** A run is over this long after its last op, or at once when the module says it is done (a plan finished, a summary asked for). A model can think for a while between steps. */
export const IDLE_MS = 30_000;
/** The tab pill is redrawn this often while work continues, so a navigation that replaced the document gets it back. */
export const BEAT_MS = 2000;
/** An open question is raised again after this long. */
export const REMIND_MS = 120_000;
/** A question nobody answered stops owning the run after this long (the act stays held and can still be answered). */
export const WAIT_MAX_MS = 10 * 60_000;
/** 12 icon frames at 5 frames a second. */
const FRAMES = 12;
export const FRAME_MS = 200;
export const GROUP_TITLE = "Vyre";
export const TITLES = { working: "Vyre", turn: "Vyre, your turn", done: "Vyre, done" };
export const GROUP_COLOR = "grey";
export const COLORS = { bone: "#EDE8DC", ink: "#171513" };
const STILL = { 16: "icons/icon-16.png", 32: "icons/icon-32.png" };
/** What the step is, in plain words, from the op that ran. @param {string} op @param {any} a */
export function stepText(op, a) {
  const args = a || {};
  const name = (/** @type {any} */ x) => { const n = x && (x.name || x.identifier || x.text); return n ? String(n).slice(0, 40) : ""; };
  if (op === "page.act") { const n = name(args.selector); const k = String(args.kind || "click"); return n ? `${k === "click" ? "Clicking" : k === "type" ? "Typing in" : k === "select" ? "Choosing in" : k === "check" ? "Ticking" : "Pressing a key in"} "${n}"` : "Acting on the page"; }
  if (op === "page.fill") return `Filling ${Array.isArray(args.fields) ? args.fields.length : "some"} field${Array.isArray(args.fields) && args.fields.length === 1 ? "" : "s"}`;
  if (op === "page.wait") return "Waiting for the page";
  if (op === "tabs.navigate" || op === "tabs.open" || op === "tabs.use") { try { return `Opening ${new URL(String(args.url)).host}`; } catch { return "Opening a page"; } }
  if (op === "api.call") return "Calling the app's own API";
  if (op === "batch.run" || op === "ghl.run") return `Running ${Array.isArray(args.steps) ? args.steps.length + " steps" : "a flow"}`;
  if (op === "ghl.section") return "Going to a section";
  return "";
}

/**
 * The page side: one pill per document, updated in place, always dark glass so it reads on any site (team/0.2/chrome-ux.html).
 * st = { mode: "working" | "paused" | "stopped" | "login", step, of, text, site }. The only actions a page could trigger by calling the bindings are
 * stop and pause (harmless) and login continue/skip (harmless: Continue re-checks that the wall is really gone). Nothing here can approve, send or resume:
 * a page can call any binding, so those live only in trusted surfaces.
 * @param {{ mode: string, step?: number, of?: number|null, text?: string, site?: string }} st
 */
export const pillScript = st => `(() => {
  const ST = ${JSON.stringify({ mode: String(st.mode || "working"), step: Number(st.step) || 0, of: st.of ? Number(st.of) : null, text: String(st.text || "").slice(0, 120), site: String(st.site || "").slice(0, 60) })};
  const cur = window.__vyrePill;
  if (cur && cur.host.isConnected) { cur.set(ST); return true; }
  const host = document.createElement("vyre-pill");
  host.setAttribute("data-vyre", "pill");
  host.style.cssText = "all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;pointer-events:none;";
  const root = host.attachShadow({ mode: "closed" });
  const css = document.createElement("style");
  css.textContent = ".p{font:500 12px/1.35 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#EDE8DC;background:rgba(23,21,19,.88);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);border:1px solid rgba(237,232,220,.22);border-radius:14px;padding:9px 12px 11px;display:flex;flex-direction:column;gap:3px;min-width:200px;max-width:min(360px,80vw);box-shadow:0 0 0 1px rgba(237,232,220,.06),0 6px 22px rgba(0,0,0,.4);position:relative;overflow:hidden}"
    + ".r{display:flex;align-items:center;gap:9px}.b{width:8px;height:8px;border-radius:50%;background:#EDE8DC;flex:none;animation:v 2.4s ease-in-out infinite}.b.s{animation:none;background:none;border:2px solid #EDE8DC;width:6px;height:6px}"
    + ".t{font-weight:600}.x{color:rgba(237,232,220,.72);font-weight:400}.k{margin-left:auto;display:flex;gap:6px}"
    + "button{pointer-events:auto;font:inherit;color:#171513;background:#EDE8DC;border:0;border-radius:999px;padding:3px 10px;cursor:pointer}button.g{background:none;color:#EDE8DC;border:1px solid rgba(237,232,220,.35)}"
    + ".l{position:absolute;left:0;bottom:0;height:2px;background:#EDE8DC;opacity:.85;transition:width .3s}"
    + "@keyframes v{0%,100%{opacity:1}50%{opacity:.3}}@media (prefers-reduced-motion:reduce){.b{animation:none!important}}";
  const box = document.createElement("div"); box.className = "p";
  root.append(css, box);
  const btn = (label, cls, fn) => { const x = document.createElement("button"); x.type = "button"; x.textContent = label; if (cls) x.className = cls; x.addEventListener("click", e => { e.stopPropagation(); fn(); }); return x; };
  const stop = via => { if (typeof window.vyreStop === "function") window.vyreStop(via); };
  const login = a => { if (typeof window.vyreLogin === "function") window.vyreLogin(a); };
  const place = () => {
    const corners = [["right", "bottom"], ["left", "bottom"], ["right", "top"], ["left", "top"]];
    const hot = "a,button,input,select,textarea,summary,[role=button],[role=link],[role=menuitem],[tabindex]:not([tabindex='-1']),[onclick]";
    for (const [h, v] of corners) {
      host.style.cssText = "all:initial;position:fixed;" + h + ":16px;" + v + ":16px;z-index:2147483647;pointer-events:none;";
      const r = box.getBoundingClientRect();
      if (!r.width) return;
      let clear = true;
      for (const fx of [0.05, 0.5, 0.95]) for (const fy of [0.1, 0.5, 0.9]) {
        const e = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy);
        if (e && e !== host && e.closest && e.closest(hot)) clear = false;
      }
      if (clear) return;
    }
    host.style.cssText = "all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;pointer-events:none;";
  };
  const set = s => {
    box.textContent = "";
    const row = document.createElement("div"); row.className = "r";
    const bead = document.createElement("span"); bead.className = "b" + (s.mode === "working" ? "" : " s");
    const head = document.createElement("span"); head.className = "t";
    if (s.mode === "login") head.textContent = "Your turn: sign in" + (s.site ? " to " + s.site : "");
    else if (s.mode === "paused") head.textContent = "Paused at step " + s.step;
    else if (s.mode === "stopped") head.textContent = "Stopped at step " + s.step;
    else head.textContent = "Step " + Math.max(1, s.step) + (s.of ? " of " + s.of : "");
    row.append(bead, head);
    const keys = document.createElement("span"); keys.className = "k";
    if (s.mode === "working") { keys.append(btn("Pause", "g", () => stop("pause"))); }
    if (s.mode === "login") { keys.append(btn("Continue", "", () => login("continue")), btn("Skip", "g", () => login("skip"))); }
    row.append(keys); box.append(row);
    const sub = document.createElement("div"); sub.className = "x";
    if (s.mode === "login") sub.textContent = "Vyre can't see what you type. It carries on when you press Continue.";
    else if (s.mode === "paused") sub.textContent = "Nothing is submitted while paused. Continue from Vyre or the toolbar icon.";
    else if (s.mode === "stopped") sub.textContent = "You pressed Esc. Continue from Vyre or the toolbar icon.";
    else sub.textContent = (s.text ? s.text + " \u00b7 " : "") + "Esc to stop";
    box.append(sub);
    if (s.mode === "working" && s.of) { const l = document.createElement("div"); l.className = "l"; l.style.width = Math.min(100, Math.round(100 * Math.max(0, s.step - 1) / s.of)) + "%"; box.append(l); }
    place();
  };
  set(ST);
  document.addEventListener("keydown", e => { if (e.key === "Escape" && window.__vyrePill && window.__vyrePill.host.isConnected) stop("esc"); }, true);
  (document.body || document.documentElement).appendChild(host);
  set(ST);
  const rectOf = label => { const b = [...box.querySelectorAll("button")].find(x => x.textContent === label); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
  window.__vyrePill = { host, set, rectOf };
  return true;
})()`;

/** The card a run leaves behind: what changed, where to open it, how to undo. A closed shadow root like the pill; its links and Dismiss take clicks, nothing else does. @param {{ counts: Record<string, number>, items: { what: string, url?: string }[], steps: number }} d */
export const cardScript = d => `(() => {
  const D = ${JSON.stringify({ counts: d.counts, items: d.items.slice(0, 12).map(i => ({ what: String(i.what).slice(0, 100), url: /^https?:\/\//.test(String(i.url || "")) ? String(i.url).slice(0, 300) : "" })), steps: d.steps })};
  const old = document.querySelector("vyre-card"); if (old) old.remove();
  const host = document.createElement("vyre-card");
  host.setAttribute("data-vyre", "card");
  host.style.cssText = "all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;pointer-events:none;";
  const root = host.attachShadow({ mode: "closed" });
  const box = document.createElement("div");
  box.style.cssText = "pointer-events:auto;font:13px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#202124;background:#fff;border:1px solid #dadce0;border-left:4px solid #1a73e8;border-radius:8px;padding:12px 14px;width:min(340px,80vw);box-shadow:0 4px 18px rgba(0,0,0,.25);";
  const head = document.createElement("div");
  head.style.cssText = "font-weight:600;margin-bottom:6px;";
  const parts = Object.entries(D.counts).filter(([, n]) => n > 0).map(([k, n]) => n + " " + (k === "create" ? "created" : k === "edit" ? "edited" : k === "delete" ? "deleted" : k));
  head.textContent = "Vyre finished" + (parts.length ? " · " + parts.join(", ") : " · " + D.steps + " steps");
  box.append(head);
  for (const it of D.items) {
    const row = document.createElement("div"); row.style.cssText = "display:flex;justify-content:space-between;gap:8px;margin:2px 0;";
    const t = document.createElement("span"); t.textContent = it.what; row.append(t);
    if (it.url) { const a = document.createElement("a"); a.href = it.url; a.target = "_self"; a.textContent = "Open"; a.style.cssText = "color:#1a73e8;text-decoration:none;flex:none;"; row.append(a); }
    box.append(row);
  }
  const foot = document.createElement("div"); foot.style.cssText = "margin-top:8px;color:#5f6368;font-size:12px;";
  foot.textContent = D.counts.create ? "To undo the drafts, tell Vyre: undo what you created." : "";
  const x = document.createElement("button"); x.type = "button"; x.textContent = "Dismiss"; x.style.cssText = "margin-top:8px;font:inherit;color:#1a73e8;background:none;border:0;cursor:pointer;padding:0;display:block;";
  x.addEventListener("click", () => host.remove());
  box.append(foot, x); root.append(box);
  (document.body || document.documentElement).appendChild(host);
  setTimeout(() => { try { host.remove(); } catch (e) {} }, 60000);
  return true;
})()`;

/** Take the pill away. */
export const pillGone = `(() => { const c = window.__vyrePill; if (c && c.host) c.host.remove(); window.__vyrePill = undefined; return true; })()`;

/**
 * @param {{ chrome: any, cdp?: any, onStop?: (via: string) => void, now?: () => number, setT?: any, clearT?: any, setI?: any, clearI?: any, onLogin?: (action: string, tabId: number) => void, onFinish?: (run: any) => void }} o
 */
export function createPresence({ chrome, cdp, onStop = () => {}, now = Date.now, setT = setTimeout, clearT = clearTimeout, setI = setInterval, clearI = clearInterval, onLogin = () => {}, onFinish = () => {} }) {
  /** The run in progress, or null. @type {null | { steps: number, of: number|null, label: string, text: string, waiting: string|null, site: string, paused: string|null, failed: boolean, tabs: Set<number>, startedAt: number, changes: any[] }} */
  let run = null;
  /** @type {Map<number, number>} window id to the group that holds Vyre's tabs there */
  const groups = new Map();
  /** @type {any} */ let idle = null;
  /** @type {any} */ let beat = null;
  /** @type {any} */ let pulse = null;
  let frame = 0;
  /** A failure streak on the connection owns the badge; presence stays out of its way. */
  let badgeOwned = () => false;
  const bound = new Set();
  /** @type {any} */ let remind = null;
  /** @type {any} */ let expire = null;
  let asked = 0;
  /** @param {{ title: string, message: string }} n */
  function notify(n) {
    const api = chrome && chrome.notifications;
    if (!api || !api.create) return;
    try {
      const p = api.create(`vyre-${asked}-${now()}`, { type: "basic", iconUrl: chrome.runtime && chrome.runtime.getURL ? chrome.runtime.getURL("icons/icon-128.png") : "icons/icon-128.png", title: n.title, message: n.message, priority: 2, requireInteraction: true });
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch { /* no notification permission: the amber badge and pill still say it */ }
  }

  /** A timer that never keeps a process alive (under node, in tests); a service worker has no unref and needs none. */
  const weak = (/** @type {any} */ h) => { try { if (h && typeof h.unref === "function") h.unref(); } catch { /* not node */ } return h; };
  const safe = async (/** @type {() => any} */ f) => { try { return await f(); } catch { return undefined; } };
  const action = () => chrome && chrome.action;

  /** The pill as data. */
  const view = () => {
    if (!run) return { mode: "working", step: 0, of: null, text: "", site: "" };
    const mode = run.paused ? (run.paused === "pause" ? "paused" : "stopped") : run.waiting && run.site ? "login" : "working";
    return { mode, step: run.steps + (mode === "working" ? 1 : 0), of: run.of, text: run.text || run.label, site: run.site };
  };
  const text = () => {
    if (!run) return "";
    const v = view();
    if (v.mode === "login") return `Your turn: sign in${v.site ? " to " + v.site : ""}`;
    if (v.mode === "paused") return `Paused at step ${v.step}`;
    if (v.mode === "stopped") return `Stopped at step ${v.step}`;
    if (run.waiting) return `Your turn: ${run.waiting}`;
    return `Step ${v.step}${v.of ? " of " + v.of : ""} \u00b7 ${v.text ? v.text + " \u00b7 " : ""}Esc to stop`;
  };

  /** The person's turn is the only thing the badge ever says: "1" in Bone on ink. Nothing else is counted there. */
  async function paintBadge() {
    const a = action();
    if (!a || badgeOwned()) return;
    const turn = !!(run && run.waiting);
    await safe(() => a.setBadgeText({ text: turn ? "1" : "" }));
    if (turn) {
      if (a.setBadgeBackgroundColor) await safe(() => a.setBadgeBackgroundColor({ color: COLORS.bone }));
      if (a.setBadgeTextColor) await safe(() => a.setBadgeTextColor({ color: COLORS.ink }));
    }
    if (a.setTitle) await safe(() => a.setTitle({ title: run ? `Vyre for Chrome: ${text()}` : "Vyre for Chrome" }));
    await retitle();
  }

  /** The group says whose turn it is. @param {string} [force] */
  async function retitle(force) {
    if (!chrome || !chrome.tabGroups || !chrome.tabGroups.update) return;
    const t = force || (run && run.waiting ? TITLES.turn : TITLES.working);
    for (const gid of groups.values()) await safe(() => chrome.tabGroups.update(gid, { title: t, color: GROUP_COLOR }));
  }

  /** The toolbar icon animates only while Vyre is working; waiting for the person, it holds still. */
  function paintIcon() {
    const a = action();
    if (!a || !a.setIcon) return;
    const animate = !!run && !run.waiting && !run.paused;
    if (!animate) {
      if (pulse) { clearI(pulse); pulse = null; }
      void safe(() => a.setIcon({ path: STILL }));
      return;
    }
    if (pulse) return;
    frame = 0;
    pulse = weak(setI(() => { frame = (frame + 1) % FRAMES; void safe(() => a.setIcon({ path: { 16: `frames/working-${String(frame).padStart(2, "0")}.png` } })); }, FRAME_MS));
  }

  /**
   * Everything Vyre draws in a page runs in an ISOLATED WORLD (its own JavaScript globals, the page's DOM): a website cannot see window.__vyrePill, cannot
   * call or overwrite the stop and login bindings (they exist only in this world, by executionContextName), and cannot read the closed shadow root.
   * @type {Map<number, { frameId: string, contextId: number }>}
   */
  const worlds = new Map();
  const WORLD = "vyre-ui";
  /** Run a script in the tab's isolated world, making the world on first use and again after a navigation. @param {number} tabId @param {string} expression @param {boolean} [withBindings] */
  async function inWorld(tabId, expression, withBindings = true) {
    if (!cdp || !cdp.attached().includes(tabId)) return undefined;
    const run = async (/** @type {number} */ contextId) => cdp.send(tabId, "Runtime.evaluate", { expression, contextId, returnByValue: true });
    const make = async () => {
      const t = await cdp.send(tabId, "Page.getFrameTree", {});
      const frameId = t && t.frameTree && t.frameTree.frame && t.frameTree.frame.id;
      if (!frameId) throw new Error("no frame");
      const w = await cdp.send(tabId, "Page.createIsolatedWorld", { frameId, worldName: WORLD, grantUniveralAccess: false });
      worlds.set(tabId, { frameId, contextId: w.executionContextId });
      return w.executionContextId;
    };
    if (withBindings && !bound.has(tabId)) {
      bound.add(tabId);
      for (const name of ["vyreStop", "vyreLogin"]) await safe(() => cdp.send(tabId, "Runtime.addBinding", { name, executionContextName: WORLD }));
    }
    const have = worlds.get(tabId);
    try { return await run(have ? have.contextId : await make()); }
    catch { return safe(async () => run(await make())); }
  }
  /** The pill in a tab's top page. @param {number} tabId */
  async function pill(tabId) {
    if (!run) return;
    await safe(() => inWorld(tabId, pillScript(view())));
  }
  async function unpill(/** @type {number} */ tabId) {
    await safe(() => inWorld(tabId, pillGone));
    if (cdp && cdp.attached().includes(tabId)) for (const name of ["vyreStop", "vyreLogin"]) await safe(() => cdp.send(tabId, "Runtime.removeBinding", { name }));
    bound.delete(tabId); worlds.delete(tabId);
  }
  // Only the isolated world's own buttons reach these, and only these words are believed, whatever else a payload says.
  const STOP_VIA = new Set(["pill", "esc", "pause"]);
  const LOGIN_ACT = new Set(["continue", "skip"]);
  if (cdp && cdp.on) cdp.on((/** @type {number} */ tabId, /** @type {string} */ method, /** @type {any} */ p) => {
    if (method !== "Runtime.bindingCalled" || !p || !run) return;
    const w = worlds.get(tabId);
    if (!w || p.executionContextId !== w.contextId) return;
    const payload = String(p.payload || "");
    if (p.name === "vyreStop" && STOP_VIA.has(payload)) { run.paused = payload === "pause" ? "pause" : "stop"; onStop(payload); void paintBadge(); paintIcon(); for (const t of run.tabs) void pill(t); }
    else if (p.name === "vyreLogin" && run.waiting && LOGIN_ACT.has(payload)) onLogin(payload, tabId);
  });
  if (cdp && cdp.onDetach) cdp.onDetach((/** @type {number} */ tabId) => { bound.delete(tabId); worlds.delete(tabId); });

  /** Put a tab Vyre opened, or took over while it was not in a group of the person's, into the Vyre group. @param {number} tabId */
  async function group(tabId) {
    if (!chrome || !chrome.tabs || !chrome.tabs.group) return;
    const tab = await safe(() => chrome.tabs.get(tabId));
    if (!tab) return;
    const known = groups.get(tab.windowId);
    if (tab.groupId != null && tab.groupId !== -1) {
      if (tab.groupId === known) return;
      // In a group the person made: leave it. (A group we made earlier, from before a worker restart, is recognised by its title.)
      const g = chrome.tabGroups && chrome.tabGroups.get ? await safe(() => chrome.tabGroups.get(tab.groupId)) : null;
      if (g && Object.values(TITLES).includes(g.title)) groups.set(tab.windowId, tab.groupId);
      return;
    }
    let gid = known;
    if (gid == null && chrome.tabGroups && chrome.tabGroups.query) {
      const found = await safe(() => chrome.tabGroups.query({ windowId: tab.windowId, color: GROUP_COLOR }));
      if (found) for (let i = found.length - 1; i >= 0; i--) if (!Object.values(TITLES).includes(found[i].title)) found.splice(i, 1);
      if (found && found[0]) gid = found[0].id;
    }
    const id = await safe(() => chrome.tabs.group(gid != null ? { tabIds: [tabId], groupId: gid } : { tabIds: [tabId], createProperties: { windowId: tab.windowId } }));
    if (typeof id !== "number") { groups.delete(tab.windowId); return; }
    groups.set(tab.windowId, id);
    if (chrome.tabGroups && chrome.tabGroups.update) await safe(() => chrome.tabGroups.update(id, { title: run && run.waiting ? TITLES.turn : TITLES.working, color: GROUP_COLOR, collapsed: false }));
  }

  function arm() {
    if (idle) clearT(idle);
    idle = weak(setT(() => { void finish(); }, IDLE_MS));
  }

  async function begin() {
    if (run) return;
    run = { steps: 0, of: null, label: "", text: "", waiting: null, site: "", paused: null, failed: false, tabs: new Set(), startedAt: now(), changes: [] };
    paintIcon();
    beat = weak(setI(() => { if (run) for (const t of run.tabs) void pill(t); }, BEAT_MS));
    await paintBadge();
  }

  /** The run is over: clear the badge, stop the pulse, take the pill away, collapse the group. The finish card (section 4) gets the record. */
  async function finish() {
    if (!run) return;
    const done = run; run = null;
    if (idle) { clearT(idle); idle = null; }
    if (beat) { clearI(beat); beat = null; }
    paintIcon();
    await paintBadge();
    await retitle(TITLES.done);
    for (const t of done.tabs) await unpill(t);
    // What the run changed stays on screen as a card, in the last tab it worked in, until the person dismisses it.
    if (done.changes.length && cdp && done.tabs.size) {
      const last = [...done.tabs].pop();
      /** @type {Record<string, number>} */ const counts = {};
      for (const c of done.changes) counts[c.kind || "change"] = (counts[c.kind || "change"] || 0) + 1;
      if (last !== undefined) await safe(() => inWorld(last, cardScript({ counts, items: done.changes, steps: done.steps }), false));
    }
    // The group stays, titled "Vyre, done", for the person to look at; it goes back to plain "Vyre" on the next run. Nothing ever closes a tab.
    try { onFinish({ steps: done.steps, of: done.of, startedAt: done.startedAt, endedAt: now(), tabs: [...done.tabs], changes: done.changes, failed: done.failed }); } catch { /* the card must not break the shell */ }
  }

  const tabOfCall = (/** @type {any} */ args, /** @type {any} */ result) => {
    const a = args || {};
    for (const v of [a.tabId, a.tab, result && typeof result === "object" ? (result.tabId ?? (result.tab && result.tab.id) ?? result.id) : undefined]) if (typeof v === "number" && v > 0) return v;
    return undefined;
  };

  /** @type {any} */ let this_ = null;
  const api = {
    /** Who owns the badge (the connection diagnosis does, while failing). @param {() => boolean} f */
    badgeOwnedBy(f) { badgeOwned = f; },
    /** A run is on. */
    active: () => !!run,
    /** What the pill says right now. */
    label: text,
    /**
     * Wrap one op. Nothing here can make it fail or slow it by more than a few best-effort browser calls.
     * @template T @param {string} op @param {any} args @param {() => Promise<T>} fn @returns {Promise<T>}
     */
    async around(op, args, fn) {
      if (QUIET.test(op) || typeof op !== "string") return fn();
      await begin();
      if (!run) return fn();
      const pre = tabOfCall(args, undefined);
      { const tx = stepText(op, args); if (tx) run.text = tx; }
      if (pre !== undefined) { run.tabs.add(pre); void pill(pre); }
      if (idle) { clearT(idle); idle = null; }
      try {
        const r = await fn();
        if (run) {
          const t = tabOfCall(args, r);
          if (t !== undefined) { run.tabs.add(t); { const rr = /** @type {any} */ (r); if (rr && ((op === "tabs.open" && rr.opened !== false) || (/^tabs\.(use|find)/.test(op) && rr.reused === false))) await group(t); } void pill(t); }
          { const tx = stepText(op, args); if (tx) run.text = tx; }
          if (/^(batch\.run|ghl\.run|recipe\.run)$/.test(op)) run.steps += Math.max(0, Number(/** @type {any} */ (r) && /** @type {any} */ (r).done) || 0);
          else if (STEP.test(op)) run.steps += 1;
          if (r && typeof r === "object" && /** @type {any} */ (r).ok === false) run.failed = true;
          await paintBadge();
        }
        return r;
      } catch (e) {
        if (run) { run.failed = true; await paintBadge(); }
        throw e;
      } finally { if (run) arm(); }
    },
    /** What the server tells us: the plan length, a label, or that the person is wanted. @param {{ of?: number, label?: string, waiting?: string|null, done?: boolean }} s */
    async state(s) {
      if (!s || typeof s !== "object") return;
      if (s.done) { await finish(); return; }
      await begin();
      if (!run) return;
      // A notification the person cannot miss, and a reminder if the question is still open two minutes later. Never auto-answered, never timed out.
      if (s.notify && typeof s.notify === "object") {
        const n = { title: String(s.notify.title || "Vyre needs you").slice(0, 80), message: String(s.notify.message || "").slice(0, 200) };
        notify(n);
        const at = ++asked;
        remind = weak(setT(() => { if (run && run.waiting && asked === at) notify({ title: "Still waiting for you", message: n.message }); }, REMIND_MS));
      }
      if (s.waiting === null && remind) { clearT(remind); remind = null; }
      if (s.change && typeof s.change === "object") run.changes.push({ what: String(s.change.what || "").slice(0, 160), kind: String(s.change.kind || ""), url: s.change.url ? String(s.change.url).slice(0, 300) : "", at: now() });
      if (typeof s.login === "object" && s.login) run.site = String(s.login.site || "").slice(0, 60);
      if (s.waiting === null) run.site = "";
      if (s.stopped !== undefined) run.paused = s.stopped ? (s.stopped === "pause" ? "pause" : "stop") : null;
      if (typeof s.of === "number" && s.of > 0) run.of = s.of;
      if (typeof s.label === "string") run.label = s.label.slice(0, 120);
      if (s.waiting !== undefined) { run.waiting = s.waiting ? String(s.waiting).slice(0, 100) : null; if (expire) { clearT(expire); expire = null; } if (run.waiting) { const w0 = run.waiting; expire = weak(setT(() => { if (run && run.waiting === w0) void this_.state({ waiting: null }); }, WAIT_MAX_MS)); } if (run.waiting) { if (idle) { clearT(idle); idle = null; } } else arm(); }
      if (!run.waiting && !idle) arm();
      await paintBadge();
      paintIcon();
      for (const t of run.tabs) void pill(t);
    },
    /** A change the run made (for the finish card): one line, and where to open it. @param {{ what: string, url?: string, undo?: any }} c */
    change(c) { if (run) run.changes.push({ ...c, at: now() }); },
    finish,
    /** The centre of one of the pill's own buttons, so the trusted side can press it with a real click (the proof that the button reaches the binding). @param {number} tabId @param {string} label */
    async buttonPoint(tabId, label) {
      const r = await inWorld(tabId, `(() => { const p = window.__vyrePill; return p && p.rectOf ? p.rectOf(${JSON.stringify(String(label))}) : null; })()`);
      return r && r.result ? r.result.value : null;
    },
    /** For tests. */
    groups: () => new Map(groups),
  };
  this_ = api;
  return api;
}
