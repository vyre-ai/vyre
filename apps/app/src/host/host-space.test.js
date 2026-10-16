import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHost } from "./host-core.js";
import { verifyPairCode } from "../../../../lib/pair-code.js";
import { commandOk } from "../../../../lib/first-run-shape.js";
import { world, BASE } from "../../../../names/worker/testing.js";
import worker from "../../../../names/worker/index.js";

const FAST = { memoryKiB: 64, passes: 2 };
const PASSWORD = "correct horse battery staple";
const nap = () => new Promise((r) => setTimeout(r, 5));

function directory(t) {
  const w = world(t);
  const fetchIn = async (url, init = {}) => {
    const u = new URL(url);
    const headers = new Headers(init.headers || {});
    headers.set("cf-connecting-ip", "203.0.113.9");
    return worker.fetch(new Request(`${BASE}${u.pathname}${u.search}`, { method: init.method || "GET", headers, body: init.body }), w.env);
  };
  return { fetch: fetchIn, base: BASE, now: () => w.clock.t, clock: w.clock };
}

const memoryStore = () => { let kept = null; return { load: async () => (kept ? structuredClone(kept) : null), save: async (k) => { kept = structuredClone(k); }, peek: () => kept }; };

/** The relay, the setup channel and the pairing as a test drives them: a server that answers the line when `serverUp` is set, and one pairing the page makes. */
function ports() {
  const seen = { pairs: [], forgot: [], tickets: [], resolveAs: null, claims: [], calls: [], claimFails: [] };
  const offer = { relay: "wss://relay.example", route: "r".repeat(26), box: new Uint8Array(32) };
  const p = {
    seen,
    client: {
      resolveSetup: async () => {
        if (!seen.resolveAs) throw Object.assign(new Error("no offer yet"), { code: "not_found" });
        if (seen.resolveAs === "contested") throw Object.assign(new Error("two"), { code: "contested" });
        return { offer, name: "alex-space.vyre.run", fingerprint: "ab".repeat(8) };
      },
      mailboxReader: async () => ({ next: async () => { await nap(); return ["Installing Vyre"]; } }),
      setupWords: async () => [],
    },
    relay: "wss://relay.example",
    connect: async () => ({ call: async (tool) => (tool === "wink.server.setup-offer" ? { qr: "vyre://wink/2?t=AAAAAAAAAAAAAAAAAAAAAA&r=wss%3A%2F%2Frelay.example" } : {}), close() {} }),
    pair: async (qr, ctx, who) => {
      seen.pairs.push({ qr, who: { id: who.id, name: who.name, hasKey: typeof who.key.sign === "function" } });
      return { box: "boxA", route: offer.route, relay: offer.relay, name: "alex-space.vyre.run" };
    },
    claim: async (who, o) => {
      seen.claims.push({ who: { id: who.id, name: who.name, hasOps: Array.isArray(who.ops) && who.ops.length > 0, hasKey: typeof who.key.sign === "function" }, name: o.name, box: o.route.box });
      const fail = seen.claimFails.shift();
      if (fail) throw Object.assign(new Error("That name is taken. Pick another."), { code: fail });
      return "spc_abcdefghijkl";
    },
    call: async (name, input, box) => { seen.calls.push({ name, input, box }); return {}; },
    forget: async (box) => { seen.forgot.push(box); },
  };
  return p;
}

async function ready(t, extra = {}) {
  const d = directory(t);
  const store = memoryStore();
  const pp = ports();
  const host = createHost({ store, directory: d.base, fetch: d.fetch, now: d.now, kdf: FAST, space: { load: async () => pp }, sleep: nap, pollMs: 5, ...extra });
  const made = await host.call("onboard.person.create", { username: "alex", password: PASSWORD, confirm: PASSWORD });
  return { d, store, pp, host, made };
}

async function until(host, id, want) {
  for (let i = 0; i < 400; i++) { const r = await host.call("onboard.space.poll", { id }); if (want(r)) return r; await nap(); }
  throw new Error("the page never reached the state it was waiting for");
}

