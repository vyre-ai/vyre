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

/** @param {any} ctx @param {string} url @param {boolean} focus */
async function open(ctx, url, focus, timeoutMs = 15_000) {
  const v = await ctx.floorUrl(url, "tabs.open");
  if (!v.allow) throw err("blocked", `${v.why} (${v.tier})`);
  const tab = await ctx.tabs.create({ url, active: focus });
  const set = await openedSet(ctx);
  set.add(tab.id);
  await saveOpened(ctx, set);
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

/** @type {{ name: string, ops: Record<string, (args: any, ctx: any) => Promise<any>> }} */
export default {
  name: "tabs",
  ops: {
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
        return { ...shape(best.s), reused: true, matched: best.how };
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

    "tabs.activate": async (args, ctx) => {
      if (typeof args.tabId !== "number") throw err("bad_request", "tabs.activate needs a tabId");
      await bring(ctx, args.tabId, true);
      return { id: args.tabId, active: true };
    },

    "tabs.close": async (args, ctx) => {
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

