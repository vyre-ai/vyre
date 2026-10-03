// @ts-check
// core/vault/forward-file.js: files through the forward (the lead's addition for a real firm: a retainer to the e-signature service, documents into the practice-management
// system). The same mechanism as forward (the call runs AT THE HOME, no key or token reaches the device) with the bytes kept off the forward and out of memory:
//   - BUILT: Drive references, both ways. The lent computer sends a Drive reference (path and version), never the file: the home reads it from the Drive as a stream and sends
//     it (a plain body, or a multipart form with text fields and Drive files). A download is saved straight into the Drive (`saveTo`) and the answer is a reference.
//     A response can also come back as a stream (`stream: true`) for an in-process caller; the kernel's remote call decides how to carry it.
//   - NOT BUILT: a file streamed up from the lent computer in the request itself. An outward call has to wait for a person, and a stream cannot wait; a file the device
//     holds goes into the Drive first (the sync the runner already has) and is sent from there.
// Per route: `maxBytes` (default 25 MB, up and down), `contentTypes` (what a request body, a part or a response may be; default JSON, form and plain text), and `drive`
// (`{ read, write }` lists of Drive paths the route may touch, default none). Nothing is held whole in memory: a file moves one chunk at a time, and a stream that goes over
// its cap is stopped and (for a save) leaves nothing behind. Anything outward is held for the ask-first task exactly as vault.request holds it; the card names the files, and
// what runs after approval is rebuilt from the held record and must match the file versions and content hashes the person saw.
import crypto from "node:crypto";
import https from "node:https";
import { pipeline, Readable } from "node:stream";
import { checkTarget, approvalHash, pinnedOptions, summarize } from "./api-request.js";
import { forwardHeaders, scrub } from "./request.js";

