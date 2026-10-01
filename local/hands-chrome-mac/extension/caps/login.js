// @ts-check
// login: the person signs in, Vyre waits (team/0.2/chrome-ux.md, section 2).
//
// A login wall is a page that asks for a password, a one-time code, or sits on a known sign-in host. On one, login.handoff brings
// that tab to the front, outlines the form, tells the person once (a "login.wall" event the module turns into one chat line) and
// marks the run as waiting for them. login.wait polls until the wall is gone for two looks in a row and then clears the outline and
// the waiting state ("login.done"). Nothing here types anything: a password goes in through the person's hands or through a vault
// fill, never through this file. It reads the page only as far as the floor lets any read go.

import { err } from "../lib/err.js";
import { passwordFieldScript } from "../shared/guards.js";
import { isGhlHost } from "../shared/ghlhosts.js";

/** Sign-in hosts whose every page is a wall, and the paths that mean one anywhere. */
const AUTH_HOST = /(^|\.)(accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com|appleid\.apple\.com|[a-z0-9-]+\.okta\.com|[a-z0-9-]+\.auth0\.com|login\.salesforce\.com|id\.atlassian\.com|github\.com\/login)$/i;
const AUTH_PATH = /^\/(login|log-in|signin|sign-in|sign_in|auth|sso|oauth2?\/authorize|session\/new|users\/sign_in)(\/|$|\?)/i;
export const POLL_MS = 2000;
export const MAX_WAIT_MS = 10 * 60_000;

/** One-time-code and verification prompts: a short code field with words that say what it is. */
export const otpScript = `(() => {
  const vis = e => { try { if (!e.getClientRects().length) return false; const s = getComputedStyle(e); return s.visibility !== "hidden" && s.display !== "none"; } catch { return false; } };
  const text = String((document.body && document.body.innerText) || "").slice(0, 4000);
  const words = /(verification code|authenticator|two-factor|2-step|two-step|one-time (code|password)|security code|enter the code|6-digit)/i.test(text);
  for (const e of document.querySelectorAll("input")) {
    if (!vis(e)) continue;
    const t = String(e.getAttribute("type") || "text").toLowerCase();
    if (!["text", "tel", "number", ""].includes(t)) continue;
    const ac = String(e.getAttribute("autocomplete") || "").toLowerCase();
    const nm = [e.name, e.id, e.getAttribute("aria-label"), e.placeholder].join(" ").toLowerCase();
    const short = Number(e.maxLength) > 0 && Number(e.maxLength) <= 8;
    if (ac === "one-time-code" || (/(otp|2fa|mfa|totp|verif|passcode|security.?code)/.test(nm) && (short || words)) || (words && short)) return true;
  }
  return false;
})()`;

/** Light the password or code field's form (a two-tone ring that reads on light and dark pages, the rest of the page dimmed by half) and bring it into view; or put it back. @param {boolean} on */
export const highlightScript = (on) => `(() => {
  for (const e of document.querySelectorAll("[data-vyre-hl]")) { e.style.boxShadow = e.getAttribute("data-vyre-hl") || ""; e.removeAttribute("data-vyre-hl"); }
  if (!${on ? "true" : "false"}) return true;
  const vis = e => { try { return !!e.getClientRects().length; } catch { return false; } };
  const f = [...document.querySelectorAll("input")].find(e => vis(e) && (String(e.type).toLowerCase() === "password" || /one-time-code|current-password/.test(String(e.autocomplete || ""))))
    || [...document.querySelectorAll("input")].find(e => vis(e) && /(otp|2fa|mfa|verif|passcode|code)/i.test([e.name, e.id, e.placeholder].join(" ")));
  if (!f) return false;
  const box = f.closest("form") || f.parentElement || f;
  box.setAttribute("data-vyre-hl", box.style.boxShadow || "");
  box.style.boxShadow = "0 0 0 3px #171513, 0 0 0 5px #EDE8DC, 0 0 18px 6px rgba(237,232,220,.45), 0 0 0 9999px rgba(0,0,0,.5)";
  try { box.scrollIntoView({ block: "center" }); f.focus({ preventScroll: true }); } catch { /* the page may refuse */ }
  return true;
})()`;

