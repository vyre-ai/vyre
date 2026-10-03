// @ts-check
// spaces: what a device does with an identity chain (team/0.3/DESIGN-wink.md section 2). The rules themselves are in names/worker/chain.js and
// are the same code the directory runs, so a change is checked here first and again there. Every change is signed by an entry already on
// the list, goes to the directory, and is kept in this device's copy with the head it verified, so a stale or forked answer is noticed.
//
// A device that is added learns of it at once (the entry that added it gave it the chain); every OTHER device learns on its next sync(),
// which returns the alerts (a new sign-in, a removal) and says whether this device itself was removed.

import * as C from "../../kernel/identity/chain.js";
import { newCode, codeKey, normalizeCode } from "./recovery.js";
import crypto from "node:crypto";
import { keyId } from "../../lib/identity/directory.js";
import { privateKeyOf } from "./identity.js";

const refuse = (message, code) => Object.assign(new Error(message), { code });
const chainWords = {
  newcomer: "A sign-in under 24 hours old cannot do that yet. Use an older device, or wait.",
  not_on_list: "That device is not on your list.",
  last_entry: "That would leave nobody who can sign in.",
  exists: "That is already on your list.",
  has_code: "There is a recovery code already. Replace it instead.",
  no_quorum: "Two of your recovery contacts need to approve.",
  too_many: "Your list is as long as it can be. Remove something first.",
  bad_signature: "That signature did not check out.",
};
const plain = e => chainWords[e && e.code] || (e && e.message) || "That did not work.";

/**
 * @param {{ store: ReturnType<typeof import("./identity.js").fileIdentityStore>, dir: ReturnType<typeof import("../../lib/identity/directory.js").idDirectory>,
 *   now: () => number, emit?: (type: string, payload: any) => void, stretch?: any }} d
 */
