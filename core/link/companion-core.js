// @ts-check
// companion-core: the link a local core keeps with the box when a desktop app started it (VYRE_SUPERVISOR=app, the Windows app).
//
// This core is a companion of the app's device, not a Mac of its own: it has no bearer key and no tailnet listener, and it starts no
// program. It does three things.
//   1. Joins: it makes its own P-256 key, asks the app over the app-owned pipe to vouch for it (the app calls link.companion.pair with its
//      own presence proof, never anything the core hands it), pins the box's key from the answer, and has the app seal its private key with
//      Windows (DPAPI) before it is written down.
//   2. Calls: every call to the box is a token signed with that key (core/link/companion.js, the wire contract), over HTTPS to the box's
//      address, and only to a tailnet address.
//   3. Offers sync.send the same tools the Mac's link does (link.remote, link.upload, link.call), so import and sync run unchanged.
// Only the sync.upload.* tools exist for a companion. Anything else is refused here, before it leaves the PC.

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { connector, isTailnet, normalize } from "./transport.js";
import { tokenMessage, boxId } from "./companion.js";
import { handoff } from "../daemon/app-handoff.js";

export const FILE = "companion.json";
const ALLOWED = new Set(["sync.upload.plan", "sync.upload.start", "sync.upload.cancel", "sync.upload.finish"]);
const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One request to the app on its pipe: one JSON line out, one back, then the connection is closed (the app serves one request per connection).
 * @param {string} pipe @param {any} request @param {number} [timeout]
 * @returns {Promise<any>}
 */
export function askApp(pipe, request, timeout = 30_000) {
  return new Promise((resolve, reject) => {
    const s = net.connect(pipe);
    let buf = "", settled = false;
    const done = (e, v) => { if (settled) return; settled = true; clearTimeout(t); s.destroy(); e ? reject(e) : resolve(v); };
    const t = setTimeout(() => done(Object.assign(new Error("the app did not answer"), { code: "app_silent" })), timeout);
    s.on("connect", () => s.write(JSON.stringify(request) + "\n"));
    s.on("data", d => {
      buf += d;
      if (buf.length > 16_384) return done(new Error("the app's answer is too large"));
      const i = buf.indexOf("\n");
      if (i < 0) return;
      try { done(null, JSON.parse(buf.slice(0, i))); } catch { done(new Error("the app's answer is not JSON")); }
    });
    s.on("error", e => done(Object.assign(new Error(`could not reach the app (${/** @type {any} */ (e).code || e.message})`), { code: "app_unreachable" })));
    s.on("end", () => done(Object.assign(new Error("the app closed the connection without answering"), { code: "app_refused" })));
  });
}

/** A server address is an https origin and nothing else: no credentials, path, query or fragment. @param {any} a */
const plainOrigin = (a, insecure = false) => { try { const u = new URL(String(a)); return (u.protocol === "https:" || (insecure && u.protocol === "http:")) && !u.username && !u.password && u.pathname === "/" && !u.search && !u.hash && String(a).replace(/\/$/, "") === u.origin; } catch { return false; } };

/** The bytes the box signs to prove itself to a companion core in link.companion.hello's answer. */
export const helloMessage = ({ box, companion, nonce }) => Buffer.from(["vyre-companion-hello", box, companion, nonce].join("\n"));

/** @param {string} code @param {string} message */
const fail = (code, message) => Object.assign(new Error(message), { code });

/**
 * @param {any} ctx
 * @param {{ pipe?: string, insecure?: boolean, timeout?: number, now?: () => number, verify?: (ip: string) => Promise<any> }} [seam]
 */
