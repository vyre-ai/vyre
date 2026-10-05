// @ts-check
// VyreDrop over Wink: a file goes from one of a person's computers to another without Tailscale. The sender seals it to the receiving computer's own key (drop-seal.js) and hands it to the person's server
// (its home) over the connection it already holds; the server keeps the ciphertext (drop-store.js) until the receiver is connected and takes it, then deletes it. A receiver that is asleep gets it when it
// wakes: the drop waits, bounded in size, in total and in time. Only the person's own paired computers can send or receive: the server admits only the owner's devices, and a drop names a device on that list.
//
//   on the server (role box):   files.drop.register / targets / begin / put / finish / pending / meta / get / ack / cancel   (called by the person's computers, over their held connection)
//                               files.deliver   the server's own files to one of the person's computers
//   on a computer (role local): files.send      a file to one of the person's other computers
//                               files.receive   take drops in (off by default; turning it on makes this computer's drop key and registers it)
// The server tells a receiver there is something for it down the connection that computer holds (`wink.drop.offer`, core/wink); a receiver that missed it asks again when it connects.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { deviceIdOf } from "../../lib/caller.js";
import * as config from "../config/index.js";
import { CHUNK, sender, receiver } from "./drop-seal.js";
import { createDropStore } from "./drop-store.js";

/** The box's inbox when config files.inbox is not set: inside /work, the box's default root. */
export const INBOX = "/work/inbox";
/** A computer's inbox when config files.inbox is not set: inside its home. */
export const macInbox = () => path.join(os.homedir(), "Vyre", "inbox");
const RETRY = 60_000;
const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });
const inside = (/** @type {string} */ p, /** @type {string} */ dir) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
const obj = (/** @type {any} */ properties = {}, /** @type {string[]} */ required = []) => ({ type: "object", properties, required });
const str = { type: "string" };

/**
 * @param {any} ctx the files module's context
 * @param {{ role: "box" | "local", g: any, cfg: any, store?: ReturnType<typeof createDropStore>, now?: () => number }} o
 * @returns {{ stop(): Promise<void> }}
 */
