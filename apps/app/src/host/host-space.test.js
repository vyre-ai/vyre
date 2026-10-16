import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHost } from "./host-core.js";
import { verifyPairCode } from "../../../../lib/pair-code.js";
import { createLoginService } from "../../../../kernel/identity/space-login.js";
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
  const seen = { pairs: [], forgot: [], tickets: [], resolveAs: null, claims: [], calls: [], claimFails: [], joins: [], closed: 0 };
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
    join: async (link, who) => {
      seen.joins.push({ link, who: { id: who.id, name: who.name, hasKey: typeof who.key.sign === "function" } });
      return { card: { space: "juniper.vyre.run", role: "admin", fingerprint_words: "one two three four" }, accept: async () => ({ joined: true, space: "spc_zzzzzzzzzzzz", membership: { role: "admin" } }), close() { seen.closed += 1; } };
    },
    forget: async (box) => { seen.forgot.push(box); },
  };
  return p;
}

async function ready(t, extra = {}) {
  const d = directory(t);
  const store = memoryStore();
  const pp = ports();
  // The directory's list of a username's spaces (the add and remove acts) is answered here; everything else is the real names Worker.
  const posted = [];
  pp.seen.directoryDown = 0;
  const fetchSeen = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname.startsWith("/v1/ids/spaces/")) {
      posted.push({ path: u.pathname, body: JSON.parse(init.body), order: pp.seen.calls.length });
      if (pp.seen.directoryDown > 0) { pp.seen.directoryDown -= 1; return new Response("{}", { status: 503 }); }
      return new Response("{}", { status: 200 });
    }
    // Which space has this chain id: answered here as the names Worker answers it; everything else is the real Worker.
    if (u.pathname === "/v1/ids/resolve" && u.searchParams.get("id") && pp.seen.spaceById) { pp.seen.asked.push(u.searchParams.get("id")); const r = pp.seen.spaceById(u.searchParams.get("id")); return new Response(JSON.stringify(r ? { data: r } : { error: { code: "not_found" } }), { status: r ? 200 : 404 }); }
    return d.fetch(url, init);
  };
  pp.seen.posted = posted;
  pp.seen.asked = [];
  const host = createHost({ store, directory: d.base, fetch: fetchSeen, now: d.now, kdf: FAST, space: { load: async () => pp }, sleep: nap, pollMs: 5, ...extra });
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
  // Then the space is added to this username's list in the directory (so GitHub sign-in finds it), signed by the identity key, after the claim and the vault.
  assert.deepEqual(pp.seen.posted.map((p) => [p.path, p.body.name, p.body.address, p.order]), [["/v1/ids/spaces/add", "alex", "alex-space.vyre.run", 1]]);
  assert.equal(typeof pp.seen.posted[0].body.act.sig, "string");
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
  assert.deepEqual(await host.call("onboard.space.remove", { space: "spc_abcdefghijkl" }), { removed: true, id: "spc_abcdefghijkl", unpublished: true });
  assert.deepEqual(pp.seen.posted.map((p) => p.path), ["/v1/ids/spaces/add", "/v1/ids/spaces/remove"]);
  assert.equal(pp.seen.posted[1].body.address, "alex-space.vyre.run");
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

test("the directory being down after the claim and the vault is tried again on the next poll, without claiming or making the vault twice, and nothing is kept until it takes the space", async (t) => {
  const { pp, host } = await ready(t);
  pp.seen.directoryDown = 2;
  const open = await host.call("onboard.space.open", { kind: "linux", name: "alex-space" });
  pp.seen.resolveAs = "one";
  const retrying = await until(host, open.id, (r) => r.failed);
  assert.equal(retrying.retrying, true);
  assert.equal(retrying.code, "directory");
  assert.deepEqual((await host.call("onboard.space.list")).spaces, [], "nothing is kept while the directory has not taken the space");
  const done = await until(host, open.id, (r) => r.online);
  assert.equal(done.space, "spc_abcdefghijkl");
  assert.equal(pp.seen.claims.length, 1, "the name was claimed once");
  assert.equal(pp.seen.calls.length, 1, "the space vault was made once");
  assert.equal(pp.seen.posted.length, 3, "two refused tries and one that took");
  assert.equal((await host.call("onboard.space.list")).spaces.length, 1);
});