test("create a space from a page: the line carries a code the server's own check accepts for this person, the server is found and paired, and the page names it", async (t) => {
  const { store, pp, host, made } = await ready(t);
  assert.equal(host.has("onboard.space.open"), true);
  const open = await host.call("onboard.space.open", { kind: "linux", name: "alex-space" });
  assert.equal(commandOk(open.command), true);
  assert.equal(open.role, "owner");
  assert.equal(open.spaceId, "spc_alex-space");
  const code = /VYRE_CODE=([A-Za-z0-9_-]{239}) /.exec(open.command)[1];
  // The daemon's verify (lib/pair-code.js) takes what the page minted: signed by the identity key, naming the identity chain's id.
  const checked = verifyPairCode(code, () => Date.parse(open.expiresAt) - 60_000);
  assert.equal(checked.ok, true);
  assert.equal(checked.person, made.id);
  assert.ok(!JSON.stringify(store.peek()).includes(code), "the install code is never kept");

  const waiting = await host.call("onboard.space.poll", { id: open.id });
  assert.equal(waiting.online, false);
  assert.equal(pp.seen.pairs.length, 0, "nothing is paired before a server answers the line");

  pp.seen.resolveAs = "one";
  const done = await until(host, open.id, (r) => r.online);
  assert.equal(done.server.name, "alex-space.vyre.run");
  assert.deepEqual([done.server.hostname, done.server.address, done.server.space], ["alex-space.vyre.run", "https://alex-space.vyre.run", "alex-space"]);
  assert.equal(done.canRemove, true);
  assert.equal(done.space, "spc_abcdefghijkl");
  assert.equal(done.server.space, "alex-space");
  // The space is made usable: the directory claim is signed by this identity through the paired server, then the space vault is made on that server.
  assert.deepEqual(pp.seen.claims, [{ who: { id: made.id, name: "alex", hasOps: true, hasKey: true }, name: "alex-space", box: "boxA" }]);
  assert.deepEqual(pp.seen.calls, [{ name: "vault.space.create", input: { space: "spc_abcdefghijkl" }, box: "boxA" }]);
  assert.equal(pp.seen.pairs.length, 1);
  assert.deepEqual(pp.seen.pairs[0].who, { id: made.id, name: "alex", hasKey: true });

  const list = await host.call("onboard.space.list");
  assert.deepEqual(list.spaces, [{ id: "spc_abcdefghijkl", name: "alex-space", role: "owner", server: "https://alex-space.vyre.run" }]);
  assert.equal(list.current, "spc_abcdefghijkl");
  assert.equal(list.id, made.id);
  // A page that reads the list again finds the same single row, and polling twice keeps one.
  await host.call("onboard.space.poll", { id: open.id });
  assert.equal((await host.call("onboard.space.list")).spaces.length, 1);
  assert.deepEqual(Object.keys(store.peek().spaces[0].paired).sort(), ["box", "name", "relay", "route"]);
});

test("two servers answering one line is a hard stop: nothing is paired, the page says so, and only a new line goes on", async (t) => {
  const { pp, host } = await ready(t);
  const first = await host.call("onboard.space.open", { kind: "mac", name: "alex-space" });
  pp.seen.resolveAs = "contested";
  const stopped = await until(host, first.id, (r) => r.contested);
  assert.equal(stopped.online, false);
  assert.match(stopped.message, /Two servers used this line/);
  assert.equal(pp.seen.pairs.length, 0);
  pp.seen.resolveAs = "one";
  await nap(); await nap();
  assert.equal((await host.call("onboard.space.poll", { id: first.id })).contested, true, "the contested line stays stopped even if one server answers later");
  assert.equal(pp.seen.pairs.length, 0);
  assert.deepEqual((await host.call("onboard.space.list")).spaces, []);
  const second = await host.call("onboard.space.open", { kind: "mac", name: "alex-space" });
  assert.notEqual(second.command, first.command);
  await until(host, second.id, (r) => r.online);
  assert.equal(pp.seen.pairs.length, 1);
});

