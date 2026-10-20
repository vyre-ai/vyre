// @ts-check
// OpenCode, one Console key, two products that are never mixed. From their own docs and nothing else:
//   Go subscription  https://opencode.ai/v2/docs/console/go/
//   Inference API    https://opencode.ai/v2/docs/console/api/inference/
//   Model paths      https://opencode.ai/v2/docs/console/models/
// go === true lists GET https://opencode.ai/inference/go/v1/models and calls only under /inference/go/.
// Otherwise it lists GET https://opencode.ai/inference/v1/models and calls only under /inference/ (never /go/).
// Auth on both is Authorization: Bearer. A models GET with no User-Agent was refused (403) on both products, so both
// send User-Agent vyre/<version>. The inference page names only Authorization and Content-Type. The Go page asks a client
// to send its own User-Agent (not a generic SDK name) and x-opencode-session on an inference call (one stable id per
// conversation). That session header is Go only, and only when a conversation id exists. The models curls send neither.
// A live models row is { id, object, created, owned_by } and names no endpoint, context or price. owned_by is not a family.
// If a row later carries an endpoint, that path picks the family, and an unknown path is hidden (no prefix guess).
// The two products disagree (Go qwen3.8-max is Anthropic, the API's qwen3.8-max is chat; Go minimax-m3 is Anthropic, the API's is chat),
// so the prefix tables are separate. Longer prefixes win. systemone (jev) is a different body and is not called.
// Google's method :generateContent is on the inference page; both model tables omit it, so it is added to the documented model path.
// The version in the User-Agent is read here, the same rule as core/runner/protocol.js. Sessions and the daemon cannot import the runner (the boundary list).
// Error JSON is not on the pages. The class comes from the HTTP status (lib/ai-errors.js). The words are ours. The body is never repeated.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isLoopbackHost, resolveSafe, pinnedFetch } from "./api-endpoint.js";
import { aiError, classifyAiError } from "./ai-errors.js";
import { scrub as scrubText } from "./scrub.js";

const ORIGIN = "https://opencode.ai";
const MAX_HISTORY = 60;
const MAX_BODY = 1_000_000;

/** @typedef {"chat" | "responses" | "anthropic" | "google"} Family */

/** Go prefixes, longest first. From the Go endpoint table. A bare "minimax-" is not here: m2 models are on the live list and not in that table. */
const GO = sortPrefixes([
  ["minimax-m3.1", "chat"],
  ["minimax-m3", "anthropic"],
  ["muse-spark-", "responses"],
  ["deepseek-", "chat"],
  ["longcat-", "chat"],
  ["claude-", "anthropic"],
  ["gemini-", "google"],
  ["grok-", "responses"],
  ["gpt-", "responses"],
  ["glm-", "chat"],
  ["kimi-", "chat"],
  ["mimo-", "chat"],
  ["qwen", "anthropic"],
  ["hy4-", "chat"],
  ["hy3", "chat"],
  ["step-", "chat"],
  ["beam-", "chat"],
]);

/** API prefixes, longest first. From the models page, not the short inference blurbs (those disagree on qwen). */
const API = sortPrefixes([
  ["qwen3.8-flash", "anthropic"],
  ["qwen3.7-plus", "anthropic"],
  ["qwen3.7-max", "anthropic"],
  ["qwen3.6-plus", "anthropic"],
  ["qwen3.5-plus", "anthropic"],
  ["qwen3.8-max", "chat"],
  ["minimax-", "chat"],
  ["muse-spark-", "responses"],
  ["deepseek-", "chat"],
  ["longcat-", "chat"],
  ["claude-", "anthropic"],
  ["gemini-", "google"],
  ["grok-", "responses"],
  ["gpt-", "responses"],
  ["glm-", "chat"],
  ["kimi-", "chat"],
  ["mimo-", "chat"],
  ["mistral-", "chat"],
  ["nemotron-", "chat"],
  ["big-pickle", "chat"],
  ["ll-alpha-", "chat"],
  ["beam-", "chat"],
  ["exo-", "chat"],
]);