test("removing a space whose directory line cannot be dropped still removes it here and says the line is still there", async (t) => {
  const { pp, host } = await ready(t);
  const open = await host.call("onboard.space.open", { kind: "linux", name: "alex-space" });
  pp.seen.resolveAs = "one";
  await until(host, open.id, (r) => r.online);
  await host.call("identity.lock");
  const r = await host.call("onboard.space.remove", { space: "spc_abcdefghijkl" });
  assert.deepEqual([r.removed, r.unpublished], [true, false]);
  assert.deepEqual(pp.seen.forgot, ["boxA"]);
  assert.deepEqual((await host.call("onboard.space.list")).spaces, []);
});

test("joining a space reads the card, accepts as the identity the page holds, keeps the row and adds the space to the directory's list", async (t) => {
  const { pp, host, made } = await ready(t);
  const link = "https://juniper.vyre.run/join/abcdefgh.ijklmnop";
  const card = await host.call("onboard.join.read", { link });
  assert.deepEqual([card.link, card.role, card.space, card.fingerprint_words], [link, "admin", "juniper", "one two three four"]);
  assert.equal(pp.seen.posted.length, 0, "reading a card lists nothing");
  const joined = await host.call("onboard.space.join", { link });
  assert.deepEqual(joined, { joined: true, space: "juniper", id: "spc_zzzzzzzzzzzz", role: "admin", server: "https://juniper.vyre.run", listed: true });
  assert.equal(pp.seen.joins.length, 1, "the card stream read first is the one accepted");
  assert.deepEqual(pp.seen.joins[0].who, { id: made.id, name: "alex", hasKey: true });
  assert.equal(pp.seen.closed, 1);
  assert.deepEqual(pp.seen.posted.map((p) => [p.path, p.body.name, p.body.address]), [["/v1/ids/spaces/add", "alex", "juniper.vyre.run"]]);
  const list = await host.call("onboard.space.list");
  assert.deepEqual(list.spaces, [{ id: "spc_zzzzzzzzzzzz", name: "juniper", role: "admin", server: "https://juniper.vyre.run" }]);
  assert.equal(list.current, "spc_zzzzzzzzzzzz");
  // The directory being down does not undo the join: the person is a member, and the answer says the list line is not there yet.
  pp.seen.directoryDown = 1;
  const again = await host.call("onboard.space.join", { link });
  assert.equal(again.listed, false);
  assert.equal((await host.call("onboard.space.list")).spaces.length, 1, "the same space is one row");
  await assert.rejects(() => host.call("onboard.join.read", { link: "" }), /does not open a space/);
});

test("the join steps need the unlocked identity and a page that can join; without ports the host does not claim them", async (t) => {
  const { host } = await ready(t);
  await host.call("identity.lock");
  await assert.rejects(() => host.call("onboard.join.read", { link: "https://juniper.vyre.run/join/abcdefgh.ijklmnop" }), (e) => e.code === "locked");
  const bare = createHost({ store: memoryStore(), directory: BASE });
  assert.equal(bare.has("onboard.join.read"), false);
  assert.equal(bare.has("onboard.space.join"), false);
  assert.equal(bare.has("onboard.person.create"), true);
});

const inviteToken = (chain) => `inv_${"ab".repeat(16)}.${Buffer.from(JSON.stringify({ chain: { id: chain, seq: 3, head: "headhead" }, rk: "rk1" })).toString("base64url")}`;

test("the link the owner shares, vyre.run/i/<token>, names no server: the token's chain id finds the space in the directory and the same join path runs; the other form is unchanged", async (t) => {
  const { pp, host, made } = await ready(t);
  const token = inviteToken("chain-of-juniper");
  pp.seen.spaceById = (id) => (id === "chain-of-juniper" ? { kind: "space", id, name: "juniper" } : null);
  const link = `https://vyre.run/i/${token}`;
  const card = await host.call("onboard.join.read", { link });
  assert.deepEqual([card.link, card.space, card.role], [link, "juniper", "admin"]);
  assert.deepEqual(pp.seen.asked, ["chain-of-juniper"]);
  assert.equal(pp.seen.joins[0].link, `https://juniper.vyre.run/join/${token}`, "the join reads the space's own link, which carries the pin the chain is checked against");
  const joined = await host.call("onboard.space.join", { link });
  assert.equal(joined.joined, true);
  assert.equal(joined.space, "juniper");
  assert.equal(pp.seen.joins.length, 1, "the card read first is the one accepted");
  assert.deepEqual(pp.seen.posted.map((p) => p.body.address), ["juniper.vyre.run"]);

  // The <space>.vyre.run/join/<token> form needs no directory question.
  pp.seen.asked.length = 0;
  await host.call("onboard.join.read", { link: `https://juniper.vyre.run/join/${token}` });
  assert.deepEqual(pp.seen.asked, []);
  assert.equal(pp.seen.joins.at(-1).link, `https://juniper.vyre.run/join/${token}`);
  assert.equal(pp.seen.joins.at(-1).who.id, made.id);
});

