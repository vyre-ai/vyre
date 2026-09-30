// @ts-check
// frames: the tab's frames, listed honestly, and a way to run a script in one of them (real-use finding: the GoHighLevel workflow builder is
// a cross-origin iframe, and a page tool that only sees the top document sees only the shell).
//
//   frames.list   every frame: index, origin, url, depth, whether a script can run in it and how, and which are NOT readable and why
//   frames.probe  what each readable frame says its title is, and whether Chrome accepted auto-attach: the quickest way to see if child
//                 frames work on this Chrome

import { err } from "../lib/err.js";

/** @param {any} ctx @param {any} args */
async function tabOf(ctx, args) {
  if (typeof args.tabId === "number") return args.tabId;
  const a = await ctx.tabs.active();
  if (!a) throw err("no_tab");
  const v = await ctx.floorAllows(a.id, "frames.list");
  if (!v.allow) throw err("blocked", `${v.why} (${v.tier})`);
  return a.id;
}

/** @type {{ name: string, ops: Record<string, (args: any, ctx: any) => Promise<any>> }} */
export default {
  name: "frames",
  ops: {
    "frames.list": async (args, ctx) => {
      const tab = await tabOf(ctx, args);
      const frames = await ctx.frames.list(tab);
      return {
        tab, count: frames.length,
        frames: frames.map((/** @type {any} */ f) => ({ index: f.index, depth: f.depth, origin: f.origin, url: String(f.url).split(/[?#]/)[0], ...(f.name ? { name: f.name } : {}), readable: f.readable, via: f.how, ...(f.why ? { why: f.why } : {}) })),
        notReadable: ctx.frames.unreadable(frames).map((/** @type {any} */ f) => ({ index: f.index, origin: f.origin })),
        autoAttach: ctx.cdp.autoAttachStatus ? ctx.cdp.autoAttachStatus(tab) : null,
      };
    },

    "frames.probe": async (args, ctx) => {
      const tab = await tabOf(ctx, args);
      const frames = await ctx.frames.list(tab);
      const rows = [];
      for (const f of frames) {
        if (!f.readable) { rows.push({ index: f.index, origin: f.origin, readable: false, why: f.why }); continue; }
        try {
          const r = await ctx.frames.evalIn(tab, f, "({ title: document.title, url: location.href, controls: document.querySelectorAll('button, a, input, select, textarea, [role=button]').length })", { returnByValue: true });
          rows.push({ index: f.index, origin: f.origin, via: f.how, readable: true, ...(r && r.result && r.result.value ? r.result.value : {}) });
        } catch (e) { rows.push({ index: f.index, origin: f.origin, readable: false, why: String(/** @type {any} */ (e).message).slice(0, 160) }); }
      }
      return { tab, frames: rows, autoAttach: ctx.cdp.autoAttachStatus ? ctx.cdp.autoAttachStatus(tab) : null, children: ctx.cdp.children ? ctx.cdp.children(tab).map((/** @type {any} */ c) => ({ type: c.type, url: String(c.url).split(/[?#]/)[0] })) : [] };
    },

    // A diagnostic, not a tool for acting: where does a mouse click in a frame actually land? It clicks the same element twice by the two ways Input can be sent
    // (the top page's session at top-viewport coordinates, then the frame's own session at frame coordinates) and counts what the page received.
    "frames.clicktest": async (args, ctx) => {
      const tab = await tabOf(ctx, args);
      const frames = await ctx.frames.list(tab);
      const f = ctx.frames.pickFrom(frames, args.frame);
      if (!f || !f.readable) throw err("not_found", `no readable frame matches ${JSON.stringify(args.frame)}`);
      const sel = JSON.stringify(String(args.css || "button"));
      await ctx.frames.evalIn(tab, f, `(() => { window.__vyreClicks = 0; if (!window.__vyreClicksOn) { window.__vyreClicksOn = true; document.addEventListener('click', () => { window.__vyreClicks++; }, true); } return true; })()`, { returnByValue: true });
      const at = await ctx.frames.evalIn(tab, f, `(() => { const e = document.querySelector(${sel}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio }; })()`, { returnByValue: true });
      const pt = at && at.result && at.result.value;
      if (!pt) throw err("not_found", `nothing matches ${sel} in frame ${f.index}`);
      const count = async () => { const r = await ctx.frames.evalIn(tab, f, "window.__vyreClicks", { returnByValue: true }); return r && r.result ? r.result.value : null; };
      const off = await ctx.frames.offset(tab, f, frames);
      const press = async (/** @type {string|undefined} */ session, /** @type {number} */ x, /** @type {number} */ y) => {
        for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await ctx.cdp.send(tab, "Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }, session);
      };
      await press(undefined, pt.x + off.dx, pt.y + off.dy);
      await new Promise(r => setTimeout(r, 150));
      const viaTop = await count();
      if (f.session) { await press(f.session, pt.x, pt.y); await new Promise(r => setTimeout(r, 150)); }
      const total = await count();
      return { frame: f.index, origin: f.origin, session: f.session || null, point: pt, offset: off, viaTopSession: viaTop, viaFrameSession: f.session ? total - (viaTop || 0) : null, total };
    },
  },
};