export function companionCoreSide(ctx, seam = {}) {
  const file = path.join(ctx.paths.root, FILE);
  const now = seam.now || Date.now;
  /** @type {null | { v: 1, companion: string, address: string, name: string, box: { pub: string, id: string }, key: { spki: string, sealed: string } }} */
  let saved = null;
  try { const j = JSON.parse(fs.readFileSync(file, "utf8")); if (j && j.v === 1 && j.companion && j.box && j.key) saved = j; } catch { /* not joined yet */ }
  /** @type {crypto.KeyObject | null} */
  let priv = null;
  /** @type {Promise<void> | null} */
  let joining = null;
  /** The server proved who it is to this process (hello); nothing but hello goes out before. */
  let verified = false;
  /** @type {Promise<void> | null} */
  let verifying = null;

  const pipe = () => seam.pipe || (handoff() && /** @type {any} */ (handoff()).countersign) || null;
  const app = async request => {
    const p = pipe();
    if (!p) throw fail("no_app", "Vyre's local helper was not started by the Vyre app, so it cannot join your server.");
    const r = await askApp(p, { v: 1, ...request }, seam.timeout || 30_000);
    if (!r || r.ok !== true) throw fail("app_refused", String((r && r.error) || "the app would not do that"));
    return r;
  };

  const save = o => {
    saved = o;
    const tmp = file + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(o, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };

  /** Join the box through the app, once. A second caller waits for the first. */
  function join() {
    if (!joining) joining = (async () => {
      const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
      const nonce = crypto.randomBytes(16).toString("base64url");
      const name = String(ctx.config.name || "").slice(0, 64) || "this PC's helper";
      const r = await app({ op: "companion", core: spki, nonce, name });
      if (r.pending) throw fail("pending", "Waiting for you to allow this PC's helper on your Vyre server. Allow it in Devices, then try again.");
      if (!plainOrigin(r.address, seam.insecure)) throw fail("bad_answer", "the app gave an address that is not your server's");
      if (typeof r.id !== "string" || !r.box || typeof r.box.pub !== "string" || r.box.id !== boxId(r.box.pub) || typeof r.address !== "string") throw fail("bad_answer", "your Vyre server's answer to the join did not check out");
      const sealed = await app({ op: "seal", data: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url") });
      save({ v: 1, companion: r.id, address: String(r.address), name, box: { pub: r.box.pub, id: r.box.id }, key: { spki, sealed: String(sealed.blob) } });
      priv = privateKey;
    })().finally(() => { joining = null; });
    return joining;
  }

  async function ready() {
    if (!saved) await join();
    if (!priv) {
      const r = await app({ op: "unseal", blob: /** @type {any} */ (saved).key.sealed });
      priv = crypto.createPrivateKey({ key: Buffer.from(String(r.data), "base64url"), format: "der", type: "pkcs8" });
    }
    return /** @type {NonNullable<typeof saved>} */ (saved);
  }

  /** The token for one call (the wire contract in core/link/companion.js). @param {NonNullable<typeof saved>} s @param {string} tool @param {any} input */
  function token(s, tool, input) {
    const ts = now(), nonce = crypto.randomBytes(12).toString("base64url");
    const sig = crypto.sign("sha256", tokenMessage({ box: s.box.id, companion: s.companion, ts, nonce, tool, input }), { key: /** @type {crypto.KeyObject} */ (priv), dsaEncoding: "ieee-p1363" });
    return `c1.${s.companion}.${ts}.${nonce}.${sig.toString("base64url")}`;
  }

  /** @param {NonNullable<typeof saved>} s */
  const conn = s => connector({ address: s.address, verify: seam.verify || (async ip => (isTailnet(normalize(ip)) ? { stableId: s.box.id } : null)), pinned: () => null, insecure: Boolean(seam.insecure) });

  /**
   * Before any file name or byte goes out, the server answers hello with its signature (by the key pinned at the join) over this very token's
   * nonce, so a name, directory or certificate takeover that merely answers cannot receive a transcript. Once per process; refused on any mismatch.
   * @param {NonNullable<typeof saved>} s
   */
  function verifyBox(s) {
    if (verified) return Promise.resolve();
    if (!verifying) verifying = (async () => {
      const t = token(s, "link.companion.hello", {});
      const nonce = t.split(".")[3];
      let r;
      try { r = await conn(s).json("POST", "/v1/tools/link.companion.hello", { token: t }, { timeout: seam.timeout || 15_000 }); }
      catch (e) { const x = /** @type {any} */ (e); throw fail("box_unreachable", `your server is not reachable from this PC (${x.code || x.message}). Is Tailscale signed in?`); }
      const d = r.body && r.body.data;
      if (!d || !d.box || d.box.id !== s.box.id || d.companion !== s.companion) throw fail("not_box", (r.body && r.body.error && r.body.error.message) || "the server at this address is not the one this PC joined, so nothing was sent");
      let good = false;
      try { good = typeof d.proof === "string" && crypto.verify(null, helloMessage({ box: s.box.id, companion: s.companion, nonce }), crypto.createPublicKey({ key: Buffer.from(s.box.pub, "base64url"), format: "der", type: "spki" }), Buffer.from(d.proof, "base64url")); } catch { good = false; }
      if (!good) throw fail("not_box", "the server at this address did not prove it is the one this PC joined, so nothing was sent");
      verified = true;
    })().finally(() => { verifying = null; });
    return verifying;
  }

  /** A JSON tool on the box, as { data } or { error }. */
  async function remote(tool, input = {}) {
    if (!ALLOWED.has(String(tool))) return { error: { code: "denied", message: `${tool} is not something this PC's helper may ask your server` } };
    let s;
    try { s = await ready(); await verifyBox(s); } catch (e) { const x = /** @type {any} */ (e); return { error: { code: x.code || "no_link", message: x.message } }; }
    try {
      const r = await conn(s).json("POST", `/v1/tools/${encodeURIComponent(tool)}`, { ...input, companion: token(s, tool, input) }, { timeout: seam.timeout || 15_000 });
      return r.body;
    } catch (e) {
      const x = /** @type {any} */ (e);
      return { error: { code: x.code === "not_box" ? "not_box" : "box_unreachable", message: x.code === "not_box" ? x.message : `your server is not reachable from this PC (${x.code || x.message}). Is Tailscale signed in?` } };
    }
  }

  /** @param {string} upload @param {number} offset @param {Buffer} data */
  async function upload(upload, offset, data) {
    if (!UPLOAD_ID.test(String(upload))) throw fail("bad_input", "upload must be the id sync.upload.start gave");
    const s = await ready();
    await verifyBox(s);
    let r;
    try {
      r = await conn(s).json("POST", `/v1/sync/upload/${encodeURIComponent(upload)}?offset=${encodeURIComponent(String(offset))}`, data,
        { timeout: seam.timeout || 15_000, headers: { "x-vyre-companion": token(s, "sync.upload.chunk", { upload, offset, data }) } });
    } catch (e) {
      const x = /** @type {any} */ (e);
      throw fail(x.code === "not_box" ? "not_box" : "box_unreachable", x.code === "not_box" ? x.message : `your server is not reachable from this PC (${x.code || x.message})`);
    }
    if (r.body && r.body.error) throw fail(r.body.error.code, r.body.error.message);
    return r.body && r.body.data !== undefined ? r.body.data : r.body;
  }

  ctx.tool("link.status", {
    description: "Whether this PC's local helper has joined your Vyre server, and the server it joined.",
    input: { type: "object", properties: {} },
    run: async () => ({ paired: Boolean(saved), companion: true, ...(saved ? { box: saved.address, name: saved.name } : {}) }),
  });
  ctx.tool("link.call", {
    description: "Ask your server to take this PC's sessions (the only thing this helper does). sync.consent is the person's switch on the server, so it is checked there.",
    input: { type: "object", properties: { tool: { type: "string" }, input: { type: "object" } }, required: ["tool"] },
    run: async ({ tool, input }) => {
      if (tool === "sync.consent") {
        // Import is switched on for this PC by the person on the server. Ask with an empty plan, so the person hears the server's own reason.
        if (input && input.on === false) return {};
        const r = await remote("sync.upload.plan", { files: [] });
        if (r.error) throw fail(r.error.code, r.error.message);
        return r.data || {};
      }
      const r = await remote(tool, input || {});
      if (r.error) throw fail(r.error.code, r.error.message);
      return r.data;
    },
  });
  ctx.tool("link.remote", {
    description: "ctx.remote's carrier: a sync.upload tool on your server for core/sync.",
    input: { type: "object", properties: { tool: { type: "string" }, input: { type: "object" } }, required: ["tool"] },
    internal: true,
    run: async ({ tool, input }) => ({ result: await remote(tool, input || {}) }),
  });
  ctx.tool("link.upload", {
    description: "One chunk of sync.upload's bytes to your server. Internal: core/sync's carrier.",
    input: { type: "object", required: ["upload", "offset", "data"], properties: { upload: { type: "string" }, offset: { type: "integer", minimum: 0 }, data: {} } },
    internal: true,
    run: async ({ upload: id, offset, data }) => upload(id, offset, Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ""), "base64")),
  });
  return { async stop() { priv = null; verified = false; } };
}