test("a vyre.run/i link whose space the directory cannot name, names another kind of record, or is not a join token is refused in plain words and nothing is joined", async (t) => {
  const { pp, host } = await ready(t);
  pp.seen.spaceById = (id) => (id === "chain-person" ? { kind: "person", id, name: "juniper" } : id === "chain-wrong" ? { kind: "space", id: "other", name: "juniper" } : null);
  for (const [link, why] of [[`https://vyre.run/i/${inviteToken("chain-unknown")}`, /could not be matched/], [`https://vyre.run/i/${inviteToken("chain-person")}`, /could not be matched/], [`https://vyre.run/i/${inviteToken("chain-wrong")}`, /could not be matched/],
    ["https://vyre.run/i/abcdefghij", /does not say which space/], ["https://vyre.run/x/abcdefghij", /does not open a space/], ["https://evil.example/join/abcdefgh.ijklmnop", /does not open a space/]]) {
    await assert.rejects(() => host.call("onboard.join.read", { link }), why, link);
    await assert.rejects(() => host.call("onboard.space.join", { link }), why, link);
  }
  assert.deepEqual(pp.seen.joins, []);
  assert.deepEqual((await host.call("onboard.space.list")).spaces, []);
  pp.seen.spaceById = () => { throw new Error("down"); };
  await assert.rejects(() => host.call("onboard.join.read", { link: `https://vyre.run/i/${inviteToken("chain-x1234567")}` }));
});

test("a space made here and the same space signed in to from another device are the same row: id, name, role, server", { timeout: 240000 }, async (t) => {
  const d = directory(t);
  const rec = new Map();
  const svc = createLoginService({ space: "alex-space", store: { get: (k) => rec.get(k), set: (k, v) => rec.set(k, v) }, now: d.now, verifyIdentity: async () => true, isMember: async () => true });
  const named = { id: "spc_abcdefghijkl", name: "alex-space", role: "owner", server: "https://alex-space.vyre.run" };
  const fetchAll = async (url, init = {}) => {
    const u = new URL(url);
    if (u.host === "alex-space.vyre.run" && u.pathname === "/login") {
      const body = JSON.parse(init.body);
      const out = body.op === "begin" ? svc.begin(body, "203.0.113.5")
        : body.op === "finish" ? await svc.finish(body, "203.0.113.5").then((r) => (r && r.ok ? { ...r, spaces: [named] } : r))
        : await svc.register(body).catch((e) => ({ error: { code: e.code, message: e.message } }));
      return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u.pathname.startsWith("/v1/ids/spaces/")) return new Response("{}", { status: 200 });
    return d.fetch(url, init);
  };
  // Device one makes the identity at the production cost, creates the space, and registers its sign-in record at it.
  const pp = ports();
  const one = createHost({ store: memoryStore(), directory: d.base, fetch: fetchAll, now: d.now, space: { load: async () => pp }, sleep: nap, pollMs: 5 });
  await one.call("onboard.person.create", { username: "alex", password: PASSWORD, confirm: PASSWORD });
  const open = await one.call("onboard.space.open", { kind: "linux", name: "alex-space" });
  pp.seen.resolveAs = "one";
  await until(one, open.id, (r) => r.online);
  const created = (await one.call("onboard.space.list")).spaces;
  assert.deepEqual(await svc.register(await one.registerLogin("alex-space", PASSWORD)), { ok: true, username: "alex" });

  // Device two has nothing and signs in with the address, the username and the master password.
  const two = createHost({ store: memoryStore(), directory: d.base, fetch: fetchAll, now: d.now });
  await two.call("onboard.signin", { space: "alex-space.vyre.run", username: "alex", password: PASSWORD });
  const signed = (await two.call("onboard.space.list")).spaces;

  assert.equal(created.length, 1);
  assert.deepEqual(signed, created, "the same row, whichever way the space got onto the device");
  for (const row of [created[0], signed[0]]) {
    assert.deepEqual(Object.keys(row).sort(), ["id", "name", "role", "server"]);
    assert.match(row.id, /^spc_[a-z2-7]{8,}$/);
    assert.equal(row.server, `https://${row.name}.vyre.run`);
  }
});