test("Not your server? Remove it forgets the pairing and the space; a line that runs out says so", async (t) => {
  const { d, pp, host } = await ready(t);
  const open = await host.call("onboard.space.open", { kind: "linux", name: "alex-space" });
  pp.seen.resolveAs = "one";
  await until(host, open.id, (r) => r.online);
  await assert.rejects(() => host.call("onboard.space.remove", { space: "spc_nobody" }), /not one this identity belongs to/);
  assert.deepEqual(await host.call("onboard.space.remove", { space: "spc_abcdefghijkl" }), { removed: true, id: "spc_abcdefghijkl" });
  assert.deepEqual(pp.seen.forgot, ["boxA"]);
  assert.deepEqual((await host.call("onboard.space.list")).spaces, []);

  pp.seen.resolveAs = null;
  const later = await host.call("onboard.space.open", { kind: "linux", name: "second" });
  d.clock.t += 31 * 60 * 1000;
  const out = await until(host, later.id, (r) => r.expired);
  assert.match(out.message, /install window ended/);
  assert.equal(pp.seen.pairs.length, 1);
});

test("the space steps need the identity unlocked, and locking stops a line that is waiting", async (t) => {
  const { pp, host } = await ready(t);
  const open = await host.call("onboard.space.open", { kind: "linux", name: "alex-space" });
  await host.call("identity.lock");
  pp.seen.resolveAs = "one";
  await nap(); await nap(); await nap();
  assert.equal(pp.seen.pairs.length, 0, "a locked page pairs nothing");
  await assert.rejects(() => host.call("onboard.space.open", { kind: "linux" }), (e) => e.code === "locked");
  await assert.rejects(() => host.call("onboard.space.open", { kind: "windows" }), (e) => e.code === "locked");
  await host.call("identity.unlock", { password: PASSWORD });
  await assert.rejects(() => host.call("onboard.space.open", { kind: "windows" }), /Linux server or an always-on Mac/);
  assert.equal((await host.call("onboard.space.poll", { id: open.id })).online, false);
});

test("a name the directory refuses leaves the server paired and unnamed: the page says so, offers another name or removal, and a second name finishes the space", async (t) => {
  const { pp, host } = await ready(t);
  pp.seen.claimFails.push("taken");
  const open = await host.call("onboard.space.open", { kind: "linux", name: "alex-space" });
  pp.seen.resolveAs = "one";
  const failed = await until(host, open.id, (r) => r.failed);
  assert.equal(failed.canRename, true);
  assert.equal(failed.canRemove, true);
  assert.equal(failed.online, false);
  assert.deepEqual((await host.call("onboard.space.list")).spaces, [], "no space is kept for a name the directory refused");
  assert.equal(pp.seen.calls.length, 0, "no space vault is made for a space that was not claimed");
  await assert.rejects(() => host.call("onboard.space.name", { id: open.id, name: "x" }), /3 to 20/);
  await host.call("onboard.space.name", { id: open.id, name: "alex-two" });
  const done = await until(host, open.id, (r) => r.online);
  assert.equal(done.server.space, "alex-two");
  assert.equal(pp.seen.claims.length, 2);
  assert.equal(pp.seen.pairs.length, 1, "the server was paired once");
  assert.equal((await host.call("onboard.space.list")).spaces[0].name, "alex-two");
});

test("a vault that already exists on the server is fine; any other vault refusal fails the poll and keeps nothing", async (t) => {
  const { pp, host } = await ready(t);
  pp.call = async () => { throw Object.assign(new Error("exists"), { code: "exists" }); };
  const open = await host.call("onboard.space.open", { kind: "linux", name: "alex-space" });
  pp.seen.resolveAs = "one";
  assert.equal((await until(host, open.id, (r) => r.online)).space, "spc_abcdefghijkl");
  const two = await ready(t);
  two.pp.call = async () => { throw Object.assign(new Error("The server could not make the vault."), { code: "unavailable" }); };
  const o2 = await two.host.call("onboard.space.open", { kind: "linux", name: "alex-space" });
  two.pp.seen.resolveAs = "one";
  const bad = await until(two.host, o2.id, (r) => r.failed);
  assert.equal(bad.code, "unavailable");
  assert.deepEqual((await two.host.call("onboard.space.list")).spaces, []);
});