/** Names only for a host that IS the vendor's: an exact registrable-domain match, never a substring (google-login.evil.example is not Google). Anything else is named by its host. @param {string} host */
export function appName(host) {
  const h = String(host || "").toLowerCase().replace(/:\d+$/, "");
  const on = (/** @type {string} */ d) => h === d || h.endsWith("." + d);
  if (isGhlHost(h)) return "GoHighLevel";
  if (on("google.com") || on("accounts.google.com")) return "Google";
  if (on("microsoftonline.com") || on("live.com") || on("microsoft.com")) return "Microsoft";
  if (on("github.com")) return "GitHub";
  return h || "the site";
}

/** The host a person sees next to the name, always. @param {string} host */
export const bareHost = host => String(host || "").toLowerCase().replace(/:\d+$/, "");

/**
 * Is this tab at a login wall? Looks in every readable frame. Returns what kind and in which frame, never a value.
 * @param {any} ctx @param {number} tabId
 */
export async function check(ctx, tabId) {
  const tab = await ctx.tabs.get(tabId);
  const url = String(tab.pendingUrl || tab.url || "");
  let host = "", path = "";
  try { const u = new URL(url); host = u.host; path = u.pathname + u.search; } catch { /* no URL yet */ }
  if (!host || /^(about|chrome|chrome-error|data):/i.test(url)) return { wall: false, host, reason: "no page" };
  if (AUTH_HOST.test(host)) return { wall: true, kind: "sign-in host", host, app: appName(host) };
  const list = ctx.frames && ctx.frames.list ? await ctx.frames.list(tabId).catch(() => []) : [];
  for (const f of list.length ? list.filter((/** @type {any} */ x) => x.readable) : [null]) {
    /** @param {string} js */
    const run = async js => { const r = f && f.how !== "top" ? await ctx.frames.evalIn(tabId, f, js, { returnByValue: true }) : await ctx.cdp.send(tabId, "Runtime.evaluate", { expression: js, returnByValue: true }); return r && r.result ? r.result.value : undefined; };
    try {
      if (await run(passwordFieldScript) === true) return { wall: true, kind: "password", host, frame: f ? f.index : 0, app: appName(host) };
      if (await run(otpScript) === true) return { wall: true, kind: "code", host, frame: f ? f.index : 0, app: appName(host) };
    } catch { /* an unreadable frame is not a wall */ }
  }
  if (AUTH_PATH.test(path)) return { wall: true, kind: "sign-in page", host, app: appName(host) };
  return { wall: false, host };
}

/** @type {Map<number, { since: number, app: string }>} tabs the person has been asked to sign in to */
const waiting = new Map();
/** What the person pressed on the pill: Continue (look again now) or Skip (give up on this sign-in). A page can press these too; both are harmless, because the wait still checks the wall is really gone. @type {Map<number, string>} */
const pressed = new Map();
/** @param {number} tabId @param {string} action */
export function signal(tabId, action) { if (action === "continue" || action === "skip") pressed.set(tabId, action); }

/**
 * Bring the tab to the front, outline the form, tell the person once.
 * @param {any} ctx @param {number} tabId @param {any} wall
 */
export async function handoff(ctx, tabId, wall) {
  const have = waiting.get(tabId);
  if (have) return { handedOff: false, already: true, app: have.app };
  const tab = await ctx.tabs.get(tabId);
  try { await ctx.tabs.update(tabId, { active: true }); if (tab.windowId != null && ctx.tabs.focusWindow) await ctx.tabs.focusWindow(tab.windowId); } catch { /* the tab may be gone */ }
  try { await ctx.cdp.send(tabId, "Runtime.evaluate", { expression: highlightScript(true), returnByValue: true }); } catch { /* not attached; the front tab is the main thing */ }
  waiting.set(tabId, { since: Date.now(), app: wall.app });
  const host = bareHost(wall.host);
  const named = host && host !== wall.app ? `${wall.app} (${host})` : wall.app;
  const message = `Sign in to ${named} in the window I opened. I'll carry on when you're in.`;
  if (ctx.presence) await ctx.presence.state({ waiting: `sign in to ${named}`, login: { site: named } });
  ctx.emit({ event: "login.wall", tab: tabId, app: wall.app, host, kind: wall.kind, message });
  return { handedOff: true, app: wall.app, message };
}

/** @param {any} ctx @param {number} tabId @param {string} [app] */
async function done(ctx, tabId, app) {
  waiting.delete(tabId);
  try { await ctx.cdp.send(tabId, "Runtime.evaluate", { expression: highlightScript(false), returnByValue: true }); } catch { /* gone */ }
  if (ctx.presence) await ctx.presence.state({ waiting: null });
  ctx.emit({ event: "login.done", tab: tabId, app });
}

