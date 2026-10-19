// @ts-check
// How Sign in with GitHub gets to GitHub and back, with no popup. Pure: the storage, the relay call and the clock are passed in, so it runs in Node.
//   a browser    the tab itself goes to GitHub. A popup opened after the sign-in's awaits is blocked, and web.vyre.run's same-origin opener policy cuts a popup off from the page anyway
//                (the page sees it as closed at once). The relay sends the tab back to /github-return, which keeps the ticket and goes back to the page the sign-in started on;
//                that page finds the ticket and carries on.
//   the Mac app  the person's own browser goes to GitHub (the app's window has no popups and the browser cannot open vyreapp://). The relay keeps the ticket for the app,
//                which claims it with the verifier only it holds, asking every two seconds.
//   a phone      the system's sign-in sheet, which hands the return address back itself.

export const START_KEY = "vyre.gh.start";
export const RETURN_KEY = "vyre.gh.return";
/** As long as the relay keeps a start. */
export const START_MS = 10 * 60_000;
const TICKET_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * @typedef {{ getItem(k: string): string | null, setItem(k: string, v: string): void, removeItem(k: string): void }} Store
 * @typedef {{ ticket: string, cv: string }} Got
 * @typedef {{ code: string }} Ended
 */

/** Which way this page goes to GitHub. @param {{ web: boolean, mac: boolean }} where @returns {"redirect" | "claim" | "sheet"} */
export function githubWay(where) {
  if (!where.web) return "sheet";
  return where.mac ? "claim" : "redirect";
}

/** The relay's start address. @param {string} base @param {string} cc @param {string} app @param {boolean} claim */
export function startUrl(base, cc, app, claim) {
  return `${base.replace(/\/+$/, "")}/v1/github/start?cc=${encodeURIComponent(cc)}&app=${encodeURIComponent(app)}${claim ? "&claim=1" : ""}`;
}

/** The ticket in a return address's fragment, or why the sign-in ended. @param {string} hash @returns {string | Ended} */
export function parseReturn(hash) {
  const p = new URLSearchParams(String(hash || "").replace(/^#/, ""));
  const t = p.get("ticket");
  if (t && TICKET_RE.test(t)) return t;
  return { code: p.get("error") === "denied" ? "denied" : "failed" };
}

/** A path on this site to come back to; anything else (another site, a protocol-relative address) is the front page. @param {unknown} back */
export function safeBack(back) {
  const s = String(back ?? "");
  return /^\/(?![/\\])[^\s\\]*$/.test(s) ? s : "/";
}

/** Keep the verifier and the page to come back to, before the tab goes to GitHub. False when the browser keeps nothing (then the sign-in could not finish). @param {Store} store @param {{ cv: string, back: string, now: number }} s */
export function rememberStart(store, s) {
  try {
    store.removeItem(RETURN_KEY);
    store.setItem(START_KEY, JSON.stringify({ cv: s.cv, back: safeBack(s.back), at: s.now }));
    return store.getItem(START_KEY) !== null;
  } catch { return false; }
}

/** @param {Store} store @param {number} now @returns {{ cv: string, back: string, at: number } | null} */
function readStart(store, now) {
  try {
    const j = JSON.parse(store.getItem(START_KEY) || "null");
    if (j && typeof j.cv === "string" && typeof j.at === "number" && now >= j.at && now - j.at < START_MS) return j;
  } catch { /* nothing kept, or not ours */ }
  return null;
}

/** A sign-in is back from GitHub and waiting for this page to finish it. @param {Store | null} store @param {number} now */
export function returnWaiting(store, now) {
  if (!store) return false;
  try { return Boolean(readStart(store, now) && store.getItem(RETURN_KEY)); } catch { return false; }
}

/** Take the finished sign-in, once: the ticket and the verifier kept at the start, or why it ended. null when no sign-in has come back. @param {Store | null} store @param {number} now @returns {Got | Ended | null} */
export function takeReturn(store, now) {
  if (!store) return null;
  let start = null, hash = null;
  try { start = readStart(store, now); hash = store.getItem(RETURN_KEY); } catch { return null; }
  if (!hash) return null;
  try { store.removeItem(RETURN_KEY); store.removeItem(START_KEY); } catch { /* gone */ }
  if (!start) return { code: "expired" };
  const t = parseReturn(hash);
  return typeof t === "string" ? { ticket: t, cv: start.cv } : t;
}

/** The return page: keep what GitHub sent and say where the tab goes next, the page the sign-in started on. null when this browser started no sign-in (an older popup, which just closes). @param {Store | null} store @param {string} hash @param {number} now */
export function landReturn(store, hash, now) {
  if (!store) return null;
  try { store.setItem(RETURN_KEY, String(hash || "")); } catch { return null; }
  const s = readStart(store, now);
  return s ? safeBack(s.back) : null;
}

/**
 * The Mac app's wait: ask the relay for the ticket with the verifier until it is there, the sign-in ended at GitHub, or the start runs out.
 * @param {(cv: string) => Promise<{ status: number, json: any }>} ask @param {string} cv @param {{ sleep: (ms: number) => Promise<unknown>, every?: number, until?: number }} o
 * @returns {Promise<string | Ended>}
 */
export async function claimTicket(ask, cv, o) {
  const every = o.every ?? 2000, until = o.until ?? START_MS;
  for (let waited = 0; waited < until; waited += every) {
    await o.sleep(every);
    const r = await ask(cv);
    if (r.status === 200 && r.json) {
      if (typeof r.json.ticket === "string" && TICKET_RE.test(r.json.ticket)) return r.json.ticket;
      return { code: r.json.error === "denied" ? "denied" : "failed" };
    }
    // 202: still at GitHub. 429 or no answer (0, 5xx): ask again. Any other refusal ends it.
    if (r.status === 202 || r.status === 429 || r.status === 0 || r.status >= 500) continue;
    return { code: "failed" };
  }
  return { code: "timeout" };
}

export const AFTER_KEY = "vyre.gh.after";
/** @param {unknown} v */
const shortText = (v) => String(v ?? "").replace(/[\u0000-\u001f]/g, "").slice(0, 60);

/**
 * What a first-run screen needs to pick up after the tab went to GitHub: which step started it, and the names the person typed (never a password). `create` is the new-person
 * flow's Continue with GitHub; anything else is Sign in with GitHub. @param {Store | null} store @param {{ kind: "create" | "signin", first?: string, last?: string, username?: string }} v
 */
export function saveAfter(store, v) {
  if (!store) return;
  try { store.setItem(AFTER_KEY, JSON.stringify({ kind: v.kind === "create" ? "create" : "signin", first: shortText(v.first), last: shortText(v.last), username: shortText(v.username) })); } catch { /* nothing kept: the step starts over */ }
}

/** @param {Store | null} store @returns {{ kind: "create" | "signin", first: string, last: string, username: string } | null} */
export function readAfter(store) {
  if (!store) return null;
  try {
    const j = JSON.parse(store.getItem(AFTER_KEY) || "null");
    if (!j || typeof j !== "object") return null;
    return { kind: j.kind === "create" ? "create" : "signin", first: shortText(j.first), last: shortText(j.last), username: shortText(j.username) };
  } catch { return null; }
}

/** @param {Store | null} store */
export function clearAfter(store) {
  if (!store) return;
  try { store.removeItem(AFTER_KEY); } catch { /* gone */ }
}
