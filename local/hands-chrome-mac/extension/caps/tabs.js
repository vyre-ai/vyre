// @ts-check
// tabs: find, reuse and (only when nothing fits) open the person's tabs.
//
// Opening a tab costs 200 ms to 2 s and pulls attention, so tabs.use looks first: exact URL,
// then same origin with a path prefix, then same origin, preferring the tab the person already has
// in front. It never focuses unless asked (focus:true) and never opens unless nothing matches, a
// url was given and openIfMissing is not false. Tabs Vyre opened are remembered in
// chrome.storage.session and are the only tabs tabs.close will close.
//
// Blind tabs (floor.js) are listed as {url:"[blind]", title:""} so a model knows a tab exists
// without learning what it is, and they never match a search.

import { redact } from "../lib/shared.js";
import { err } from "../lib/err.js";

const OPENED = "tabs.opened";
const PREFETCHED = "tabs.prefetched";
const MAX_MANY = 6;
const MAX_PREFETCH = 6;

/** @param {string} u */
const stripHash = u => { try { const x = new URL(u); x.hash = ""; return x.href.replace(/\/$/, ""); } catch { return u; } };
/** @param {string} u */
const parse = u => { try { return new URL(u); } catch { return null; } };

/** @param {any} ctx @returns {Promise<Set<number>>} */
async function openedSet(ctx) { return new Set((await ctx.storage.get("session", OPENED)) || []); }
/** @param {any} ctx @param {Set<number>} s */
const saveOpened = (ctx, s) => ctx.storage.set("session", { [OPENED]: [...s] });

/**
 * @param {any} ctx
 * @returns {Promise<{ tab: any, blind: boolean, opened: boolean, active: boolean }[]>}
 */
async function survey(ctx) {
  const [all, opened, last] = await Promise.all([ctx.tabs.query({}), openedSet(ctx), ctx.tabs.active()]);
  const alive = new Set(all.map(t => t.id));
  const kept = new Set([...opened].filter(id => alive.has(id)));
  if (kept.size !== opened.size) await saveOpened(ctx, kept);
  const out = [];
  for (const tab of all) {
    const v = await ctx.floorUrl(tab.pendingUrl || tab.url, "tabs.list");
    out.push({ tab, blind: !v.allow && v.tier === "blind", opened: kept.has(tab.id), active: !!last && last.id === tab.id });
  }
  return out;
}

/** @param {{ tab: any, blind: boolean, opened: boolean }} s */
const shape = s => ({
  id: s.tab.id, windowId: s.tab.windowId,
  url: s.blind ? "[blind]" : redact.url(s.tab.url || s.tab.pendingUrl || ""),
  title: s.blind ? "" : String(s.tab.title || ""),
  active: !!s.tab.active, opened: s.opened,
});

/**
 * Rank the open, non-blind tabs against a match. Lower tier is a better match.
 * @param {Awaited<ReturnType<typeof survey>>} tabs @param {{ url?: string, origin?: string, title?: string }} match
 */
function rank(tabs, match) {
  const want = match.url ? parse(match.url) : null;
  const wantOrigin = match.origin || (want && want.origin) || "";
  const wantUrl = match.url ? stripHash(match.url) : "";
  const title = (match.title || "").toLowerCase();
  const scored = [];
  for (const s of tabs) {
    if (s.blind) continue;
    const url = s.tab.url || s.tab.pendingUrl || "";
    if (title && !String(s.tab.title || "").toLowerCase().includes(title)) continue;
    const u = parse(url);
    let tier = -1, how = "";
    if (wantUrl && stripHash(url) === wantUrl) { tier = 0; how = "exact url"; }
    else if (u && wantOrigin && u.origin === wantOrigin) {
      const p = want ? want.pathname : "/";
      tier = p !== "/" && (u.pathname === p || u.pathname.startsWith(p.replace(/\/$/, "") + "/")) ? 1 : 2;
      how = tier === 1 ? "same origin and path" : "same origin";
    } else if (!wantUrl && !wantOrigin && title) { tier = 2; how = "title"; }
    if (tier >= 0) scored.push({ s, tier, how });
  }
  // Within a tier: the tab in front, then a tab in front of its own window, then the oldest id.
  scored.sort((a, b) => a.tier - b.tier || Number(b.s.active) - Number(a.s.active) || Number(!!b.s.tab.active) - Number(!!a.s.tab.active) || a.s.tab.id - b.s.tab.id);
  return scored;
}

