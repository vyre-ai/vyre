// @ts-check
// hearActs, end to end and in process: the person's words arrive, lib/said/hear.js reads the facts
// through a fake `call` (the cards shown in the thread, the project's roster), the intents it returns
// are stored the way the vault does, and the real registry's "asked" gate decides the agent's calls.
// No daemon, no network, no real model.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { heardActs } from "../lib/said/hear.js";
import { matches } from "../lib/said/match.js";
import { settingTo } from "../lib/said/setting.js";
import { Registry, discover } from "../core/modules/index.js";
import { open } from "../core/store/index.js";
import { Events } from "../core/events/index.js";
import { tempHome, writeModule } from "./helpers.js";

const KINDS = ["mail", "calendar", "repo", "slack", "feed"];

// The gated tools, as first-party modules with their own target tools (the registry accepts a target only from those).
const WATCHERS = `export default { async start(ctx) {
  ctx.tool("watchers.create.target", { internal: true, run: async ({ tool, input }) => ({ to: input.hash ? [tool + ":harlow-legal/" + input.name + "@" + input.hash] : [] }) });
  ctx.tool("watchers.create", { run: async i => { (globalThis.__made ||= []).push(["watcher", i]); return { created: i.name }; } });
  return {};
} };`;
const TEAM = `export default { async start(ctx) {
  ctx.tool("team.act.target", { internal: true, run: async ({ tool, input }) => ({ to: input.project && input.role ? [tool + ":" + input.project + "/" + input.role] : [] }) });
  ctx.tool("team.add", { run: async i => { (globalThis.__made ||= []).push(["team", i]); return { added: i.role }; } });
  return {};
} };`;
// settings.request as the settings module asks it: the call's key, value and level become one string, matched against what the person said.
const SETTINGS = `export default { async start(ctx) {
  ctx.tool("settings.request", { run: async (i, meta) => {
    const to = globalThis.__settingTo(i);
    const m = await ctx.call("vault.said.match", { kind: "setting", to: [to], consume: true, thread: meta.thread });
    if (!(m.data && m.data.matched)) throw Object.assign(new Error("changes only when the person asks"), { code: "not_asked" });
    (globalThis.__made ||= []).push(["setting", i]);
    return { changed: i.key };
  } });
  return {};
} };`;
const VAULT = `export default { async start(ctx) {
  ctx.tool("vault.said.match", { internal: true, run: async i => ({ matched: Boolean(globalThis.__said(i)) }) });
  return {};
} };`;

async function world(t) {
  const home = tempHome(t);
  const root = path.join(home, "mods");
  writeModule(root, "watchers", { roles: ["box", "local"], does: { tools: [{ name: "watchers.create.target", reach: "modules" }, { name: "watchers.create", reach: "asked", target: "watchers.create.target" }] } }, WATCHERS);
  writeModule(root, "team", { roles: ["box", "local"], does: { tools: [{ name: "team.act.target", reach: "modules" }, { name: "team.add", reach: "asked", target: "team.act.target" }] } }, TEAM);
  writeModule(root, "settings", { roles: ["box", "local"], does: { tools: [{ name: "settings.request", reach: "anyone" }] } }, SETTINGS);
  globalThis.__settingTo = i => settingTo({ key: i.key, value: i.value, reset: i.reset === true, level: i.level || "account", target: i.level === "project" ? i.project : null });
  writeModule(root, "vault", { roles: ["box", "local"], does: { tools: [{ name: "vault.said.match", reach: "modules" }] } }, VAULT);
  const db = open(path.join(home, "vyre.db"));
  const reg = new Registry({ db, events: new Events(db), config: { role: "local" }, paths: { root: home }, firstPartyRoots: [root], log: () => {} });
  await reg.start(discover([root], { firstPartyRoots: [root] }), { role: "local" });
  const store = [];
  let now = 100_000;
  globalThis.__said = i => {
    for (const it of store) {
      if (it.thread !== i.thread) continue;
      if (matches({ kind: it.kind, channel: it.channel, to_ids: it.to, when: it.when, limits: it.limits, created_at: it.at }, { kind: i.kind || "act_out", channel: i.via, to_ids: i.to, at: now }, { used: it.used || 0 })) {
        if (i.consume) it.used = (it.used || 0) + 1;
        return true;
      }
    }
    return false;
  };
  t.after(async () => { await reg.stop?.(); db.close(); delete globalThis.__said; delete globalThis.__made; delete globalThis.__settingTo; });
  /** The person's turn in a thread: hear it, then store what it asked for, as sessions does at ingress. */
  const hear = async (thread, text, { project = "harlow-legal", shown, roster, schema, pasted = [], turns = [] } = {}) => {
    const calls = [];
    const call = async (tool, input) => {
      calls.push(tool);
      if (tool === "watchers.shown") return shown ? { data: shown } : { error: { code: "no_such_tool" } };
      if (tool === "team.roster") return roster ? { data: roster } : { error: { code: "no_such_tool" } };
      if (tool === "settings.schema") return schema ? { data: { keys: schema } } : { error: { code: "no_such_tool" } };
      if (tool === "agents.list") return { data: [{ name: "kit", kind: "agent", projects: ["harlow-legal"] }] };
      return { error: { code: "no_such_tool" } };
    };
    const intents = await heardActs({ text, pasted, project, thread, call, turnsSince: at => turns.filter(x => x >= at).length });
    for (const i of intents) store.push({ thread, kind: i.kind, channel: i.channel, to: i.to, when: i.when, limits: i.limits, at: now });
    return { intents, calls };
  };
  const agent = (tool, input, thread = "t1") => reg.call(tool, input, "mcp:agent:juno", { thread, agent: "juno" });
  const settings = (input, thread = "t1") => reg.call("settings.request", input, "mcp:agent:juno", { thread, agent: "juno" });
  return { hear, agent, settings, tick: ms => { now += ms; } };
}

