// @ts-check
// learn: captured exchanges plus example inputs become an Operation. Only the example values become params; everything else is kept verbatim.
//
// Ported from api-anything (github.com/goodnight000/api-anything, MIT, (c) goodnight000; see NOTICE). Differences from the original, all deliberate:
//   - no cookie jar and no session store: the cookies and storage handed in are used to RECOGNISE a credential in the request and are then forgotten. The operation holds
//     only a reference (`cookie:<name>`, `session:<name>`) that the page resolves when it signs the call; no value of one is returned or written anywhere;
//   - example values leave the template: a leaf bound to an input is blanked, so a person's search term never sits in a stored operation;
//   - the op carries a `kind` (read, send, ...) and a `login` flag instead of readOnly and learnedLoggedIn.
// PURE: no I/O, no clock beyond learnedAt, no Buffer.
//
// An Exchange is { id, resourceType, request: { method, url, headers, body? }, response?: { status, headers, body?, contentType }, aborted? }, headers lower-cased.

import { asText, escapeTemplate, escapeValue, fillSlotTemplate, fillTemplate, getAt, setAt, templateRefs, walk } from "./codec.js";
import { inferShape, innerJson, parseBody, xssiOf } from "./extract.js";
import { parseOperation, readOnly } from "./spec.js";

/** @typedef {import("./codec.js").Leaf} Leaf */
/** @typedef {import("./codec.js").Req} Req */
/** @typedef {{ id: number, resourceType: string, request: Req, response?: { status: number, headers: Record<string, string>, body?: string, contentType: string }, aborted?: boolean }} Exchange */
/** @typedef {Record<string, any>} Args */

/* ------------------------------------------------------------------ noise */

export const ASSET_EXT = /\.(js|mjs|cjs|jsx|ts|css|scss|png|jpe?g|gif|svg|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp4|webm|ogg|mp3|wav|wasm|map|pdf|zip)$/i;
const DENY_RESOURCE = new Set(["image", "font", "stylesheet", "script", "media", "manifest", "texttrack", "websocket", "eventsource", "preflight", "ping", "cspviolationreport"]);
const DENY_MIME = /^(image|font|video|audio)\/|^text\/(css|javascript)|^application\/(javascript|x-javascript|font|octet-stream|wasm)/i;
const ANALYTICS = /google-analytics\.com|googletagmanager\.com|doubleclick\.net|sentry\.io|\/sentry\/|segment\.(io|com)|mixpanel\.com|amplitude\.com|hotjar\.com|facebook\.com\/tr|clarity\.ms|nr-data\.net|datadoghq|\/(collect|beacon|log_event|telemetry|jot|csp-report|client_event|tracking|logging)(\/|\?|$)/i;
// Pages and APIs can end in .js (github.com/vercel/next.js): the extension only means an asset for subresources.
const DATA_RESOURCE = new Set(["document", "xhr", "fetch"]);