/** @param {any} args */
function matchOf(args) {
  const m = { ...(args.match || {}) };
  if (!m.url && !m.origin && !m.title && typeof args.url === "string") m.url = args.url;
  return m;
}

/** @param {any} ctx @param {number} tabId @param {boolean} focus */
async function bring(ctx, tabId, focus) {
  if (!focus) return;
  const t = await ctx.tabs.update(tabId, { active: true });
  if (t && t.windowId != null) await ctx.tabs.focusWindow(t.windowId);
}

/** Pages open together, so the remembered set is changed one at a time: two reads of it would each lose the other's tab. */
let marking = Promise.resolve();
/** @param {any} ctx @param {number} id */
function remember(ctx, id) {
  const next = marking.then(async () => { const set = await openedSet(ctx); set.add(id); await saveOpened(ctx, set); });
  marking = next.catch(() => {});
  return next;
}

/** @param {any} ctx @param {string} url @param {boolean} focus */
async function open(ctx, url, focus, timeoutMs = 15_000) {
  const v = await ctx.floorUrl(url, "tabs.open");
  if (!v.allow) throw err("blocked", `${v.why} (${v.tier})`);
  const tab = await ctx.tabs.create({ url, active: focus });
  await remember(ctx, tab.id);
  // Resolve only when the tab has committed to the page and finished loading (or the time is up), so the next call sees the real page,
  // never a tab that is still loading or already sitting on Chrome's error page.
  const s = ctx.tabs.settle ? await ctx.tabs.settle(tab.id, Math.min(60_000, Math.max(0, Number(timeoutMs) || 15_000))) : { tab, settled: true, waitedMs: 0 };
  return { created: tab, tab: s.tab || tab, settled: s.settled, waitedMs: s.waitedMs };
}

/**
 * What an open tab ended up as, said plainly: loaded, still loading, or Chrome's error page (the site did not load).
 * @param {any} r the result of open() @param {string} asked the URL that was asked for
 */
function landed(r, asked) {
  const url = String((r.tab && (r.tab.url || r.tab.pendingUrl)) || "");
  const failed = url.startsWith("chrome-error:");
  return { finalUrl: redact.url(url || asked), title: String((r.tab && r.tab.title) || "").slice(0, 120), loaded: r.settled && !failed, ...(failed ? { failed: "the page did not load: Chrome is showing its own error page (no network, a wrong address or a refused connection). The tab is open; check the address and try again." } : {}), ...(!r.settled && !failed ? { stillLoading: true } : {}), waitedMs: r.waitedMs };
}


/** Tabs opened ahead of need (in the background, in order). @param {any} ctx @returns {Promise<number[]>} */
async function prefetchedList(ctx) { return ((await ctx.storage.get("session", PREFETCHED)) || []).filter(/** @param {any} n */ n => Number.isInteger(n)); }
/** @param {any} ctx @param {number[]} l */
const savePrefetched = (ctx, l) => ctx.storage.set("session", { [PREFETCHED]: l });

/**
 * Open several pages at once, each reused when a tab already shows that exact URL. The loads run together, so the wait is the slowest page, not
 * the sum. Every URL goes through the same floor as tabs.open; one that fails does not stop the others.
 * @param {any} ctx @param {any} args @param {boolean} prefetch
 */
async function many(ctx, args, prefetch) {
  const urls = Array.isArray(args.urls) ? args.urls.filter((/** @type {any} */ u) => typeof u === "string" && u) : [];
  if (!urls.length) throw err("bad_request", `${prefetch ? "tabs.prefetch" : "tabs.many"} needs urls: [...]`);
  if (urls.length > MAX_MANY) throw err("bad_request", `at most ${MAX_MANY} urls at once`);
  const focus = args.focus === true && !prefetch;
  const have = await survey(ctx);
  const t0 = Date.now();
  const out = await Promise.all(urls.map(async (/** @type {string} */ url) => {
    const hit = rank(have, { url }).find(h => h.tier === 0);
    if (hit) return { url: redact.url(url), id: hit.s.tab.id, reused: true, loaded: true };
    try {
      const r = await open(ctx, url, focus, Number(args.timeoutMs) || undefined);
      const l = landed(r, url);
      return { url: redact.url(url), id: r.created.id, opened: true, loaded: l.loaded, ...(l.failed ? { failed: l.failed } : {}), ...(l.stillLoading ? { stillLoading: true } : {}) };
    } catch (e) { return { url: redact.url(url), error: String(/** @type {any} */ (e)?.message || e).slice(0, 200), code: /** @type {any} */ (e)?.code || "error" }; }
  }));
  let closed = [];
  if (prefetch) {
    // Pages fetched ahead stay in the background; past the cap the oldest unused ones are closed (only tabs Vyre opened).
    const live = new Set((await ctx.tabs.query({})).map((/** @type {any} */ t) => t.id));
    const list = (await prefetchedList(ctx)).filter(id => live.has(id));
    for (const o of out) if (o.opened && typeof o.id === "number") list.push(o.id);
    const keep = list.slice(-MAX_PREFETCH);
    closed = list.slice(0, list.length - keep.length);
    const set = await openedSet(ctx);
    for (const id of closed) { try { await ctx.tabs.remove(id); } catch { /* gone */ } set.delete(id); try { await ctx.cdp.detach(id); } catch { /* not attached */ } }
    await saveOpened(ctx, set);
    await savePrefetched(ctx, keep);
  }
  return { tabs: out, ms: Date.now() - t0, ...(prefetch ? { prefetched: true, closedOldest: closed } : {}) };
}