export function dropWink(ctx, { role, g, cfg, store, now = Date.now }) {
  const log = (/** @type {string} */ m) => { try { ctx.log(m); } catch { /* no log */ } };
  const emit = (/** @type {string} */ t, /** @type {any} */ p) => { try { ctx.events.emit(t, p); } catch (e) { log(`${t} was not announced: ${/** @type {Error} */ (e).message}`); } };
  /** The key to seal to, from the person's identity list and nowhere else: the key-agreement point of the receiving entry. A computer the list does not carry, or one with no such key, gets nothing sent. @param {string} eid */
  const agreeOf = async eid => {
    const me = /** @type {any} */ (await ctx.call("spaces.identity.id", {}).catch(() => null));
    const person = me && me.data && me.data.id;
    if (!person) throw fail("not_ready", "this computer has no identity yet");
    const r = /** @type {any} */ (await ctx.call("spaces.identity.devices.read", { person }).catch(() => null));
    const e = r && r.data && Array.isArray(r.data.devices) ? r.data.devices.find((/** @type {any} */ d) => d && d.device === eid && typeof d.agree === "string") : null;
    if (!e) throw fail("not_verified", "that computer is not on your identity list with a key for receiving files, so nothing was sent");
    return String(e.agree);
  };
  const dropCfg = () => (ctx.config && ctx.config.files && ctx.config.files.drop) || {};
  const inboxPath = () => path.resolve(String(cfg.inbox || (role === "box" ? INBOX : macInbox())));

  // ---------------------------------------------------------------- the server's half
  if (role === "box") {
    const root = ctx.paths && ctx.paths.root ? ctx.paths.root : path.join(os.homedir(), ".vyre");
    const st = store || createDropStore({ dir: path.join(root, "drop"), now, ...(dropCfg().maxBytes ? { maxBytes: Number(dropCfg().maxBytes) } : {}), ...(dropCfg().homeBytes ? { homeBytes: Number(dropCfg().homeBytes) } : {}), ...(dropCfg().days ? { ttlMs: Number(dropCfg().days) * 86_400_000 } : {}) });
    /** The calling computer, from the connection it arrived on, never from the input. @param {any} meta */
    const caller = meta => { const d = deviceIdOf(meta); if (!d) throw fail("denied", "this is for the person's own computers, over their connection to this server"); return d; };
    /** The person's computers this server knows, with what a sender needs. @returns {Promise<any[]>} */
    const devices = async () => { const r = /** @type {any} */ (await ctx.call("relay.devices.all", {})); return r && r.data && Array.isArray(r.data.devices) ? r.data.devices : []; };
    const known = async (/** @type {string} */ id) => (await devices()).find(d => d.id === id && d.kind !== "web") || null;
    const t = (/** @type {string} */ name, /** @type {any} */ input, /** @type {(i: any, meta: any) => any} */ run) => ctx.tool(name, { description: `VyreDrop on the server: ${name.split(".").pop()}. Called by the person's own paired computers over their connection to this server.`, input, run: async (/** @type {any} */ i, /** @type {any} */ meta = {}) => run(i || {}, meta) });

    t("files.drop.register", obj({ eid: str }, ["eid"]), (i, meta) => { st.register(caller(meta), String(i.eid)); return { registered: true }; });
    t("files.drop.unregister", obj(), (_i, meta) => { st.unregister(caller(meta)); return { registered: false }; });
    t("files.drop.targets", obj(), async (_i, meta) => {
      const me = caller(meta);
      return { devices: (await devices()).filter(d => d.id !== me && d.kind !== "web").map(d => ({ id: d.id, name: d.name, kind: d.kind, online: Boolean(d.online), ready: Boolean(st.keyOf(d.id)), ...(st.keyOf(d.id) ? { eid: st.keyOf(d.id)?.eid } : {}) })) };
    });
    t("files.drop.begin", obj({ id: str, to: str, total: { type: "number" }, size: { type: "number" }, eph: str }, ["id", "to", "total", "size", "eph"]), async (i, meta) => {
      const me = caller(meta);
      if (!(await known(String(i.to))) || i.to === me) throw fail("not_found", "no such computer of yours");
      if (!st.keyOf(String(i.to))) throw fail("not_ready", "that computer has not turned receiving on");
      return { id: st.begin({ id: String(i.id), from: me, to: String(i.to), total: Number(i.total), size: Number(i.size), eph: String(i.eph) }) };
    });
    t("files.drop.put", obj({ id: str, index: { type: "number" }, b64: str }, ["id", "index", "b64"]), (i, meta) => { st.put(String(i.id), caller(meta), Number(i.index), Buffer.from(String(i.b64), "base64")); return { ok: true }; });
    t("files.drop.finish", obj({ id: str }, ["id"]), async (i, meta) => { const r = st.finish(String(i.id), caller(meta)); void offer(r.to, r.id); return { ready: true }; });
    t("files.drop.cancel", obj({ id: str }, ["id"]), (i, meta) => st.cancel(String(i.id), caller(meta)));
    t("files.drop.pending", obj(), (_i, meta) => ({ drops: st.pending(caller(meta)) }));
    t("files.drop.meta", obj({ id: str }, ["id"]), (i, meta) => st.meta(String(i.id), caller(meta)));
    t("files.drop.get", obj({ id: str, index: { type: "number" } }, ["id", "index"]), (i, meta) => ({ b64: st.get(String(i.id), caller(meta), Number(i.index)).toString("base64") }));
    t("files.drop.ack", obj({ id: str }, ["id"]), (i, meta) => st.ack(String(i.id), caller(meta)));

    /** Tell a receiver there is a drop for it, down the connection it holds; a receiver that is not connected finds out when it connects. @param {string} to @param {string} id */
    async function offer(to, id) {
      try { await ctx.call("wink.device.call", { device: to, tool: "wink.drop.offer", input: { id } }); }
      catch (e) { log(`drop ${id.slice(0, 6)} waits for ${to.slice(0, 6)} (${String(/** @type {any} */ (e).code || "not connected")})`); }
    }
    // The daemon says a computer just connected: whatever waits for it is offered now.
    ctx.tool("files.drop.push", { description: "Offer a computer the drops waiting for it (the daemon calls this when the computer connects).", input: obj({ device: str }, ["device"]),
      run: async (/** @type {any} */ i, /** @type {any} */ meta = {}) => { if (!String((meta && meta.caller) || "").startsWith("module:")) throw fail("denied", "the daemon calls this"); for (const d of st.pending(String(i.device))) await offer(String(i.device), d.id); return { offered: st.pending(String(i.device)).length }; } });

    // files.deliver: the server's own file to one of the person's computers (the same drop, sealed on the server)
    ctx.tool("files.deliver", {
      description: "Send a file from this server to one of your computers. It waits here, sealed to that computer, until the computer is connected and has receiving turned on; it ends after a few days. Secrets and dotfiles are refused.",
      input: obj({ path: str, device: { ...str, description: "One of your computers: its id or its name (files.drop.targets)." } }, ["path", "device"]),
      callers: ["cli", "local", "deck", "capsule"],
      run: async (/** @type {any} */ i) => {
        const safe = g.resolveSafe(i.path); const s = fs.statSync(safe.real);
        if (!s.isFile()) throw fail("bad_input", "only a file can be sent, not a folder");
        const to = (await devices()).find(d => (d.id === i.device || d.name === i.device) && d.kind !== "web");
        if (!to) throw fail("not_found", `no paired computer called "${i.device}"`);
        const k = st.keyOf(to.id); if (!k) throw fail("not_ready", `"${to.name}" has not turned receiving on`);
        const point = await agreeOf(k.eid);
        const id = crypto.randomBytes(15).toString("hex");
        const sealed = await sealFile(safe.real, id, point, k.eid);
        st.begin({ id, from: "server", to: to.id, total: sealed.total, size: s.size, eph: sealed.eph });
        let n = 0; for (const blob of sealed.chunks()) st.put(id, "server", n++, blob);
        st.finish(id, "server"); void offer(to.id, id);
        emit("files.sent", { name: path.basename(safe.real), bytes: s.size, to: to.name });
        return { sent: path.basename(safe.real), bytes: s.size, to: to.name, queued: !to.online };
      },
    });

    const sweep = setInterval(() => { try { st.sweep(); } catch { /* the next pass */ } }, 10 * 60_000); sweep.unref();
    return { async stop() { clearInterval(sweep); } };
  }

  // ---------------------------------------------------------------- a computer's half
  /** This computer's own entry on the person's identity list, the one whose key-agreement key opens what is sealed to it. */
  const ownEid = async () => {
    const r = /** @type {any} */ (await ctx.call("spaces.identity.status", {}).catch(() => null));
    const eid = r && r.data && r.data.exists && !r.data.pending && typeof r.data.eid === "string" ? r.data.eid : null;
    if (!eid) throw fail("not_ready", "this computer has no identity yet");
    return eid;
  };
  /** This computer's key-agreement step: the shared secret with a wrap's ephemeral point, from the identity module; the private key never leaves it. @param {Uint8Array} epk */
  const ecdh = async epk => {
    const r = /** @type {any} */ (await ctx.call("spaces.identity.ecdh", { epk: Buffer.from(epk).toString("base64url") }));
    if (!r || !r.data || typeof r.data.secret !== "string") throw fail("not_ready", "this computer has no key for receiving files yet");
    return new Uint8Array(Buffer.from(r.data.secret, "base64url"));
  };
  const home = async () => {
    const r = /** @type {any} */ (await ctx.call("wink.home.id", {}).catch(() => null));
    const sid = r && r.data && r.data.device;
    if (!sid || typeof ctx.sessionFor !== "function") throw fail("no_server", "this computer is not paired to a server (it sends and receives files through the server it is paired to)");
    return /** @type {{ call(tool: string, input?: any): Promise<any> }} */ (ctx.sessionFor(sid));
  };

  ctx.tool("files.send", {
    description: "Send a file from this computer to another of your computers, through your server, sealed so only that computer can open it. If the other computer is asleep it waits on the server (a few days) and arrives when the computer is on. Secrets and dotfiles are refused.",
    input: obj({ path: str, to: { ...str, description: "One of your other computers: its name or id (files.drop.targets lists them). Left out, the only one that is ready." } }, ["path"]),
    callers: ["cli", "capsule", "local", "deck"],
    run: async (/** @type {any} */ i) => {
      const safe = g.resolveSafe(i.path); const s = fs.statSync(safe.real);
      if (!s.isFile()) throw fail("bad_input", "only a file can be sent, not a folder");
      const h = await home();
      const t = await h.call("files.drop.targets", {});
      const all = t.devices || [];
      const to = i.to ? all.find((/** @type {any} */ d) => d.id === i.to || d.name === i.to) : (all.filter((/** @type {any} */ d) => d.ready).length === 1 ? all.find((/** @type {any} */ d) => d.ready) : null);
      if (!to) throw fail(i.to ? "not_found" : "ambiguous", i.to ? `none of your other computers is called "${i.to}"` : all.length ? `say which computer: ${all.map((/** @type {any} */ d) => `${d.name}${d.ready ? "" : " (not receiving)"}`).join(", ")}` : "you have no other computer paired to your server");
      if (!to.ready || !to.eid) throw fail("not_ready", `"${to.name}" has not turned receiving on (files.receive on, on that computer)`);
      const point = await agreeOf(String(to.eid));
      const id = crypto.randomBytes(15).toString("hex");
      const sealed = await sealFile(safe.real, id, point, String(to.eid));
      await h.call("files.drop.begin", { id, to: to.id, total: sealed.total, size: s.size, eph: sealed.eph });
      try {
        let n = 0; for (const blob of sealed.chunks()) await h.call("files.drop.put", { id, index: n++, b64: blob.toString("base64") });
        await h.call("files.drop.finish", { id });
      } catch (e) { await h.call("files.drop.cancel", { id }).catch(() => {}); throw e; }
      emit("files.sent", { name: path.basename(safe.real), bytes: s.size, to: to.name });
      return { sent: path.basename(safe.real), bytes: s.size, to: to.name, queued: !to.online };
    },
  });

  // Receiving: off by default (a computer takes in nothing it did not ask for). On makes this computer's drop key, registers it with the server, and takes what waits.
  /** @type {NodeJS.Timeout | null} */ let retry = null;
  let on = cfg.receive === true;
  const prepare = () => {
    const dir = inboxPath(), rs = g.roots();
    if (!rs.live.some((/** @type {any} */ r) => inside(dir, r.given) || inside(dir, r.real))) { log(`the inbox ${dir} is not inside a files root, so nothing is received`); return null; }
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); const safe = g.resolveSafe(dir, g.roots()); if (!fs.statSync(safe.real).isDirectory()) throw new Error("not a folder"); return safe.real; }
    catch { log(`the inbox ${dir} is not a folder the files guard allows, so nothing is received`); return null; }
  };
  /** Name for an arriving file: the sender's name reduced to a plain file name, never a path, never hidden, and never over a file already there. @param {string} dir @param {string} raw */
  const landing = (dir, raw) => {
    let name = path.basename(String(raw).replace(/\\/g, "/")).replace(/[\u0000-\u001f]/g, "").replace(/^\.+/, "").slice(0, 200) || "file";
    const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
    for (let n = 2; fs.existsSync(path.join(dir, name)); n++) name = `${stem} (${n})${ext}`;
    return name;
  };
  /** Take one drop: open every chunk, check the whole, write it into the inbox, tell the server it is taken. @param {string} id */
  async function pull(id) {
    const dir = prepare(); if (!dir) return;
    const eid = await ownEid();
    const h = await home();
    const m = await h.call("files.drop.meta", { id });
    const open = await receiver(id, m.eph, ecdh, eid);
    const head = JSON.parse(open.open(0, m.total, Buffer.from((await h.call("files.drop.get", { id, index: 0 })).b64, "base64")).toString("utf8"));
    const name = landing(dir, head.name);
    const tmp = path.join(dir, `.${crypto.randomBytes(6).toString("hex")}.part`);
    const hash = crypto.createHash("sha256"); let bytes = 0;
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      for (let i = 1; i < m.total; i++) { const plain = open.open(i, m.total, Buffer.from((await h.call("files.drop.get", { id, index: i })).b64, "base64")); hash.update(plain); bytes += plain.length; fs.writeSync(fd, plain); }
    } catch (e) { fs.closeSync(fd); fs.rmSync(tmp, { force: true }); throw e; }
    fs.closeSync(fd);
    if (bytes !== head.size || hash.digest("hex") !== head.sha256) { fs.rmSync(tmp, { force: true }); throw fail("bad_file", "the file did not arrive intact"); }
    fs.renameSync(tmp, path.join(dir, name));
    await h.call("files.drop.ack", { id });
    emit("files.received", { name, path: name, bytes });
  }
  const taking = new Set();
  /** Take every drop that waits (and one named, when the server just offered it). @param {string} [only] */
  async function takeAll(only) {
    if (!on) return;
    const h = await home();
    const list = only ? [{ id: only }] : (await h.call("files.drop.pending", {})).drops || [];
    for (const d of list) { if (taking.has(d.id)) continue; taking.add(d.id); try { await pull(d.id); } catch (e) { log(`a dropped file was not taken: ${String(/** @type {Error} */ (e).message).slice(0, 120)}`); } finally { taking.delete(d.id); } }
  }
  /** Register this computer's key with the server and take what waits; until it works (the server not reached yet) look again each minute, never faster. */
  async function ready() {
    if (!on) return;
    try {
      const eid = await ownEid();
      const h = await home();
      await h.call("files.drop.register", { eid });
      await takeAll();
    } catch (e) { if (!on) return; retry = setTimeout(() => { retry = null; ready().catch(() => {}); }, RETRY); retry.unref(); }
  }
  ctx.tool("files.receive", {
    description: "Turn on or off whether this computer takes in files your other computers send it with files.send. Off by default. Turning it on tells your server which key on your identity list opens them; it holds a file for it until it is on.",
    input: obj({ on: { type: "boolean" } }, ["on"]),
    callers: ["cli", "local", "deck", "capsule"],
    run: async (/** @type {any} */ i) => {
      const next = i.on === true;
      if (next === on) return { on, changed: false };
      if (!ctx.paths) throw new Error("this vyred has no home to save config in");
      config.save({ files: { receive: next } }, ctx.paths.root, ctx.config); cfg.receive = next; on = next;
      if (next) { await ready(); }
      else { if (retry) { clearTimeout(retry); retry = null; } try { await (await home()).call("files.drop.unregister", {}); } catch { /* the server is not reachable: it forgets with the key */ } }
      ctx.log(`files.receive ${next ? "on" : "off"}`);
      return { on, changed: true };
    },
  });
  // the server says there is a drop for this computer (core/wink serves `wink.drop.offer` from the paired server only and calls this)
  ctx.tool("files.drop.offered", { description: "A drop is waiting on the server for this computer (the Wink module calls this).", input: obj({ id: str }, ["id"]),
    run: async (/** @type {any} */ i, /** @type {any} */ meta = {}) => { if (String((meta && meta.caller) || "") !== "module:wink") throw fail("denied", "the Wink module calls this"); if (!/^[a-z0-9]{20,40}$/.test(String(i.id))) throw fail("bad_input", "a drop's id"); void takeAll(String(i.id)).catch(() => {}); return { ok: true }; } });
  const offPaired = ctx.events.on("wink.server-paired", () => { void ready(); });
  if (on) void ready();
  return { async stop() { on = false; if (retry) clearTimeout(retry); try { offPaired(); } catch { /* gone */ } } };
}

