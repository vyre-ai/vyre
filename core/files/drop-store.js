// @ts-check
// drop-store: where a drop waits on the home until the receiving device connects and takes it. Everything in it is ciphertext sealed on the sending device to the receiver's key (drop-seal.js): the
// home keeps the order, the sizes, who it is from and for, and when it ends, and nothing it could read. A drop is bounded (size, how many bytes the home holds in all, and how long: it ends and is
// deleted), and what the receiver acknowledges is deleted at once.
import fs from "node:fs";
import path from "node:path";

const ID = /^[a-z0-9]{20,40}$/;
const DEV = /^[A-Za-z0-9_-]{1,64}$/;
const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });

/**
 * @param {{ dir: string, maxBytes?: number, homeBytes?: number, ttlMs?: number, now?: () => number }} o
 */
export function createDropStore(o) {
  const now = o.now || Date.now;
  const maxBytes = o.maxBytes ?? 2 * 1024 ** 3, homeBytes = o.homeBytes ?? 10 * 1024 ** 3, ttlMs = o.ttlMs ?? 7 * 86_400_000;
  fs.mkdirSync(o.dir, { recursive: true, mode: 0o700 });
  const dirOf = (/** @type {string} */ id) => { if (!ID.test(id)) throw fail("not_found", "no such drop"); return path.join(o.dir, id); };
  const readMeta = (/** @type {string} */ id) => { try { return JSON.parse(fs.readFileSync(path.join(dirOf(id), "meta.json"), "utf8")); } catch { return null; } };
  const writeMeta = (/** @type {string} */ id, /** @type {any} */ m) => { const f = path.join(dirOf(id), "meta.json"); fs.writeFileSync(`${f}.tmp`, JSON.stringify(m), { mode: 0o600 }); fs.renameSync(`${f}.tmp`, f); };
  const ids = () => { try { return fs.readdirSync(o.dir).filter(n => ID.test(n)); } catch { return []; } };
  const held = () => ids().reduce((n, id) => { const m = readMeta(id); return n + (m ? m.bytes_held || 0 : 0); }, 0);
  const keys = path.join(o.dir, "keys.json");
  const keyMap = () => { try { return JSON.parse(fs.readFileSync(keys, "utf8")); } catch { return {}; } };

  return {
    /** A device's drop key (its public half), as the device itself registered it. @param {string} device @param {string} pub */
    register(device, pub) {
      if (!DEV.test(device) || typeof pub !== "string" || !/^[A-Za-z0-9_-]{40,120}$/.test(pub)) throw fail("bad_input", "a device and its drop key");
      const m = keyMap(); m[device] = pub; fs.writeFileSync(`${keys}.tmp`, JSON.stringify(m), { mode: 0o600 }); fs.renameSync(`${keys}.tmp`, keys);
    },
    /** The device stops receiving: its key is forgotten, and what waits for it is thrown away. @param {string} device */
    unregister(device) {
      const m = keyMap(); delete m[device]; fs.writeFileSync(`${keys}.tmp`, JSON.stringify(m), { mode: 0o600 }); fs.renameSync(`${keys}.tmp`, keys);
      for (const id of ids()) { const x = readMeta(id); if (x && x.to === device) fs.rmSync(dirOf(id), { recursive: true, force: true }); }
    },
    keyOf(/** @type {string} */ device) { const k = keyMap()[device]; return typeof k === "string" ? k : null; },
    /** The sender chooses the drop's id (it is the salt of the sealing key, so it is known before the key is made). @param {{ id: string, from: string, to: string, total: number, size: number, eph: string }} i @returns {string} the drop's id */
    begin(i) {
      if (!DEV.test(i.from) || !DEV.test(i.to)) throw fail("bad_input", "name the devices");
      if (!Number.isInteger(i.total) || i.total < 1 || i.total > 1_000_000 || !Number.isFinite(i.size) || i.size < 0) throw fail("bad_input", "name the file's size");
      if (i.size > maxBytes) throw fail("too_large", `a file sent this way is at most ${Math.floor(maxBytes / 1024 ** 2)} MB`);
      if (held() + i.size > homeBytes) throw fail("no_room", "this server is holding as many dropped files as it will; try again when some have been taken");
      if (typeof i.eph !== "string" || !/^[A-Za-z0-9_-]{40,120}$/.test(i.eph)) throw fail("bad_input", "the sealing key");
      const id = String(i.id);
      if (!ID.test(id)) throw fail("bad_input", "the drop's id");
      if (fs.existsSync(dirOf(id))) throw fail("conflict", "that drop already exists");
      fs.mkdirSync(dirOf(id), { mode: 0o700 });
      writeMeta(id, { id, from: i.from, to: i.to, total: i.total, size: i.size, eph: i.eph, got: 0, bytes_held: 0, state: "open", created: now(), expires: now() + ttlMs });
      return id;
    },
    /** One chunk, in order. @param {string} id @param {string} from @param {number} index @param {Buffer} blob */
    put(id, from, index, blob) {
      const m = readMeta(id);
      if (!m || m.from !== from || m.state !== "open") throw fail("not_found", "no such drop");
      if (index !== m.got) throw fail("gap", "a chunk is missing or repeated");
      if (index >= m.total || blob.length > 1024 * 1024 + 64) throw fail("bad_input", "that chunk does not fit the drop");
      if (m.bytes_held + blob.length > maxBytes + m.total * 64) throw fail("too_large", "more than the drop said it would hold");
      fs.writeFileSync(path.join(dirOf(id), `c${index}`), blob, { mode: 0o600 });
      m.got = index + 1; m.bytes_held += blob.length; writeMeta(id, m);
    },
    /** Complete: every chunk is here, so the receiver may take it. @returns {{ id: string, to: string }} */
    finish(/** @type {string} */ id, /** @type {string} */ from) {
      const m = readMeta(id);
      if (!m || m.from !== from || m.state !== "open") throw fail("not_found", "no such drop");
      if (m.got !== m.total) throw fail("incomplete", "not every chunk arrived");
      m.state = "ready"; writeMeta(id, m);
      return { id, to: m.to };
    },
    /** The drops waiting for a device. @param {string} to */
    pending(to) { return ids().map(readMeta).filter(m => m && m.to === to && m.state === "ready" && m.expires > now()).map(m => ({ id: m.id, from: m.from, size: m.size, total: m.total, expires: m.expires })); },
    /** What the receiver needs to open it. @param {string} id @param {string} to */
    meta(id, to) { const m = readMeta(id); if (!m || m.to !== to || m.state !== "ready" || m.expires <= now()) throw fail("not_found", "no such drop"); return { id, from: m.from, total: m.total, size: m.size, eph: m.eph }; },
    get(/** @type {string} */ id, /** @type {string} */ to, /** @type {number} */ index) {
      const m = readMeta(id);
      if (!m || m.to !== to || m.state !== "ready" || m.expires <= now() || !Number.isInteger(index) || index < 0 || index >= m.total) throw fail("not_found", "no such drop");
      return fs.readFileSync(path.join(dirOf(id), `c${index}`));
    },
    /** Taken: gone from here at once. */
    ack(/** @type {string} */ id, /** @type {string} */ to) { const m = readMeta(id); if (!m || m.to !== to) throw fail("not_found", "no such drop"); fs.rmSync(dirOf(id), { recursive: true, force: true }); return { gone: true }; },
    /** The sender takes it back, before or after it is ready. */
    cancel(/** @type {string} */ id, /** @type {string} */ from) { const m = readMeta(id); if (!m || m.from !== from) throw fail("not_found", "no such drop"); fs.rmSync(dirOf(id), { recursive: true, force: true }); return { gone: true }; },
    /** What has ended or was never finished is deleted. @returns {number} how many */
    sweep() { let n = 0; for (const id of ids()) { const m = readMeta(id); if (!m || m.expires <= now() || (m.state === "open" && now() - m.created > 3_600_000)) { fs.rmSync(dirOf(id), { recursive: true, force: true }); n++; } } return n; },
    held,
  };
}
