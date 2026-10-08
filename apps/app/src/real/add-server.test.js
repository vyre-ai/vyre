// @ts-check
// The one add-a-server piece: the install line carries the app's one-time code and the Records choice; the server's offer is found with nothing copied back; nothing opens until the person
// confirms the four words in the app; the pairing is asked for over the channel only that app can open. Against fakes here, and against a real server over a real relay at the end.
import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CHOICES, DEFAULT_CHOICE, GAINS, MESSAGES, choiceOf, createAddServer, installLine, memoryNote } from "./add-server.js";

const until = async (/** @type {() => any} */ fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 5)); } throw new Error("timed out"); };
const CODE = "A".repeat(43);

/** Fakes for the relay client: the offer appears after `after` tries (or is contested). */
function fakes({ after = 1, contested = false, words = ["lantern", "quiet", "river", "oak"], lines = [] } = {}) {
  let tries = 0;
  const calls = { connect: 0, tools: /** @type {string[]} */ ([]), paired: /** @type {string[]} */ ([]), closed: 0 };
  const client = {
    createSetupKey: async () => ({ privateKey: {}, spki: new Uint8Array(91) }),
    setupCode: async () => CODE,
    resolveSetup: async () => { if (contested) throw Object.assign(new Error("two"), { code: "contested" }); if (++tries < after) throw Object.assign(new Error("none"), { code: "ticket_gone" }); return { offer: { box: new Uint8Array(32), route: "r".repeat(26), relay: "ws://x" }, name: "harlow-server", fingerprint: "ab12" }; },
    setupWords: async () => words,
    mailboxReader: async () => { let sent = false; return { next: async () => { if (!sent) { sent = true; return lines; } await new Promise(r => setTimeout(r, 10)); return []; } }; },
  };
  const connect = async () => { calls.connect++; return { call: async (/** @type {string} */ tool, /** @type {any} */ input) => { calls.tools.push(tool); if (tool === "system.info") return { memoryMb: 7900 }; if (tool === "wink.server.setup-offer") { assert.equal(input.identity, "per_abc"); return { qr: "vyre://wink/2?t=" + "x".repeat(22) + "&r=wss%3A%2F%2Frelay.example", expires: 1 }; } throw new Error("no such tool"); }, close: () => { calls.closed++; } }; };
  return { client, connect, calls };
}
const make = (f, extra = {}) => createAddServer({ client: f.client, relay: "ws://x", identity: async () => ({ id: "per_abc" }), connect: f.connect, pair: async qr => { f.calls.paired.push(qr); }, sleep: () => new Promise(r => setTimeout(r, 2)), pollMs: 2, ...extra });

test("the two choices: Records first and the default, then the small server; the line carries the code and the choice, the variables on sh", () => {
  assert.deepEqual(CHOICES.map(c => [c.id, c.label, c.store]), [["records", "With Records", "auto"], ["plain", "Without Records", "sqlite"]]);
  assert.equal(DEFAULT_CHOICE, "records");
  assert.match(CHOICES[0].note, /8 GB.*4 GB/);
  assert.match(CHOICES[1].note, /2 GB/);
  assert.equal(installLine(CODE, "auto"), `curl -fsSL https://vyre.run/i | VYRE_CODE=${CODE} VYRE_STORE=auto sh`);
  assert.equal(installLine(CODE, "sqlite"), `curl -fsSL https://vyre.run/i | VYRE_CODE=${CODE} VYRE_STORE=sqlite sh`);
  assert.equal(installLine(CODE, "anything-else"), `curl -fsSL https://vyre.run/i | VYRE_CODE=${CODE} VYRE_STORE=auto sh`, "only the two values ever reach the line");
  assert.equal(choiceOf("nope").id, "records");
  assert.equal(GAINS.length, 4);
  assert.match(GAINS.join(" "), /sleeps.*phone.*Watchers.*Teammates/);
});

test("memory: said plainly when the server cannot run the choice, and nothing when it can", () => {
  assert.equal(memoryNote("records", 7900), null);
  assert.equal(memoryNote("records", 3900), null, "4 GB is the least");
  assert.match(String(memoryNote("records", 2000)), /start without Records.*Settings/);
  assert.equal(memoryNote("plain", 1990), null);
  assert.match(String(memoryNote("plain", 900)), /2 GB/);
  assert.equal(memoryNote("records", NaN), null);
});