/** A path in an endpoint field, when a models row grows one. systemone is hidden by the caller before this. */
const ENDPOINT_FAMILY = [
  ["/openai/v1/chat/completions", "chat"],
  ["/openai/v1/responses", "responses"],
  ["/anthropic/v1/messages", "anthropic"],
  ["/google/v1beta/models/", "google"],
];

const WORDS = Object.freeze({
  go: Object.freeze({
    rate_limit: "Your OpenCode Go plan has used its share for the next few hours.",
    credits: "Your OpenCode Go plan has used its monthly share.",
    auth: "OpenCode Go refused that key. Check it in Settings, AI accounts.",
    unavailable: "OpenCode Go did not answer. Try again in a moment.",
    bad_request: "OpenCode Go refused that request.",
    refused: "OpenCode Go refused that request.",
  }),
  api: Object.freeze({
    rate_limit: "OpenCode refused that request for now. Try again in a moment.",
    credits: "OpenCode refused that request for now. Try again in a moment.",
    auth: "OpenCode refused that key. Check it in Settings, AI accounts.",
    unavailable: "OpenCode did not answer. Try again in a moment.",
    bad_request: "OpenCode refused that request.",
    refused: "OpenCode refused that request.",
  }),
});

/** @param {[string, string][]} rows */
function sortPrefixes(rows) {
  return Object.freeze([...rows].sort((a, b) => b[0].length - a[0].length || a[0].localeCompare(b[0])));
}

