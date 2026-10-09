// @ts-check
// agent-fill: vault.agent.fill (ADR 0028, decision 3). vyred signs an agent in on the agent's OWN computer with a login the agent was lent, and the agent never reads the login.
//
// Who may: a vouched agent caller (agent:<name>), for its own computer only, and only for a login that is lent to it at that origin: either a kernel grant (vault.agent.grant, access.js)
// or a # tag the person typed in this conversation (a "use" intent, said.js: ends with the conversation, idle 8 hours, the person can take it back).
//
// How: computers.fill.begin shields the computer (the agent's hands and CDP sockets are cut) and hands this module a CDP address and a token for this fill only. A fresh browser context
// opens the lent origin; the page's origin is read back on OUR connection and must equal the grant's; the username, password and one-time-code fields are found by the DOM, focused, and
// set with Input.insertText. A value never goes through Runtime.evaluate, a log line, an event, an audit row or an error. computers.fill.end lowers the shield and names the signed-in tab.
//
// The agent gets { filled, origin, navigated, tab } or a refusal that names the origin it saw, never a field.

import { Cdp } from "../../lib/cdp.js";
import { scrub } from "../../lib/scrub.js";
import { totp } from "./totp.js";
import { exactOrigin } from "./agents.js";
import { hostsOf } from "./native.js";

/** The longest the whole sign-in may take (computers ends a fill at 60 s on its own). */
const NAV_MS = 20_000;
/** At most this many pages of one sign-in (a username page, a password page, a code page). */
const STAGES = 3;

const fail = (message, code = "failed") => Object.assign(new Error(message), { code });

/** The page-side finder. It returns where the fields ARE (no value goes in or out): remote objects for the username, password and code inputs that are visible. */
const FIND = `(() => {
  const vis = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && !e.disabled && !e.readOnly; };
  const all = [...document.querySelectorAll("input")].filter(vis);
  const pass = all.find(e => e.type === "password") || null;
  const otp = all.find(e => e !== pass && (e.autocomplete === "one-time-code" || /otp|totp|2fa|mfa|verification|security.?code|one.?time/i.test(e.name + " " + e.id + " " + (e.getAttribute("aria-label") || "") + " " + (e.placeholder || "")))) || null;
  const text = all.filter(e => e !== pass && e !== otp && /^(text|email|tel|)$/i.test(e.type));
  const user = (pass && text.filter(e => pass.form ? e.form === pass.form : true).pop()) || text.find(e => e.autocomplete === "username" || /user|email|login|account/i.test(e.name + " " + e.id)) || text[0] || null;
  return { user, pass, otp };
})()`;

/**
 * Sign an agent in on its own computer.
 * @param {{ vault: import("./vault.js").Vault, call: (name: string, input: any) => Promise<any>, said?: import("./said.js").SaidIntents | null, log?: (m: string) => void, now?: () => number,
 *   makeCdp?: (o: { cdpUrl: string, token: string }) => any }} deps
 * @param {{ agent: string, item: string, origin?: string, thread?: string, lineage?: string[] }} q
 * @returns {Promise<{ filled: string[], origin: string, navigated: boolean, tab?: string, needs?: "code" }>}
 */
export async function agentFill(deps, q) {
  const { vault, call } = deps, log = deps.log || (() => {});
  const who = `agent:${q.agent}`;
  const row = vault.row(String(q.item || ""));
  const refuse = (/** @type {string} */ why, /** @type {string} */ message, code = "denied", origin = null) => {
    vault.agents.recordUse({ action: "agent-fill", item: row ? row.name : null, who, ok: false, origin, surface: "computer", why: why.slice(0, 120) });
    throw fail(message, code);
  };
  if (!row || row.kind !== "login") return refuse("no such login", `no login named ${String(q.item || "").slice(0, 80)}`, "not_found");
  const hosts = hostsOf(row);
  const origin = exactOrigin(q.origin) || (q.origin ? null : hosts[0] || null);
  if (!origin) return refuse("no origin", `${row.name} has no site yet; give it hosts, or say which origin`, "bad_input");
  if (!hosts.includes(origin)) return refuse("origin not on the login", `${row.name} is not for ${origin}; it is for ${hosts.join(", ") || "no site yet"}`, "denied", origin);

  // Lent to this agent at this origin: a grant, or a tag the person typed in this conversation.
  let lent = vault.access ? await vault.access.allowed(q.agent, row.name, origin).catch(() => false) : false;
  if (!lent && q.thread && deps.said) lent = Boolean(await deps.said.match({ kind: "use", to: [row.name], hosts: [origin] }, { thread: q.thread, lineage: q.lineage || [] }).catch(() => null));
  if (!lent) return refuse("not lent", `${row.name} is not lent to ${q.agent} for ${origin} in this conversation: type # and pick the login, or the person lends it with vault.agent.grant`, "denied", origin);

  // Open the item here, in this process; the values live in this closure until the call ends.
  const f = await vault.fields(row);
  const user = String(f.username || ""), pass = String(f.password || "");
  let code = "";
  if (f.totp) { try { code = totp(f.totp, { at: vault.clock() }).code; } catch { /* a bad seed must not block the password */ } }
  const secrets = [user, pass, code, String(f.totp || "")].filter(x => x.length >= 4);
  const clean = (/** @type {string} */ m) => scrub(String(m), secrets, { marker: "[value]", min: 4 });

  const began = await call("computers.fill.begin", { agent: q.agent, origin });
  if (began && began.error) return refuse(`computer: ${began.error.code || "failed"}`, clean(`${q.agent}'s computer could not be filled: ${began.error.message}`), began.error.code || "failed", origin);
  const { fill, cdpUrl, token } = began.data || began;
  const cdp = deps.makeCdp ? deps.makeCdp({ cdpUrl, token }) : new Cdp({ cdpUrl, token });
  /** @type {string | undefined} */ let tab;
  let why = "done";
  try {
    const out = await drive(cdp, { origin, loginUrl: typeof row.url === "string" ? row.url : "", user, pass, code, clean, hasSeed: Boolean(f.totp) });
    tab = out.tab;
    vault.agents.recordUse({ action: "agent-fill", item: row.name, who, ok: true, origin, surface: "computer", why: null });
    vault.emit("vault.filled", { name: row.name, agent: q.agent, origin, surface: "computer" });
    return { filled: out.filled, origin, navigated: out.navigated, ...(out.tab ? { tab: out.tab } : {}), ...(out.needs ? { needs: out.needs } : {}) };
  } catch (e) {
    why = "failed";
    const err = /** @type {any} */ (e);
    vault.agents.recordUse({ action: "agent-fill", item: row.name, who, ok: false, origin, surface: "computer", why: err.seen ? `origin was ${err.seen}` : String(err.code || "failed") });
    throw Object.assign(fail(clean(err.message), err.code || "failed"), err.seen ? { seen: err.seen } : {});
  } finally {
    try { await cdp.close(); } catch { /* the socket is gone with the fill */ }
    const ended = await call("computers.fill.end", { agent: q.agent, fill, ...(tab ? { target: tab } : {}) });
    if (ended && ended.error) log(`vault: ${q.agent}'s fill did not end cleanly: ${ended.error.message}`);
    void why;
  }
}