/** @type {{ name: string, ops: Record<string, (args: any, ctx: any) => Promise<any>> }} */
export default {
  name: "tabs",
  ops: {
    // What the person sees of Vyre's work in this tab: the run label, the tab's group, whether the pill is in the page.
    "tabs.presence": async (args, ctx) => {
      const tabId = typeof args.tabId === "number" ? args.tabId : undefined;
      const p = ctx.presence;
      const out = { active: !!(p && p.active()), label: p ? p.label() : "", group: null, pill: null, card: null, exposedToPage: null };
      if (tabId !== undefined) {
        try { const t = await ctx.tabs.get(tabId); if (t && t.groupId != null && t.groupId !== -1) { const g = chrome.tabGroups ? await chrome.tabGroups.get(t.groupId) : null; out.group = g ? { id: g.id, title: g.title, color: g.color, collapsed: g.collapsed } : { id: t.groupId }; } } catch { /* no groups API */ }
        try {
          const r = await ctx.cdp.send(tabId, "Runtime.evaluate", { expression: "JSON.stringify({ pill: !!document.querySelector('vyre-pill'), card: !!document.querySelector('vyre-card'), stop: typeof window.vyreStop, login: typeof window.vyreLogin, state: typeof window.__vyrePill })", returnByValue: true });
          const v = JSON.parse(r && r.result ? r.result.value : "{}");
          out.pill = !!v.pill; out.card = !!v.card;
          // What a website's own script can see of Vyre: nothing should be there.
          out.exposedToPage = { vyreStop: v.stop !== "undefined", vyreLogin: v.login !== "undefined", pillState: v.state !== "undefined" };
        } catch { /* not attached */ }
        // A real mouse click on one of the pill's own buttons, to prove the button reaches the stop. The same as the person clicking it.
        if (args.press && ["Stop", "Pause"].includes(String(args.press)) && p && p.buttonPoint) {
          const pt = await p.buttonPoint(tabId, String(args.press));
          out.pressed = !!pt;
          if (pt) for (const type of ["mousePressed", "mouseReleased"]) await ctx.cdp.send(tabId, "Input.dispatchMouseEvent", { type, x: pt.x, y: pt.y, button: "left", clickCount: 1 });
        }
      }
      return out;
    },

    "tabs.list": async (_args, ctx) => ({ tabs: (await survey(ctx)).map(shape) }),

    "tabs.find": async (args, ctx) => {
      const m = matchOf(args);
      if (!m.url && !m.origin && !m.title) throw err("bad_request", "match needs a url, origin or title");
      const hits = rank(await survey(ctx), m);
      return { tabs: hits.map(h => ({ ...shape(h.s), matched: h.how })) };
    },

    "tabs.use": async (args, ctx) => {
      const m = matchOf(args);
      if (!m.url && !m.origin && !m.title) throw err("bad_request", "tabs.use needs a match or a url");
      const focus = args.focus === true;
      const best = rank(await survey(ctx), m)[0];
      if (best) {
        await bring(ctx, best.s.tab.id, focus);
        const ahead = await prefetchedList(ctx);
        const was = ahead.includes(best.s.tab.id);
        if (was) await savePrefetched(ctx, ahead.filter(id => id !== best.s.tab.id));
        return { ...shape(best.s), reused: true, matched: best.how, ...(was ? { prefetched: true } : {}) };
      }
      if (typeof args.url !== "string" || args.openIfMissing === false) throw err("no_tab", "no open tab matches and none was opened");
      const r = await open(ctx, args.url, focus, Number(args.timeoutMs) || undefined);
      const l = landed(r, args.url);
      return { id: r.created.id, windowId: r.created.windowId, url: l.finalUrl, title: l.title, active: !!r.created.active, opened: true, reused: false, matched: "opened", loaded: l.loaded, ...(l.failed ? { failed: l.failed } : {}), ...(l.stillLoading ? { stillLoading: true } : {}), waitedMs: l.waitedMs };
    },

    "tabs.open": async (args, ctx) => {
      if (typeof args.url !== "string" || !args.url) throw err("bad_request", "tabs.open needs a url");
      const r = await open(ctx, args.url, args.focus === true, Number(args.timeoutMs) || undefined);
      const l = landed(r, args.url);
      return { id: r.created.id, windowId: r.created.windowId, url: l.finalUrl, title: l.title, opened: true, loaded: l.loaded, ...(l.failed ? { failed: l.failed } : {}), ...(l.stillLoading ? { stillLoading: true } : {}), waitedMs: l.waitedMs };
    },

    // Open (or reuse) several pages together. tabs.prefetch is the same, for pages the person will want next: always in the background, capped, oldest closed first.
    "tabs.many": (args, ctx) => many(ctx, args, false),
    "tabs.prefetch": (args, ctx) => many(ctx, args, true),

    "tabs.activate": async (args, ctx) => {
      if (typeof args.tabId !== "number" && typeof args.tab === "number") args = { ...args, tabId: args.tab };
      if (typeof args.tabId !== "number") throw err("bad_request", "tabs.activate needs a tabId");
      await bring(ctx, args.tabId, true);
      return { id: args.tabId, active: true };
    },

    "tabs.close": async (args, ctx) => {
      if (typeof args.tabId !== "number" && typeof args.tab === "number") args = { ...args, tabId: args.tab };
      if (typeof args.tabId !== "number") throw err("bad_request", "tabs.close needs a tabId");
      const set = await openedSet(ctx);
      if (!set.has(args.tabId)) throw err("blocked", "Vyre did not open that tab, so it will not close it");
      await ctx.tabs.remove(args.tabId);
      set.delete(args.tabId);
      await saveOpened(ctx, set);
      await ctx.cdp.detach(args.tabId);
      return { id: args.tabId, closed: true };
    },

    // The debugger attach is normally invisible (every op attaches on first use and keeps it). These
    // two exist so its cost can be measured and so a person or a test can release a tab explicitly.
    "tabs.attach": async (args, ctx) => {
      if (typeof args.tabId !== "number") throw err("bad_request", "tabs.attach needs a tabId");
      const t0 = Date.now();
      await ctx.cdp.attach(args.tabId);
      return { id: args.tabId, attached: true, ms: Date.now() - t0 };
    },

    "tabs.detach": async (args, ctx) => {
      if (typeof args.tabId !== "number") throw err("bad_request", "tabs.detach needs a tabId");
      await ctx.cdp.detach(args.tabId);
      return { id: args.tabId, attached: false };
    },

    "tabs.navigate": async (args, ctx) => {
      if (typeof args.url !== "string" || !args.url) throw err("bad_request", "tabs.navigate needs a url");
      let id = args.tabId;
      if (typeof id !== "number") {
        const a = await ctx.tabs.active();
        if (!a) throw err("no_tab");
        id = a.id;
        const cur = await ctx.floorAllows(id, "tabs.navigate");
        if (!cur.allow) throw err("blocked", `${cur.why} (${cur.tier})`);
      }
      const target = await ctx.floorUrl(args.url, "tabs.open");
      if (!target.allow) throw err("blocked", `${target.why} (${target.tier})`);
      await ctx.tabs.update(id, { url: args.url });
      const st = ctx.tabs.settle ? await ctx.tabs.settle(id, Math.min(60_000, Math.max(0, Number(args.timeoutMs) || 15_000))) : null;
      const now = st && st.tab ? String(st.tab.url || "") : "";
      const failed = now.startsWith("chrome-error:");
      return { id, url: redact.url(now || args.url), ...(st ? { loaded: st.settled && !failed, waitedMs: st.waitedMs } : {}), ...(failed ? { failed: "the page did not load: Chrome is showing its own error page. Check the address and try again." } : {}) };
    },
  },
};

