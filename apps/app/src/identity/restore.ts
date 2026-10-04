// Getting an existing name onto a new or wiped device, with no box (team/0.3/UX-AUDIT.md, "Getting an existing name onto a new or wiped phone"). The same steps as
// core/spaces/identity-ops.js recoverWithCode, built from the pieces claim.js uses: resolve the name's chain at the names directory, check the recovery code's key is on it, make this
// device's own key, append an `add` op signed by the code's key, publish it, keep the chain. The screen shows its own sentence for each `.code`; it never renders `.message`.
//
//   not_found    no such name at the directory
//   not_a_person the name belongs to a space
//   wrong_code   the code (or password) is not the one for this name; nothing was changed
//   unreachable  the directory did not answer (or answered something that is not a chain)
//   rate_limited the directory asked us to slow down
//   newcomer     the chain refuses the change from this entry (too new to do it)
//   rolled_back  the directory's chain is older than one this device has seen (the pin)
//   exists       this device already holds a different name
//   not_hardware a phone could not give its Secure Enclave key (`requireEnclave`): nothing is signed or kept (NK-2)

import * as C from "../../../../kernel/identity/chain.js";
import { codeLooksRight, codeSigner, STRETCH } from "./recovery.js";
import { generateDeviceKey } from "./keys.js";
import { forgetIdentity, hadIdentity, loadIdentity, saveIdentity } from "./store.ts";
import type { PairingSession } from "../api/pairing-session";
import type { WinkCode } from "../api/wink-code";

export { hadIdentity };

const DIRECTORY = (process.env.EXPO_PUBLIC_VYRE_NAMES_DIRECTORY || "https://names.vyre.run").replace(/\/+$/, "");
const fail = (code: string, message: string) => Object.assign(new Error(message), { code });

type Opts = {
  name: string; code: string; password?: string; deviceLabel: string; base?: string;
  /** What this device saw of the chain before (an earlier sighting): a directory that answers older than this is refused. */
  pin?: { id: string; seq: number; head: string };
  fetch?: typeof fetch; now?: () => number; params?: { memoryKiB: number; passes: number };
  /** This device's key (the phone's Keychain key from keys/createIdentityKey); a browser or a test makes one here. */
  key?: Awaited<ReturnType<typeof generateDeviceKey>>;
  /** The phone's Secure Enclave public key (NK-2) for the new entry, when this device has one. */
  enclave?: string;
  /** On a phone: refuse (not_hardware) unless `enclave` is given, so a recovered phone never has a device entry whose seed alone can change the list (NK-2). */
  requireEnclave?: boolean;
};

