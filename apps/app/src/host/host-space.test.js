import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHost } from "./host-core.js";
import { verifyPairCode } from "../../../../lib/pair-code.js";
import { createLoginService } from "../../../../kernel/identity/space-login.js";
import { commandOk } from "../../../../lib/first-run-shape.js";
import { mintPairCode } from "../../../../relay/client/pair-install.js";
import { createSetupKey, setupFingerprint } from "../../../../relay/client/setup.js";
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
    mintPairCode, createSetupKey, setupFingerprint,
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
    if (u.pathname === "/v1/ids/server") pp.seen.listed.push(JSON.parse(init.body));
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
  pp.seen.listed = [];
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

test("the last step of Make a new Space keeps the row with its pairing, selects it, and signs the server listing at once (not at the next repair); a copy of the record from before the claim is never written back over what was kept meanwhile", async (t) => {
  const { store, pp, host } = await ready(t);
  await host.call("identity.lock");
  await host.call("identity.unlock", { password: PASSWORD });
  const open = await host.call("onboard.space.open", { kind: "linux", name: "alex-space" });
  pp.seen.resolveAs = "one";
  // something else keeps a change to the record while the claim runs (the record the poll started from is then out of date)
  const origClaim = pp.claim;
  pp.claim = async (...a) => { const k = store.peek(); await store.save({ ...k, display: "Alex Rivera" }); return origClaim(...a); };
  await until(host, open.id, (r) => r.online);
  for (let i = 0; i < 100 && !pp.seen.listed.length; i++) await nap();
  const kept = store.peek();
  assert.equal(kept.display, "Alex Rivera", "what was kept while the claim ran is still there");
  assert.equal(kept.current, "spc_abcdefghijkl");
  assert.equal(kept.spaces.length, 1);
  assert.equal(kept.spaces[0].paired.box, "boxA");
  assert.equal(pp.seen.listed.length >= 1, true, "the owner's signed server-add was sent right after the Space was kept");
  assert.equal(pp.seen.listed[0].name, "alex-space");
  assert.equal(pp.seen.listed[0].route, "r".repeat(26));
  assert.equal(pp.seen.listed[0].act.action ?? "server-add", "server-add");
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
  // A space is named by the person: leaving the name empty must not default to a shared label (the first person in the world would hold it and everyone after be told "taken").
  for (const name of [undefined, "", "  ", "ab", "Not Valid!"]) await assert.rejects(() => host.call("onboard.space.open", { kind: "linux", ...(name === undefined ? {} : { name }) }), (e) => e.code === "bad_input" && /Name your space/.test(e.message), String(name));
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

  // Device two has nothing and signs in with the address, the username and the password.
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

test("a slow claim is not started twice: polls that arrive while it runs share its answer and the name is claimed once", async (t) => {
  const { pp, host } = await ready(t);
  let release = () => {};
  const gate = new Promise((r) => { release = r; });
  const claim = pp.claim;
  pp.claim = async (who, o) => { await gate; return claim(who, o); };
  const open = await host.call("onboard.space.open", { kind: "linux", name: "alex-space" });
  pp.seen.resolveAs = "one";
  // three screens' worth of asking at once while the claim is held; the claim is let go a moment after the server is paired
  const timer = setTimeout(release, 400);
  try {
    const done = await Promise.all([1, 2, 3].map(() => until(host, open.id, (r) => r.online)));
    assert.ok(done.every((r) => r.online));
  } finally { clearTimeout(timer); release(); }
  assert.equal(pp.seen.claims.length, 1, "the name was claimed once");
});

test("a server that asks for the person's approval before it makes the space vault does not stop the space: it is online, and the answer says the vault is waiting", async (t) => {
  const { pp, host } = await ready(t);
  pp.call = async () => { throw Object.assign(new Error("Approve this."), { code: "presence_required" }); };
  const open = await host.call("onboard.space.open", { kind: "linux", name: "alex-space" });
  pp.seen.resolveAs = "one";
  const done = await until(host, open.id, (r) => r.online || r.failed);
  assert.equal(done.online, true);
  assert.equal(done.vaultPending, true);
  assert.equal((await host.call("onboard.space.list")).spaces.length, 1);
});

test("a page with no daemon offers the AI sign-in once its space is online, and forwards it to the paired server without anything secret coming back", async (t) => {
  const { pp, host, store } = await ready(t);
  // an identity that already has another paired server, listed first: the sign-in must go to the one made now
  assert.deepEqual((await host.call("onboard.agent.list", {})).providers.map((p) => p.id), ["claude", "codex", "grok"]);
  await assert.rejects(() => host.call("onboard.agent.signin", { provider: "claude", label: "Claude" }), (e) => e.code === "no_server", "no server yet, no sign-in");
  { const k = await store.load(); await store.save({ ...k, spaces: [{ id: "spc_zzzzzzzzzzzz", name: "older", role: "owner", server: null, paired: { box: "boxOLD", route: "r", relay: "x" } }] }); }
  const open = await host.call("onboard.space.open", { kind: "linux", name: "alex-space" });
  pp.seen.resolveAs = "one";
  await until(host, open.id, (r) => r.online);
  const first = pp.call;
  pp.call = async (name, input, box) => { if (name === "sessions.accounts.signin") { pp.seen.calls.push({ name, input, box }); return { flow: "fl_1", step: "code", url: "https://login.example/x", code: "ABCD", token: "SECRET-TOKEN", apiKey: "SECRET-KEY", internal: { vault: "path" }, debug: "server detail", account: "ac_1", error: { code: "x", message: "m", stack: "S" } }; } return first(name, input, box); };
  await assert.rejects(() => host.call("onboard.agent.signin", { provider: "mystery" }), (e) => /does not support/.test(e.message));
  const r = await host.call("onboard.agent.signin", { provider: "claude", label: "Claude" });
  assert.deepEqual([r.flow, r.url, r.code], ["fl_1", "https://login.example/x", "ABCD"]);
  assert.ok(!("token" in r) && !("apiKey" in r) && !("internal" in r) && !("debug" in r), "only the allowed fields come back");
  assert.deepEqual(Object.keys(r).sort(), ["account", "code", "error", "flow", "step", "url"], "the allow-list");
  assert.deepEqual(r.error, { code: "x", message: "m" }, "an error is its code and message only");
  const sent = pp.seen.calls.filter((c) => c.name === "sessions.accounts.signin").pop();
  assert.deepEqual([sent.box, sent.input.provider, sent.input.label], ["boxA", "claude", "Claude"], "it goes to the server this onboarding made, not the older one listed first");
});

test("the Assistant step names the Assistant and keeps its look on the server this onboarding made, and refuses a name or a look it should not take", async (t) => {
  const { pp, host } = await ready(t);
  await assert.rejects(() => host.call("onboard.assistant.set", { name: "Juno", look: "s1~c2" }), (e) => e.code === "no_server", "no server yet, no Assistant");
  const open = await host.call("onboard.space.open", { kind: "linux", name: "alex-space" });
  pp.seen.resolveAs = "one";
  await until(host, open.id, (r) => r.online);
  const first = pp.call;
  pp.call = async (name, input, box) => {
    if (name === "onboard.you" || name === "onboard.assistant" || name === "agents.update") {
      pp.seen.calls.push({ name, input, box });
      return name === "onboard.assistant" ? { name: "juno", display: "Juno", made: true, why: null, token: "SECRET" } : { ok: true };
    }
    return first(name, input, box);
  };
  await assert.rejects(() => host.call("onboard.assistant.set", { name: "", look: "s1~c2" }), (e) => e.code === "bad_name");
  await assert.rejects(() => host.call("onboard.assistant.set", { name: "x".repeat(41), look: "s1~c2" }), (e) => e.code === "bad_name");
  await assert.rejects(() => host.call("onboard.assistant.set", { name: "Juno", look: "<script>" }), (e) => e.code === "bad_look");
  const look = "s3~c5~e1~m2~t4~b1~h0";
  const r = await host.call("onboard.assistant.set", { name: "Juno", look, person: "Proof Walker" });
  assert.deepEqual(r, { name: "juno", display: "Juno", look }, "only the name, the display name and the look come back");
  const sent = pp.seen.calls.filter((c) => ["onboard.you", "onboard.assistant", "agents.update"].includes(c.name));
  assert.deepEqual(sent.map((c) => c.name), ["onboard.you", "onboard.assistant", "agents.update"], "named, made, then its look kept");
  assert.ok(sent.every((c) => c.box === "boxA"), "all three go to the server this onboarding made");
  assert.equal(sent[0].input.assistant, "Juno");
  assert.equal(sent[0].input.name, "Proof Walker", "the name the person gave is the one the server shows");
  assert.deepEqual(sent[2].input, { name: "juno", look });
});

test("a tool that writes the Assistant never lands on the current space's server when none was made in this run and several are paired", async (t) => {
  const { pp, host, store } = await ready(t);
  { const k = await store.load(); await store.save({ ...k, current: "spc_aaaaaaaaaaaa", spaces: [
    { id: "spc_aaaaaaaaaaaa", name: "team", role: "member", server: null, paired: { box: "boxTEAM", route: "r", relay: "x" } },
    { id: "spc_bbbbbbbbbbbb", name: "older", role: "owner", server: null, paired: { box: "boxOLD", route: "r", relay: "x" } }] }); }
  const sent = [];
  const first = pp.call;
  pp.call = async (name, input, box) => { sent.push({ name, box }); return first(name, input, box); };
  for (const [tool, input] of [["onboard.assistant.set", { name: "Juno", look: "s1~c2" }], ["onboard.assistant.models", {}], ["onboard.assistant.model", { model: "opus" }]]) {
    await assert.rejects(() => host.call(tool, input), (e) => e.code === "no_server", tool);
  }
  assert.deepEqual(sent, [], "nothing was sent to either server");
});

test("the API key tool sends the key once to the server's key tool and never lets it out: not in what it returns, not in what it throws, only the owner adds one, and only the one allowed address is accepted", async (t) => {
  const { pp, host, store } = await ready(t);
  const KEY = "sk-ant-RECOGNISABLE-KEY-0123456789";
  await assert.rejects(() => host.call("onboard.agent.key", { kind: "anthropic-compatible", key: KEY, label: "Work" }), (e) => e.code === "no_server");
  const open = await host.call("onboard.space.open", { kind: "linux", name: "alex-space" });
  pp.seen.resolveAs = "one";
  await until(host, open.id, (r) => r.online);
  const first = pp.call;
  const sent = [];
  let mode = "ok";
  pp.call = async (name, input, box) => {
    if (name === "sessions.accounts.key") {
      sent.push({ name, input, box });
      if (mode === "echo") throw Object.assign(new Error(`the service refused the key ${input.key} at https://api.anthropic.com`), { code: "bad_input" });
      return { account: "ac_9", provider: "claude", label: input.label, checked: true, host: "api.anthropic.com", secret: input.key };
    }
    return first(name, input, box);
  };
  // the key never comes back, and the server gets the name for its Vault item
  const r = await host.call("onboard.agent.key", { kind: "anthropic-compatible", key: KEY, label: "Work Claude" });
  assert.deepEqual(r, { account: "ac_9", provider: "claude", label: "Work Claude", checked: true });
  assert.ok(!JSON.stringify(r).includes(KEY));
  assert.deepEqual([sent[0].box, sent[0].input.name, sent[0].input.label, sent[0].input.kind], ["boxA", "Work Claude", "Work Claude", "anthropic-compatible"]);
  // the app names no model: the server keeps an OpenRouter account with its default (core/sessions/account-model.js)
  await host.call("onboard.agent.key", { kind: "openrouter", key: KEY, label: "OpenRouter key" });
  assert.equal(sent[1].input.model, undefined);
  // an error that echoes the key is thrown without it
  mode = "echo";
  await assert.rejects(() => host.call("onboard.agent.key", { kind: "anthropic-compatible", key: KEY, label: "Work Claude" }), (e) => { assert.ok(!String(e.message).includes(KEY), "the thrown words carry no key"); assert.equal(e.code, "bad_input"); return true; });
  mode = "ok";
  await assert.rejects(() => host.call("onboard.agent.key", { kind: "opencode", key: KEY, label: "OpenCode", base_url: "https://evil.example/v1" }), (e) => e.code === "bad_address");
  // other addresses, kinds, keys and names are refused with nothing sent
  sent.length = 0;
  for (const bad of [{ kind: "anthropic-compatible", base_url: "https://evil.example/v1" }, { kind: "openai-compatible", base_url: "https://evil.example/v1" }, { kind: "openrouter", base_url: "https://api.x.ai/v1" }, { kind: "mystery" }, { kind: "openrouter", key: "short" }, { kind: "openrouter", label: "" }]) {
    await assert.rejects(() => host.call("onboard.agent.key", { kind: "openrouter", key: KEY, label: "Work", ...bad }), (e) => e.code === "bad_address" || e.code === "bad_kind" || e.code === "bad_key" || e.code === "bad_name");
  }
  const ok = await host.call("onboard.agent.key", { kind: "openai-compatible", key: "xai-0123456789abcdef", label: "Grok", base_url: "https://api.x.ai/v1" });
  assert.equal(ok.account, "ac_9");
  assert.equal(sent.length, 1, "only the allowed address went to the server");
  // a member of the space does not put the key in the owner's Vault: without a member-key store the tool says it is not available, and nothing is sent
  sent.length = 0;
  { const k = await store.load(); await store.save({ ...k, spaces: (k.spaces || []).map((x) => ({ ...x, role: "member" })) }); }
  await assert.rejects(() => host.call("onboard.agent.key", { kind: "anthropic-compatible", key: KEY, label: "Work" }), (e) => e.code === "ask_owner");
  assert.deepEqual(sent, [], "nothing was sent for a member");
});

test("a joining member's key goes to their own Vault in one act: checked with its provider first, the password asked for only when their vault is missing or locked, and neither the key nor the password is in anything returned or thrown", async (t) => {
  const keys = new Map();
  const { pp, host, store } = await ready(t, { memberKeyPath: true, memberKeys: { get: async (a) => keys.get(a) ?? null, put: async (a, k) => void keys.set(a, k), remove: async (a) => void keys.delete(a) } });
  const KEY = "sk-ant-MEMBER-KEY-0123456789", PW = "member pass phrase 77";
  const open = await host.call("onboard.space.open", { kind: "linux", name: "alex-space" });
  pp.seen.resolveAs = "one";
  await until(host, open.id, (r) => r.online);
  { const k = await store.load(); await store.save({ ...k, spaces: (k.spaces || []).map((x) => ({ ...x, role: "member" })) }); }
  const first = pp.call;
  const calls = [];
  let vault = { account: false, unlocked: false }, fail = "", badKey = false, halfDone = false;
  pp.call = async (name, input, box) => {
    if (!/^(vault\.me\.|sessions\.accounts\.(add|key))/.test(name)) return first(name, input, box);
    const copy = JSON.parse(JSON.stringify(input || {})); const space = copy.space; delete copy.space;
    calls.push({ name, input: copy, box, space });
    if (name === "sessions.accounts.key") { if (badKey) throw new Error(`the service refused that key ${input.key}`); return { checked: true, host: "api.anthropic.com" }; }
    if (name === "vault.me.account.status") return { ...vault, ...(vault.account ? { acct: "a1" } : {}) };
    if (name === "vault.me.add-key") {
      if (halfDone) { vault = { account: true, unlocked: true }; return { item: "", failed: "your vault could not be checked for that name", acct: "a2", secret_key: "SECRET-KEY-HALF" }; }
      if (fail) throw new Error(`${fail}: ${input.value} / ${input.password}`);
      const made = !vault.account; vault = { account: true, unlocked: true };
      return { item: input.label, acct: "a1", ...(made ? { secret_key: "SECRET-KEY-OF-VAULT" } : {}) };
    }
    if (name === "sessions.accounts.add") return { id: "ac_m1", provider: input.provider, label: input.label };
    throw new Error("unexpected " + name);
  };
  const ask = (extra = {}) => host.call("onboard.agent.key", { kind: "anthropic-compatible", key: KEY, label: "My Claude", ...extra });
  // no vault yet and no password: the key is checked, then it asks for the password, and nothing is written
  await assert.rejects(() => ask(), (e) => e.code === "need_password" && !String(e.message).includes(KEY));
  assert.deepEqual(calls.map((c) => c.name), ["sessions.accounts.key", "vault.me.account.status"]);
  assert.equal(calls[0].input.check_only, true, "the check keeps nothing");
  // with the password: one act makes and opens the vault and puts the key; the vault's Secret Key stays on this device
  calls.length = 0;
  const r = await ask({ password: PW });
  assert.deepEqual(r, { account: "ac_m1", provider: "claude", label: "My Claude", checked: true, item: "My Claude" }, "the name it is saved under in their Vault comes back, so the sheet can say it");
  assert.deepEqual(calls.map((c) => c.name), ["sessions.accounts.key", "vault.me.account.status", "vault.me.add-key", "sessions.accounts.add"]);
  assert.ok(calls.every((c) => c.box === "boxA"));
  assert.ok(calls.every((c) => /^spc_[a-z2-7]{12}$/.test(String(c.space))), "every call names the team's Space, which is how the app sends it through the team's door");
  assert.equal(calls.filter((c) => JSON.stringify(c.input).includes(PW)).map((c) => c.name).join(), "vault.me.add-key", "the password goes to the one act only");
  assert.equal(calls.filter((c) => JSON.stringify(c.input).includes(KEY)).map((c) => c.name).join(), "sessions.accounts.key,vault.me.add-key", "the key goes to its check and to the one act");
  assert.deepEqual(calls[3].input, { provider: "claude", label: "My Claude", kind: "api-key", vault_item: "My Claude" });
  assert.equal(keys.get("a1"), "SECRET-KEY-OF-VAULT");
  assert.ok(!JSON.stringify(r).includes(PW) && !JSON.stringify(r).includes(KEY));
  // open already: no password is asked for, and none is sent
  calls.length = 0;
  await ask({ label: "Second" });
  assert.deepEqual(calls.map((c) => c.name), ["sessions.accounts.key", "vault.me.account.status", "vault.me.add-key", "sessions.accounts.add"]);
  assert.ok(!("password" in calls[2].input) && !("secret_key" in calls[2].input), "no prompt, nothing extra sent");
  // locked: it asks for the password, and sends it with the Secret Key this device holds
  vault = { account: true, unlocked: false }; calls.length = 0;
  await assert.rejects(() => ask({ label: "Third" }), (e) => e.code === "need_password");
  await ask({ label: "Third", password: PW });
  const act = calls.find((c) => c.name === "vault.me.add-key");
  assert.deepEqual([act.input.password, act.input.secret_key], [PW, "SECRET-KEY-OF-VAULT"]);
  // a device without the Secret Key says so and writes nothing
  keys.clear(); vault = { account: true, unlocked: false }; calls.length = 0;
  await assert.rejects(() => ask({ label: "Fourth", password: PW }), (e) => e.code === "no_device_key");
  assert.ok(!calls.some((c) => c.name === "vault.me.add-key" || c.name === "sessions.accounts.add"));
  keys.set("a1", "SECRET-KEY-OF-VAULT");
  // an error that echoes the key and the password is thrown without either
  fail = "the vault refused"; vault = { account: true, unlocked: true };
  await assert.rejects(() => ask({ label: "Fifth", password: PW }), (e) => { assert.ok(!String(e.message).includes(KEY) && !String(e.message).includes(PW), String(e.message)); return true; });
  fail = "";
  // a key the provider refuses is caught at once, before a password or the vault, and the message does not carry the key
  badKey = true; calls.length = 0;
  await assert.rejects(() => ask({ label: "Sixth", password: PW }), (e) => { assert.ok(!String(e.message).includes(KEY)); assert.match(e.message, /refused that key/); return true; });
  assert.deepEqual(calls.map((c) => c.name), ["sessions.accounts.key"], "nothing else was asked or put");
  badKey = false;
  // every kind the owner can add: an OpenAI-style key at xAI's one address makes an openai-compatible account at that address, in their own vault
  vault = { account: true, unlocked: true }; calls.length = 0;
  const xai = await host.call("onboard.agent.key", { kind: "openai-compatible", key: "xai-0123456789abcdef", label: "Grok", base_url: "https://api.x.ai/v1" });
  assert.equal(xai.provider, "openai-compatible");
  assert.equal(calls[0].input.base_url, "https://api.x.ai/v1");
  assert.equal(calls.find((c) => c.name === "sessions.accounts.add").input.base_url, "https://api.x.ai/v1");
  const orr = await host.call("onboard.agent.key", { kind: "openrouter", key: "sk-or-0123456789abc", label: "Router" });
  assert.equal(orr.provider, "openrouter");
  // a vault just made whose later step failed still hands over its Secret Key, and the device keeps it before the failure is said
  halfDone = true; vault = { account: false, unlocked: false };
  await assert.rejects(() => ask({ label: "Seventh", password: PW }), (e) => /could not be checked/.test(e.message));
  assert.equal(keys.get("a2"), "SECRET-KEY-HALF", "the Secret Key was kept even though the key was not put");
  halfDone = false;
  // a kind this tool does not know is said plainly, with nothing sent
  calls.length = 0;
  await assert.rejects(() => host.call("onboard.agent.key", { kind: "mystery", key: KEY, label: "x" }), (e) => e.code === "bad_kind");
  assert.deepEqual(calls, []);
});

test("adding another Space: the Assistant of the person's other server is read (name and look only), and nothing when there is no other server", async (t) => {
  const { pp, host, store } = await ready(t);
  assert.deepEqual(await host.call("onboard.assistant.current", {}), { assistant: null }, "no other server");
  { const k = await store.load(); await store.save({ ...k, current: "spc_aaaaaaaaaaaa", spaces: [{ id: "spc_aaaaaaaaaaaa", name: "first", role: "owner", server: null, paired: { box: "boxFIRST", route: "r", relay: "x" } }] }); }
  const first = pp.call;
  pp.call = async (name, input, box) => name === "agents.list" ? [{ name: "kit", kind: "agent", look: "s0~c0" }, { name: "juno", display: "Juno", kind: "assistant", look: "s3~c5~e1~m2~t4~b1~h0", token: "SECRET" }] : first(name, input, box);
  const r = await host.call("onboard.assistant.current", {});
  assert.deepEqual(r, { assistant: { name: "Juno", look: "s3~c5~e1~m2~t4~b1~h0" } });
  pp.call = async (name, input, box) => name === "agents.list" ? [{ name: "juno", kind: "assistant", look: "<script>" }] : first(name, input, box);
  assert.equal((await host.call("onboard.assistant.current", {})).assistant.look, "", "a look that is not one is dropped");
});

test("copying AI accounts to a new Space: only key accounts are copyable, each key is read from the other server one by one, goes to the new Space through the owner's key tool, and no key or item name is in anything returned or thrown", async (t) => {
  const { pp, host, store } = await ready(t);
  const open = await host.call("onboard.space.open", { kind: "linux", name: "alex-space" });
  pp.seen.resolveAs = "one";
  await until(host, open.id, (r) => r.online);
  { const k = await store.load(); await store.save({ ...k, current: "spc_aaaaaaaaaaaa", spaces: [{ id: "spc_aaaaaaaaaaaa", name: "first", role: "owner", server: null, paired: { box: "boxFIRST", route: "r", relay: "x" } }, ...(k.spaces || [])] }); }
  const first = pp.call, sent = [];
  const KEY1 = "sk-ant-OLDKEY-0123456789", KEY2 = "sk-or-OLDKEY-0123456789";
  pp.call = async (name, input, box) => {
    if (box === "boxFIRST" && name === "sessions.accounts.list") return [{ id: "a1", provider: "claude", label: "Work", kind: "api-key", vault_item: "ai-key-claude-1" }, { id: "a2", provider: "openrouter", label: "Router", kind: "api-key", vault_item: "ai-key-or-1" }, { id: "a3", provider: "codex", label: "Codex login", kind: "login", vault_item: null }, { id: "default", provider: "claude", synthetic: true }];
    if (box === "boxFIRST" && name === "vault.reveal") { sent.push({ name, box, item: input.name }); return { value: input.name === "ai-key-claude-1" ? KEY1 : KEY2 }; }
    if (name === "sessions.accounts.key") { sent.push({ name, box, label: input.label, kind: input.kind }); if (input.label === "Router") throw new Error(`refused ${input.key}`); return { account: "ac_new", checked: true }; }
    return first(name, input, box);
  };
  const c = await host.call("onboard.accounts.copyable", {});
  assert.deepEqual(c.accounts.map((a) => [a.label, a.copy]), [["Work", true], ["Router", true], ["Codex login", false]]);
  assert.equal(c.from, "first");
  assert.ok(!JSON.stringify(c).includes("ai-key"), "no item name");
  const r = await host.call("onboard.accounts.copy", { ids: ["a1", "a2", "a3"] });
  assert.deepEqual(r.copied.map((x) => [x.label, x.ok]), [["Codex login", false], ["Work", true], ["Router", false]]);
  assert.ok(!JSON.stringify(r).includes("OLDKEY"), "no key in the answer or the failure words");
  assert.deepEqual(sent.filter((x) => x.name === "vault.reveal").map((x) => x.box), ["boxFIRST", "boxFIRST"], "each key is read from the OTHER server, one call each");
  assert.deepEqual(sent.filter((x) => x.name === "sessions.accounts.key").map((x) => [x.box, x.kind]), [["boxA", "anthropic-compatible"], ["boxA", "openrouter"]], "and added to the new Space's server");
  // sec53: a custom address is added by hand, and an account that is not the caller's is not copied: neither is READ
  const reveals = [];
  pp.call = async (name, input, box) => {
    if (box === "boxFIRST" && name === "sessions.accounts.list") return [
      { id: "c1", provider: "openai-compatible", label: "My lab", kind: "api-key", vault_item: "lab", base_url: "http://127.0.0.1:8080/v1" },
      { id: "c2", provider: "openai-compatible", label: "Grok", kind: "api-key", vault_item: "grok", base_url: "https://api.x.ai/v1" },
      { id: "c3", provider: "claude", label: "Team shared", kind: "api-key", vault_item: "team", person: "per_" + "z".repeat(26) },
      { id: "c4", provider: "claude", label: "Mine", kind: "api-key", vault_item: "mine" }];
    if (name === "vault.reveal") { reveals.push(input.name); return { value: "xai-0123456789abcdef" }; }
    if (name === "sessions.accounts.key") return { account: "ac_x", checked: true };
    return first(name, input, box);
  };
  const lst = await host.call("onboard.accounts.copyable", {});
  assert.deepEqual(lst.accounts.map((x) => [x.label, x.copy, x.why || ""]), [["My lab", false, "Add this one by hand."], ["Grok", true, ""], ["Team shared", false, "Not yours to copy."], ["Mine", true, ""]]);
  const cp = await host.call("onboard.accounts.copy", { ids: ["c1", "c2", "c3", "c4"] });
  assert.deepEqual(reveals.sort(), ["grok", "mine"], "only the caller's own accounts at an allowed address are read");
  assert.deepEqual(cp.copied.filter((x) => !x.ok).map((x) => [x.label, x.why]).sort(), [["My lab", "Add this one by hand."], ["Team shared", "Not yours to copy."]]);
  // a read the person does not approve is said, per account, with the way on: never silent
  pp.call = async (name, input, box) => { if (name === "vault.reveal") throw Object.assign(new Error("Nothing was approved."), { code: "cancelled" }); if (name === "sessions.accounts.list" && box === "boxFIRST") return [{ id: "a1", provider: "claude", label: "Work", kind: "api-key", vault_item: "ai-key-claude-1" }]; return first(name, input, box); };
  const no = await host.call("onboard.accounts.copy", { ids: ["a1"] });
  assert.deepEqual([no.copied[0].ok, /Not approved.*Sign in again/.test(no.copied[0].why)], [false, true]);
  await assert.rejects(() => host.call("onboard.accounts.copy", { ids: [] }), (e) => e.code === "bad_input");
});

test("the model step lists what each signed-in account offers (its own list, else its provider's) and keeps the Assistant's model, sending nothing but names and ids", async (t) => {
  const { pp, host } = await ready(t);
  await assert.rejects(() => host.call("onboard.assistant.models", {}), (e) => e.code === "no_server");
  const open = await host.call("onboard.space.open", { kind: "linux", name: "alex-space" });
  pp.seen.resolveAs = "one";
  await until(host, open.id, (r) => r.online);
  const first = pp.call;
  const say = { "sessions.accounts.list": [{ id: "ac_1", provider: "claude", label: "Work", kind: "login", token: "SECRET" }, { id: "ac_2", provider: "codex", label: "Key", kind: "api-key", vault_item: "k" }, { id: "ac_3", provider: "claude", label: "Nope", pending: true }, { id: "default", provider: "claude", label: "Default", synthetic: true }],
    "agents.list": [{ name: "kit", kind: "agent" }, { name: "juno", kind: "assistant" }] };
  /** @type {string[]} */ const order = [];
  pp.call = async (name, input, box) => {
    if (name === "models.refresh") { order.push(name); return { refreshed: true }; }
    if (name === "sessions.accounts.list" || name === "agents.list") return say[name];
    if (name === "sessions.accounts.models") { order.push(name); if (input.account === "ac_1") return { models: [{ id: "opus", label: "Opus" }, { id: "sonnet", name: "Sonnet", provider: "claude", vendor: "Anthropic", context: 1000000, price: { in: 3, out: 15 }, efforts: ["low", "high"], vault_item: "x" }], secret: "S" }; throw new Error("not offered"); }
    if (name === "sessions.models") { pp.seen.calls.push({ name, input, box }); return [{ id: "gpt-5", label: "GPT 5" }]; }
    if (name === "agents.update") { pp.seen.calls.push({ name, input, box }); return { ok: true }; }
    return first(name, input, box);
  };
  const r = await host.call("onboard.assistant.models", {});
  assert.deepEqual(r.accounts.map((a) => [a.id, a.label, a.provider, a.models.map((m) => m.id)]), [["ac_1", "Work", "claude", ["opus", "sonnet"]], ["ac_2", "Key", "codex", ["gpt-5"]]], "pending and synthetic accounts are left out; an account with no list of its own shows its provider's");
  assert.ok(!JSON.stringify(r).includes("SECRET") && !JSON.stringify(r).includes("vault_item"), "no credential or vault item comes back");
  const sonnet = r.accounts[0].models[1];
  assert.deepEqual([sonnet.name, sonnet.vendor, sonnet.context, sonnet.price, sonnet.efforts], ["Sonnet", "Anthropic", 1000000, { in: 3, out: 15 }, ["low", "high"]], "each model keeps its details for the one picker");
  assert.equal(order[0], "models.refresh", "the registry is asked to look before any account's models are read");
  pp.call = async (name, input, box) => (name === "models.refresh" ? Promise.reject(new Error("not yours")) : name === "sessions.accounts.list" ? say[name] : name === "sessions.accounts.models" ? { models: [{ id: "opus", label: "Opus" }] } : first(name, input, box));
  assert.equal((await host.call("onboard.assistant.models", {})).accounts.length, 2, "a refused look still lists what is known");
  pp.call = async (name, input, box) => {
    if (name === "sessions.accounts.list" || name === "agents.list") return say[name];
    if (name === "agents.update") { pp.seen.calls.push({ name, input, box }); return { ok: true }; }
    return first(name, input, box);
  };
  await assert.rejects(() => host.call("onboard.assistant.model", { model: "a b; rm" }), (e) => e.code === "bad_model");
  const m = await host.call("onboard.assistant.model", { model: "opus" });
  assert.deepEqual(m, { name: "juno", model: "opus" });
  const sent = pp.seen.calls.filter((c) => c.name === "agents.update").pop();
  assert.deepEqual([sent.box, sent.input], ["boxA", { name: "juno", model: "opus" }]);
  // the one picker's pick: the provider the model is on and its effort go with it
  assert.deepEqual(await host.call("onboard.assistant.model", { model: "x-ai/grok-4.7", provider: "openrouter", effort: "high" }), { name: "juno", model: "x-ai/grok-4.7", provider: "openrouter", effort: "high" });
  assert.deepEqual(pp.seen.calls.filter((c) => c.name === "agents.update").pop().input, { name: "juno", model: "x-ai/grok-4.7", model_provider: "openrouter", effort: "high" });
  await assert.rejects(() => host.call("onboard.assistant.model", { model: "m", provider: "Not A Provider" }), (e) => e.code === "bad_model");
});

test("a Mac window says on its online answer that fingerprint approvals are not there yet; a browser says nothing", async (t) => {
  for (const mac of [true, false]) {
    const { pp, host } = await ready(t, { softwareKeyHere: mac });
    const open = await host.call("onboard.space.open", { kind: "linux", name: "alex-space" });
    pp.seen.resolveAs = "one";
    const done = await until(host, open.id, (r) => r.online);
    assert.equal(done.noFingerprintYet === true, mac, mac ? "the Mac window says it" : "the browser does not");
  }
});

test("a relaunched host is locked: a tool that needs the key answers locked until the password opens it", async (t) => {
  const { d, store, pp, host } = await ready(t);
  // the same kept identity in a new page (a relaunch): nothing of the key survives in memory
  const again = createHost({ store, directory: d.base, fetch: d.fetch, now: d.now, kdf: FAST, space: { load: async () => pp }, sleep: nap, pollMs: 5 });
  assert.equal((await again.call("identity.status", {})).unlocked, false, "the new page holds no key");
  await assert.rejects(() => again.call("onboard.space.open", { kind: "linux", name: "alex-space" }), (e) => e.code === "locked", "the answer is the locked one");
  await assert.rejects(() => again.call("identity.unlock", { password: "zebra quartz mango pillow" }), (e) => e.code === "bad_password", "a wrong password is refused and opens nothing");
  assert.equal((await again.call("identity.status", {})).unlocked, false);
  await again.call("identity.unlock", { password: "correct horse battery staple" });
  assert.equal((await again.call("identity.status", {})).unlocked, true, "the right password opens it");
  void host;
});
