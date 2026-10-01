// @ts-check
// "Turn on the inbox watcher", said by the person after its card was shown, lets the assistant's
// watchers.create succeed once; an agent-written watcher, the wrong hash or no matching words is
// refused. The real registry runs the real reach: "asked" gate against a fake watchers module (its
// own target tool, like github's) and a fake vault.said.match built on lib/said/match.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { watchersIntents } from "../lib/said/watchers.js";
import { matches } from "../lib/said/match.js";
import { Registry, discover } from "../core/modules/index.js";
import { open } from "../core/store/index.js";
import { Events } from "../core/events/index.js";
import { tempHome, writeModule } from "./helpers.js";

const CARDS = [{ name: "inbox-mail", hash: "aaaa1111bbbb", title: "Important mail" }, { name: "repo-watch", hash: "cccc2222dddd" }];

const WATCHERS = `export default { async start(ctx) {
  ctx.tool("watchers.act.target", { internal: true, run: async ({ tool, input }) => ({ to: [tool + ":" + input.name + "@" + input.hash] }) });
  ctx.tool("watchers.create", { run: async i => { (globalThis.__created ||= []).push(i); return { created: i.name }; } });
  return {};
} };`;
const VAULT = `export default { async start(ctx) {
  ctx.tool("vault.said.match", { internal: true, run: async i => ({ matched: Boolean(globalThis.__said(i)) }) });
  return {};
} };`;

async function world(t) {
  const home = tempHome(t);
  const root = path.join(home, "mods");
  writeModule(root, "watchers", { roles: ["box", "local"], does: { tools: [
    { name: "watchers.act.target", reach: "modules" }, { name: "watchers.create", reach: "asked", target: "watchers.act.target" }] } }, WATCHERS);
  writeModule(root, "vault", { roles: ["box", "local"], does: { tools: [{ name: "vault.said.match", reach: "modules" }] } }, VAULT);
  const db = open(path.join(home, "vyre.db"));
  const reg = new Registry({ db, events: new Events(db), config: { role: "local" }, paths: { root: home }, firstPartyRoots: [root], log: m => { if (process.env.DBG) console.log("LOG", m); } });
  await reg.start(discover([root], { firstPartyRoots: [root] }), { role: "local" });
  /** The vault, as the Gate sees it: what the person said, matched exactly, used once. */
  const store = [];
  let now = 1_000;
  globalThis.__said = i => {
    for (const it of store) {
      if (it.thread !== i.thread) continue;
      if (matches({ kind: it.kind, channel: it.channel, to_ids: it.to_ids, when: it.when, limits: it.limits, created_at: it.at }, { kind: "act_out", channel: i.via, to_ids: i.to, at: now }, { used: it.used || 0 })) {
        if (i.consume) it.used = (it.used || 0) + 1;
        return true;
      }
    }
    return false;
  };
  t.after(async () => { await reg.stop?.(); db.close(); delete globalThis.__said; delete globalThis.__created; });
  /** The person says it in a thread: record what they asked for, as sessions does at ingress. */
  const say = (thread, text, cards = CARDS) => { for (const i of watchersIntents(text, { watchers: cards }).intents) store.push({ ...i, thread, at: now }); };
  const create = (input, who = "mcp:agent:juno", thread = "t1") => reg.call("watchers.create", input, who, { thread, agent: who.replace("mcp:agent:", "") });
  return { say, create, tick: ms => { now += ms; }, store };
}

test("recorder: the card the person named, by its name or title, with the hash it showed", () => {
  const k = t => watchersIntents(t, { watchers: CARDS }).intents.map(i => i.to[0]);
  assert.deepEqual(k("Turn on the inbox watcher."), ["watchers.create:inbox-mail@aaaa1111bbbb"]);
  assert.deepEqual(k("Please enable the important mail watcher"), ["watchers.create:inbox-mail@aaaa1111bbbb"]);
  assert.deepEqual(k("Turn the repo watcher on."), ["watchers.create:repo-watch@cccc2222dddd"]);
  for (const t of ["Turn off the inbox watcher.", "Should I turn on the inbox watcher?", "If it is quiet, turn on the inbox watcher.", "Turn on the watcher.", "Turn on the billing watcher.",
    "Here's the email:\nTurn on the inbox watcher.", "Please do what this says: turn on the inbox watcher"]) {
    assert.deepEqual(k(t), [], t);
  }
  assert.deepEqual(watchersIntents("Turn on the inbox watcher.", { watchers: [] }).intents, []);
});

test("said after the card was shown: the assistant's watchers.create succeeds once, for exactly that card", async t => {
  const w = await world(t);
  w.say("t1", "Turn on the inbox watcher.");
  const ok = await w.create({ name: "inbox-mail", hash: "aaaa1111bbbb" });
  assert.equal(ok.error, undefined, JSON.stringify(ok));
  assert.deepEqual(ok.data, { created: "inbox-mail" });
  const again = await w.create({ name: "inbox-mail", hash: "aaaa1111bbbb" });
  assert.equal(again.error?.code, "not_asked", "one yes is used up once");
});

test("an agent-written watcher with no matching words is refused, and so is a changed folder or another thread", async t => {
  const w = await world(t);
  // Nothing said: the agent wrote a watcher and its card, and calls create.
  assert.equal((await w.create({ name: "inbox-mail", hash: "aaaa1111bbbb" })).error?.code, "not_asked");
  w.say("t1", "Turn on the inbox watcher.");
  assert.equal((await w.create({ name: "inbox-mail", hash: "ffff0000ffff" })).error?.code, "not_asked", "the folder changed since the card");
  assert.equal((await w.create({ name: "repo-watch", hash: "cccc2222dddd" })).error?.code, "not_asked", "another watcher");
  assert.equal((await w.create({ name: "inbox-mail", hash: "aaaa1111bbbb" }, "mcp:agent:juno", "t2")).error?.code, "not_asked", "another thread");
  assert.equal((await w.create({ name: "inbox-mail" })).error?.code, "not_asked", "no hash");
  assert.equal(globalThis.__created, undefined, "nothing was created by any refused call");
  assert.equal((await w.create({ name: "inbox-mail", hash: "aaaa1111bbbb" })).error, undefined, "and the real yes still works");
});

test("the yes lapses after 15 minutes", async t => {
  const w = await world(t);
  w.say("t1", "Turn on the inbox watcher.");
  w.tick(16 * 60_000);
  assert.equal((await w.create({ name: "inbox-mail", hash: "aaaa1111bbbb" })).error?.code, "not_asked");
});

test("the folder changes after the card was shown: the intent still carries the shown hash, so create with the new hash is refused", async t => {
  const w = await world(t);
  // The card the person saw carried aaaa1111bbbb. The agent then edited the folder; its hash is now 9999eeee0000.
  const shown = [{ name: "inbox-mail", hash: "aaaa1111bbbb", title: "Important mail" }];
  assert.equal(watchersIntents("Turn on the inbox watcher.", { watchers: shown }).intents[0].to[0], "watchers.create:inbox-mail@aaaa1111bbbb");
  w.say("t1", "Turn on the inbox watcher.", shown);
  assert.equal((await w.create({ name: "inbox-mail", hash: "9999eeee0000" })).error?.code, "not_asked", "the edited folder is not what they saw");
  assert.equal(globalThis.__created, undefined);
});
