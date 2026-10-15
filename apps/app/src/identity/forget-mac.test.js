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
      pairings: async () => o.pairings ?? [{ box: "b1", name: "testbox" }, { box: "b2", name: "Harlow Legal" }, { box: "b3", name: "testbox" }, { box: "b4" }],
      forget: async servers => { did.push(["forget", servers]); if (o.no) throw new Error("Not forgotten. Your key is still on this Mac."); },
      leave: async p => { did.push(["leave", p.box]); if (o.down && o.down.includes(p.box)) throw new Error("unreachable"); },
      dropRelay: async () => { did.push(["dropRelay"]); },
      wipe: async () => { did.push(["wipe"]); },
      after: () => { did.push(["after"]); },
    },
  };
};

test("the shell asks first, naming every server; then this Mac leaves each server over its relay key, then the key goes, then the wipe and the pair-again screen", async () => {
  const w = world();
  assert.deepEqual(await forgetThisMac(w.d), { servers: ["testbox", "Harlow Legal", "a server"], kept: [] });
  assert.deepEqual(w.did, [["forget", ["testbox", "Harlow Legal", "a server"]], ["leave", "b1"], ["leave", "b2"], ["leave", "b3"], ["leave", "b4"], ["dropRelay"], ["wipe"], ["after"]]);
});

test("a no at the shell's alert changes nothing: no server is left, no key dropped, nothing wiped", async () => {
  const w = world({ no: true });
  await assert.rejects(() => forgetThisMac(w.d), /Not forgotten/);
  assert.deepEqual(w.did.map(x => x[0]), ["forget"]);
});

test("a server that cannot be reached keeps its row and is named; the rest still goes", async () => {
  const w = world({ down: ["b2"] });
  assert.deepEqual((await forgetThisMac(w.d)).kept, ["Harlow Legal"]);
  assert.deepEqual(w.did.slice(-3).map(x => x[0]), ["dropRelay", "wipe", "after"]);
});

test("a device with no pairings still forgets, and the alert names no server", async () => {
  const w = world({ pairings: [] });
  assert.deepEqual(await forgetThisMac(w.d), { servers: [], kept: [] });
  assert.deepEqual(serverNamesOf([{ name: "  " }]), ["a server"]);
});

test("the Mac's device wipe also drops the shell's relay key, and the shell type takes the servers", () => {
  const read = f => fs.readFileSync(new URL(f, import.meta.url), "utf8");
  assert.match(read("./device-wipe.web.ts"), /name: "relay key on this Mac", run: async \(\) => \{ await shellRelayBridge\(\)\?\.forget\?\.\(\); \}/);
  assert.match(read("../shell/shell.ts"), /forget\(servers\?: string\[\], opts\?: \{ keepRelay\?: boolean \}\): Promise<void>;/);
  const here = read("./forget-mac.ts");
  assert.match(here, /forget: \(servers\) => id\.forget\(servers, \{ keepRelay: true \}\)/);
  assert.match(here, /leave: \(p\) => tool\("relay\.devices\.leave", \{\}, \{ server: p\.box \}\)/);
});

test("Settings has a Forget this Mac row in the Mac app only, beside Make this Mac a server, and it runs this forget", () => {
  const read = f => fs.readFileSync(new URL(f, import.meta.url), "utf8");
  const row = read("../../screens/settings/ForgetThisMac.tsx");
  assert.match(row, /if \(!shell\(\)\?\.identity\?\.forget\) return null;/, "only where the shell can forget");
  assert.match(row, /forgetThisMacHere\(\)/);
  assert.match(row, /title="Forget this Mac"/);
  assert.match(read("../../screens/settings/SettingsHome.tsx"), /at === "after:Devices"[^\n]*<ForgetThisMac \/>/);
});