/** A failed page op on a login page is not the page's fault: hand the tab to the person and say so. Returns the error to send, or null when this is not a wall.
 * @param {string} op @param {any} args @param {{ code?: string, message?: string }} e @param {any} ctx */
export async function onFailure(op, args, e, ctx) {
  if (!/^(page\.|batch\.run|ghl\.|frames\.|dev\.console\.eval)/.test(op) || typeof args?.tabId !== "number") return null;
  if (!["not_found", "timeout", "covered", "tied", "blocked", "not_saved"].includes(String(e && e.code))) return null;
  let w;
  try { w = await check(ctx, args.tabId); } catch { return null; }
  if (!w.wall) return null;
  const h = await handoff(ctx, args.tabId, w);
  return { code: "login_required", message: `${w.app}${bareHost(w.host) && bareHost(w.host) !== w.app ? ` (${bareHost(w.host)})` : ""} is asking the person to sign in (${w.kind}), so this step could not run. I brought that tab to the front and told them. Call chrome_login with action "wait" and I will carry on when they are in. Do not type a password.`, detail: { app: w.app, kind: w.kind, handedOff: h.handedOff, tab: args.tabId } };
}

/** @type {{ name: string, ops: Record<string, (args: any, ctx: any) => Promise<any>> }} */
export default {
  name: "login",
  ops: {
    "login.check": async (args, ctx) => {
      if (typeof args.tabId !== "number") throw err("bad_request", "login.check needs a tab");
      return { ...(await check(ctx, args.tabId)), waitingForPerson: waiting.has(args.tabId) };
    },
    "login.handoff": async (args, ctx) => {
      if (typeof args.tabId !== "number") throw err("bad_request", "login.handoff needs a tab");
      const w = await check(ctx, args.tabId);
      if (!w.wall) return { wall: false, handedOff: false };
      return { wall: true, kind: w.kind, ...(await handoff(ctx, args.tabId, w)) };
    },
    /** Wait until the person is in. Returns when the wall has been gone for two looks in a row, or at the timeout. */
    "login.wait": async (args, ctx) => {
      if (typeof args.tabId !== "number") throw err("bad_request", "login.wait needs a tab");
      const tabId = args.tabId;
      const limit = Math.min(Math.max(Number(args.timeoutMs) || 120_000, 1000), MAX_WAIT_MS);
      const t0 = Date.now();
      const nap = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));
      let first = await check(ctx, tabId);
      if (!first.wall && !waiting.has(tabId)) return { ok: true, signedIn: true, waitedMs: 0, note: "there was no sign-in wall" };
      if (first.wall) await handoff(ctx, tabId, first);
      const app = (waiting.get(tabId) || { app: first.app }).app;
      let clear = 0;
      while (Date.now() - t0 < limit) {
        if (ctx.stopped()) throw err("stopped");
        // Sleep in short slices so a press on the pill is heard at once.
        for (let slept = 0, gap = args.pollMs ? Number(args.pollMs) : POLL_MS; slept < gap && !pressed.has(tabId) && Date.now() - t0 < limit; slept += 100) await nap(Math.min(100, gap - slept));
        const key = pressed.get(tabId);
        if (key === "skip") { pressed.delete(tabId); waiting.delete(tabId); try { await ctx.cdp.send(tabId, "Runtime.evaluate", { expression: highlightScript(false), returnByValue: true }); } catch { /* gone */ } if (ctx.presence) await ctx.presence.state({ waiting: null }); return { ok: false, signedIn: false, skipped: true, waitedMs: Date.now() - t0, why: "the person chose to skip this sign-in" }; }
        if (key === "continue") pressed.delete(tabId);
        let w;
        try { w = await check(ctx, tabId); } catch (e) { if (/** @type {any} */ (e)?.code === "blocked") { clear = 0; continue; } throw e; }
        clear = w.wall ? 0 : clear + 1;
        if (clear >= 2) { await done(ctx, tabId, app); return { ok: true, signedIn: true, waitedMs: Date.now() - t0 }; }
      }
      return { ok: false, signedIn: false, waitedMs: Date.now() - t0, why: `still waiting for the person to sign in to ${app}; ask again to keep waiting` };
    },
  },
};