/** @param {Exchange} e */
function isNoise(e) {
  if (e.request.method.toUpperCase() === "OPTIONS") return true;
  if (DENY_RESOURCE.has(e.resourceType.toLowerCase())) return true;
  let url;
  try { url = new URL(e.request.url); } catch { return true; }
  if ((!DATA_RESOURCE.has(e.resourceType) && ASSET_EXT.test(url.pathname)) || ANALYTICS.test(e.request.url)) return true;
  if (e.aborted) return false;
  if (!e.response) return true;
  if (e.response.status >= 300 && e.response.status < 400) return true;
  // Media is never data, even fetched by XHR (video segments); otherwise XHR and fetch are data by definition.
  if (/^(image|font|video|audio)\//i.test(e.response.contentType)) return true;
  return e.resourceType !== "xhr" && e.resourceType !== "fetch" && DENY_MIME.test(e.response.contentType);
}

/* ------------------------------------------------------------- candidates */

// The page URL rides along in these on every XHR, so they say nothing about which request carries the args.
const NOT_EVIDENCE = new Set(["header:cookie", "header:referer", "header:origin"]);
// Telemetry posts the page URL in its body; a value seen only inside a URL is weak evidence.
const URLISH = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Lower-cased and percent-decoded (up to 3 layers, + as a space): a location reads the same in any leaf. @param {string} s */
function norm(s) {
  let out = s.toLowerCase();
  for (let i = 0; i < 3; i++) {
    let next;
    try { next = decodeURIComponent(out.replace(/\+/g, " ")); } catch { break; }
    if (next === out) break;
    out = next;
  }
  return out.replace(/\+/g, " ");
}

/** The pages a capture ran on: its documents, every Referer, and any extra (the filled trigger, the page's own locations). @param {Exchange[]} exchanges @param {string[]} [extra] */
export function pageUrls(exchanges, extra = []) {
  const urls = new Set(extra);
  for (const e of exchanges) {
    if (e.resourceType === "document") urls.add(e.request.url);
    if (e.request.headers.referer) urls.add(e.request.headers.referer);
  }
  return [...urls];
}

/** @typedef {{ abs: string[], rel: string[] }} Locations */
/** What a page's location looks like when a script echoes it (normalized). @param {string[]} pages @returns {Locations} */
function locations(pages) {
  const abs = new Set(), rel = new Set();
  for (const p of pages) {
    let u;
    try { u = new URL(p); } catch { continue; }
    for (const s of [u.origin + u.pathname + u.search, u.origin + u.pathname, u.origin]) abs.add(norm(s));
    for (const s of [u.pathname + u.search, u.pathname, u.search]) if (s.length > 1) rel.add(norm(s));
  }
  return { abs: [...abs], rel: [...rel] };
}

/** A leaf that holds the page's own location around the value is an echo, not evidence. @param {string} text @param {string} v @param {Locations} locs */
function echoes(text, v, locs) {
  const want = norm(v), t = norm(text);
  const of = (/** @type {string} */ l) => l.length > want.length && l.includes(want);
  return locs.abs.some(l => of(l) && t.includes(l)) || locs.rel.some(l => of(l) && t.startsWith(l));
}

/** A 2xx that carries no data: empty, or a tiny body of flags (`{"success":true}`, `OK`): a beacon's answer. @param {Exchange} e */
export function isAck(e) {
  const r = e.response;
  if (!r || r.status < 200 || r.status >= 300) return false;
  const body = (r.body ?? "").trim();
  if (body.length > 100) return false;
  /** @param {any} v @returns {boolean} */
  const flags = v => v === null || typeof v === "boolean" || (typeof v === "string" && /^\w{0,8}$/.test(v)) || (typeof v === "object" && Object.values(v).every(flags));
  const data = tryParse(body);
  return flags(data === undefined ? body : data);
}

/** The text an example is searched by; an array example by its first element. @param {any} v */
function exampleText(v) {
  if (Array.isArray(v)) return asText(v.find(x => asText(x).length >= 3) ?? v[0]).toLowerCase();
  return asText(v).toLowerCase();
}
/** @param {Args} args @returns {[string, string][]} */
const exampleValues = args => Object.entries(args).map(([k, v]) => [k, exampleText(v)]);

/** @param {string|undefined} body @returns {any} */
function tryParse(body) {
  if (!body) return undefined;
  try { return parseBody(body); } catch { return undefined; }
}

/**
 * Noise-filtered requests, best first: carries the example values, succeeded, returned JSON. `all`: the caller already chose the pool (a match), so only preflights are dropped.
 * `pages`: the capture's page URLs; a value found only in an echo of them is no hit. A data-less answer (a beacon's ack) ranks below every real answer.
 * @param {Exchange[]} exchanges @param {Args} [args] @param {{ all?: boolean, pages?: string[] }} [o]
 */
export function rankCandidates(exchanges, args = {}, o = {}) {
  const values = exampleValues(args).filter(([, v]) => v.length >= 3);
  const locs = locations(o.pages ?? pageUrls(exchanges));
  return exchanges
    .filter(e => (o.all ? e.request.method.toUpperCase() !== "OPTIONS" : !isNoise(e)))
    .map(e => {
      const all = walk(e.request).filter(l => !NOT_EVIDENCE.has(l.at[0]));
      const leaves = (/** @type {string} */ v) => all.filter(l => !echoes(l.value, v, locs));
      const has = (/** @type {string} */ v, /** @type {Leaf[]} */ ls) => ls.some(l => l.value.toLowerCase().includes(v));
      // a URL-valued example (a link preview's ?url=) is evidence in a URL-valued leaf
      const direct = (/** @type {string} */ v) => leaves(v).filter(l => !l.container && (!URLISH.test(l.value) || URLISH.test(v)));
      const hits = values.filter(([, v]) => has(v, direct(v))).map(([k]) => k);
      const urlHits = values.filter(([k, v]) => !hits.includes(k) && has(v, leaves(v))).length;
      const body = e.response?.body ?? "";
      const parsed = tryParse(body);
      const json = parsed !== null && typeof parsed === "object";
      const status = e.response?.status;
      const lower = values.length ? body.toLowerCase() : "";
      const score = hits.length * 1000 + urlHits * 50 + (e.aborted ? 600 : 0) + (status !== undefined && status >= 200 && status < 300 ? 300 : 0) + (json ? 400 : 0)
        + (e.resourceType === "xhr" || e.resourceType === "fetch" ? 100 : 0) + (values.some(([, v]) => lower.includes(v)) ? 200 : 0) + Math.min(body.length / 1000, 100);
      return { id: e.id, method: e.request.method.toUpperCase(), url: e.request.url, resourceType: e.resourceType, status, contentType: e.response?.contentType, operationName: operationNameOf(e.request),
        hits, size: body.length, aborted: !!e.aborted,
        // a read's answer is data: an ack with hits still ranks below any real answer with one
        score: Math.round(isAck(e) ? score / 10 : score) };
    })
    .sort((a, b) => b.score - a.score);
}

/* ------------------------------------------------------------------ match */

/** @param {Req} req @param {string[]} at */
function tryGet(req, at) { try { return getAt(req, at); } catch { return undefined; } }

const GQL_NAME = /(?:^|\})\s*(?:query|mutation|subscription)\s+([A-Za-z_]\w*)/;

/** GraphQL-ish operation name from the body (a batch's first op too), form, query, or Meta's friendly-name header; else the name in the query text. @param {Req} req @returns {string|undefined} */
export function operationNameOf(req) {
  const fields = [["body", "json:/operationName"], ["body", "json:/0/operationName"], ["form:fb_api_req_friendly_name"], ["form:operationName"], ["query:operationName"], ["header:x-fb-friendly-name"]];
  for (const at of fields) { const v = tryGet(req, at); if (typeof v === "string" && v) return v; }
  // A GET GraphQL call names its query in queryId as "<name>.<hash>": the name before the dot is the stable identity; the hash is what a deploy rotates.
  const qid = tryGet(req, ["query:queryId"]);
  const named = typeof qid === "string" ? /^([A-Za-z][A-Za-z0-9_]*)\.[0-9a-fA-F_-]{8,}$/.exec(qid) : null;
  if (named) return named[1];
  for (const at of [["body", "json:/query"], ["body", "json:/0/query"], ["form:query"], ["query:query"]]) {
    const v = tryGet(req, at);
    const m = typeof v === "string" ? GQL_NAME.exec(v) : null;
    if (m) return m[1];
  }
  return undefined;
}

/** camelCase, PascalCase, snake and kebab words ("UserByScreenName") are names, not hashes. @param {string} s */
const wordy = s => !/\d/.test(s) && s.split(/[_-]|(?=[A-Z])/).every(w => w === "" || /^[A-Z]?[a-z]+$/.test(w));
/** Long random-looking token: a queryId or hash, never a word. @param {string} s */
export const hashLike = s => s.length >= 16 && /^[A-Za-z0-9_-]+$/.test(s) && /[A-Za-z]/.test(s) && !wordy(s);

/** Does a request match an op's stable identity (method, host, path with `*` for one segment, GraphQL operation name)? Never a hash. @param {any} m @param {Req} req */
export function matches(m, req) {
  let u;
  try { u = new URL(req.url); } catch { return false; }
  if (m.method && m.method.toUpperCase() !== req.method.toUpperCase()) return false;
  if (m.host && m.host.toLowerCase() !== u.hostname.toLowerCase()) return false;
  if (m.path) {
    const want = m.path.split("/"), got = u.pathname.split("/");
    if (want.length !== got.length || want.some((/** @type {string} */ w, /** @type {number} */ i) => w !== "*" && w !== got[i])) return false;
  }
  if (m.operationName && operationNameOf(req) !== m.operationName) return false;
  return true;
}