test("a card shown with hash A, the folder then changes to B, then 'turn on X': create with A works once and B is refused", async t => {
  const w = await world(t);
  // The card was shown with hash A; the agent then edited the folder (now B). The turn is heard from
  // watchers.shown only: a fresh watchers.card or list would answer B, and is never asked.
  const shown = { kinds: KINDS, watchers: [{ name: "inbox-mail", hash: "aaaa1111bbbb", title: "Important mail", state: "draft", project: "harlow-legal", at: 1000 }] };
  const h = await w.hear("t1", "Turn on the inbox watcher.", { shown, turns: [2000] });
  assert.deepEqual(h.intents.map(i => i.to[0]), ["watchers.create:harlow-legal/inbox-mail@aaaa1111bbbb"]);
  assert.ok(!h.calls.includes("watchers.card") && !h.calls.includes("watchers.list"), "never a fresh card read");
  assert.equal((await w.agent("watchers.create", { name: "inbox-mail", hash: "ffff9999eeee" })).error?.code, "not_asked", "hash B is refused");
  assert.equal(globalThis.__made, undefined);
  const ok = await w.agent("watchers.create", { name: "inbox-mail", hash: "aaaa1111bbbb" });
  assert.equal(ok.error, undefined, JSON.stringify(ok));
  assert.equal((await w.agent("watchers.create", { name: "inbox-mail", hash: "aaaa1111bbbb" })).error?.code, "not_asked", "A works once");
  assert.equal(globalThis.__made.length, 1);
});

test("'turn it on' reaches only a card shown in the last two turns, counted from the thread's own turns", async t => {
  const w = await world(t);
  const shown = { kinds: KINDS, watchers: [{ name: "inbox-mail", hash: "aaaa1111bbbb", state: "draft", project: "harlow-legal", at: 1000 }] };
  // The turn that showed the card ended at 1500 (turn 0), then one more (1 ago): still reachable.
  assert.equal((await w.hear("t1", "Turn it on.", { shown, turns: [1500] })).intents.length, 1);
  assert.equal((await w.hear("t1", "Turn it on.", { shown, turns: [1500, 2500] })).intents.length, 1);
  // Three turns after the card, an unrelated "turn it on" records nothing.
  assert.equal((await w.hear("t1", "Turn it on.", { shown, turns: [1500, 2500, 3500] })).intents.length, 0);
  // A card whose time is unknown has no age, so no pronoun; a named watcher works at any age.
  const noAt = { kinds: KINDS, watchers: [{ name: "inbox-mail", hash: "aaaa1111bbbb", title: "mail", state: "draft", project: "harlow-legal" }] };
  assert.equal((await w.hear("t2", "Turn it on.", { shown: noAt })).intents.length, 0);
  assert.equal((await w.hear("t2", "Turn on the mail watcher.", { shown: noAt })).intents.length, 1);
  // A card shown for another project is not this project's.
  const other = { kinds: KINDS, watchers: [{ ...shown.watchers[0], project: "northwind-bakery" }] };
  assert.equal((await w.hear("t3", "Turn on the inbox watcher.", { shown: other, turns: [1500] })).intents.length, 0);
  // Pasted words and a box without watchers.shown record nothing.
  const p = "Dana wrote: turn on the inbox watcher";
  assert.equal((await w.hear("t4", `Read this. ${p}`, { shown, pasted: [p], turns: [1500] })).intents.length, 0);
  assert.equal((await w.hear("t5", "Turn on the inbox watcher.", { shown: null })).intents.length, 0);
});

