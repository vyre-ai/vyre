// @ts-check
// presence: what the person sees while Vyre works in their Chrome (team/0.2/chrome-ux.md, section 1).
//
//   - the tabs Vyre opens go in a tab group named "Vyre" (a tab the person already put in a group of their own is left there),
//   - the toolbar badge counts steps, and the icon pulses while a step is in flight,
//   - a small pill in the tab Vyre is working in says "Vyre is working · step 12 of 20 · Esc to stop".
//
// It watches every op the shell runs (around()), so background API calls show too. It changes no page state the agent reads:
// the pill lives in a closed shadow root on an element the snapshot skips, takes no pointer events except its Stop button, and is
// removed when the run goes quiet. Every browser call is best effort: a missing API (an older Chrome, a fake) never fails an op.

/** Ops that advance the step count: each one is a thing the person could have done by hand. */
const STEP = /^(page\.(act|fill)|tabs\.(open|navigate|use)|api\.call|dev\.console\.eval|ghl\.section)/;
/** Ops that say nothing about work in progress. */
const QUIET = /^(caps|status|hello|presence|tabs\.(list|query)|frames\.list|dev\.state)/;
/** A run is over this long after its last op. */
export const IDLE_MS = 8000;
/** The tab pill is redrawn this often while work continues, so a navigation that replaced the document gets it back. */
export const BEAT_MS = 2000;
const PULSE_MS = 600;
export const GROUP_TITLE = "Vyre";
export const COLORS = { working: "#1a73e8", waiting: "#f29900", failed: "#d93025" };

/** The page side: one pill per document, updated in place. `text` and `stop` are the only inputs. @param {string} text @param {boolean} waiting */
export const pillScript = (text, waiting) => `(() => {
  const T = ${JSON.stringify(String(text).slice(0, 160))}, W = ${waiting ? "true" : "false"};
  const cur = window.__vyrePill;
  if (cur && cur.host.isConnected) { cur.set(T, W); return true; }
  const host = document.createElement("vyre-pill");
  host.setAttribute("data-vyre", "pill");
  host.style.cssText = "all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;pointer-events:none;";
  const root = host.attachShadow({ mode: "closed" });
  const box = document.createElement("div");
  box.style.cssText = "font:500 12px/1.2 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#fff;background:#1a73e8;border-radius:999px;padding:8px 12px;display:flex;gap:10px;align-items:center;box-shadow:0 2px 10px rgba(0,0,0,.3);max-width:70vw;";
  const dot = document.createElement("span");
  dot.style.cssText = "width:8px;height:8px;border-radius:50%;background:#fff;animation:v 1s ease-in-out infinite;";
  const st = document.createElement("style");
  st.textContent = "@keyframes v{0%,100%{opacity:1}50%{opacity:.3}}@media (prefers-reduced-motion:reduce){span{animation:none!important}}";
  const label = document.createElement("span");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "Stop";
  btn.style.cssText = "pointer-events:auto;font:inherit;color:#1a73e8;background:#fff;border:0;border-radius:999px;padding:3px 10px;cursor:pointer;";
  btn.addEventListener("click", e => { e.stopPropagation(); if (typeof window.vyreStop === "function") window.vyreStop("pill"); });
  box.append(dot, label, btn);
  root.append(st, box);
  const set = (t, w) => { label.textContent = t; box.style.background = w ? "#f29900" : "#1a73e8"; btn.style.color = w ? "#b06000" : "#1a73e8"; };
  set(T, W);
  document.addEventListener("keydown", e => { if (e.key === "Escape" && window.__vyrePill && window.__vyrePill.host.isConnected && typeof window.vyreStop === "function") window.vyreStop("esc"); }, true);
  (document.body || document.documentElement).appendChild(host);
  window.__vyrePill = { host, set };
  return true;
})()`;

/** Take the pill away. */
export const pillGone = `(() => { const c = window.__vyrePill; if (c && c.host) c.host.remove(); window.__vyrePill = undefined; return true; })()`;

/**
 * @param {{ chrome: any, cdp?: any, onStop?: (via: string) => void, now?: () => number, setT?: any, clearT?: any, setI?: any, clearI?: any, draw?: (frame: number) => Promise<any>, onFinish?: (run: any) => void }} o
 */
