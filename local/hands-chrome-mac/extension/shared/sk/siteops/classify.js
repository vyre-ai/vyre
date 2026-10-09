// GENERATED from lib/siteops/classify.js by scripts/sync-copies.mjs (the extension cannot import from lib/). Do not edit here: change the original and run the script.
// @ts-check
// classify: judge every response, never by status code alone. ok, drift, auth, rate, blocked, input, or error, each with the next step.
//
// Ported from api-anything classify.ts (github.com/goodnight000/api-anything, MIT; see NOTICE). PURE. A page-format answer needs a DOM: the shell passes `readers`
// ({ html(body, recipe) => items[], emptyResults(body, itemsSelector) => boolean }) from the live page; without them a page answer is judged by its markers alone.

import { extract, getPath, inferShape, parseBody } from "./extract.js";
import { readOnly } from "./spec.js";

/** @typedef {"ok"|"drift"|"auth"|"rate"|"blocked"|"input"|"error"} Class */
/** @typedef {{ class: Class, reason: string, missing?: boolean, data?: any }} Classified */
/** @typedef {{ status: number, headers: Record<string, string>, body: string, url?: string }} Observed */
/** @typedef {{ html?: (body: string, recipe: any) => any[], emptyResults?: (body: string, items: string) => boolean }} Readers */