test("add-server: the line is shown first, the offer is found without copying anything back, and NOTHING opens until the words are confirmed", async () => {
  const f = fakes({ after: 3, lines: ["[1/4] Checking Docker"] });
  const a = make(f);
  await a.begin("plain");
  assert.equal(a.state.stage, "install");
  assert.equal(a.state.installLine, installLine(CODE, "sqlite"));
  await until(() => a.state.stage === "found");
  assert.deepEqual(a.state.box && a.state.box.words, ["lantern", "quiet", "river", "oak"]);
  assert.equal(a.state.box && a.state.box.name, "harlow-server");
  await until(() => a.state.lines.length === 1);
  assert.deepEqual(a.state.lines, ["[1/4] Checking Docker"]);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(f.calls.connect, 0, "a sealed offer anyone who saw the code could have made opens nothing");
  await a.confirmWords();
  assert.equal(a.state.stage, "done");
  assert.equal(f.calls.connect, 1);
  assert.deepEqual(f.calls.tools, ["system.info", "wink.server.setup-offer"], "the memory, then the one ticket, for this identity only");
  assert.equal(f.calls.paired.length, 1);
  assert.match(f.calls.paired[0], /^vyre:\/\/wink\/2\?t=/);
  assert.equal(f.calls.closed, 1, "the channel is closed once the ticket is in hand");
  assert.equal(a.state.memoryMb, 7900);
  assert.equal(a.state.note, null);
});

test("add-server: words that do not match stop it with nothing opened; a second confirm does nothing; a contested code and a lapsed hour say so", async () => {
  let f = fakes();
  let a = make(f);
  await a.begin();
  await until(() => a.state.stage === "found");
  a.denyWords();
  assert.equal(a.state.stage, "stopped");
  assert.equal(a.state.error && a.state.error.code, "mismatch");
  await a.confirmWords();
  assert.equal(f.calls.connect, 0, "nothing was opened after a no");

  f = fakes();
  a = make(f);
  await a.begin();
  await until(() => a.state.stage === "found");
  await a.confirmWords();
  await a.confirmWords();
  assert.equal(f.calls.paired.length, 1, "one pairing");

  f = fakes({ contested: true });
  a = make(f);
  await a.begin();
  await until(() => a.state.stage === "stopped");
  assert.equal(a.state.error && a.state.error.message, MESSAGES.contested);

  f = fakes({ after: 1e9 });
  let t = 0;
  a = make(f, { now: () => t, sleep: async () => { t += 61 * 60_000; } });
  await a.begin();
  await until(() => a.state.stage === "stopped");
  assert.equal(a.state.error && a.state.error.code, "expired");
});

test("add-server: a server that cannot make the ticket, or a pairing that fails, says so in words; a small server with Records is told it will start without them", async () => {
  let f = fakes();
  f.connect = async () => ({ call: async (/** @type {string} */ tool) => { if (tool === "system.info") return { memoryMb: 1900 }; throw Object.assign(new Error("This server already belongs to someone."), { code: "owned" }); }, close: () => {} });
  let a = make(f);
  await a.begin("records");
  await until(() => a.state.stage === "found");
  await a.confirmWords();
  assert.equal(a.state.stage, "stopped");
  assert.equal(a.state.error && a.state.error.message, MESSAGES.pair, "never the server's own words");
  assert.match(String(a.state.note), /without Records/, "the memory note was already said");

  f = fakes();
  a = createAddServer({ client: f.client, relay: "ws://x", identity: async () => ({ id: "per_abc" }), connect: f.connect, pair: async () => { throw new Error("no"); }, sleep: () => new Promise(r => setTimeout(r, 2)), pollMs: 2 });
  await a.begin();
  await until(() => a.state.stage === "found");
  await a.confirmWords();
  assert.equal(a.state.error && a.state.error.code, "pair");
});

test("add-server: starting again drops the old run (its offer and its lines never land in the new one)", async () => {
  const f = fakes({ after: 2 });
  const a = make(f);
  await a.begin();
  await a.begin("plain");
  await until(() => a.state.stage === "found");
  assert.equal(a.state.choice, "plain");
  a.stop();
  assert.equal(a.state.stage, "idle");
});