export function createPresence({ chrome, cdp, onStop = () => {}, now = Date.now, setT = setTimeout, clearT = clearTimeout, setI = setInterval, clearI = clearInterval, draw, onFinish = () => {} }) {
  /** The run in progress, or null. @type {null | { steps: number, of: number|null, label: string, waiting: string|null, failed: boolean, tabs: Set<number>, startedAt: number, changes: any[] }} */
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

  /** A timer that never keeps a process alive (under node, in tests); a service worker has no unref and needs none. */
  const weak = (/** @type {any} */ h) => { try { if (h && typeof h.unref === "function") h.unref(); } catch { /* not node */ } return h; };
  const safe = async (/** @type {() => any} */ f) => { try { return await f(); } catch { return undefined; } };
  const action = () => chrome && chrome.action;

  const text = () => {
    if (!run) return "";
    const n = run.of ? `step ${Math.min(run.steps + (run.waiting ? 0 : 1), run.of)} of ${run.of}` : `step ${run.steps + 1}`;
    if (run.waiting) return `Vyre is waiting for you · ${run.waiting}`;
    return `Vyre is working · ${n} · Esc to stop`;
  };

  async function paintBadge() {
    const a = action();
    if (!a || badgeOwned()) return;
    await safe(() => a.setBadgeText({ text: run ? (run.waiting ? "?" : run.failed ? "!" : String(run.steps)) : "" }));
    if (run) await safe(() => a.setBadgeBackgroundColor({ color: run && run.waiting ? COLORS.waiting : run && run.failed ? COLORS.failed : COLORS.working }));
    if (a.setTitle) await safe(() => a.setTitle({ title: run ? `Vyre for Chrome: ${text()}` : "Vyre for Chrome" }));
  }

  function startPulse() {
    if (pulse || !draw || !action() || !action().setIcon) return;
    pulse = weak(setI(async () => { frame ^= 1; const img = await safe(() => draw(frame)); if (img) await safe(() => action().setIcon({ imageData: img })); }, PULSE_MS));
  }
  async function stopPulse() {
    if (pulse) { clearI(pulse); pulse = null; }
    frame = 0;
    if (draw && action() && action().setIcon) { const img = await safe(() => draw(0)); if (img) await safe(() => action().setIcon({ imageData: img })); }
  }

  /** The pill in a tab's top page, through the debugger the agent already holds there. @param {number} tabId */
  async function pill(tabId) {
    if (!run || !cdp || !cdp.attached().includes(tabId)) return;
    if (!bound.has(tabId)) { bound.add(tabId); await safe(() => cdp.send(tabId, "Runtime.addBinding", { name: "vyreStop" })); }
    await safe(() => cdp.send(tabId, "Runtime.evaluate", { expression: pillScript(text(), !!(run && run.waiting)), returnByValue: true }));
  }
  async function unpill(/** @type {number} */ tabId) {
    if (!cdp || !cdp.attached().includes(tabId)) return;
    await safe(() => cdp.send(tabId, "Runtime.evaluate", { expression: pillGone, returnByValue: true }));
  }
  if (cdp && cdp.on) cdp.on((/** @type {number} */ tabId, /** @type {string} */ method, /** @type {any} */ p) => {
    if (method === "Runtime.bindingCalled" && p && p.name === "vyreStop" && run) onStop(String(p.payload || "pill"));
  });
  if (cdp && cdp.onDetach) cdp.onDetach((/** @type {number} */ tabId) => bound.delete(tabId));

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
      if (g && g.title === GROUP_TITLE) groups.set(tab.windowId, tab.groupId);
      return;
    }
    let gid = known;
    if (gid == null && chrome.tabGroups && chrome.tabGroups.query) {
      const found = await safe(() => chrome.tabGroups.query({ windowId: tab.windowId, title: GROUP_TITLE }));
      if (found && found[0]) gid = found[0].id;
    }
    const id = await safe(() => chrome.tabs.group(gid != null ? { tabIds: [tabId], groupId: gid } : { tabIds: [tabId], createProperties: { windowId: tab.windowId } }));
    if (typeof id !== "number") { groups.delete(tab.windowId); return; }
    groups.set(tab.windowId, id);
    if (chrome.tabGroups && chrome.tabGroups.update) await safe(() => chrome.tabGroups.update(id, { title: GROUP_TITLE, color: "blue", collapsed: false }));
  }

  function arm() {
    if (idle) clearT(idle);
    idle = weak(setT(() => { void finish(); }, IDLE_MS));
  }

  async function begin() {
    if (run) return;
    run = { steps: 0, of: null, label: "", waiting: null, failed: false, tabs: new Set(), startedAt: now(), changes: [] };
    startPulse();
    beat = weak(setI(() => { if (run) for (const t of run.tabs) void pill(t); }, BEAT_MS));
    await paintBadge();
  }

  /** The run is over: clear the badge, stop the pulse, take the pill away, collapse the group. The finish card (section 4) gets the record. */
  async function finish() {
    if (!run) return;
    const done = run; run = null;
    if (idle) { clearT(idle); idle = null; }
    if (beat) { clearI(beat); beat = null; }
    await stopPulse();
    await paintBadge();
    for (const t of done.tabs) await unpill(t);
    if (chrome && chrome.tabGroups && chrome.tabGroups.update) for (const gid of groups.values()) await safe(() => chrome.tabGroups.update(gid, { collapsed: true }));
    try { onFinish({ steps: done.steps, of: done.of, startedAt: done.startedAt, endedAt: now(), tabs: [...done.tabs], changes: done.changes, failed: done.failed }); } catch { /* the card must not break the shell */ }
  }

  const tabOfCall = (/** @type {any} */ args, /** @type {any} */ result) => {
    const a = args || {};
    for (const v of [a.tabId, a.tab, result && typeof result === "object" ? (result.tabId ?? (result.tab && result.tab.id) ?? result.id) : undefined]) if (typeof v === "number" && v > 0) return v;
    return undefined;
  };

  return {
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
      if (pre !== undefined) { run.tabs.add(pre); void pill(pre); }
      if (idle) { clearT(idle); idle = null; }
      try {
        const r = await fn();
        if (run) {
          const t = tabOfCall(args, r);
          if (t !== undefined) { run.tabs.add(t); if (/^tabs\.(open|use)/.test(op) && /** @type {any} */ (r) && /** @type {any} */ (r).reused === false) await group(t); void pill(t); }
          if (/^(batch\.run|ghl\.run)$/.test(op)) run.steps += Math.max(0, Number(/** @type {any} */ (r) && /** @type {any} */ (r).done) || 0);
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
      if (typeof s.of === "number" && s.of > 0) run.of = s.of;
      if (typeof s.label === "string") run.label = s.label.slice(0, 120);
      if (s.waiting !== undefined) { run.waiting = s.waiting ? String(s.waiting).slice(0, 100) : null; if (run.waiting && idle) { clearT(idle); idle = null; } else arm(); }
      await paintBadge();
      for (const t of run.tabs) void pill(t);
    },
    /** A change the run made (for the finish card): one line, and where to open it. @param {{ what: string, url?: string, undo?: any }} c */
    change(c) { if (run) run.changes.push({ ...c, at: now() }); },
    finish,
    /** For tests. */
    groups: () => new Map(groups),
  };
}

/** Draw the toolbar icon, frame 1 with a pulse ring, into ImageData at 16 and 32. Null where there is no canvas (the badge still works). @param {string} url32 */
export function iconDrawer(url32) {
  /** @type {any} */ let bmp = null;
  return async (/** @type {number} */ frame) => {
    const OC = /** @type {any} */ (globalThis).OffscreenCanvas;
    if (!OC || typeof fetch !== "function" || typeof createImageBitmap !== "function") return null;
    if (!bmp) bmp = await createImageBitmap(await (await fetch(url32)).blob());
    const out = {};
    for (const size of [16, 32]) {
      const c = new OC(size, size);
      const g = c.getContext("2d");
      g.drawImage(bmp, 0, 0, size, size);
      if (frame) { g.fillStyle = COLORS.working; g.beginPath(); g.arc(size - size * 0.22, size - size * 0.22, size * 0.2, 0, Math.PI * 2); g.fill(); g.strokeStyle = "#fff"; g.lineWidth = Math.max(1, size / 16); g.stroke(); }
      /** @type {any} */ (out)[size] = g.getImageData(0, 0, size, size);
    }
    return out;
  };
}
