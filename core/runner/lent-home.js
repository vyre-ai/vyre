// @ts-check
// The home's end of a lent computer (docs/work/runner.md "The lent-computer wire"): what the Space's home does when a member's computer runs one of its sessions.
// It is a SERVICE of the kernel's remote server (kernel/remote/server.js `services.lent`): every method is `(chain, ...args)` with the chain the home's own Surfaces door minted from
// what the transport proved (the lender's device key and person), never from the request. It holds the lent-session table, decides what a session may reach, and fronts the
// checkpoint store (core/runner/checkpoint-store.js) with a per-call authorization that comes from the Offers and the table, not from a role.
//
//   start({ session, lease })   the home writes the session's definition (its command, routes, read-only folders, labels and NETWORK limited by the lender's cap), binds the lease to the
//                               session's routes, and records the session as lent to THIS person and device. Both Offers must stand.
//   stop({ session })           the session leaves the table; its calls answer not_found from then on.
//   appendTranscript, getTranscript, putFile, getFile, putCheckpoint, getCheckpoint, usage    the store's own, authorized per call; files cross in chunks.
//
// A call is allowed only when the session is in the table for this person AND device, both Offers still stand at this very call, and then the store's own checks pass.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createCheckpointStore } from "./checkpoint-store.js";
import { effectiveNetwork } from "./runner.js";
import { KernelError } from "../../kernel/core/errors.js";
const err = (code, message) => new KernelError(code, message);
export const CHUNK_BYTES = 96 * 1024;
const SESSION = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_UPLOADS = 8;

/**
 * @param {{ space: string, root: string, offers: { active(q: { member: string, device: string }): { spaceAllows: boolean, memberAccepts: boolean } },
 *   specFor: (i: { space: string, session: string, person: string, device: string }) => Promise<any> | any,
 *   lenderCap?: (i: { person: string, device: string }) => "provider" | "internet" | undefined,
 *   leases?: { renew(chain: any, i: { id: string }): Promise<any>, bind(session: string, id: string, def: any): void, unbind(session: string): void },
 *   caps?: any, fs?: any }} o
 */