/** @param {Req} req @param {Set<number>} paramSegments */
function buildMatch(req, paramSegments) {
  const u = new URL(req.url);
  const path = u.pathname.split("/").map((seg, i) => (i > 0 && (paramSegments.has(i - 1) || hashLike(seg) || /^\d{6,}$/.test(seg)) ? "*" : seg)).join("/");
  const operationName = operationNameOf(req);
  return { method: req.method.toUpperCase(), host: u.hostname, path, ...(operationName ? { operationName } : {}) };
}

/* --------------------------------------------------------------- learning */

// Conditional headers (a revalidating browser's If-None-Match) would turn every replay into a 304. The body is stored decoded, so its content-encoding goes too.
const DROP_HEADER = /^(:.*|host|content-length|connection|cookie|accept-encoding|content-encoding|if-[a-z-]+)$/i;
const SESSION_HEADER = /^(authorization|x-[a-z0-9-]*token|x-csrf[a-z0-9-]*|x-xsrf[a-z0-9-]*|x-goog-batchexecute-bgr|x-client-transaction-id|x-fb-lsd|x-ig-www-claim)$/i;
// Per-session credentials sent in forms, queries or JSON bodies: Google's `at`, Meta's fb_dtsg and lsd, Rails' and ASP.NET's anti-CSRF fields, OAuth-style access tokens.
const SESSION_FIELD = /^(at|fb_dtsg|lsd|authenticity_token|__RequestVerificationToken|_?csrf(_?token)?|_?xsrf(_?token)?|csrfmiddlewaretoken|(access_?)?token|session_?id)$/i;
// Headers the browser computes itself: an example inside them is a coincidence, and they never carry a nonce of the site's.
const BROWSER_HEADER = /^(user-agent|accept(-[a-z-]+)?|content-(type|language)|sec-[a-z0-9-]+|if-[a-z-]+|priority|dnt|upgrade-insecure-requests|cache-control|pragma|x-requested-with)$/i;
const URL_HEADER = new Set(["header:referer", "header:origin"]);
const URL_SHAPED = /^([a-z][a-z0-9+.-]*:\/\/|\/)\S*$/i;
const VOLATILE_KEY = /^(doc_?id|query_?id|document_?id|sha256_?hash|query_?hash|persisted_?query_?hash|hash)$/i;

const key = (/** @type {string[]} */ at) => JSON.stringify(at);
const headerName = (/** @type {string[]} */ at) => (at[0].startsWith("header:") ? at[0].slice(7) : undefined);
const escapeRe = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const lastToken = (/** @type {string[]} */ at) => { const s = at[at.length - 1]; return s.startsWith("json:") ? s.slice(s.lastIndexOf("/") + 1) : s.slice(s.indexOf(":") + 1); };
/** The name a leaf goes by: its header, field, query key or JSON key. @param {string[]} at */
export const leafName = at => headerName(at) ?? lastToken(at);

/** Example values must be locatable and distinct. @param {Args} args @param {string} label */
export function checkExamples(args, label) {
  /** @type {Map<string, string>} */ const seen = new Map();
  for (const [name, v] of Object.entries(args)) {
    const s = asText(v).toLowerCase();
    if (s.length < 3) throw new Error(`${label} ${name}=${JSON.stringify(v)}: example values need at least 3 characters to be located`);
    const other = seen.get(s);
    if (other) throw new Error(`${label}: ${other} and ${name} share the value ${JSON.stringify(v)}; example values must be distinct`);
    seen.set(s, name);
  }
}

/** @param {Exchange} e */
function headersOf(e) {
  /** @type {Record<string, string>} */ const out = {};
  for (const [k, v] of Object.entries(e.request.headers)) if (!DROP_HEADER.test(k)) out[k.toLowerCase()] = v;
  return out;
}

/** @param {any} input @param {Exchange[]} exchanges @param {Args} args @param {string[]} pages @param {string[]} warnings @returns {Exchange} */
function pickExchange(input, exchanges, args, pages, warnings) {
  if (input.id !== undefined) {
    const e = exchanges.find(x => x.id === input.id);
    if (!e) throw new Error(`no captured request with id ${input.id}`);
    return e;
  }
  const pool = input.match ? exchanges.filter(e => matches(input.match, e.request)) : exchanges;
  const ranked = rankCandidates(pool, args, { all: !!input.match, pages }).filter(c => input.match || c.hits.length);
  if (!ranked.length) throw new Error(input.match ? `no captured request matches ${JSON.stringify(input.match)}` : "no captured request carries the example values; check the trigger, or pass match or id");
  const byId = (/** @type {number} */ id) => /** @type {Exchange} */ (exchanges.find(e => e.id === id));
  // A response recipe names the answer: a beacon echoing the page URL doesn't resolve it.
  const accepted = input.accepts && ranked.find(c => input.accepts(byId(c.id)));
  if (accepted) return byId(accepted.id);
  const [top, next] = ranked;
  if (next && next.score === top.score) warnings.push(`ambiguous: requests #${top.id} and #${next.id} rank equally; learned #${top.id}, pass id or match to choose`);
  return byId(top.id);
}

/** Pointers inside a JSON text whose value equals want (an array or object example). @param {any} root @param {string} want @param {string} [ptr] @returns {string[]} */
function jsonPointers(root, want, ptr = "") {
  if (JSON.stringify(root) === want) return [ptr];
  if (!root || typeof root !== "object") return [];
  return Object.entries(root).flatMap(([k, c]) => jsonPointers(c, want, `${ptr}/${k.replace(/~/g, "~0").replace(/\//g, "~1")}`));
}

/** @typedef {{ leaf: Leaf, text: string, encoded: boolean }} Hit */