/**
 * The browser side: one fresh context, up to STAGES pages. Returns what was filled by name only.
 * @param {any} cdp @param {{ origin: string, loginUrl: string, user: string, pass: string, code: string, clean: (m: string) => string, hasSeed: boolean }} s
 */
async function drive(cdp, s) {
  const filled = [];
  await cdp.connect();
  const { browserContextId } = await cdp.send("Target.createBrowserContext", { disposeOnDetach: false });
  const start = (() => { try { const u = new URL(s.loginUrl); return u.origin === s.origin ? u.href : s.origin + "/"; } catch { return s.origin + "/"; } })();
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", browserContextId });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const send = (/** @type {string} */ m, /** @type {any} */ p = {}) => cdp.send(m, p, sessionId);
  await send("Page.enable");
  await send("Runtime.enable");
  const loaded = () => cdp.waitFor(m => m.sessionId === sessionId && (m.method === "Page.loadEventFired" || m.method === "Page.frameNavigated" && !m.params.frame.parentId), NAV_MS);
  let navigated = false;
  const nav = cdp.waitFor(m => m.sessionId === sessionId && m.method === "Page.loadEventFired", NAV_MS);
  await send("Page.navigate", { url: start });
  await nav;
  const seen = async () => String((await send("Runtime.evaluate", { expression: "location.origin", returnByValue: true })).result.value || "");
  // The page's origin is read on OUR connection, whatever the agent or the page claims.
  const first = await seen();
  if (first !== s.origin) { await send("Page.navigate", { url: "about:blank" }).catch(() => {}); throw Object.assign(fail(`the page is ${first || "not a web page"}, not ${s.origin}; nothing was filled`, "wrong_origin"), { seen: first || "(none)" }); }

  const field = async (/** @type {string} */ which) => {
    const r = await send("Runtime.evaluate", { expression: `(() => { const r = ${FIND}; return r.${which}; })()`, returnByValue: false });
    return r.result && r.result.objectId ? r.result.objectId : null;
  };
  const put = async (/** @type {string} */ which, /** @type {string} */ value, /** @type {string} */ name) => {
    const objectId = await field(which);
    if (!objectId) return false;
    await send("DOM.focus", { objectId });
    // Clear whatever the page prefilled, then insert; the value travels only in this one parameter.
    await send("Runtime.callFunctionOn", { objectId, functionDeclaration: "function(){ this.select && this.select(); }" });
    await send("Input.insertText", { text: value });
    filled.push(name);
    return true;
  };
  const submit = async () => {
    const wait = loaded();
    for (const type of ["rawKeyDown", "char", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, ...(type === "char" ? { text: "\r" } : {}) });
    await wait;
    // A page that signs in without a navigation (a script) gets a moment to settle.
    await new Promise(r => setTimeout(r, 400));
  };

  /** @type {"code" | undefined} */ let needs;
  for (let stage = 0; stage < STAGES; stage++) {
    const had = filled.length;
    if (!filled.includes("username") && s.user) await put("user", s.user, "username");
    if (!filled.includes("password")) await put("pass", s.pass, "password");
    const wantsCode = await field("otp");
    if (wantsCode && !filled.includes("code")) {
      if (s.code) await put("otp", s.code, "code");
      else { needs = "code"; break; }
    }
    if (filled.length === had) break;
    const before = await seen().catch(() => "");
    await submit();
    navigated = true;
    const now = await seen().catch(() => "");
    if (now && before && now !== before && now !== s.origin) break;
    // Signed in when there is no password or code field left to fill.
    if (!(await field("pass")) && !(await field("otp"))) break;
  }
  // Nothing sensitive is left in the DOM.
  await send("Runtime.evaluate", { expression: `document.querySelectorAll('input[type=password]').forEach(e => { e.value = ""; })` }).catch(() => {});
  if (!filled.length) throw fail("no sign-in form was found on the page; nothing was filled", "no_form");
  return { filled, navigated, tab: targetId, needs };
}