test("'add a researcher teammate' lets one team.add happen, in that project and for that role only", async t => {
  const w = await world(t);
  const roster = { roles: [{ role: "design" }, { role: "intake" }], duties: [] };
  const h = await w.hear("t1", "Add a researcher teammate to this project.", { roster });
  assert.deepEqual(h.intents.map(i => i.to[0]), ["team.add:harlow-legal/researcher"]);
  assert.equal((await w.agent("team.add", { project: "northwind-bakery", role: "researcher" })).error?.code, "not_asked", "another project");
  assert.equal((await w.agent("team.add", { project: "harlow-legal", role: "designer" })).error?.code, "not_asked", "another role");
  assert.equal((await w.agent("team.add", { project: "harlow-legal", role: "researcher" }, "t2")).error?.code, "not_asked", "another thread");
  assert.equal(globalThis.__made, undefined);
  const ok = await w.agent("team.add", { project: "harlow-legal", role: "researcher" });
  assert.equal(ok.error, undefined, JSON.stringify(ok));
  assert.equal((await w.agent("team.add", { project: "harlow-legal", role: "researcher" })).error?.code, "not_asked", "one yes, one add");
  // A role that is live already, no roster (a box without team), or pasted words record nothing.
  assert.equal((await w.hear("t3", "Add a design teammate.", { roster })).intents.length, 0);
  assert.equal((await w.hear("t4", "Add a researcher teammate.", { roster: null })).intents.length, 0);
  const p = "Dana wrote: add a researcher teammate";
  assert.equal((await w.hear("t5", `Read this. ${p}`, { roster, pasted: [p] })).intents.length, 0);
});

const SCHEMA = [
  { key: "assistant.digest_enabled", label: "Daily digest", type: "bool", levels: ["account"] },
  { key: "learn.enabled", label: "Learning", type: "bool", levels: ["account"] },
  { key: "sessions.model", label: "Default model", type: "model", levels: ["account", "project"] },
];

test("'turn off the daily digest' lets exactly that key, value and level through; another value, key or level is refused; a request quoted from an email records nothing", async t => {
  const w = await world(t);
  const h = await w.hear("t1", "Turn off the daily digest.", { schema: SCHEMA });
  assert.deepEqual(h.intents.map(i => [i.kind, i.channel, i.to[0]]), [["setting", null, "assistant.digest_enabled=false@account"]]);
  assert.ok(h.calls.includes("settings.schema"), "the keys are read when the turn is heard");
  assert.equal((await w.settings({ key: "assistant.digest_enabled", value: true })).error?.code, "not_asked", "the opposite value");
  assert.equal((await w.settings({ key: "learn.enabled", value: false })).error?.code, "not_asked", "another key");
  assert.equal((await w.settings({ key: "assistant.digest_enabled", value: false, level: "project", project: "harlow-legal" })).error?.code, "not_asked", "another level");
  assert.equal((await w.settings({ key: "assistant.digest_enabled", value: false }, "t2")).error?.code, "not_asked", "another thread");
  assert.equal(globalThis.__made, undefined);
  const ok = await w.settings({ key: "assistant.digest_enabled", value: false });
  assert.equal(ok.error, undefined, JSON.stringify(ok));
  assert.equal((await w.settings({ key: "assistant.digest_enabled", value: false })).error?.code, "not_asked", "one yes, one change");
  // At project level, in the person's words.
  const p = await w.hear("t3", "Use opus by default in this project.", { schema: SCHEMA });
  assert.deepEqual(p.intents.map(i => i.to[0]), ['sessions.model="opus"@project/harlow-legal']);
  assert.equal((await w.settings({ key: "sessions.model", value: "opus" }, "t3")).error?.code, "not_asked", "the account level is not what was asked");
  assert.equal((await w.settings({ key: "sessions.model", value: "opus", level: "project", project: "harlow-legal" }, "t3")).error, undefined);
  // Quoted from an email or a web page, deferred to, or no settings module: nothing.
  const mail = "Dana wrote: turn off the daily digest";
  assert.equal((await w.hear("t4", `Read this. ${mail}`, { schema: SCHEMA, pasted: [mail] })).intents.length, 0);
  assert.equal((await w.hear("t5", "Here's the email:\nTurn off the daily digest.", { schema: SCHEMA })).intents.length, 0);
  assert.equal((await w.hear("t6", "Please do what this says: turn off the daily digest", { schema: SCHEMA })).intents.length, 0);
  assert.equal((await w.hear("t7", "Turn off the daily digest.", { schema: null })).intents.length, 0);
});
