import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startTypedPairing, SAY } from "../app/ui/typed-pair.js";

const fakeDeps = (over = {}) => {
  const calls = { invoke: [], join: [] };
  return {
    calls,
    deps: {
      relay: "wss://relay.example", name: "Sam's PC",
      shellDeviceKey: (invoke) => ({ keyStore: { from: invoke }, crypto: {} }),
      invoke: async (cmd, args) => { calls.invoke.push([cmd, args]); },
      joinWithCode: async (o) => { calls.join.push(o); o.onState({ state: "checking" }); o.onState({ state: "ack", code: "K4-9XM" }); return { ok: true, paired: { relay: "wss://relay.example", route: "r", box: "b", device: "d", name: "alex", address: "https://alex.vyre.run" } }; },
      ...over,
    },
  };
};

test("a typed code is joined over the relay, the ack is shown, and the shell keeps the pairing with the box's address", async () => {
  const { deps, calls } = fakeDeps();
  const acks = [];
  const r = await startTypedPairing({ input: "WINK-7K4Q-M2XD", onAck: (a) => acks.push(a) }, deps);
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(acks, ["K4-9XM"]);
  assert.equal(calls.join[0].input, "WINK-7K4Q-M2XD");
  assert.equal(calls.join[0].relay, "wss://relay.example");
  assert.equal(calls.join[0].pairOptions.about.kind, "app");
  assert.equal(calls.invoke[0][0], "finish_typed_pair");
  assert.equal(calls.invoke[0][1].address, "https://alex.vyre.run");
  assert.equal(calls.invoke[0][1].handle, null, "no handle when the record had none");
  assert.equal(calls.invoke[0][1].link.name, "alex");
});

test("each way the join can fail says one plain thing and keeps nothing", async () => {
  for (const reason of ["format", "busy", "offline", "refused", "closed", "expired"]) {
    const { deps, calls } = fakeDeps({ joinWithCode: async () => ({ ok: false, reason }) });
    const r = await startTypedPairing({ input: "x" }, deps);
    assert.deepEqual(r, { ok: false, say: SAY[reason] });
    assert.equal(calls.invoke.length, 0, reason);
  }
  const { deps } = fakeDeps({ joinWithCode: async () => ({ ok: false, reason: "weird" }) });
  assert.equal((await startTypedPairing({ input: "x" }, deps)).say, SAY.refused);
});

test("a pairing that gives no address is not kept, and the shell's refusal is said in its own words", async () => {
  const noAddr = fakeDeps({ joinWithCode: async () => ({ ok: true, paired: { relay: "wss://relay.example", route: "r", box: "b", device: "d", name: "alex" } }) });
  assert.deepEqual(await startTypedPairing({ input: "x" }, noAddr.deps), { ok: false, say: SAY.nothing });
  assert.equal(noAddr.calls.invoke.length, 0);
  const refused = fakeDeps({ invoke: async () => { throw new Error("The pairing gave no address this app can open."); } });
  assert.deepEqual(await startTypedPairing({ input: "x" }, refused.deps), { ok: false, say: "The pairing gave no address this app can open." });
});

test("the first-run page types a code, draws no QR, and the shell has the command and the permission for it", () => {
  const ui = (f) => readFileSync(new URL(`../app/ui/${f}`, import.meta.url), "utf8");
  const html = ui("first-run.html");
  assert.match(html, /id="code"/);
  assert.doesNotMatch(html, /qr|seedbox/i, "no plain QR on the first-run page");
  assert.match(ui("first-run-pair.js"), /startTypedPairing/);
  const rs = readFileSync(new URL("../app/src/main.rs", import.meta.url), "utf8");
  assert.match(rs, /async fn finish_typed_pair\(/);
  assert.match(rs, /generate_handler!\[[^\]]*finish_typed_pair/);
  assert.match(readFileSync(new URL("../app/build.rs", import.meta.url), "utf8"), /"finish_typed_pair"/);
  const caps = JSON.parse(readFileSync(new URL("../app/capabilities/first-run.json", import.meta.url), "utf8"));
  assert.ok(caps.permissions.includes("allow-finish-typed-pair"));
  // every permission a capability names is a command the build declares (a stale one fails the Tauri build, as allow-cancel-pair did)
  const declared = [...readFileSync(new URL("../app/build.rs", import.meta.url), "utf8").matchAll(/"([a-z_]+)"/g)].map((m) => "allow-" + m[1].replace(/_/g, "-"));
  for (const perm of caps.permissions.filter((x) => x.startsWith("allow-"))) assert.ok(declared.includes(perm), `${perm} is declared in build.rs`);
  assert.match(rs, /shell::pin_from_offer\(handle\.as_deref\(\), address\.as_deref\(\)\)/, "the address and handle go through the shell's pin rules");
  for (const gone of ["begin_pair", "offer_pair", "confirm_pair", "pair_status", "finish_pair\\b", "pending_pair"]) assert.doesNotMatch(rs, new RegExp(gone), `${gone} is deleted`);
  assert.doesNotMatch(readFileSync(new URL("../app/build.rs", import.meta.url), "utf8"), /begin_pair|confirm_pair/);
});

test("a record with only a handle is kept too (the shell turns it into its vyre.run address)", async () => {
  const { deps, calls } = fakeDeps({ joinWithCode: async () => ({ ok: true, paired: { relay: "wss://relay.example", route: "r", box: "b", device: "d", name: "alex", handle: "alex" } }) });
  assert.deepEqual(await startTypedPairing({ input: "x" }, deps), { ok: true });
  assert.deepEqual([calls.invoke[0][1].address, calls.invoke[0][1].handle], [null, "alex"]);
});