/** @type {string | null} */
let version = null;
/** vyre/<package version>, the shape Go asks a client to send instead of a generic SDK name. */
export function opencodeUserAgent() {
  if (!version) {
    try { version = String(JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")).version || "0.0.0"); }
    catch { version = "0.0.0"; }
  }
  const v = /^[0-9A-Za-z._+-]{1,40}$/.test(version) ? version : "0.0.0";
  return `vyre/${v}`;
}

/** A test double on this machine only. Any other host in the env is ignored, so a poisoned env cannot move the key. @param {string} name */
function loopbackOrigin(name) {
  try {
    const x = new URL(String(process.env[name] || ""));
    if (x.protocol === "http:" && isLoopbackHost(x.hostname)) return x.origin;
  } catch { /* not a URL */ }
  return null;
}

/** @param {boolean} go true is OpenCode Go only. Anything else, including a leftover provider id, is the regular API. */
export function opencodeRoot(go) {
  const on = go === true;
  const origin = loopbackOrigin(on ? "VYRE_OPENCODE_GO_URL" : "VYRE_OPENCODE_URL") || ORIGIN;
  return origin + (on ? "/inference/go" : "/inference");
}

/** The models list for this product only. @param {boolean} go */
export function modelsUrl(go) {
  return `${opencodeRoot(go)}/v1/models`;
}

/**
 * The family of one model, or null when it must not be called (hidden from the picker too).
 * An endpoint on the row wins. An endpoint this file does not know hides the model. No endpoint: that product's own prefix table.
 * @param {boolean} go @param {unknown} id @param {unknown} [endpoint] @returns {Family | null}
 */
export function familyOf(go, id, endpoint) {
  const hint = typeof endpoint === "string" ? endpoint : "";
  if (hint) {
    if (hint.includes("/systemone/")) return null;
    const hit = ENDPOINT_FAMILY.find(([p]) => hint.includes(p));
    return hit ? /** @type {Family} */ (hit[1]) : null;
  }
  const table = go === true ? GO : API;
  const name = String(id || "").trim().toLowerCase().replace(/^models\//, "");
  const row = table.find(([p]) => name.startsWith(p));
  return row ? /** @type {Family} */ (row[1]) : null;
}

/** Keep a models-list row only when this product can call it. @param {boolean} go @param {any} row */
export function keepModel(go, row) {
  const obj = row && typeof row === "object";
  const id = obj ? (row.id ?? row.name) : row;
  const endpoint = obj && typeof row.endpoint === "string" ? row.endpoint : obj && typeof row.url === "string" ? row.url : "";
  return Boolean(familyOf(go, id, endpoint || undefined));
}

/** Bearer and User-Agent. No session header: the models curls do not send one. @param {string} key */
export function listHeaders(key) {
  return { authorization: `Bearer ${key}`, "user-agent": opencodeUserAgent() };
}

/**
 * Inference headers. Go without a conversation id returns null (the call is not sent).
 * The regular API never sends x-opencode-session, even when a thread id exists.
 * @param {boolean} go @param {string} key @param {unknown} session @returns {Record<string, string> | null}
 */
export function callHeaders(go, key, session) {
  const headers = { ...listHeaders(key), "content-type": "application/json" };
  if (go !== true) return headers;
  const s = String(session || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200);
  if (!s) return null;
  headers["x-opencode-session"] = s;
  return headers;
}

/** @param {unknown} c */
function textOf(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => (typeof b === "string" ? b : b && typeof b === "object" ? String(b.text || b.content || "") : "")).join("");
  return c == null ? "" : String(c);
}

/** @param {any[] | undefined} messages */
function turns(messages) {
  const list = Array.isArray(messages) ? messages.slice(-MAX_HISTORY) : [];
  return list.map((m) => ({ role: String(m && m.role || "user"), content: textOf(m && m.content) }));
}

/**
 * The documented body for one family.
 * Chat: { model, messages }. Responses: { model, input } as one string (the docs show a string, not a messages array), so the conversation is not dropped.
 * Anthropic: max_tokens is required (the example uses 1024). A system role is lifted into `system` because the Messages API does not take it inside messages; the example shows only a user turn.
 * Google: { contents: [{ role, parts: [{ text }] }] }. The example omits role; user and model are sent so a second turn is not a guess of a single blob. Assistant is role model. A system line is put on the first user text.
 * @param {Family} family @param {string} model @param {any[] | undefined} messages @param {number | undefined} max
 */
export function bodyFor(family, model, messages, max) {
  const all = turns(messages);
  if (family === "chat") {
    const msgs = all.map((m) => ({ role: m.role === "assistant" || m.role === "system" ? m.role : "user", content: m.content }));
    return { model, messages: msgs, ...(max ? { max_tokens: max } : {}) };
  }
  if (family === "responses") {
    const input = all.map((m) => `${m.role}: ${m.content}`).join("\n");
    return { model, input };
  }
  if (family === "anthropic") {
    const system = all.filter((m) => m.role === "system").map((m) => m.content).filter(Boolean).join("\n\n");
    let msgs = all.filter((m) => m.role === "user" || m.role === "assistant").map((m) => ({ role: m.role, content: m.content }));
    if (!msgs.length) msgs = [{ role: "user", content: system || " " }];
    return { model, max_tokens: max || 1024, messages: msgs, ...(system && msgs[0].content !== system ? { system } : {}) };
  }
  const system = all.filter((m) => m.role === "system").map((m) => m.content).filter(Boolean).join("\n\n");
  /** @type {{ role: string, parts: { text: string }[] }[]} */
  const contents = [];
  let pending = system;
  for (const m of all) {
    if (m.role === "system") continue;
    const role = m.role === "assistant" ? "model" : "user";
    const text = pending && role === "user" ? `${pending}\n\n${m.content}` : m.content;
    if (pending && role === "user") pending = "";
    contents.push({ role, parts: [{ text }] });
  }
  if (!contents.length) contents.push({ role: "user", parts: [{ text: pending || " " }] });
  else if (pending) contents.unshift({ role: "user", parts: [{ text: pending }] });
  return { contents };
}

/** @param {boolean} go @param {Family} family @param {string} model */
export function callUrl(go, family, model) {
  const root = opencodeRoot(go);
  if (family === "chat") return `${root}/openai/v1/chat/completions`;
  if (family === "responses") return `${root}/openai/v1/responses`;
  if (family === "anthropic") return `${root}/anthropic/v1/messages`;
  return `${root}/google/v1beta/models/${encodeURIComponent(model)}:generateContent`;
}

/** Text from the compatible API the docs name. OpenCode's pages show the request, not the response. @param {Family} family @param {any} j */
function textFrom(family, j) {
  if (!j || typeof j !== "object") return "";
  if (family === "chat") {
    const c = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    return textOf(c);
  }
  if (family === "anthropic") {
    const parts = Array.isArray(j.content) ? j.content : [];
    return parts.map((p) => (p && p.type === "text" ? String(p.text || "") : "")).join("");
  }
  if (family === "responses") {
    if (typeof j.output_text === "string" && j.output_text) return j.output_text;
    const out = Array.isArray(j.output) ? j.output : [];
    return out.flatMap((o) => (Array.isArray(o && o.content) ? o.content : [])).map((p) => (p && p.text ? String(p.text) : "")).join("");
  }
  const parts = j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts;
  return Array.isArray(parts) ? parts.map((p) => (p && p.text ? String(p.text) : "")).join("") : "";
}

/** @param {Family} family @param {any} j */
function usageOf(family, j) {
  const u = j && j.usage;
  if (family === "chat" && u) return { input_tokens: Number(u.prompt_tokens) || 0, output_tokens: Number(u.completion_tokens) || 0 };
  if ((family === "anthropic" || family === "responses") && u) return { input_tokens: Number(u.input_tokens) || 0, output_tokens: Number(u.output_tokens) || 0 };
  const g = j && j.usageMetadata;
  if (family === "google" && g) return { input_tokens: Number(g.promptTokenCount) || 0, output_tokens: Number(g.candidatesTokenCount) || 0 };
  return null;
}

/** @param {boolean} go @param {import("./ai-errors.js").AiErrorClass} cls @param {string} key */
function fail(go, cls, key) {
  const table = /** @type {Record<string, string>} */ (go === true ? WORDS.go : WORDS.api);
  const message = table[cls] || table.unavailable;
  throw aiError(cls, scrubText(message, key ? [key] : [], { marker: "[key]", min: 1 }));
}

/**
 * One inference call. The address is this product's documented path. credential.base is ignored: a person cannot point the key elsewhere.
 * @param {{ go?: boolean, key?: string, model?: string, messages?: any[], max?: number, session?: unknown, fetch?: (url: string, init: any) => Promise<any>, signal?: AbortSignal, timeoutMs?: number }} q
 * @returns {Promise<{ content: string, usage?: { input_tokens: number, output_tokens: number } }>}
 */
export async function opencodeCall(q) {
  const go = q.go === true;
  const key = String(q.key || "");
  const model = String(q.model || "");
  if (!key) fail(go, "auth", key);
  const family = familyOf(go, model);
  if (!family) throw aiError("bad_request", "OpenCode has no chat path for that model, so it was not called.");
  const headers = callHeaders(go, key, q.session);
  if (!headers) throw aiError("bad_request", "OpenCode Go needs a conversation id, so this was not sent.");
  const url = callUrl(go, family, model);
  const body = JSON.stringify(bodyFor(family, model, q.messages, q.max));
  const fetchImpl = q.fetch;
  const pin = fetchImpl ? null : await resolveSafe(url);
  if (!fetchImpl && !pin) fail(go, "unavailable", key);
  const send = fetchImpl || ((/** @type {string} */ u, /** @type {any} */ i) => pinnedFetch(u, i, /** @type {any} */ (pin)));
  let res;
  try {
    res = await send(url, { method: "POST", headers, body, signal: q.signal, timeoutMs: q.timeoutMs || 60_000, retries: 0 });
  } catch { fail(go, "unavailable", key); }
  if (!res) fail(go, "unavailable", key);
  const raw = String(await res.text().catch(() => ""));
  if (raw.length > MAX_BODY) fail(go, "unavailable", key);
  if (!res.ok) fail(go, classifyAiError({ status: res.status, text: raw.slice(0, 2000) }), key);
  let j = /** @type {any} */ (null);
  try { j = JSON.parse(raw); } catch { fail(go, "unavailable", key); }
  if (j && j.error) {
    const text = typeof j.error === "string" ? j.error : String(j.error.message || "");
    fail(go, classifyAiError({ status: j.error.code || j.error.status, text: text.slice(0, 2000) }), key);
  }
  const content = textFrom(family, j);
  if (!content) fail(go, "unavailable", key);
  const usage = usageOf(family, j);
  return { content, ...(usage ? { usage } : {}) };
}

/** Read one models list. A bad address throws bad_input. Anything else throws the key-check sentence. @param {boolean} go @param {string} key @param {((url: string, init: any) => Promise<any>) | undefined} fetchImpl */
async function readList(go, key, fetchImpl) {
  const url = modelsUrl(go);
  const headers = { accept: "application/json", ...listHeaders(key) };
  const ac = new AbortController(), timer = setTimeout(() => ac.abort(), 15_000);
  try {
    const pin = fetchImpl ? null : await resolveSafe(url);
    if (!fetchImpl && !pin) throw Object.assign(new Error("that address is not a place a key may be sent"), { code: "bad_input" });
    const send = fetchImpl || ((/** @type {string} */ u, /** @type {any} */ i) => pinnedFetch(u, i, /** @type {any} */ (pin)));
    const res = await send(url, { method: "GET", headers, signal: ac.signal, timeoutMs: 15_000, retries: 0 });
    const raw = res && typeof res.text === "function" ? String(await res.text().catch(() => "")).slice(0, MAX_BODY) : "";
    return { ok: Boolean(res && res.ok), status: res && res.status, raw };
  } catch (e) {
    if (/** @type {any} */ (e).code === "bad_input") throw e;
    throw Object.assign(new Error(/** @type {any} */ (e).name === "AbortError" ? "the service did not answer in time" : "could not reach the service to check the key"), { code: "bad_input" });
  } finally { clearTimeout(timer); }
}

/**
 * Check one Console key. The regular models list decides whether the key is kept (401 or 403 stores nothing).
 * The Go list only says whether "Only use OpenCode Go" can be offered. A miss there does not fail the key.
 * A 200 that is not JSON is still a good key. The key is never put in an error.
 * @param {string} key @param {(url: string, init: any) => Promise<any>} [fetchImpl] @returns {Promise<{ go_ok: boolean }>}
 */
export async function probeOpenCode(key, fetchImpl) {
  const regular = await readList(false, key, fetchImpl);
  if (regular.status === 401 || regular.status === 403) throw Object.assign(new Error("the service refused that key"), { code: "bad_input" });
  if (!regular.ok) throw Object.assign(new Error(`the service answered ${regular.status} when the key was checked`), { code: "bad_input" });
  let go_ok = false;
  try {
    const go = await readList(true, key, fetchImpl);
    if (go.ok) {
      let j = /** @type {any} */ (null);
      try { j = JSON.parse(go.raw); } catch { j = null; }
      const rows = Array.isArray(j && j.data) ? j.data : Array.isArray(j && j.models) ? j.models : [];
      go_ok = rows.some((r) => keepModel(true, r));
    }
  } catch { go_ok = false; }
  return { go_ok };
}

/**
 * The inference door's call. models() stays on the list driver (it already holds the key). input.go selects the product.
 * Message content is flattened to text here so a tool part is not sent as an array.
 * @param {{ fetch?: (url: string, init: any) => Promise<any>, timeoutMs?: number }} [entry]
 */
export function opencodeDoorDriver(entry = {}) {
  return {
    /** @param {{ go?: boolean, model?: string, messages?: any[], max_output_tokens?: number, session?: unknown, credential?: { key?: string, base?: string } }} input */
    call(input) {
      const go = input.go === true;
      const messages = Array.isArray(input.messages) ? input.messages.map((m) => ({ ...m, content: textOf(m && m.content) })) : input.messages;
      return opencodeCall({
        go, key: input.credential && input.credential.key, model: input.model, messages,
        max: input.max_output_tokens, ...(go ? { session: input.session } : {}), fetch: entry.fetch, timeoutMs: entry.timeoutMs,
      });
    },
  };
}
