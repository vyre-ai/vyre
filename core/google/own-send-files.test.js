// @ts-check
// A member's own send from the firm key, with files (mail6's attachments joined with the own-send path): the files go by reference, are read as the member at the hold (the Drive judges them), and are read
// again at send only after the person who asked is asked once more whether they may read them, and checked against the hash. A file the member may not read stops the message before anything is sent; an agent's
// send with files is held with the references, never the bytes. Against the fake Google, with a stand-in for the kernel's Drive and its person check.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import mod from "./index.js";
import { startFakeGoogle } from "../../lib/connectors/testing/fake-google.js";
import { allowLoopbackForTests } from "../../lib/http.js";
allowLoopbackForTests();

const BYTES = Buffer.from("%PDF-1.4 fixture refund letter for Dana");
const OTHER = Buffer.from("%PDF-1.4 fixture partner memo, not Alice's");

async function setup(t) {
  const fake = await startFakeGoogle(t, { users: ["alice@firm.test", "owner@firm.test"] });
  const db = new DatabaseSync(":memory:");
  const tools = new Map(), events = [], gate = [];
  const files = new Map([["Clients/refund.pdf", BYTES], ["Partners/memo.pdf", OTHER]]);
  const mayRead = new Map([["p-alice", new Set(["Clients/refund.pdf"])]]);
  const personOf = chain => (chain.hops || []).find(h => h.actor.kind === "person")?.actor.id;
  const ctx = {
    store: { db, migrate: ms => { for (const m of ms) db.exec(m); } },
    vault: { fetch: async item => { if (item === "firm-sa") return fake.serviceAccount("owner@firm.test"); throw new Error("no such item"); } },
    tool: (n, d) => tools.set(n, d), events: { emit: (...a) => events.push(a) }, log() {},
    call: async (tool, input) => {
      if (tool === "gate.request") { gate.push(input); return { data: { id: "h" + gate.length } }; }
      // the Gate's record of a held item, with the person the Gate recorded as its requester
      if (tool === "gate.get") { const i = Number(String(input.id).slice(1)) - 1; return gate[i] ? { data: { id: input.id, via: gate[i].via, requester: "p-alice", state: "sending" } } : { error: { code: "not_found", message: "none" } }; }
      return { data: {} };
    },
    kernel: {
      owner: "p-owner", space: "spc_x",
      chain: async meta => ({ hops: (meta.hops || []).map(id => ({ actor: { kind: String(id).startsWith("agent:") ? "agent" : "person", id } })) }),
      serviceChain: () => ({ svc: true, hops: [] }),
      drive: { get: async (chain, p) => { if (!chain.svc && !(mayRead.get(personOf(chain)) || new Set()).has(p)) throw Object.assign(new Error("denied"), { code: "denied" }); const b = files.get(p); if (!b) throw new Error("gone"); return b; } },
      personMay: async (person, action, urn) => action === "drive.read" && (mayRead.get(person) || new Set()).has(String(urn).split("/file/")[1]),
    },
  };
  await mod.start(ctx);
  const run = (name, input, hops) => tools.get(name).run(input, { token: "t", caller: hops.some(h => String(h).startsWith("agent:")) ? "mcp:agent:kit" : "cli", hops });
  await run("google.add", { name: "firm", email: "owner@firm.test", firm: true, domain: "firm.test", auth: { type: "service-account", item: "firm-sa", subject: "owner@firm.test" }, base: fake.base }, ["p-owner"]);
  await run("google.members.email", { person: "p-alice", email: "alice@firm.test" }, ["p-owner"]);
  return { fake, run, tools, gate, events, mayRead, files };
}
const MAIL = { to: ["dana@harlow.example"], subject: "Refund R-9", body: "Dana, the letter is attached." };

test("a member's own send with a file goes out at once with the file's bytes, from the member's own mailbox", async t => {
  const s = await setup(t);
  const out = await s.run("google.mail.send", { ...MAIL, attachments: [{ path: "Clients/refund.pdf", name: "refund.pdf" }] }, ["p-alice"]);
  assert.ok(!out.held, JSON.stringify(out));
  const sent = s.fake.mail.sent;
  assert.equal(sent.length, 1);
  const wire = Buffer.from(sent[0].raw, "base64url").toString("utf8");
  assert.match(wire, /filename="?refund\.pdf"?/);
  assert.ok(wire.replace(/\s+/g, "").includes(BYTES.toString("base64")), "the file's bytes are in the message");
  assert.equal(s.fake.apiCalls().filter(c => c.path.startsWith("/gmail/")).every(c => c.subject === "alice@firm.test"), true, "every Gmail call was made as Alice");
  assert.equal(s.gate.length, 0, "nothing went to the Gate: it is her own send");
});