/** How the arg is escaped inside a templated leaf: URL-valued leaves take it percent-encoded, JSON string literals escaped. @param {Leaf} leaf @param {Hit[]} hits @returns {"url"|"json"|undefined} */
function escapeOf(leaf, hits) {
  if (URL_HEADER.has(leaf.at[0])) return undefined;
  if (hits.some(h => h.encoded)) return "url";
  if (URL_SHAPED.test(leaf.value) && hits.every(h => encodeURIComponent(h.text) === h.text)) return "url";
  const i = leaf.value.toLowerCase().indexOf(hits[0].text);
  const quotes = leaf.value.slice(0, Math.max(0, i)).match(/(?<!\\)"/g)?.length ?? 0;
  return quotes % 2 ? "json" : undefined;
}

/** Random-looking: 16+ chars, no spaces, not a URL, two character classes, 3+ bits of entropy per char. @param {string} v */
export function highEntropy(v) {
  if (v.length < 16 || /\s/.test(v) || URLISH.test(v)) return false;
  if ([/[a-z]/, /[A-Z]/, /\d/].filter(r => r.test(v)).length < 2) return false;
  /** @type {Map<string, number>} */ const n = new Map();
  for (const c of v) n.set(c, (n.get(c) ?? 0) + 1);
  let bits = 0;
  for (const k of n.values()) bits -= (k / v.length) * Math.log2(k / v.length);
  return bits >= 3;
}

const notFound = (/** @type {string} */ name, /** @type {any} */ raw) => new Error(`example value for "${name}" (${JSON.stringify(raw)}) is not in the learned request, so the input would change nothing. Pick the request that carries it (pass its id), or drop the input`);

/**
 * Slots for the example args. An exact leaf is a slot; a leaf holding the value inside other text (never a number, flag or browser header) is a templated slot. Referer, Origin, Cookie and any
 * echo of the page's location follow the args but are not evidence: a value found only there changes nothing the server reads.
 * @param {Leaf[]} leaves @param {Args} args @param {Locations} locs @param {string[]} warnings
 */
function paramSlots(leaves, args, locs, warnings) {
  /** @type {any[]} */ const slots = [];
  /** @type {Map<string, string>} */ const types = new Map();
  /** @type {Map<string, { exact: Leaf[], part: Hit[] }>} */ const found = new Map();
  for (const [name, raw] of Object.entries(args)) {
    if (raw !== null && typeof raw === "object") {
      // an array or object example binds to the JSON container equal to it
      const want = JSON.stringify(raw);
      const at = leaves.filter(l => l.container).flatMap(l => jsonPointers(JSON.parse(l.value), want).map(p => [...l.at, `json:${p}`]));
      if (!at.length) throw notFound(name, raw);
      for (const a of at) slots.push({ param: name, at: a });
      types.set(name, Array.isArray(raw) ? "array" : "object");
      continue;
    }
    const v = asText(raw).toLowerCase();
    const literal = /^(true|false|null)$/.test(v);
    const digits = /^\d+$/.test(v);
    const enc = encodeURIComponent(asText(raw)).toLowerCase();
    const forms = [...new Set([enc, enc.replace(/%20/g, "+")])].filter(f => f !== v);
    // digits inside a longer number (a timestamp, a cache-buster) are not the arg
    const inside = (/** @type {string} */ text, /** @type {string} */ t) => (digits ? new RegExp(`(?<!\\d)${t}(?!\\d)`).test(text) : text.includes(t));
    /** @type {Leaf[]} */ let exact = [];
    /** @type {Hit[]} */ const part = [];
    for (const leaf of leaves) {
      const header = headerName(leaf.at);
      if (header === "cookie" || (header && BROWSER_HEADER.test(header))) continue;
      const text = leaf.value.toLowerCase();
      if (text === v) { exact.push(leaf); continue; }
      if (leaf.container || leaf.type !== "string" || literal) continue;
      if (header && !URL_HEADER.has(leaf.at[0]) && !header.startsWith("x-")) continue;
      // a short example ("SFO") turns up by chance inside a random token: there it must stand alone
      const within = v.length <= 4 && highEntropy(leaf.value) ? (/** @type {string} */ t, /** @type {string} */ x) => new RegExp(`(?<![a-z0-9])${escapeRe(x)}(?![a-z0-9])`).test(t) : inside;
      if (within(text, v)) part.push({ leaf, text: v, encoded: false });
      else {
        const f = forms.find(x => within(text, x));
        if (f) part.push({ leaf, text: f, encoded: true });
      }
    }
    if (literal && exact.length) {
      // X-style GraphQL sends dozens of true flags, and a lone one may be any flag: bind only the one named like the input
      const named = exact.filter(l => lastToken(l.at).toLowerCase() === name.toLowerCase());
      if (!named.length) throw new Error(`example value for "${name}" (${JSON.stringify(raw)}) matches ${exact.length} flag(s) (${exact.map(l => l.at.join(" > ")).join("; ")}), none with the key "${name}"; name the input after its key so it binds to one`);
      exact = named;
    }
    found.set(name, { exact, part });
  }
  // A leaf that equals one input's value belongs to that input, even if another's value is inside it.
  const exactKeys = new Set([...found.values()].flatMap(f => f.exact.map(l => key(l.at))));
  /** @type {Map<string, Hit[]>} */ const partial = new Map();
  for (const [name, f] of found) {
    const part = f.part.filter(h => !exactKeys.has(key(h.leaf.at)));
    const v = asText(args[name]).toLowerCase();
    const places = [...f.exact, ...part.map(h => h.leaf)].filter(l => !NOT_EVIDENCE.has(l.at[0]) && !echoes(l.value, v, locs)).map(l => l.at.join(" > "));
    if (!places.length) throw notFound(name, args[name]);
    if (places.length > 1) warnings.push(`"${name}" appears in ${places.length} places, all will be filled: ${places.join("; ")}`);
    for (const leaf of f.exact) {
      slots.push({ param: name, at: leaf.at });
      if (leaf.type === "number") types.set(name, "number");
      if (leaf.type === "boolean") types.set(name, "boolean");
    }
    for (const h of part) partial.set(key(h.leaf.at), [...(partial.get(key(h.leaf.at)) ?? []), { ...h, text: `${name}\0${h.text}` }]);
  }
  for (const hits of partial.values()) {
    const leaf = hits[0].leaf;
    const byText = new Map(hits.map(h => [h.text.slice(h.text.indexOf("\0") + 1), h.text.slice(0, h.text.indexOf("\0"))]));
    // one alternation, longest first, so "nasa" never splits "nasagov"
    const alts = [...byText.keys()].sort((a, b) => b.length - a.length).map(t => (/^\d+$/.test(t) ? `(?<!\\d)${t}(?!\\d)` : escapeRe(escapeTemplate(t))));
    const template = escapeTemplate(leaf.value).replace(new RegExp(alts.join("|"), "gi"), m => `{${byText.get(m.toLowerCase())}}`);
    const plain = hits.map(h => ({ ...h, text: h.text.slice(h.text.indexOf("\0") + 1) }));
    const escape = escapeOf(leaf, plain);
    slots.push({ param: /** @type {string} */ (byText.values().next().value), at: leaf.at, template, ...(escape ? { escape } : {}) });
  }
  return { slots, types };
}

/* ------------------------------------------------------------ credentials */

// Words that name a credential in a key or header: api_key, authToken, x-session-id, sid, X-Amz-Signature.
const CREDENTIAL_WORD = /^(?:auth(?!or)[a-z0-9]*|[a-z0-9]*(?:token|secret|key|signature|password|passwd|pwd|credential|bearer)s?|sess(?:ion)?[a-z0-9]*|sid)$/;

/** A key or header named like a credential, judged by its words (authToken: auth, token; "author" is not). @param {string} name */
export function credentialName(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).some(w => CREDENTIAL_WORD.test(w));
}

