// The device rows on a REAL daemon: the facts come from the daemon's own `callerFacts` and the home's own relay row (`relay.device.info`), not from facts built by hand. A confirmed
// owner device signed in reads personal memory; an unsigned one gets the sign-in hint; a web device, a setup device, a removed device and an id never paired get the plain refusal with
// no hint. The person session id is a stand-in (SHIM(person session): vault's pairing-opened session is on work/paired-session); the chain only needs the daemon to carry it as a fact.
// Run it on a test box, never on a person's Mac.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../daemon/index.js";
import { callerFacts } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";

test("device rows on a real daemon: callerFacts from the home's relay row decides who reads personal memory", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const d = await start({ root: tempHome(t), log: () => {}, kernel: true });
  t.after(() => d.stop());
  const ins = d.registry.deps.db.prepare("INSERT INTO relay_devices (id, name, pub, paired_at, kind, trusted, removed_at) VALUES (?, ?, 'p', 1, ?, ?, ?)");
  const ids = { app: "aaaaaaaaaaaaaaaa", web: "bbbbbbbbbbbbbbbb", setup: "cccccccccccccccc", gone: "dddddddddddddddd", never: "eeeeeeeeeeeeeeee" };
  ins.run(ids.app, "phone", "app", 0, null); ins.run(ids.web, "browser", "web", 1, null); ins.run(ids.setup, "setup page", "setup", 0, null); ins.run(ids.gone, "old", "app", 0, 5);
  /** One memory call the way the daemon makes it: the facts are callerFacts' own, from the relay row. */
  const read = async (id, signedIn, tool = "memory.graph") => {
    const label = `device:${id}`, via = signedIn ? { person: { id: "ps1" } } : {};
    const info = await d.registry.call("relay.device.info", { id }, "module:vyred");
    const facts = callerFacts(label, { caller: label }, via, d.kernel, false, info.data ? { ...info.data, person: d.kernel.id.owner } : null);
    return d.registry.call(tool, {}, label, { ...via, ...(facts ? { kernelFacts: facts } : {}) });
  };
  const ok = r => !r.error;
  assert.ok(ok(await read(ids.app, true)), "a confirmed owner device, signed in, reads personal memory");
  assert.ok(ok(await read(ids.app, true, "memory.corrections")));
  const unsigned = await read(ids.app, false);
  assert.equal(unsigned.error && unsigned.error.code, "person_session_required", "the owner's own unsigned device gets the sign-in hint");
  for (const k of ["web", "setup", "gone", "never"]) for (const signedIn of [true, false]) {
    const r = await read(ids[k], signedIn);
    assert.equal(r.error && r.error.code, "denied", `${k} (signed in: ${signedIn})`);
    assert.doesNotMatch(String(r.error && r.error.message), /sign in|passkey|session/i, `${k}: no sign-in hint to a device that is not the owner's`);
  }
});