export const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
export const HARD_MAX_BYTES = 1024 * 1024 * 1024;
export const DEFAULT_TYPES = Object.freeze(["application/json", "application/x-www-form-urlencoded", "text/plain"]);
const ERROR_BODY = 64 * 1024, TEXT_BODY = 2_000_000, TIMEOUT_MS = 60_000;
const bad = (msg, code = "bad_input") => Object.assign(new Error(msg), { code });
const isStr = v => typeof v === "string", isObj = v => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const baseType = h => String(h || "").split(";")[0].trim().toLowerCase();
const typeOk = (list, t) => !!t && list.some(x => x === t || (x.endsWith("/*") && t.startsWith(x.slice(0, -1))));
const atPath = (pat, p) => (pat.endsWith("/*") ? p === pat.slice(0, -2) || p.startsWith(pat.slice(0, -1)) : p === pat);
const textual = t => /json|text|xml|javascript|x-www-form-urlencoded|csv|yaml|html/i.test(t);
const mb = n => `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;

/** The production streaming transport: one https request to an address already validated, the body sent as a stream and the reply handed back as a stream. */
export function httpsStream({ url, address, method, headers, body, length, timeoutMs = TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (body !== undefined) { if (length !== undefined) h["content-length"] = String(length); else h["transfer-encoding"] = "chunked"; }
    const req = https.request(pinnedOptions(url, address, { method, headers: h, timeout: timeoutMs }), res => {
      const heads = {}; for (const [k, v] of Object.entries(res.headers)) heads[k] = Array.isArray(v) ? v.join(", ") : String(v ?? "");
      resolve({ status: res.statusCode || 0, headers: heads, stream: res, abort: () => res.destroy() });
    });
    req.on("timeout", () => req.destroy(new Error("the API did not answer in time"))); req.on("error", reject);
    if (body === undefined) req.end(); else pipeline(Readable.from(body), req, e => { if (e) req.destroy(e); });
  });
}

/** A multipart form built as a stream: text fields and Drive files, with its exact length known in advance. @returns {{ contentType: string, length: number, iterable: AsyncIterable<Buffer> }} */
function multipart(parts) {
  const boundary = `vyre${crypto.randomBytes(12).toString("hex")}`, segs = [];
  let length = 0;
  for (const p of parts) {
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"${p.file ? `; filename="${p.filename}"` : ""}\r\n${p.file ? `Content-Type: ${p.contentType}\r\n` : ""}\r\n`);
    const tail = Buffer.from("\r\n");
    if (p.file) { segs.push({ b: head }, { file: p.file }, { b: tail }); length += head.length + p.file.size + tail.length; }
    else { const v = Buffer.from(String(p.value)); segs.push({ b: Buffer.concat([head, v, tail]) }); length += head.length + v.length + tail.length; }
  }
  const end = Buffer.from(`--${boundary}--\r\n`); segs.push({ b: end }); length += end.length;
  return { contentType: `multipart/form-data; boundary=${boundary}`, length, iterable: (async function* () { for (const s of segs) { if (s.b) yield s.b; else yield* s.file.stream(); } })() };
}
/** A Drive path is checked before anything moves: no dot segments, empty segments, leading slash, backslash, percent escapes or control characters. */
const drivePath = v => { if (!isStr(v) || !v || v.length > 1024 || v.startsWith("/") || /(^|\/)\.{1,2}(\/|$)|\/\/|[\\%\u0000-\u001f\u007f]/.test(v)) throw bad("a Drive path is a plain name", "bad_input"); return v; };
const clean = (v, what) => { if (!isStr(v) || !v || v.length > 200 || /[\r\n"\\\0]/.test(v)) throw bad(`${what} is a plain name`); return v; };

/**
 * @param {import("./request.js").ApiRequests} api
 * @param {{ files: { read: (path: string, version?: number | null) => Promise<{ version: number, size: number, sha256: string | null, stream: () => AsyncIterable<Buffer> }>,
 *   write: (path: string, source: AsyncIterable<Buffer>, o: { maxBytes: number, by: string }) => Promise<{ path: string, version: number, size: number, sha256: string }> } }} io
 * @param {any} input { credential, method, url, query?, headers?, body?, upload?, saveTo?, stream?, limits?, drive? } @param {{ caller: string }} meta
 */
export async function forwardFile(api, io, input, meta) {
  const caller = String(meta.caller), name = String(input.credential || "");
  const maxBytes = Math.min(Number(input.limits?.maxBytes) > 0 ? Number(input.limits.maxBytes) : DEFAULT_MAX_BYTES, HARD_MAX_BYTES);
  const types = Array.isArray(input.limits?.contentTypes) && input.limits.contentTypes.length ? input.limits.contentTypes.map(x => String(x).toLowerCase()) : DEFAULT_TYPES;
  const driveRead = (input.drive?.read ?? []).map(String), driveWrite = (input.drive?.write ?? []).map(String);
  const audit = (ok, why) => api.vault.audit("api-request", name || null, caller, ok, why);
  const headers = forwardHeaders(input.headers, input.allow_headers);

  // The upload, resolved to Drive versions now so the card and the send agree on exactly which bytes.
  const resolveFile = async ref => {
    const path = drivePath(ref?.path);
    if (!driveRead.some(p => atPath(p, path))) throw bad("that Drive path is not one this route may read", "not_found");
    const f = await io.files.read(path, ref.version ?? null);
    return { path, version: f.version, size: f.size, sha256: f.sha256, file: f };
  };
  /** @type {any} */ let upload = null, body, length;
  if (input.upload) {
    const u = input.upload;
    if (isObj(u.drive)) {
      const f = await resolveFile(u.drive), t = baseType(u.drive.contentType ?? u.contentType);
      if (!typeOk(types, t)) throw bad(`${t || "that"} is not a content type this route allows`, "type_refused");
      headers["content-type"] = t; upload = { kind: "drive", file: { path: f.path, version: f.version, size: f.size, sha256: f.sha256 }, contentType: t };
      body = f.file.stream(); length = f.size;
    } else if (Array.isArray(u.multipart) && u.multipart.length && u.multipart.length <= 20) {
      if (!typeOk(types, "multipart/form-data")) throw bad("multipart/form-data is not a content type this route allows", "type_refused");
      const parts = [], desc = [];
      for (const p of u.multipart) {
        if (isObj(p.drive)) {
          const f = await resolveFile(p.drive), ct = baseType(p.contentType);
          if (!typeOk(types, ct)) throw bad(`${ct || "that"} is not a content type this route allows`, "type_refused");
          parts.push({ name: clean(p.name, "a part name"), filename: clean(p.filename, "a file name"), contentType: ct, file: f.file }); desc.push({ name: p.name, filename: p.filename, contentType: ct, file: { path: f.path, version: f.version, size: f.size, sha256: f.sha256 } });
        } else { parts.push({ name: clean(p.name, "a part name"), value: String(p.value ?? "").slice(0, 100_000) }); desc.push({ name: p.name, value: String(p.value ?? "").slice(0, 100_000) }); }
      }
      const m = multipart(parts); headers["content-type"] = m.contentType; body = m.iterable; length = m.length; upload = { kind: "multipart", parts: desc };
    } else throw bad("an upload is a Drive file or a multipart form of text fields and Drive files", "bad_input");
    if (length > maxBytes) throw bad(`the upload is ${mb(length)}, over this route's ${mb(maxBytes)} limit`, "too_large");
  } else if (input.body !== undefined && input.body !== null && input.body !== "") {
    throw bad("a request body goes through vault.forward; a file is sent from the Drive with `upload`", "bad_input");
  }
  if (input.saveTo !== undefined) { const p = drivePath(input.saveTo); if (!driveWrite.some(w => atPath(w, p))) throw bad("that Drive path is not one this route may write", "not_found"); }

  let plan;
  try { plan = await api.plan({ credential: name, method: input.method, url: input.url, query: input.query, headers }, name); } catch (e) { audit(false, String(/** @type {Error} */ (e).message).slice(0, 160)); throw e; }
  const desc = { upload, saveTo: input.saveTo ?? null, limits: { maxBytes, contentTypes: types }, session: isStr(input.session) ? input.session.slice(0, 80) : null };
  const hash = approvalHash({ credential: plan.name, method: plan.method, url: plan.href, headers: plan.headers, body: { file: desc } });

  const go = () => run(api, io, { plan, headers, body, length, input, desc, types, maxBytes, caller, name, audit });
  if (plan.kind === "read") return { ...(await go()), kind: "read" };

  // Outward: held for a person. The card names the files; the held record carries the versions and hashes.
  if (!api.deps.call) throw bad("the Gate is not running, so an outward call cannot be held", "failed");
  await api.offer();
  const files = upload ? (upload.kind === "drive" ? [upload.file] : upload.parts.filter(p => p.file).map(p => p.file)) : [];
  const summary = `${summarize({ kind: plan.kind, method: plan.method, url: plan.href, actingAs: plan.actingAs, parsed: { recipients: [] } })}${files.length ? ` Files: ${files.map(f => `${f.path.split("/").pop()} (${mb(f.size)})`).join(", ")}.` : ""}`;
  const r = await api.deps.call("gate.request", {
    kind: plan.kind === "read" ? "send" : plan.kind, via: "vault-api", to: plan.to, why: `vault.forward.file on ${name}`,
    content: api.sealed({ credential: name, method: plan.method, url: plan.href, summary, hash, kind: plan.kind, request: { headers: plan.headers, file: desc }, parsed: { recipients: [] } }),
  });
  if (r.error) throw bad(r.error.message || "the Gate did not take it", r.error.code || "failed");
  audit(true, `${plan.method} ${plan.url.hostname} ${plan.kind} held ${r.data.id} (files)`);
  return { held: r.data.id, kind: plan.kind, summary, message: r.data.message };
}

/** The Gate approved a held file request: rebuilt from its own record, it must match the card (hash) and the files must still be the versions and bytes the person saw. */
export async function sendFile(api, io, c, held, it, caller) {
  const desc = held.file, name = c.credential;
  if (!isObj(desc) || !isObj(desc.limits)) throw bad("the approved content is not a held file request", "bad_input");
  const resolveFile = async ref => { const f = await io.files.read(ref.path, ref.version); if (f.size !== ref.size || (ref.sha256 && f.sha256 !== ref.sha256)) throw bad("a file changed after it was held, so it is not sent; ask again", "denied"); return f; };
  let body, length; const headers = { ...(isObj(held.headers) ? held.headers : {}) };
  if (desc.upload?.kind === "drive") { const f = await resolveFile(desc.upload.file); body = f.stream(); length = f.size; }
  else if (desc.upload?.kind === "multipart") {
    const parts = []; for (const p of desc.upload.parts) parts.push(p.file ? { name: p.name, filename: p.filename, contentType: p.contentType, file: await resolveFile(p.file) } : { name: p.name, value: p.value });
    const m = multipart(parts); headers["content-type"] = m.contentType; body = m.iterable; length = m.length;
  }
  const plan = await api.plan({ credential: name, method: c.method, url: c.url, headers: isObj(held.headers) ? held.headers : {} }, name);
  if (approvalHash({ credential: plan.name, method: plan.method, url: plan.href, headers: plan.headers, body: { file: desc } }) !== c.hash) throw bad("the request was changed after it was held, so it is not sent; ask again", "denied");
  if (plan.kind !== c.kind) throw bad(`this credential now classifies the request as a ${plan.kind}, not a ${c.kind}; ask again`, "denied");
  const audit = (ok, why) => api.vault.audit("api-request", name, `${caller} for ${it.by || "the user"}`, ok, why);
  const r = await run(api, io, { plan, headers: { ...plan.headers, ...(headers["content-type"] ? { "content-type": headers["content-type"] } : {}) }, body, length, input: { saveTo: desc.saveTo }, desc, types: desc.limits.contentTypes, maxBytes: desc.limits.maxBytes, caller: `${caller} for ${it.by || "the user"}`, name, audit });
  return r;
}

async function run(api, io, { plan, headers, body, length, input, desc, types, maxBytes, caller, name, audit }) {
  const tag = `${plan.method} ${plan.url.hostname} ${plan.kind} file`;
  let known = [];
  try {
    const auth = await api.authFor(plan); known = auth.known;
    const t = await checkTarget(plan.url.toString(), plan.config.hosts, { lookup: api.deps.lookup });
    const send = api.deps.streamTransport || httpsStream;
    await api.throttle(plan);
    const reply = await send({ url: t.url, address: t.addresses[0], method: plan.method, headers: { accept: "*/*", ...headers, ...auth.headers }, ...(body !== undefined ? { body, length } : {}), timeoutMs: TIMEOUT_MS });
    const heads = {}; for (const k of ["content-type", "content-length", "etag", "last-modified", "retry-after", "x-request-id", "content-disposition"]) if (reply.headers[k] !== undefined) heads[k] = scrub(String(reply.headers[k]), known);
    if (reply.status >= 300 && reply.status < 400) { reply.abort?.(); throw bad("the API answered a redirect, which is not followed for a file", "redirect"); }
    const type = baseType(reply.headers["content-type"]), ok = reply.status >= 200 && reply.status < 300;
    // An error answer is small text: read it, scrub it, hand it back.
    if (!ok) { const b = await collect(reply.stream, ERROR_BODY, true); reply.abort?.(); audit(false, `${tag} ${reply.status}`); return { status: reply.status, ok: false, headers: heads, body: Buffer.from(scrub(b.toString("utf8"), known)) }; }
    if (!typeOk(types, type) && !(type === "" && input.stream !== true && input.saveTo === undefined)) { reply.abort?.(); throw bad(`the response is ${type || "of no declared type"}, which this route does not allow`, "type_refused"); }
    if (Number(reply.headers["content-length"]) > maxBytes) { reply.abort?.(); throw bad(`the response is ${mb(Number(reply.headers["content-length"]))}, over this route's ${mb(maxBytes)} limit`, "too_large"); }
    const flow = guard(reply, known, maxBytes, () => reply.abort?.());
    if (input.saveTo !== undefined) {
      const saved = await io.files.write(String(input.saveTo), flow, { maxBytes, by: caller });
      audit(true, `${tag} ${reply.status} saved ${saved.size} bytes`); return { status: reply.status, ok, headers: heads, saved: { path: saved.path, version: saved.version, size: saved.size, sha256: saved.sha256 } };
    }
    if (input.stream === true) { audit(true, `${tag} ${reply.status} streamed`); return { status: reply.status, ok, headers: heads, stream: flow }; }
    if (!textual(type)) { reply.abort?.(); throw bad("a file response needs `saveTo` (to the Drive) or `stream`", "needs_destination"); }
    const b = await collect(flow, TEXT_BODY, false); audit(true, `${tag} ${reply.status}`);
    return { status: reply.status, ok, headers: heads, body: Buffer.from(scrub(b.toString("utf8"), known)) };
  } catch (e) {
    const msg = scrub(String(/** @type {Error} */ (e)?.message || e), known); audit(false, `${tag}: ${msg.slice(0, 160)}`);
    throw Object.assign(new Error(msg), { code: /** @type {any} */ (e)?.code || "failed", ...(/** @type {any} */ (e)?.retryAfter ? { retryAfter: /** @type {any} */ (e).retryAfter } : {}) });
  }
}

/** The reply as a stream that is stopped at its cap and when a credential value would pass through it (checked across chunk boundaries). */
async function* guard(reply, known, cap, stop) {
  const secrets = known.filter(k => isStr(k) && k.length >= 8).map(k => Buffer.from(k)), keep = secrets.reduce((m, s) => Math.max(m, s.length), 1) - 1;
  let n = 0, tail = Buffer.alloc(0);
  try {
    for await (const c of reply.stream) {
      const b = Buffer.from(c); n += b.length;
      if (n > cap) { stop(); throw bad(`the response is over this route's ${mb(cap)} limit`, "too_large"); }
      if (secrets.length) { const win = Buffer.concat([tail, b]); if (secrets.some(s => win.includes(s))) { stop(); throw bad("the response carries a credential value and is withheld", "withheld"); } tail = win.subarray(Math.max(0, win.length - keep)); }
      yield b;
    }
  } finally { stop(); }
}
async function collect(source, cap, soft) { const parts = []; let n = 0; for await (const c of source) { n += c.length; if (n > cap) { if (soft) break; throw bad("the response is larger than 2 MB; save it to the Drive with `saveTo`", "too_large"); } parts.push(c); } return Buffer.concat(parts); }