export function createIdentityOps({ store, dir, now, emit = () => {}, stretch }) {
  const me = () => {
    const s = store.status();
    if (!s.exists) throw refuse("This device has no Vyre identity yet.", "no_identity");
    return s;
  };
  const ctx = () => ({ now: now() + C.SKEW_MS });
  /** The verified state of the chain this device holds. */
  const stateNow = async () => C.verifyChain(store.ops(), ctx());
  const signer = () => { const s = me(); return { by: /** @type {string} */ (s.eid), sign: (/** @type {Uint8Array} */ m) => store.sign(Buffer.from(m)) }; };
  const nameOf = () => { const s = me(); if (!s.name) throw refuse("Choose your Vyre name first.", "no_identity"); return /** @type {string} */ (s.name); };

  /** Take any newer list the directory has before building on it (another device may have changed it), refusing a stale or different one. */
  async function refresh() {
    const r = await dir.resolve(nameOf(), { pin: store.pin() }).catch(e => { throw refuse(plain(e), /** @type {any} */ (e).code || "failed"); });
    if (!r.ok) throw refuse(`The directory's answer for your name could not be trusted: ${r.why}`, r.code || "bad_answer");
    if (r.advanced) store.setChain(r.ops, r.pin);
  }

  /** Make an op, check it here, send it, keep it. `by` is another signer when the code or a contact signs. */
  async function change(body, by = signer()) {
    await refresh();
    const state = await stateNow();
    const op = await C.makeOp(state, body, { by: by.by, ts: Math.max(now(), state.ts), sign: by.sign });
    let next;
    try { next = await C.applyOp(state, op, ctx()); } catch (e) { throw refuse(plain(e), /** @type {any} */ (e).code || "failed"); }
    try { await dir.append(nameOf(), [op]); } catch (e) { throw refuse(plain(e), /** @type {any} */ (e).code || "failed"); }
    store.setChain([...store.ops(), op], C.pinOf(next));
    // Alerts about what other devices did stay pending (sync() shows them); only our own op is marked seen.
    if (store.alerted() === state.seq) store.setAlerted(next.seq);
    return { op, state: next };
  }

  const view = (/** @type {C.State} */ state) => {
    const t = now(), self = me().eid;
    return state.entries.map(e => ({ eid: e.eid, kind: e.kind, label: e.label || null, since: e.since, self: e.eid === self,
      newcomer: C.youngAt(e, t), trustedAt: C.youngAt(e, t) ? e.since + C.NEWCOMER_MS : null }));
  };

  return {
    /** Make this device's key and chain with a recovery code (and an optional recovery password), and claim the name. The code is returned ONCE. */
    async create({ name, password = "", deviceLabel }) {
      const code = newCode();
      const ck = codeKey(code, password, stretch);
      await store.generate({ code: { eid: ck.eid, pub: ck.publicKey }, label: deviceLabel, ts: now() });
      try {
        const state = await stateNow();
        await dir.claim(name, state, store.ops(), signer(), { v: 1 });
        store.setChain(store.ops(), C.pinOf(state));
      } catch (e) { store.clear(); throw e; }
      const status = store.setName(name);
      return { status, recoveryCode: code, passwordSet: Boolean(password) };
    },
    entries: async () => view(await stateNow()),
    /** Add a device (its public key came from pairing) or a recovery contact (its approval key came from the contact). */
    async addEntry({ kind = "device", publicKey, label }) {
      if (kind !== "device" && kind !== "contact") throw refuse("Add a device or a recovery contact.", "bad_kind");
      const pub = Buffer.from(String(publicKey), "base64url");
      if (pub.length !== 32) throw refuse("That is not a device key.", "bad_key");
      const eid = keyId(pub);
      const r = await change({ type: "add", entry: { eid, kind, pub: String(publicKey), label: label ? String(label).slice(0, 60) : undefined } });
      emit("identity.entry-added", { name: nameOf(), eid, kind, seq: r.state.seq, at: now() });
      return { eid, seq: r.state.seq };
    },
    async removeEntry(eid) {
      await refresh();
      const state = await stateNow();
      const target = state.entries.find(e => e.eid === eid);
      if (!target) throw refuse(chainWords.not_on_list, "not_on_list");
      const r = await change({ type: "remove", target: eid });
      emit("identity.entry-removed", { name: nameOf(), eid, kind: target.kind, seq: r.state.seq, at: now() });
      return { eid, seq: r.state.seq };
    },
    /** A new recovery code; the old one stops. The code is returned ONCE. */
    async replaceCode({ password = "" } = {}) {
      const code = newCode();
      const ck = codeKey(code, password, stretch);
      const r = await change({ type: "replace-code", entry: { eid: ck.eid, kind: "code", pub: ck.publicKey } });
      emit("identity.code-replaced", { name: nameOf(), seq: r.state.seq, at: now() });
      return { recoveryCode: code, passwordSet: Boolean(password), seq: r.state.seq };
    },
    /** Here: a recovery contact makes the key it will approve with, and gives the PUBLIC half to the person. */
    makeContactKey(forName) {
      const k = store.newDeviceKey();
      store.held.put(k.eid, { privateKey: k.privateKey, publicKey: k.publicKey, forName: String(forName).toLowerCase() });
      return { eid: k.eid, publicKey: k.publicKey };
    },
    /**
     * Learn what changed on the list since this device last looked: new sign-ins and removals (alerts), and whether this device was removed.
     * A stale or forked answer is reported, never taken.
     */
    async sync() {
      const name = nameOf(), mine = me().eid;
      const r = await dir.resolve(name, { pin: store.pin() });
      if (!r.ok) { emit("identity.warning", { name, why: r.why, code: r.code || "bad_answer", at: now() }); return { ok: false, why: r.why, code: r.code || "bad_answer" }; }
      if (r.advanced) store.setChain(r.ops, r.pin);
      const since = store.alerted();
      const alerts = C.alertsSince(r.ops, since).filter(a => a.by !== mine);
      store.setAlerted(r.state.seq);
      const removed = !r.state.entries.some(e => e.eid === mine);
      for (const a of alerts) emit(a.type === "remove" ? "identity.entry-removed" : "identity.entry-added", { name, ...a, at: now() });
      if (removed) emit("identity.device-removed", { name, eid: mine, at: now() });
      return { ok: true, alerts, removed, seq: r.state.seq };
    },
    /** A new device, the recovery code in hand (and the password if one was set): back in at once. */
    async recoverWithCode({ name, code, password = "", deviceLabel }) {
      if (store.status().exists) throw refuse("This device already has a Vyre identity.", "exists");
      const r = await dir.resolve(name);
      if (!r.ok || r.kind !== "person") throw refuse(r.ok ? "That name does not belong to a person." : r.why, "not_found");
      const ck = codeKey(code, password, stretch);
      if (!r.state.entries.some(e => e.kind === "code" && e.eid === ck.eid)) throw refuse("That code (or password) is not the one for this name.", "wrong_code");
      const key = store.newDeviceKey();
      const op = await C.makeOp(r.state, { type: "add", entry: { eid: key.eid, kind: "device", pub: key.publicKey, label: deviceLabel ? String(deviceLabel).slice(0, 60) : undefined } }, { by: ck.eid, ts: Math.max(now(), r.state.ts), sign: ck.sign });
      let next;
      try { next = await C.applyOp(r.state, op, ctx()); await dir.append(name, [op]); } catch (e) { throw refuse(plain(e), /** @type {any} */ (e).code || "failed"); }
      store.join(key, [...r.ops, op], name);
      store.setChain([...r.ops, op], C.pinOf(next));
      store.setAlerted(next.seq);
      emit("identity.recovered", { name, how: "code", seq: next.seq, at: now() });
      return { status: store.status(), seq: next.seq };
    },
    /** Everything lost: a new device asks. The request goes to the recovery contacts (any way the person likes: a code, a link). */
    async beginContactRecovery({ name, deviceLabel }) {
      if (store.status().exists) throw refuse("This device already has a Vyre identity.", "exists");
      const r = await dir.resolve(name);
      if (!r.ok || r.kind !== "person") throw refuse(r.ok ? "That name does not belong to a person." : r.why, "not_found");
      const key = store.newDeviceKey();
      const op = await C.makeOp(r.state, { type: "recover", entry: { eid: key.eid, kind: "device", pub: key.publicKey, label: deviceLabel ? String(deviceLabel).slice(0, 60) : undefined } }, { ts: Math.max(now(), r.state.ts) });
      return { request: { name, op }, key, contacts: r.state.entries.filter(e => e.kind === "contact").length };
    },
    /** On a contact's device, after the person approved with Face ID: sign the request if this device holds a contact key for that identity. */
    async approveRecovery(request) {
      const name = String(request && request.name || "").toLowerCase();
      const r = await dir.resolve(name);
      if (!r.ok || r.kind !== "person") throw refuse("That name could not be verified.", "not_found");
      const op = request.op;
      if (!op || op.type !== "recover" || op.id !== r.state.id || op.prev !== r.state.head) throw refuse("That request is out of date. Ask again.", "stale_request");
      const mine = r.state.entries.filter(e => e.kind === "contact").map(e => ({ e, held: store.held.get(e.eid) })).find(x => x.held);
      if (!mine) throw refuse("You are not one of this person's recovery contacts.", "not_a_contact");
      const sig = C.b64u(crypto.sign(null, Buffer.from(C.approvalMessage(op)), privateKeyOf(mine.held.privateKey)));
      return { eid: mine.e.eid, sig };
    },
    /** Back on the new device: put the approvals on the request, send it, and keep the chain. */
    async finishContactRecovery({ request, key, approvals }) {
      const { name } = request;
      const op = { ...request.op, approvals };
      const r = await dir.resolve(name);
      if (!r.ok) throw refuse(r.why, "not_found");
      let next;
      try { next = await C.applyOp(r.state, op, ctx()); await dir.append(name, [op]); } catch (e) { throw refuse(plain(e), /** @type {any} */ (e).code || "failed"); }
      store.join(key, [...r.ops, op], name);
      store.setChain([...r.ops, op], C.pinOf(next));
      store.setAlerted(next.seq);
      emit("identity.recovered", { name, how: "contacts", seq: next.seq, at: now() });
      return { status: store.status(), seq: next.seq };
    },
    normalizeCode,
  };
}