// [vendor, interstitial, integration]. The interstitial pattern is the challenge page's own structure. The integration pattern is a script a vendor also puts on ordinary pages: it only
// counts on an answer whose status is a challenge's own.
/** @type {[string, RegExp|undefined, RegExp?][]} */
const CHALLENGES = [
  ["Cloudflare", /<title>Just a moment\.\.\.<\/title>|cf-chl-|_cf_chl_opt|Attention Required! \| Cloudflare/i, /challenges\.cloudflare\.com/i],
  ["Akamai", /bm-verify|\/_sec\/cp_challenge|errors\.edgesuite\.net/i],
  ["DataDome", /captcha-delivery\.com/i, /datadome/i],
  ["PerimeterX", /px-captcha|Press & Hold/i, /_pxAppId|perimeterx/i],
  ["AWS WAF", /awsWafCookieDomainList|gokuProps|<title>Human Verification<\/title>/i, /AwsWafIntegration|\.awswaf\.com|\/__challenge_[\w-]+\/[^"']*challenge\.js/i],
  ["Amazon", /automated access to Amazon data|\/errors\/validateCaptcha/i],
  ["Imperva", /Incapsula incident/i, /_Incapsula_Resource/i],
  ["Kasada", undefined, /\/[0-9a-f]{8}-[0-9a-f-]{27}\/[0-9a-f]{8}-[0-9a-f-]{27}\/ips\.js/i],
  // a proof-of-work page that solves itself and resubmits (Reddit)
  ["JS challenge", /name=["']?js_challenge|[?&]js_challenge=1/i],
  ["reCAPTCHA", /google\.com\/recaptcha|g-recaptcha|hcaptcha\.com|Prove your humanity/i],
  // a professional network's checkpoint: the account is being asked to prove it is a person
  ["Checkpoint", /\/checkpoint\/(challenge|lg)\/|security verification|let'?s do a quick security check|unusual activity/i],
];
// What bot walls answer with: 202 (AWS WAF's JS challenge), 403, 405 (AWS WAF's CAPTCHA), 429, 503.
const CHALLENGE_STATUS = new Set([202, 403, 405, 429, 503]);
const CHALLENGE_TITLE = /<title[^>]*>[^<]*(prove your humanity|human verification|just a moment|attention required|are you a (human|robot)|verify you are (a )?human|robot check)/i;

// What a server says when the session is missing, as opposed to a page that shows a password field.
const LOGIN_SAID = /"require_login"\s*:\s*true|login_required|not logged in|(log|sign) ?in to continue|please (log|sign) ?in|authentication required|bad authentication|could not authenticate|bad guest token|invalid session|session (has )?expired/i;
const LOGIN = new RegExp(`${LOGIN_SAID.source}|type=["']password["']|accounts\\.google\\.com\\/ServiceLogin`, "i");
/** A sign-in form: a password field next to a username field, a current-password hint, or a form posting to a login path. @param {string} body */
const signInForm = body => /type=["']?password/i.test(body)
  && /<input[^>]*name=["']?(user(name)?|e-?mail|login|session_key)\b|autocomplete=["']?(current-password|username)|<form[^>]*action=["']?[^"'>\s]*(log_?in|sign_?in|sign-in|session)/i.test(body);
const LOGIN_URL = /\/(login|signin|sign_in|sign-in|accounts\/login|i\/flow\/login|onboarding|ServiceLogin|uas\/login|authwall)(\/|$|\?)/i;
/** A document that is a login page: only what the page says or shows counts. @param {string} body */
const loginPage = body => LOGIN_SAID.test(body) || signInForm(body);
const NOT_FOUND_SAID = /"status"\s*:\s*404|not found|no such (user|profile|member|page|record)|does not exist|could not be found|unknown (user|profile|member)/i;
const RATE = /rate.?limit|too many requests|please wait a few minutes|slow down/i;
const DRIFT = /PersistedQueryNotFound|persisted query not found|must be defined|cannot be null|query not found|unknown (field|argument|operation)|cannot query field/i;

const ok = (reason = "ok") => /** @type {Classified} */ ({ class: "ok", reason });
const is = (/** @type {Class} */ c, /** @type {string} */ reason) => /** @type {Classified} */ ({ class: c, reason });
const missing = (/** @type {string} */ reason) => /** @type {Classified} */ ({ class: "drift", reason, missing: true });
// A CSRF *failure*, not a page that merely carries a token. The gap stays inside one message: no quote or tag.
const CSRF_FAILED = /(csrf|xsrf)[^"<>\n]{0,40}?(missing|invalid|mismatch|incorrect|expired|fail|not (set|found|valid|match))|(invalid|missing|bad|expired|can'?t verify|could not verify|requires? an? (valid|matching))[^"<>\n]{0,30}?(csrf|xsrf|authenticity)|InvalidAuthenticityToken/i;
// Instagram sends "require_login": false on its rate-limit answers, so the key alone means nothing.
const REQUIRE_LOGIN = /"require_login"\s*:\s*true|login_required/i;
const snippet = (/** @type {string} */ s) => s.replace(/\s+/g, " ").trim().slice(0, 160);

/** @param {string} body @param {number} status */
function challenge(body, status) {
  const head = body.slice(0, 200_000);
  return CHALLENGES.find(([, page, sdk]) => !!(page && page.test(head)) || (CHALLENGE_STATUS.has(status) && !!(sdk && sdk.test(head))))?.[0];
}

/**
 * The bot wall this response is, if any ("Cloudflare challenge page (HTTP 403)"). A real HTML page may mention recaptcha in a login form; challenge pages are small, non-2xx, or where
 * data was expected. `hasData`: the op's recipe finds its data on this page.
 * @param {Observed} r @param {boolean} [wantsJson] @param {() => boolean} [hasData]
 */
export function botWall(r, wantsJson = false, hasData) {
  const body = r.body ?? "";
  const ct = (r.headers["content-type"] ?? "").toLowerCase();
  const isHtml = ct.includes("html") || /^\s*<(!doctype|html)/i.test(body);
  if (r.headers["cf-mitigated"] === "challenge") return "Cloudflare challenge (cf-mitigated)";
  if (CHALLENGE_STATUS.has(r.status) && Object.keys(r.headers).some(k => k.toLowerCase().startsWith("x-kpsdk"))) return `Kasada challenge (HTTP ${r.status})`;
  if (r.status >= 400 || (isHtml && (wantsJson || body.length < 64_000))) {
    const vendor = challenge(body, r.status);
    if (vendor) return `${vendor} challenge page (HTTP ${r.status})`;
  }
  if (isHtml && CHALLENGE_TITLE.test(body.slice(0, 20_000)) && !(hasData && hasData())) return `challenge page (HTTP ${r.status})`;
  return undefined;
}

/** " (retry after 120 s)" from a Retry-After header in seconds or as an HTTP date. @param {Record<string, string>} headers */
function retryAfter(headers) {
  const v = headers["retry-after"]?.trim();
  if (!v) return "";
  if (/^\d+$/.test(v)) return ` (the server says retry after ${v} s)`;
  const t = Date.parse(v);
  return Number.isNaN(t) ? "" : ` (the server says retry after ${new Date(t).toISOString()})`;
}

/** A GraphQL errors array's verdict; `input` for a not-found entity. @param {any[]} errors @param {string} [extra] */
function graphqlErrors(errors, extra = "") {
  const msg = errors.map(e => e?.message ?? JSON.stringify(e)).join("; ");
  const types = errors.map(e => String(e?.type ?? e?.extensions?.code ?? "")).join(" ");
  if (DRIFT.test(msg)) return is("drift", `GraphQL: ${snippet(msg)}`);
  if (LOGIN.test(msg)) return is("auth", `GraphQL: ${snippet(msg)}`);
  if (RATE.test(msg)) return is("rate", `GraphQL: ${snippet(msg)}`);
  if (/NOT_FOUND/i.test(types) || /not found|could not resolve|does not exist|no such/i.test(msg)) return is("input", `GraphQL: ${snippet(msg)}`);
  return is("error", `GraphQL errors${extra}: ${snippet(msg)}`);
}

/** Learned shape and value, scoped to the extract path when it resolves: other subtrees may come and go. @param {any} op @param {any} data */
function shapeScope(op, data) {
  const shape = op.response.shape ?? {};
  const ex = op.response.extract;
  if (!ex) return { expected: shape, value: data };
  const prefix = ex.replace(/\[(\d+|\*)\]/g, "[]").replace(/\["((?:[^"\\]|\\.)*)"\]/g, (/** @type {string} */ _m, /** @type {string} */ k) => `.${JSON.parse(`"${k}"`)}`).replace(/^\./, "");
  /** @type {Record<string, string>} */ const expected = {};
  // a trailing [*] returns the items themselves, as a list: compare them as "[]..." like any list
  const items = ex.endsWith("[*]");
  for (const [k, t] of Object.entries(shape)) {
    if (items && (k === prefix || k.startsWith(`${prefix}.`) || k.startsWith(`${prefix}[]`))) expected[`[]${k.slice(prefix.length)}`] = /** @type {string} */ (t);
    else if (k.startsWith(`${prefix}.`)) expected[k.slice(prefix.length + 1)] = /** @type {string} */ (t);
    else if (k.startsWith(`${prefix}[]`)) expected[k.slice(prefix.length)] = /** @type {string} */ (t);
  }
  return { expected, value: getPath(data, ex) };
}

/** Share of the learned shape still present with the same type; null matches anything. @param {Record<string, string>} expected @param {any} data */
function shapeKept(expected, data) {
  const now = inferShape(data, 2000);
  const paths = Object.keys(expected);
  const kept = paths.filter(p => now[p] !== undefined && (now[p] === expected[p] || now[p] === "null" || expected[p] === "null"));
  return kept.length / paths.length;
}

/** @param {any} op @param {string} body */
function mentionsParam(op, body) {
  const names = new Set(op.params.map((/** @type {any} */ p) => p.name));
  for (const s of op.slots) {
    if (!s.param) continue;
    // the nearest named step: json:/legs/0/origin/airports/0 names "airports", not "0"
    const tokens = s.at.flatMap((/** @type {string} */ st) => (st.startsWith("json:") ? st.slice(5).split("/") : [st.slice(st.indexOf(":") + 1)]));
    const name = tokens.reverse().find((/** @type {string} */ t) => t && !/^\d+$/.test(t));
    if (name) names.add(name);
  }
  return [...names].some(n => n && new RegExp(`\\b${String(n).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(body));
}

/** The page recipe finds data here. Never throws. @param {any} op @param {string} body @param {Readers} rd */
function recipeFinds(op, body, rd) {
  try {
    if (op.response.format === "html") return !!(op.response.html && rd.html && rd.html(body, op.response.html).length > 0);
    if (op.response.format === "embedded") {
      const d = extract(op.response, body);
      return d !== undefined && !(Array.isArray(d) && !d.length);
    }
  } catch { /* a bad recipe finds nothing */ }
  return false;
}

/**
 * Judge one answer to an operation.
 * @param {any} op @param {Observed} r @param {Readers} [rd] @returns {Classified}
 */
export function classify(op, r, rd = {}) {
  const body = r.body ?? "";
  const ct = (r.headers["content-type"] ?? "").toLowerCase();
  const isHtml = ct.includes("html") || /^\s*<(!doctype|html)/i.test(body);
  const wantsJson = op.response.format === "json";
  const ro = readOnly(op);

  const wall = botWall(r, wantsJson, () => recipeFinds(op, body, rd));
  if (wall) return is("blocked", wall);

  const wait = retryAfter(r.headers);
  if (r.status === 429) return is("rate", `HTTP 429${wait}`);
  if (r.status >= 400 && REQUIRE_LOGIN.test(body)) return is("auth", `HTTP ${r.status}: ${snippet(body)}`);
  if (r.status >= 400 && RATE.test(body)) return is("rate", `HTTP ${r.status}${wait}: ${snippet(body)}`);
  // Laravel answers a stale CSRF token with 419, Rails with 422 InvalidAuthenticityToken.
  if (r.status === 419 || ((r.status === 400 || r.status === 422) && CSRF_FAILED.test(body))) return is("auth", `HTTP ${r.status}: CSRF check failed: ${snippet(body)}`);
  if (r.status === 401) return is("auth", `HTTP 401: ${snippet(body)}`);
  if (r.status === 403) {
    return LOGIN.test(body) || CSRF_FAILED.test(body)
      ? is("auth", `HTTP 403 with login markers: ${snippet(body)}`)
      : { ...is("blocked", `HTTP 403 with no login or challenge markers: ${snippet(body)}`), missing: true };
  }
  if (r.url) {
    try {
      const u = new URL(r.url);
      if (LOGIN_URL.test(u.pathname) && !LOGIN_URL.test(new URL(op.request.url).pathname)) return is("auth", `redirected to ${u.pathname}`);
    } catch { /* not a URL; ignore */ }
  }
  if (r.status === 404 || r.status === 410) {
    // The site says it plainly: this one thing is not there. That is the input, not a changed site, whatever the address looks like.
    if (NOT_FOUND_SAID.test(body)) return is("input", `HTTP ${r.status}: ${snippet(body)}`);
    // With the input in the path, 404 usually means that entity doesn't exist. With a rotating id in the path too, it may be a deploy: let the caller check.
    if (!op.slots.some((/** @type {any} */ s) => s.param && s.at[0].startsWith("path:"))) return ro ? missing(`HTTP ${r.status} on a templated API path`) : is("drift", `HTTP ${r.status} on a templated API path`);
    return op.volatile.some((/** @type {any} */ v) => v.at[0].startsWith("path:")) ? missing(`HTTP ${r.status}`) : is("input", `HTTP ${r.status}: not found`);
  }
  if (r.status === 400) {
    if (DRIFT.test(body)) return is("drift", `HTTP 400 schema error: ${snippet(body)}`);
    // a 400 form page (a signup's "username taken") shows a password field; only the wording counts
    if (LOGIN_SAID.test(body)) return is("auth", `HTTP 400 with login markers: ${snippet(body)}`);
    if (mentionsParam(op, body)) return is("input", `HTTP 400: ${snippet(body)}`);
    return is("error", `HTTP 400: ${snippet(body)}`);
  }
  if (r.status < 200 || r.status >= 300) return is("error", `HTTP ${r.status}: ${snippet(body)}`);

  /** @type {any} */ let data;
  try {
    data = parseBody(body, op.response.xssiPrefix);
  } catch {
    if (!ro) {
      if (isHtml && !/html/i.test(op.response.contentType ?? "") && signInForm(body)) return is("auth", "a sign-in form where the write's answer was expected");
      return ok(`HTTP ${r.status}, ${body.trim() ? "non-JSON body" : "empty body"}`);
    }
    if (wantsJson) {
      if (isHtml && LOGIN.test(body)) return is("auth", "HTML login page where JSON was expected");
      if (!body.trim()) return missing(`HTTP ${r.status} with an empty body`);
      return is("drift", isHtml ? "HTML where JSON was expected" : `response is not JSON: ${snippet(body)}`);
    }
  }
  const d = data;
  if (!ro && d && (d.ok === false || d.success === false)) return is("error", "the service rejected the write (ok or success is false)");
  const errors = d && typeof d === "object" && Array.isArray(d.errors) && d.errors.length ? d.errors : undefined;
  if (errors && d.data == null) return graphqlErrors(errors, " with null data");
  // Partial data: errors next to a null target (a rate limit, a not-found user) are the answer, not a successful null.
  if (errors && op.response.extract && getPath(data, op.response.extract) == null) return graphqlErrors(errors, ` and a null "${op.response.extract}"`);
  if (!ro) return ok();

  if (op.response.format === "html") {
    if (!op.response.html) return ok();
    if (!rd.html) return ok();
    if (rd.html(body, op.response.html).length) return ok();
    if (loginPage(body)) return is("auth", "login page instead of content");
    if (rd.emptyResults && rd.emptyResults(body, op.response.html.items)) return ok("no results");
    return missing(`selector "${op.response.html.items}" matched nothing`);
  }
  if (op.response.format === "embedded") {
    if (extract(op.response, body) !== undefined) return ok();
    return loginPage(body) ? is("auth", "login page instead of content") : missing("embedded data not found");
  }

  // An empty list where the results go is a search with no results, not missing data.
  const target = op.response.extract ? getPath(data, op.response.extract) : data;
  if (Array.isArray(target) && !target.length) return ok("no results");
  /** @type {string|undefined} */ let gone;
  const scope = op.response.shape ? shapeScope(op, data) : undefined;
  if (op.response.extract && getPath(data, op.response.extract) === undefined) gone = `extract path "${op.response.extract}" missing`;
  else if (scope && Object.keys(scope.expected).length >= 4 && shapeKept(scope.expected, scope.value) < 0.5) gone = "response shape changed (under half of the learned key paths remain)";
  if (!gone) return ok();
  // Instagram answers "login_required" and "please wait" as 200 JSON; only trust the wording when the data is gone.
  if (REQUIRE_LOGIN.test(body)) return is("auth", `${gone}: ${snippet(body)}`);
  if (RATE.test(body)) return is("rate", `${gone}: ${snippet(body)}`);
  if (LOGIN.test(body)) return is("auth", `${gone}: ${snippet(body)}`);
  return missing(gone);
}

/**
 * classify, then extract when ok. Never throws: a bad selector or regex in the op is an error.
 * @param {any} op @param {Observed} r @param {Readers} [rd] @returns {Classified}
 */
export function judge(op, r, rd = {}) {
  /** @type {Classified} */ let c;
  try { c = classify(op, r, rd); } catch (e) { return is("error", `the operation's response recipe failed: ${/** @type {Error} */ (e).message}`); }
  if (c.class !== "ok") return c;
  try {
    return { ...c, data: extract(op.response, r.body, rd.html ? { html: rd.html } : {}) };
  } catch (e) {
    // a write's non-JSON answer: hand back its text
    if (!readOnly(op)) return { ...c, data: r.body.trim() ? r.body.slice(0, 1000) : null };
    return is("drift", `extract failed: ${/** @type {Error} */ (e).message}`);
  }
}

/**
 * What to do about a failure, as one sentence the caller (an agent, a Flow, a card) can follow at most once. `ran`: a write that may have reached the server.
 * @param {Class} cls @param {any} op @param {{ reason?: string, ran?: boolean }} [o]
 */
export function nextStep(cls, op, o = {}) {
  if (cls === "ok") return undefined;
  const ro = readOnly(op);
  // A write the server may have run: never invite a second send.
  if (!ro && o.ran && cls !== "drift" && cls !== "auth") return "the write may have gone through: check the site before any retry";
  switch (cls) {
    case "auth": return `sign in again in the browser that runs this operation; then ${!ro && o.ran ? "check the site, and retry only if the write is not there" : "retry once"}`;
    case "rate": return /retry after/.test(o.reason ?? "") ? "rate limited: do not retry before the time in the reason" : "rate limited: do not retry now; wait a few minutes";
    case "blocked": return "the site is challenging this browser: a person must clear the challenge in it once, then retry once";
    case "drift": return ro ? "heal the operation (run its trigger, relearn, verify); if that fails, relearn it" : `${o.ran ? "the write may have run: check the site first, then " : ""}relearn it`;
    case "input": return "check the inputs against the operation's declared inputs";
    default: return "retry once; if it fails the same way, stop and report the reason";
  }
}