/**
 * Seal a file for a computer: the ephemeral key to hand the receiver, how many chunks, and the chunks themselves in order (chunk 0 is the header).
 * @param {string} file @param {string} id @param {string} toPoint the receiving entry's key-agreement point @param {string} toEid
 */
async function sealFile(file, id, toPoint, toEid) {
  const s = fs.statSync(file);
  const h = crypto.createHash("sha256"); await new Promise((res, rej) => fs.createReadStream(file).on("data", d => h.update(d)).on("end", res).on("error", rej));
  const total = 1 + Math.ceil(s.size / CHUNK);
  const sealer = sender(id, toPoint, toEid);
  const header = Buffer.from(JSON.stringify({ name: path.basename(file), size: s.size, sha256: h.digest("hex"), mtime: Math.floor(s.mtimeMs) }));
  return {
    eph: sealer.eph, total,
    *chunks() {
      yield sealer.seal(0, total, header);
      const fd = fs.openSync(file, "r");
      try { const buf = Buffer.alloc(CHUNK); for (let i = 1; i < total; i++) { const n = fs.readSync(fd, buf, 0, CHUNK, (i - 1) * CHUNK); yield sealer.seal(i, total, Buffer.from(buf.subarray(0, n))); } }
      finally { fs.closeSync(fd); }
    },
  };
}
export { sealFile, receiver, config, inside, obj };