async function directory(f: typeof fetch, base: string, method: "GET" | "POST", target: string, body?: unknown): Promise<{ status: number; data: any }> {
  let res: Response;
  try { res = await f(`${base}${target}`, { method, headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); }
  catch { throw fail("unreachable", "The names directory did not answer."); }
  let json: any = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  if (res.status === 429) throw fail("rate_limited", "Too many tries. Wait and try again.");
  if (res.status === 404 || (json && json.error && /^(not_found|no_such_name)$/.test(String(json.error.code)))) throw fail("not_found", "There is no such name.");
  if (!res.ok || !json || json.error || !json.data) throw fail(json && json.error && json.error.code === "rate_limited" ? "rate_limited" : "unreachable", (json && json.error && json.error.message) || `The directory answered ${res.status}.`);
  return { status: res.status, data: json.data };
}

export async function recoverIdentity(o: Opts): Promise<{ name: string; id: string }> {
  const name = String(o.name).trim().toLowerCase().replace(/\.vyre\.run$/, "");
  if (!codeLooksRight(o.code)) throw fail("wrong_code", "That is not a recovery code.");
  const f = o.fetch ?? globalThis.fetch;
  const base = (o.base ?? DIRECTORY).replace(/\/+$/, "");
  const now = o.now ?? Date.now;
  // A second recovery on the same device is idempotent: the name is already here.
  const mine = await loadIdentity().catch(() => null);
  if (mine) {
    if (mine.name !== name) throw fail("exists", "This device already holds a different name.");
    // Kept here: make sure the directory has this device's entry too (an earlier publish whose answer was lost may not have landed); if not, send the same op again.
    const last = mine.ops[mine.ops.length - 1] as any;
    const there = await directory(f, base, "GET", `/v1/ids/resolve?name=${encodeURIComponent(name)}`).catch(() => null);
    const listed = there && Array.isArray(there.data.ops) && there.data.ops.some((x: any) => x && x.entry && x.entry.eid === mine.eid);
    if (there && !listed && last && last.entry && last.entry.eid === mine.eid) await directory(f, base, "POST", "/v1/ids/append", { name, ops: [last] });
    return { name: mine.name, id: mine.id };
  }
  const r = await directory(f, base, "GET", `/v1/ids/resolve?name=${encodeURIComponent(name)}`);
  const ops: any[] = Array.isArray(r.data.ops) ? r.data.ops : [];
  if (r.data.kind !== "person") throw fail("not_a_person", "That name does not belong to a person.");
  let state: any;
  try { state = await C.verifyChain(ops, { now: now() + C.SKEW_MS }); } catch { throw fail("unreachable", "The directory's list for this name did not check out."); }
  if (state.id !== r.data.id || state.kind !== "person") throw fail("unreachable", "The directory's list is not for the identity it named.");
  if (o.pin) { const seen = await C.checkAnswer(o.pin, ops); if (!seen.ok) throw fail("rolled_back", "The directory's list is older than one this device has seen."); }
  const ck = await codeSigner(o.code, o.password ?? "", o.params ?? STRETCH);
  if (!state.entries.some((e: any) => e.kind === "code" && e.eid === ck.eid)) throw fail("wrong_code", "That code (or password) is not the one for this name.");
  if (o.requireEnclave && !o.enclave) throw fail("not_hardware", "This phone could not give its Secure Enclave key.");
  const key = o.key ?? (await generateDeviceKey());
  const entry = { eid: key.eid, kind: "device", pub: key.publicKey, label: o.deviceLabel ? String(o.deviceLabel).slice(0, 60) : undefined, ...(o.enclave ? { enclave: o.enclave } : {}) };
  let op: any, next: any;
  try {
    op = await C.makeOp(state, { type: "add", entry }, { by: ck.eid, ts: Math.max(now(), state.ts), sign: (m: Uint8Array) => ck.sign(m) });
    next = await C.applyOp(state, op, { now: now() + C.SKEW_MS });
  } catch (e) { throw fail(/new|young|old/i.test(String((e as { code?: string }).code ?? "")) ? "newcomer" : "unreachable", String((e as Error).message)); }
  // Keep the key first, then publish: if keeping fails nothing was appended (the code is not spent on a lost key).
  await saveIdentity({ name, id: state.id, eid: key.eid, ops: [...ops, op], pin: C.pinOf(next), key });
  try { await directory(f, base, "POST", "/v1/ids/append", { name, ops: [op] }); }
  catch (e) {
    // A clear refusal (the directory said no) means nothing landed: forget the key. A lost answer (the directory may have applied the op) is checked: read the chain again, and if it holds this
    // device the recovery succeeded; if it cannot be read the key STAYS (a retry sends the same op again), because forgetting it would leave an entry on the list that nobody holds (RX-2).
    if ((e as { code?: string }).code !== "unreachable") { await forgetIdentity().catch(() => {}); throw e; }
    const again = await directory(f, base, "GET", `/v1/ids/resolve?name=${encodeURIComponent(name)}`).catch(() => null);
    const landed = again && Array.isArray(again.data.ops) && again.data.ops.some((x: any) => x && x.entry && x.entry.eid === key.eid);
    if (!landed) { if (again) await forgetIdentity().catch(() => {}); throw e; }
  }
  return { name, id: state.id };
}

/**
 * This phone's half of "Add this phone from another device": the existing device shows a code (wink.phone.open); this phone redeems it, shows the three words, and when the person at
 * the other device says yes that device appends this phone's key to the identity's list. NOT BUILT: it needs the phone-side client of the relay (the counterpart of relay/client/serverpair.js,
 * which tailnet owns) and the list change signed by the existing device; asked of tailnet in CHAT.md. Until then it refuses with the code `not_built`.
 */
export function addThisDevice(_code: Extract<WinkCode, { ok: true }>, _o: { deviceLabel: string }): PairingSession {
  throw Object.assign(new Error("Adding this device from another device is not built yet."), { code: "not_built" });
}