export function createLentHome(o) {
  const lent = new Map();
  const uploads = new Map();
  const downloads = new Map();
  const who = chain => {
    const h = chain && Array.isArray(chain.hops) ? chain.hops : [];
    if (chain?.space !== o.space || h.length !== 1 || !h[0].actor || h[0].actor.kind !== "person") throw err("not_found", "not found");
    const device = String(h[0].via?.device || "").replace(/^device:/, "");
    if (!device) throw err("not_found", "not found");
    return { person: String(h[0].actor.id), device };
  };
  const stands = ({ person, device }, device_key) => { const a = o.offers.active({ member: person, device, ...(device_key ? { device_key } : {}) }); return Boolean(a && a.spaceAllows && a.memberAccepts); };
  const mine = (chain, session) => {
    const w = who(chain);
    const l = lent.get(String(session));
    if (!SESSION.test(String(session)) || !l || l.person !== w.person || l.device !== w.device || !stands(w, l.key)) throw err("not_found", "not found");
    return w;
  };
  // The store is asked per call; its authorizer is the lent table and the Offers, so no role and no grant is needed and a withdrawn Offer ends the next call.
  const store = createCheckpointStore({ space: o.space, root: o.root, caps: o.caps, fs: o.fs, authorize: async ({ chain, resource }) => {
    const session = String(resource).split("/checkpoint/")[1] || "";
    try { mine(chain, session); return { effect: "allow" }; } catch { return { effect: "deny" }; }
  } });
  const sweep = () => { while (uploads.size > MAX_UPLOADS) { const k = uploads.keys().next().value; const u = uploads.get(k); uploads.delete(k); try { fs.rmSync(u.dir, { recursive: true, force: true }); } catch {} } };

  return {
    store,
    /** Whether this person's computer may run the Space's work now (both Offers), and the lender's own cap: the lender's runner polls it (never faster than once a minute). @param {any} chain @param {{ device_key?: string }} [i] */
    async status(chain, i = {}) {
      const w = who(chain); const a = o.offers.active({ member: w.person, device: w.device, ...(i && i.device_key ? { device_key: String(i.device_key) } : {}) });
      return { spaceAllows: Boolean(a && a.spaceAllows), memberAccepts: Boolean(a && a.memberAccepts), lenderCap: (o.lenderCap && o.lenderCap(w)) || null };
    },
    /** @param {any} chain @param {{ session: string, lease?: string, device_key?: string }} i */
    async start(chain, i) {
      const w = who(chain);
      if (!i || !SESSION.test(String(i.session))) throw err("bad_input", "name the session");
      if (!stands(w, i.device_key)) throw err("not_allowed", "this computer is not allowed to run this Space's work");
      const spec = await o.specFor({ space: o.space, session: i.session, person: w.person, device: w.device });
      if (!spec || typeof spec.command !== "string" || !Array.isArray(spec.routes)) throw err("not_found", "the Space has no definition for that session");
      const cap = o.lenderCap ? o.lenderCap(w) : undefined;
      // The Space's choice, limited by what this lender accepted: the Space can never hand a session more than the lender allowed (the runner applies the same rule again on the lender).
      const network = effectiveNetwork(spec.network, cap);
      if (o.leases && i.lease) { await o.leases.renew(chain, { id: String(i.lease) }); o.leases.bind(String(i.session), String(i.lease), { routes: spec.credentialRoutes || [] }); }
      lent.set(String(i.session), { person: w.person, device: w.device, key: i.device_key });
      const { credentialRoutes, ...visible } = spec;
      return { ...visible, network, lenderCap: cap || null };
    },
    async stop(chain, i) { mine(chain, i && i.session); lent.delete(String(i.session)); if (o.leases) { try { o.leases.unbind(String(i.session)); } catch {} } return { stopped: true }; },
    appendTranscript: (chain, s, e) => store.appendTranscript(chain, String(s), e),
    getTranscript: (chain, s, from, limit) => store.getTranscript(chain, String(s), from, limit),
    putCheckpoint: (chain, s, cp) => store.putCheckpoint(chain, String(s), cp),
    getCheckpoint: (chain, s) => store.getCheckpoint(chain, String(s)),
    usage: (chain, s) => store.usage(chain, String(s)),
    /**
     * A file in chunks of at most CHUNK_BYTES raw, numbered from 0, with the total count; the last one commits it whole to the store. `deleted: true` is a removal in one call.
     * @param {any} chain @param {string} s @param {string} rel @param {{ upload?: string, index?: number, total?: number, b64?: string, deleted?: boolean }} c
     */
    async putFile(chain, s, rel, c = {}) {
      mine(chain, s);
      if (c.deleted) return store.putFile(chain, String(s), String(rel), null);
      if (!Number.isInteger(c.index) || !Number.isInteger(c.total) || c.total < 1 || c.index < 0 || c.index >= c.total || typeof c.b64 !== "string" || typeof c.upload !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(c.upload)) throw err("bad_input", "a file chunk is numbered and carries its bytes");
      const bytes = Buffer.from(c.b64, "base64");
      if (bytes.length > CHUNK_BYTES) throw err("too_large", "that chunk is too large");
      const key = `${w2(chain)}|${s}|${c.upload}`;
      let u = uploads.get(key);
      if (!u) { const dir = path.join(o.root, ".uploads", crypto.randomBytes(8).toString("hex")); fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); u = { dir, total: c.total, next: 0 }; uploads.set(key, u); sweep(); }
      if (c.index !== u.next || c.total !== u.total) throw err("gap", "a chunk is missing or repeated");
      fs.appendFileSync(path.join(u.dir, "data"), bytes, { mode: 0o600 }); u.next++;
      if (u.next < u.total) return { pending: true, next: u.next };
      uploads.delete(key);
      try { return await store.putFile(chain, String(s), String(rel), new Uint8Array(fs.readFileSync(path.join(u.dir, "data")))); }
      finally { fs.rmSync(u.dir, { recursive: true, force: true }); }
    },
    /** A file in ranges: `{ offset, len }` up to CHUNK_BYTES; the answer says the file's size so the reader knows when it has all of it. */
    async getFile(chain, s, rel, version, r = {}) {
      mine(chain, s);
      const key = `${s}|${rel}|${version}`;
      let b = downloads.get(key);
      if (!b) { b = Buffer.from(await store.getFile(chain, String(s), String(rel), version)); downloads.set(key, b); if (downloads.size > 4) downloads.delete(downloads.keys().next().value); }
      const offset = Number.isInteger(r.offset) && r.offset >= 0 ? r.offset : 0, len = Math.min(CHUNK_BYTES, Number.isInteger(r.len) && r.len > 0 ? r.len : CHUNK_BYTES);
      return { size: b.length, offset, b64: b.subarray(offset, offset + len).toString("base64") };
    },
  };
  function w2(chain) { const w = who(chain); return w.person + "/" + w.device; }
}