test("a file the member may not read stops the message before anything is sent, whatever name she gives it", async t => {
  const s = await setup(t);
  await assert.rejects(s.run("google.mail.send", { ...MAIL, attachments: [{ path: "Partners/memo.pdf", name: "refund.pdf" }] }, ["p-alice"]), e => e.code === "denied" || /denied|read/.test(e.message));
  assert.equal(s.fake.mail.sent.length, 0);
  assert.equal(s.gate.length, 0);
  for (const path of ["../Partners/memo.pdf", "/etc/passwd", "Clients/../Partners/memo.pdf"]) await assert.rejects(s.run("google.mail.send", { ...MAIL, attachments: [{ path }] }, ["p-alice"]), e => e.code === "bad_input", path);
  assert.equal(s.fake.mail.sent.length, 0);
});

test("a file that changed between the hold and the send is not sent, and neither is one the member can no longer read", async t => {
  const s = await setup(t);
  // the hold and the send are the same call for her own send, so interleave by changing the file the moment the Drive is asked for the second time (the send's read)
  let reads = 0; const real = s.files.get("Clients/refund.pdf");
  s.files.get = function (p) { if (p === "Clients/refund.pdf" && ++reads > 1) return Buffer.from("%PDF changed after the hold"); return Map.prototype.get.call(this, p); };
  await assert.rejects(s.run("google.mail.send", { ...MAIL, attachments: [{ path: "Clients/refund.pdf" }] }, ["p-alice"]), e => e.code === "changed" || /changed/.test(e.message));
  assert.equal(s.fake.mail.sent.length, 0);
  s.files.get = Map.prototype.get; void real;
  s.mayRead.set("p-alice", new Set());
  await assert.rejects(s.run("google.mail.send", { ...MAIL, attachments: [{ path: "Clients/refund.pdf" }] }, ["p-alice"]), e => e.code === "denied" || /denied|read/.test(e.message));
  assert.equal(s.fake.mail.sent.length, 0);
});

test("an agent's send with a file in a member's turn is held with the file by reference: path, name, size, hash and who asked, never the bytes", async t => {
  const s = await setup(t);
  const out = await s.run("google.mail.send", { ...MAIL, attachments: [{ path: "Clients/refund.pdf", name: "refund.pdf" }] }, ["p-alice", "agent:kit"]);
  assert.equal(out.held, "h1", JSON.stringify(out));
  assert.equal(s.fake.mail.sent.length, 0);
  const item = s.gate[0];
  assert.equal(item.via, "google-firm:firm");
  assert.equal(item.content.from, "alice@firm.test");
  assert.deepEqual(item.content.attachments.map(a => [a.path, a.name, a.size, a.by]), [["Clients/refund.pdf", "refund.pdf", BYTES.length, "p-alice"]]);
  assert.equal(item.content.attachments[0].sha256.length, 64);
  assert.ok(!JSON.stringify(item).includes(BYTES.toString("base64")) && !JSON.stringify(item).includes("fixture refund letter"), "the bytes are not in the held message");
});

test("the held agent send is checked again when the Gate releases it: it goes out with the file's bytes if the asker may still read it and the file is the same; not if access was lost or the bytes changed", async t => {
  const s = await setup(t);
  const hold = async () => { const out = await s.run("google.mail.send", { ...MAIL, attachments: [{ path: "Clients/refund.pdf", name: "refund.pdf" }] }, ["p-alice", "agent:kit"]); return { id: out.held, item: s.gate[s.gate.length - 1] }; };
  const asGate = (h) => s.tools.get("google.release").run({ id: h.id, to: h.item.to, content: h.item.content }, { caller: "module:gate", token: "t", hops: ["p-alice"] });
  // released as approved: the bytes are read (the stored item's `by`, not the caller) and sent from Alice's mailbox
  const a = await hold();
  await asGate(a);
  assert.equal(s.fake.mail.sent.length, 1);
  assert.ok(Buffer.from(s.fake.mail.sent[0].raw, "base64url").toString("utf8").replace(/\s+/g, "").includes(BYTES.toString("base64")));
  // the asker loses access after the hold: denied, nothing sent
  const b = await hold();
  s.mayRead.set("p-alice", new Set());
  await assert.rejects(asGate(b), e => e.code === "denied");
  assert.equal(s.fake.mail.sent.length, 1);
  s.mayRead.set("p-alice", new Set(["Clients/refund.pdf"]));
  // the bytes change after the hold: changed, nothing sent
  const c = await hold();
  s.files.set("Clients/refund.pdf", Buffer.from("%PDF the letter was edited after the hold"));
  await assert.rejects(asGate(c), e => e.code === "changed");
  assert.equal(s.fake.mail.sent.length, 1);
  // only the Gate releases
  await assert.rejects(s.tools.get("google.release").run({ id: c.id, to: c.item.to, content: c.item.content }, { caller: "cli", token: "t", hops: ["p-alice"] }), e => e.code === "denied");
});