/** A literal a template must not hold: a per-session field or header, or a random value under a credential's name. @param {string} name @param {string} value */
export function isCredential(name, value) {
  return ((SESSION_FIELD.test(name) || SESSION_HEADER.test(name)) && value.length >= 8) || (credentialName(name) && highEntropy(value));
}

/** A script every visitor gets byte for byte (cacheable by shared caches, fetched without the user's cookies or marked public). @param {Exchange} e */
function staticBundle(e) {
  if (e.resourceType !== "script" || e.request.method.toUpperCase() !== "GET" || !e.response) return false;
  const cc = Object.entries(e.response.headers).find(([k]) => k.toLowerCase() === "cache-control")?.[1] ?? "";
  if (/private|no-store/i.test(cc)) return false;
  return !e.request.headers.cookie || /\bpublic\b|immutable/i.test(cc);
}

/** @param {string} header @returns {Record<string, string>} */
export function parseCookieHeader(header) {
  /** @type {Record<string, string>} */ const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** @typedef {{ ref: string, transform?: "strip-quotes"|"url-decode", value?: string }} Live */

/**
 * Live values (8+ chars) a request may repeat, used only to recognise a credential: cookies (raw, unquoted, URL-decoded) and the page's localStorage and sessionStorage, including string
 * leaves of a JSON entry. A cookie is a `cookie:` ref; a storage value a `session:` ref. The values are matched and dropped, never returned.
 * @param {{ name: string, value: string }[]} cookies @param {string|undefined} cookieHeader @param {Record<string, string>} [storage] @returns {Map<string, Live>}
 */
function liveValues(cookies, cookieHeader, storage = {}) {
  /** @type {Map<string, Live>} */ const out = new Map();
  const put = (/** @type {string} */ v, /** @type {Live} */ live) => v.length >= 8 && !out.has(v) && out.set(v, live);
  for (const [name, value] of [...cookies.map(c => /** @type {[string, string]} */ ([c.name, c.value])), ...Object.entries(parseCookieHeader(cookieHeader ?? ""))]) {
    let decoded = value;
    try { decoded = decodeURIComponent(value); } catch { /* keep raw */ }
    put(value, { ref: `cookie:${name}` });
    put(value.replace(/^"|"$/g, ""), { ref: `cookie:${name}`, transform: "strip-quotes" });
    put(decoded, { ref: `cookie:${name}`, transform: "url-decode" });
  }
  for (const [name, value] of Object.entries(storage)) {
    put(value, { ref: `session:${name}`, value });
    /** @param {any} v @param {string} k */
    const visit = (v, k) => {
      if (typeof v === "string") put(v, { ref: `session:${name}/${k}`, value: v });
      else if (v && typeof v === "object") for (const [kk, c] of Object.entries(v)) visit(c, k ? `${k}/${kk}` : kk);
    };
    if (/^\s*[[{]/.test(value)) visit(tryParse(value), "");
  }
  return out;
}

/** @param {string} s */
function shapeOfToken(s) {
  const charset = /^\d+$/.test(s) ? "digits" : /^[0-9a-f]+$/i.test(s) ? "hex" : /^[A-Za-z0-9_-]+$/.test(s) ? "base64url" : "base64";
  return { charset, length: s.length };
}

/** @param {Req} req @param {Leaf[]} leaves @param {Set<string>} taken @param {string|undefined} opName */
function volatileAnchors(req, leaves, taken, opName) {
  /** @type {any[]} */ const out = [];
  // A body queryId repeating the path id shares the path's anchor; "queryId" itself is too generic to rescan by.
  /** @type {Map<string, string>} */ const anchorOf = new Map();
  const segs = new URL(req.url).pathname.split("/").slice(1);
  for (const leaf of leaves) {
    if (leaf.container || taken.has(key(leaf.at)) || leaf.at[0].startsWith("header:")) continue;
    const first = leaf.at[0];
    if (leaf.at.length === 1 && first.startsWith("path:")) {
      if (!hashLike(leaf.value)) continue;
      const i = Number(first.slice(5));
      const anchor = opName ?? segs[i + 1] ?? segs[i - 1];
      if (anchor) { out.push({ at: leaf.at, shape: shapeOfToken(leaf.value), anchor }); anchorOf.set(leaf.value, anchor); }
    } else if (VOLATILE_KEY.test(lastToken(leaf.at)) && (hashLike(leaf.value) || /^\d{8,}$/.test(leaf.value))) {
      out.push({ at: leaf.at, shape: shapeOfToken(leaf.value), anchor: opName ?? anchorOf.get(leaf.value) ?? lastToken(leaf.at) });
    }
  }
  return out;
}

/** Path to the richest array carrying an example value, else the object holding it, else the biggest array. @param {any} root @param {string[]} values @returns {string|undefined} */
export function suggestExtract(root, values) {
  const carries = (/** @type {any} */ v) => { const s = JSON.stringify(v).toLowerCase(); return values.some(x => s.includes(x)); };
  /** @type {{ path: string, len: number }|undefined} */ let bestArray;
  /** @type {{ path: string, len: number }|undefined} */ let anyArray;
  /** @type {{ path: string, depth: number }|undefined} */ let holder;
  const queue = [{ v: root, path: "", depth: 0 }];
  while (queue.length) {
    const { v, path, depth } = /** @type {any} */ (queue.shift());
    if (depth > 8 || !v || typeof v !== "object") continue;
    /** @type {[string, any][]} */
    const children = Array.isArray(v) ? v.slice(0, 50).map((c, i) => [`${path}[${i}]`, c]) : Object.entries(v).map(([k, c]) => [/^[\w$-]+$/.test(k) ? (path ? `${path}.${k}` : k) : `${path}[${JSON.stringify(k)}]`, c]);
    // a top-level list of results is itself the answer: "" (the whole response) beats any item in it
    if (Array.isArray(v) && !path && v.length > 1 && v.some(x => x !== null && typeof x === "object") && carries(v)) return "";
    if (Array.isArray(v) && path) {
      if (!anyArray || v.length > anyArray.len) anyArray = { path, len: v.length };
      const rank = v.length + (v.some(x => x !== null && typeof x === "object") ? 1e6 : 0);
      if (v.length > 1 && (!bestArray || rank > bestArray.len) && carries(v)) bestArray = { path, len: rank };
    }
    for (const [p, c] of children) {
      const inner = typeof c === "string" ? innerJson(c) : undefined;
      if (inner && typeof inner === "object") queue.push({ v: inner, path: p, depth: depth + 1 });
      else if (c && typeof c === "object") queue.push({ v: c, path: p, depth: depth + 1 });
      else if (path && c != null && values.includes(String(c).toLowerCase()) && (!holder || depth > holder.depth)) holder = { path, depth };
    }
  }
  return bestArray?.path ?? holder?.path ?? anyArray?.path;
}

/** @param {Exchange} e @param {string[]} values @param {string[]} warnings */
function learnResponse(e, values, warnings) {
  const r = e.response;
  if (!r) return { format: "json" };
  const body = r.body ?? "";
  const xssiPrefix = xssiOf(body);
  const data = tryParse(body);
  if (data !== null && typeof data === "object") {
    const extract = suggestExtract(data, values);
    return { format: "json", contentType: r.contentType, ...(xssiPrefix ? { xssiPrefix } : {}), ...(extract ? { extract } : {}), shape: inferShape(data) };
  }
  warnings.push(/html/i.test(r.contentType) ? "the answer is a page (HTML): read it from the page with a recipe, or pick the data request" : `the answer is ${r.contentType || "untyped"} text, returned raw`);
  return { format: "html", contentType: r.contentType };
}

/**
 * Two-run diff: positions that change without an input change are nonces (unless they look like counters).
 * @param {Req} req1 @param {Req} req2 @param {any[]} slots @param {Args} args2 @param {string[]} warnings @returns {string[]}
 */
function diffRuns(req1, req2, slots, args2, warnings) {
  const bySlot = new Map(slots.map(s => [key(s.at), s]));
  const second = new Map(walk(req2).map(l => [key(l.at), l]));
  const values2 = exampleValues(args2).map(([, v]) => v);
  /** @type {string[]} */ const nonces = [], missing = [];
  for (const leaf of walk(req1)) {
    if (leaf.container || leaf.at[0] === "header:cookie") continue;
    const k = key(leaf.at);
    const slot = bySlot.get(k);
    const other = second.get(k);
    if (slot?.ref) continue;
    const header = headerName(leaf.at);
    if (header && BROWSER_HEADER.test(header)) continue;
    if (!other) { missing.push(leaf.at.join(" > ")); continue; }
    if (slot?.param) {
      const want = slot.template !== undefined ? fillSlotTemplate(slot.template, args2, slot.escape) : asText(args2[slot.param]);
      // a credential hole matches whatever run 2's session held
      const same = new RegExp(`^${want.split(/\{(?:cookie|session):[^{}]+\}/).map(escapeRe).join(".*?")}$`, "is");
      if (same.test(other.value)) continue;
      // The text around the arg changed too: a signature inside the leaf (a signed URL in a param).
      const holes = slot.template !== undefined ? [...Object.keys(args2), ...templateRefs(slot.template)] : [];
      const literals = slot.template !== undefined ? fillSlotTemplate(slot.template, Object.fromEntries(holes.map(k => [k, "\0"]))).split("\0") : [];
      if (literals.some(l => l && !other.value.toLowerCase().includes(l.toLowerCase()))) nonces.push(leaf.at.join(" > "));
      else warnings.push(`run 2 has ${JSON.stringify(other.value)} at ${leaf.at.join(" > ")}, expected ${JSON.stringify(want)}`);
      continue;
    }
    if (other.value === leaf.value) continue;
    const where = leaf.at.join(" > ");
    if (values2.some(v => other.value.toLowerCase().includes(v))) warnings.push(`${where} follows the inputs in run 2 but did not match example 1; check its format`);
    else if ((/^\d+$/.test(leaf.value) && /^\d+$/.test(other.value)) || Math.max(leaf.value.length, other.value.length) <= 4) warnings.push(`${where} varies between runs (counter or timestamp?); kept constant`);
    else nonces.push(where);
  }
  if (missing.length) warnings.push(`run 2 lacks ${missing.length} position(s) of run 1, e.g. ${missing.slice(0, 3).join("; ")}`);
  return nonces;
}

/**
 * @typedef {object} LearnInput
 * @property {Exchange[]} exchanges
 * @property {Exchange[]} [exchanges2] the second trigger run, made with examples[1]
 * @property {[Args] | [Args, Args]} examples
 * @property {{ name: string, value: string }[]} [cookies] only to recognise a credential in the request; never kept
 * @property {any} [match]
 * @property {number} [id] exchange id to learn from, when the caller already chose one
 * @property {string} name
 * @property {any} trigger
 * @property {string} [kind] read (default), draft, change, send, spend, delete
 * @property {string[]} [public] header or field names a person marked as public constants: kept literal, never a ref
 * @property {Record<string, string>} [storage] the page origin's localStorage and sessionStorage at capture time
 * @property {(e: Exchange) => boolean} [accepts]
 * @property {string[]} [pages]
 * @property {string[]} [rungs]
 * @property {string} [now] ISO time for learnedAt
 * @property {boolean} [keepExamples] keep the example values in the params: only for a public example a kit ships, never for a person's own input
 */

/**
 * Learn one operation. Returns { operation, exchange, warnings }; throws a plain-sentence Error when the examples cannot be found in the captured traffic.
 * @param {LearnInput} input
 */
export function learnOperation(input) {
  /** @type {string[]} */ const warnings = [];
  const [args1, args2] = input.examples;
  checkExamples(args1, "example");
  if (args2) {
    checkExamples(args2, "example 2");
    if (Object.keys(args2).sort().join() !== Object.keys(args1).sort().join()) warnings.push("example 2 names different inputs than example 1");
  }
  const kind = input.kind ?? "read";
  const ro = kind === "read";

  // 1. pick the request
  const enc = Object.fromEntries(Object.entries(args1).map(([k, v]) => [k, encodeURIComponent(asText(v))]));
  const pages = pageUrls(input.exchanges, [fillTemplate(input.trigger.url, enc), ...(input.pages ?? [])]);
  const ex = pickExchange(input, input.exchanges, args1, pages, warnings);
  // A read's answer is data. Picked by rank alone, a data-less 2xx is a beacon's ack whose echo of the page went unrecognized; learning it would answer every call with {"success":true}.
  const answer = (ex.response?.body ?? "").toLowerCase();
  const echoesArgs = exampleValues(args1).some(([, v]) => v.length >= 3 && answer.includes(v));
  if (ro && isAck(ex) && !echoesArgs && input.id === undefined && !input.match) {
    throw new Error(`the request that carries the example values (#${ex.id} ${ex.request.method} ${ex.request.url.slice(0, 120)}) answers without data (${JSON.stringify((ex.response?.body ?? "").trim().slice(0, 60))}): an analytics beacon's ack, not the operation's answer. Pick the data request (pass its id)`);
  }
  /** @type {Req} */
  let request = { method: ex.request.method.toUpperCase(), url: ex.request.url, headers: headersOf(ex), ...(ex.request.body !== undefined ? { body: ex.request.body } : {}) };
  const leaves = walk(request);

  // 2. inputs. A request picked by id is the caller's own choice: an echo-shaped leaf there is evidence.
  const { slots, types } = paramSlots(leaves, args1, input.id !== undefined ? { abs: [], rel: [] } : locations(pages), warnings);
  const taken = new Set(slots.map(s => key(s.at)));

  // 4. credential refs: live cookie or storage values anywhere, per-session fields, credential-named values, auth headers. Values are matched, never kept.
  /** @type {Record<string, string>} */ const sessionValues = {};
  const live = liveValues(input.cookies ?? [], ex.request.headers.cookie, input.storage);
  /** @param {string[]} at @param {any} slot @param {string} [value] */
  const addRef = (at, slot, value) => {
    if (value !== undefined && slot.ref?.startsWith("session:")) {
      let name = slot.ref.slice(8);
      if (sessionValues[name] !== undefined && sessionValues[name] !== value) name += `@${encodeURIComponent(key(at))}`;
      slot = { ...slot, ref: `session:${name}` };
      sessionValues[name] = value;
      if (!live.get(value)?.ref.startsWith("cookie:")) live.set(value, { ref: slot.ref, value });
    }
    slots.push({ ...slot, at });
    taken.add(key(at));
  };
  for (const leaf of leaves) {
    const l = live.get(leaf.value);
    // string leaves only: a ref is filled with a string, which would retype a JSON number
    if (!l || leaf.type !== "string" || taken.has(key(leaf.at))) continue;
    // an app caching a persisted-query hash in storage does not make the hash a credential
    if (l.value !== undefined && VOLATILE_KEY.test(lastToken(leaf.at))) continue;
    addRef(leaf.at, { ref: l.ref, ...(l.transform ? { transform: l.transform } : {}) }, l.value);
  }
  const publicNames = new Set((input.public ?? []).map(h => h.toLowerCase()));
  // A key the site ships in its own JS to every visitor (a public API key) is a constant, not a credential.
  const scripts = input.exchanges.flatMap(e => (staticBundle(e) && e.response?.body ? [e.response.body] : []));
  const shipped = new Set();
  const secretNamed = (/** @type {string} */ name, /** @type {string} */ value) => {
    if (publicNames.has(name.toLowerCase()) || !credentialName(name) || !highEntropy(value)) return false;
    if (!scripts.some(b => b.includes(value))) return true;
    shipped.add(name.toLowerCase());
    return false;
  };
  for (const leaf of leaves) {
    if (leaf.container || leaf.type !== "string" || leaf.at[0].startsWith("header:") || taken.has(key(leaf.at))) continue;
    const name = lastToken(leaf.at);
    if ((SESSION_FIELD.test(name) && leaf.value.length >= 8) || secretNamed(name, leaf.value)) addRef(leaf.at, { ref: `session:${name}` }, leaf.value);
  }
  const fieldOf = new Map(Object.entries(sessionValues).map(([k, v]) => [v, k]));
  for (const [name, value] of Object.entries(request.headers)) {
    const at = [`header:${name}`];
    if (publicNames.has(name) || taken.has(key(at))) continue;
    // Meta's x-fb-lsd repeats the lsd field: one credential, one ref.
    const same = value.length >= 8 ? fieldOf.get(value) : undefined;
    if (!same && !SESSION_HEADER.test(name) && (BROWSER_HEADER.test(name) || !secretNamed(name, value))) continue;
    addRef(at, { ref: `session:${same ?? name}` }, same ? undefined : value);
  }
  // A random value an earlier answer of this capture handed the page is server-issued: a session ref under any name, refreshed by every trigger run.
  const issued = input.exchanges.flatMap(e => (e.id < ex.id && e.response?.body && !staticBundle(e) ? [e.response.body] : []));
  for (const leaf of leaves) {
    if (leaf.container || leaf.type !== "string" || taken.has(key(leaf.at)) || !highEntropy(leaf.value)) continue;
    const header = headerName(leaf.at);
    const name = leafName(leaf.at);
    if (leaf.at[0].startsWith("path:") || VOLATILE_KEY.test(name) || publicNames.has(name.toLowerCase())) continue;
    if (header && (URL_HEADER.has(leaf.at[0]) || BROWSER_HEADER.test(header))) continue;
    const escaped = JSON.stringify(leaf.value).slice(1, -1);
    if (!issued.some(b => b.includes(leaf.value) || b.includes(escaped))) continue;
    const ref = live.get(leaf.value)?.ref ?? `session:${name}@${encodeURIComponent(key(leaf.at))}`;
    addRef(leaf.at, { ref }, leaf.value);
  }
  // A live value inside a longer leaf ("v1:<cookie>", a next= URL holding it percent-encoded) is a templated ref, re-encoded like the leaf had it.
  const long = [...live].filter(([v]) => v.length >= 16);
  for (const leaf of leaves) {
    if (leaf.container || leaf.type !== "string") continue;
    // An input's templated leaf can carry one too: its template gets a ref hole.
    const own = taken.has(key(leaf.at)) ? slots.find(s => s.param && s.template !== undefined && key(s.at) === key(leaf.at)) : undefined;
    if (own) {
      for (const [v, l] of long) {
        if (l.transform) continue;
        /** @type {(any)[]} */
        const tries = own.escape ? [own.escape] : [undefined, "url", "json"];
        const i = tries.findIndex(e => own.template.includes(escapeTemplate(escapeValue(v, e))));
        if (i < 0) continue;
        const esc = tries[i];
        const form = escapeValue(v, esc);
        if (esc && !own.escape) own.escape = esc;
        own.template = own.template.split(escapeTemplate(form)).join(`{${l.ref}}`);
        request = setAt(request, leaf.at, String(getAt(request, leaf.at)).split(form).join(""));
      }
      continue;
    }
    if (taken.has(key(leaf.at))) continue;
    let template = escapeTemplate(leaf.value);
    /** @type {{ live: Live, escape: "url"|"json"|undefined }|undefined} */
    let primary;
    for (const [v, l] of long) {
      /** @type {[string, "url"|"json"|undefined][]} */
      const forms = [[v, undefined], [encodeURIComponent(v), "url"], [JSON.stringify(v).slice(1, -1), "json"]];
      const form = forms.find(([f, esc]) => template.includes(escapeTemplate(f)) && (!primary || primary.escape === esc));
      if (!form) continue;
      template = template.split(escapeTemplate(form[0])).join(`{${l.ref}}`);
      primary ??= { live: l, escape: form[1] };
    }
    if (primary) {
      const { live: l, escape } = primary;
      addRef(leaf.at, { ref: l.ref, ...(l.transform ? { transform: l.transform } : {}), template, ...(escape ? { escape } : {}) }, l.value);
    }
  }
  // The operation never holds a credential or an example: blank every ref leaf and every leaf an input fills, keeping its JSON type so a number stays a number when it is filled.
  const typeOf = new Map(leaves.map(l => [key(l.at), l.type]));
  /** @type {Record<string, any>} */
  const blank = { string: "", number: 0, boolean: false, null: null };
  for (const s of slots) request = setAt(request, s.at, s.ref ? "" : blank[typeOf.get(key(s.at)) ?? "string"]);

  // 5. volatile anchors
  const opName = operationNameOf(request);
  const volatile = volatileAnchors(request, leaves, taken, opName);

  // match: stable identity, with input and hash-like path segments wildcarded
  const paramSegments = new Set(slots.filter(s => s.param && s.at.length === 1 && s.at[0].startsWith("path:")).map(s => Number(s.at[0].slice(5))));
  const match = input.match ?? buildMatch(request, paramSegments);

  // 3. two-run diff
  let minTier = 1;
  if (input.exchanges2 && args2) {
    const pool = input.exchanges2.filter(e => matches(match, e.request));
    const top = rankCandidates(pool, args2, { all: true })[0];
    const ex2 = top && pool.find(e => e.id === top.id);
    if (!ex2) warnings.push("run 2 produced no matching request; skipped the two-run diff");
    else {
      // diff against the ORIGINAL request, with its examples in place: rebuild it unblanked
      const nonces = diffRuns({ ...ex.request, headers: headersOf(ex) }, { ...ex2.request, headers: headersOf(ex2) }, slots, args2, warnings);
      if (nonces.length) { minTier = 3; warnings.push(`changes between runs without an input change (nonce or signature), so a browser rung is needed: ${nonces.join("; ")}`); }
    }
  } else warnings.push("learned from one example; a second example separates inputs from nonces");

  // 8. response
  const response = learnResponse(ex, Object.values(args1).map(v => String(v).toLowerCase()), warnings);

  // An example is a value a person typed or a record they looked at: it does not stay in the operation unless the caller says it is a public one (a shipped site kit).
  const params = Object.entries(args1).map(([name, example]) => ({ name, type: types.get(name) ?? "string", required: true, ...(input.keepExamples ? { example } : {}) }));
  const login = slots.some(s => s.ref) || !!ex.request.headers.cookie;
  // Without a login or a nonce the page need not be the one to send it; a nonce or signature needs the page itself.
  const rungs = input.rungs ?? (minTier === 3 ? ["page", "box", "mac"] : login ? ["page", "box", "mac"] : ["page", "public", "box", "mac"]);

  const parsed = parseOperation({
    name: input.name, kind, request, slots, volatile, trigger: input.trigger, match, response, params, rungs,
    ...(publicNames.size || shipped.size ? { public: [...new Set([...publicNames, ...shipped])] } : {}),
    minTier, login, learnedAt: input.now ?? new Date().toISOString(),
  });
  if (!parsed.ok) throw new Error(`the learned operation is not valid: ${parsed.problems.join("; ")}`);
  return { operation: parsed.op, exchange: ex, warnings };
}

export { readOnly };
