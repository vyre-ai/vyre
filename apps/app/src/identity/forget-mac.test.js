import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { forgetThisMac, serverNamesOf } from "./forget-mac-model.js";

const world = (o = {}) => {
  const did = [];
  return {
    did,
    d: {
      pairings: async () => o.pairings ?? [{ name: "testbox" }, { name: "Harlow Legal" }, { name: "testbox" }, {}],
      forget: async servers => { did.push(["forget", servers]); if (o.no) throw new Error("Not forgotten. Your key is still on this Mac."); },
      wipe: async () => { did.push(["wipe"]); },
      after: () => { did.push(["after"]); },
    },
  };
};

test("the shell is asked first, with every server this Mac stops reaching; then the pairings and the rest are wiped, then the pair-again screen", async () => {
  const w = world();
  assert.deepEqual(await forgetThisMac(w.d), { servers: ["testbox", "Harlow Legal", "a server"] });
  assert.deepEqual(w.did, [["forget", ["testbox", "Harlow Legal", "a server"]], ["wipe"], ["after"]]);
});

test("a no at the shell's alert changes nothing: no pairing is released and nothing is wiped", async () => {
  const w = world({ no: true });
  await assert.rejects(() => forgetThisMac(w.d), /Not forgotten/);
  assert.deepEqual(w.did.map(x => x[0]), ["forget"]);
});

test("a device with no pairings still forgets, and the alert names no server", async () => {
  const w = world({ pairings: [] });
  assert.deepEqual(await forgetThisMac(w.d), { servers: [] });
  assert.deepEqual(serverNamesOf([{ name: "  " }]), ["a server"]);
});

test("the Mac's device wipe also drops the shell's relay key, and the shell type takes the servers", () => {
  const read = f => fs.readFileSync(new URL(f, import.meta.url), "utf8");
  assert.match(read("./device-wipe.web.ts"), /name: "relay key on this Mac", run: async \(\) => \{ await shellRelayBridge\(\)\?\.forget\?\.\(\); \}/);
  assert.match(read("../shell/shell.ts"), /forget\(servers\?: string\[\]\): Promise<void>;/);
  assert.match(read("./forget-mac.ts"), /forget: \(servers\) => id\.forget\(servers\)/);
});
