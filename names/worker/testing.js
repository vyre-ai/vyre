// @ts-check
// Test helpers for the name directory's tests: a world over the fakes, boxes that sign with a route key, identities (a person, a space) that sign with their own keys.
import crypto from "node:crypto";
import worker, * as W from "./index.js";
import * as I from "./ids.js";
import * as C from "./chain.js";
import { createRuntime } from "../../relay/worker/fake-cf.js";
import { fakeDns } from "./fake-dns.js";
import * as wire from "../../core/relay/wire.js";
import assert from "node:assert/strict";

export const BASE = "https://names.test";
export const HOUR = 3_600_000;
export const data = r => { assert.ok(r.json && r.json.data, JSON.stringify(r.json)); return r.json.data; };
export const code = r => r.json && r.json.error && r.json.error.code;

export function world(t, extra = {}) {
  const dns = fakeDns();
  const clock = { t: Date.UTC(2026, 9, 3, 12, 0, 0) };
  const txt = new Map();
  const rt = createRuntime({ worker, Class: W.Directory, classes: { DIRECTORY: W.Directory },
    env: { CF_API_TOKEN: dns.token, CF_ZONE_ID: dns.zoneId, CF_API: dns.api, CF_FETCH: dns.fetch, NOW: () => clock.t, ZONE: "vyre.run", RESOLVE_TXT: async n => txt.get(n) || [], ...extra } });
  t.after(async () => { await rt.settle(); assert.deepEqual(rt.errors.map(String), [], "no errors inside the Worker"); });
  return { rt, dns, clock, env: rt.env, txt };
}


/** A route key, for the box claim path only (box routes still sign their requests). */
export function who(w, key = wire.newRouteKey()) {
  const route = wire.routeId(key.pub);
  const pub = key.pub.toString("base64url");
  const send = async (method, path, body, o = {}) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    const nonce = crypto.randomBytes(16).toString("base64url");
    const ts = o.ts ?? w.clock.t;
    const bodyHash = crypto.createHash("sha256").update(text).digest("hex");
    const sig = wire.signRoute(key.priv, Buffer.from(W.authMessage({ route, ts, nonce, method, target: path, bodyHash }))).toString("base64url");
    const headers = { ...(o.unsigned ? {} : { "x-vyre-route": route, "x-vyre-pub": pub, "x-vyre-ts": String(ts), "x-vyre-nonce": nonce, "x-vyre-sig": sig }),
      ...(body === undefined ? {} : { "content-type": "application/json" }), "cf-connecting-ip": o.ip || "203.0.113.7" };
    const res = await worker.fetch(new Request(BASE + path, { method, headers, body: text || undefined }), w.env);
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  return { route, post: (p, b, o) => send("POST", p, b, o), get: (p, o) => send("GET", p, undefined, o) };
}

export async function key(label) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const pubText = Buffer.from(pub).toString("base64url");
  const eid = await C.eidOf(pub);
  const sign = m => crypto.sign(null, Buffer.from(m), privateKey);
  return { label, pub: pubText, eid, sign, sig64: m => sign(m).toString("base64url"), entry: kind => ({ eid, kind, pub: pubText }) };
}

/** A person (or space) client over the directory: it holds the chain it has built and talks plain HTTP with nothing signed at the request level. */
export async function identity(w, first, { kind = "person", ctxFor } = {}) {
  const ts = w.clock.t;
  const send = async (method, path, body, ip = "203.0.113.7") => {
    const text = body === undefined ? "" : JSON.stringify(body);
    const res = await worker.fetch(new Request(BASE + path, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), "cf-connecting-ip": ip }, body: text || undefined }), w.env);
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const me = { first, ops: [], state: null, send, get: (p, ip) => send("GET", p, undefined, ip), post: (p, b, ip) => send("POST", p, b, ip), del: (p, b) => send("DELETE", p, b) };
  me.sealRecord = (name, sealed, by = first, via) => {
    const sealedHash = crypto.createHash("sha256").update(sealed).digest("hex");
    const ts2 = w.clock.t;
    const pos = kind === "space" && me.pos ? { vseq: me.pos.via_seq, vhead: me.pos.via_head } : {};
    return { sealed, rec: { by: kind === "space" ? me.state.entries[0].eid : by.eid, ...(via ? { via } : {}), ...pos, ts: ts2, sig: by.sig64(I.recordMessage({ name, id: me.state.id, by: kind === "space" ? me.state.entries[0].eid : by.eid, via, ts: ts2, sealedHash, ...pos })) } };
  };
  me.genesis = async (entry, via) => {
    if (kind === "space" && ctxFor) me.pos = await C.viaOf(await ctxFor(entry.subject));
    const g = await C.makeGenesis({ kind, entry: entry || first.entry("device"), nonce: "nonce-" + first.eid.slice(0, 10), ts, via, viaPos: me.pos, sign: first.sign });
    me.ops = [g];
    me.state = await C.verifyChain(me.ops, { now: ts, ownerOps: ctxFor });
    return me;
  };
  // A person's first name goes through a reservation and its code; a space's name is claimed outright, signed by its owner.
  me.claim = async (name, sealed = "c2VhbGVk", by, via) => {
    const body = { name, ops: me.ops, ...me.sealRecord(name, sealed, by, via) };
    if (kind === "space") return me.post("/v1/ids/claim", body);
    const r = await me.post("/v1/ids/reserve", { name });
    if (!r.json || !r.json.data) return r;
    return me.post("/v1/ids/finalize", { ...body, code: r.json.data.code });
  };
  me.append = async (body, signer, { via } = {}) => {
    const op = await C.makeOp(me.state, body, { by: kind === "space" ? me.state.entries[0].eid : signer.eid, via, viaPos: me.pos, ts: w.clock.t, sign: signer.sign });
    return op;
  };
  me.accept = async op => { me.state = await C.applyOp(me.state, op, { now: w.clock.t, ownerOps: ctxFor }); me.ops = [...me.ops, op]; return op; };
  return me;
}
export const person = async (w, k = null) => identity(w, k || await key("phone")).then(i => i.genesis());
export const act = async (w, who_, action, name, domain, by = who_.first) => ({ by: by.eid, ts: w.clock.t, sig: by.sig64(I.actMessage({ action, name, domain, ts: w.clock.t })) });

let owners = 0;
/**
 * A server that serves a space's name, the way the app sets it up: a person (named by a reservation), a space they own, and the space's signed note that this box's route serves it.
 * @param {any} w the world @param {any} box a box from the tests (route + signed requests) @param {string} name the space's name
 */
export async function serve(w, box, name) {
  const owner = await person(w);
  data(await owner.claim(`owner${++owners}x`));
  const space = await identity(w, owner.first, { kind: "space", ctxFor: async id => id === owner.state.id ? owner.ops : null });
  await space.genesis({ eid: owner.state.id, kind: "owner", subject: owner.state.id }, owner.first.eid);
  data(await space.claim(name, "aG9tZQ", owner.first, owner.first.eid));
  const signed = async (action, subject) => ({ by: owner.state.id, via: owner.first.eid, ts: w.clock.t, sig: owner.first.sig64(I.actMessage({ action, name, domain: subject, ts: w.clock.t })) });
  return { owner, space, signed, async addServer(route = box.route) { return space.post("/v1/ids/server", { name, route, act: await signed("server-add", route) }); }, async removeServer(route = box.route) { return space.post("/v1/ids/server", { name, route, remove: true, act: await signed("server-remove", route) }); } };
}
