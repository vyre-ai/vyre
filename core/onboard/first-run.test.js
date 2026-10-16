// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { JOIN_COPY, PHASES, afterAi, afterRecovery, commandOk, mentionsServer, parseInvite, passwordOk, usernameOf } from "../../lib/first-run-shape.js";
import { lineOfOp } from "../../lib/one-yes.js";
import { registerFirstRun } from "./first-run.js";

test("a username, an invite link and the install line have one shape", () => {
  assert.equal(usernameOf("Alex"), "alex");
  assert.equal(usernameOf("ab"), "");
  assert.equal(usernameOf("a".repeat(21)), "");
  assert.equal(passwordOk("correct horse battery"), true);
  assert.equal(passwordOk("short"), false);
  assert.equal(passwordOk("password1234"), false);
  const pub = parseInvite("https://vyre.run/i/abcdefgh");
  assert.equal(pub && pub.link, "https://vyre.run/i/abcdefgh");
  assert.equal(pub && pub.legacy, false);
  const old = parseInvite("https://juniper.vyre.run/join/abcdefgh");
  assert.equal(old && old.legacy, true);
  assert.equal(old && old.spaceHost, "juniper.vyre.run");
  assert.equal(parseInvite("https://vyre.run/setup"), null);
  assert.equal(commandOk("curl -fsSL vyre.run/i | sh"), true);
  assert.equal(commandOk("curl -fsSL vyre.run/i | VYRE_CODE=abc VYRE_STORE=auto sh"), true);
  assert.equal(commandOk("curl -fsSL vyre.run/box/install-mac-server.sh | sh"), true);
  assert.equal(commandOk("vyre words"), false);
  assert.equal(commandOk("curl -fsSL vyre.run/i | sh; vyre words"), false);
});

test("the join path never names a server, and identity leads to the path the person chose", () => {
  for (const text of Object.values(JOIN_COPY)) assert.equal(mentionsServer(text), false, text);
  assert.deepEqual(PHASES, ["Identity", "Space", "Ready"]);
  assert.equal(afterRecovery({}), "id.ai");
  assert.equal(afterAi({ path: "join" }), "join.link");
  assert.equal(afterAi({ path: "join", heldInvite: "https://vyre.run/i/abcdefgh" }), "join.review");
  assert.equal(afterAi({ path: "create" }), "create.kind");
  assert.equal(afterAi({}), "space.choice");
  assert.equal(afterAi({ path: "computer" }), "computer.add");
  assert.equal(afterAi({ path: "phone" }), "phone.add");
});

/** @param {{ status?: any }} [opt] @returns {{ tools: Map<string, any>, saved: any[], calls: { name: string, input: any }[] }} */
function harness(opt = {}) {
  const tools = new Map();
  const saved = [];
  const calls = [];
  /** @type {Set<string>} */
  const made = new Set();
  /** @type {{ username: string, id: string } | null} */
  let person = null;
  const ctx = {
    tool: (name, def) => tools.set(name, def),
    events: { emit() {} },
    call: async (tool, input, opts) => {
      assert.deepEqual(opts, { relay: true });
      calls.push({ name: tool, input });
      try { return { data: await dispatch(tool, input) }; }
      catch (e) { return { error: { code: /** @type {any} */ (e).code || "failed", message: String(/** @type {any} */ (e).message || e) } }; }
    },
  };
  const dispatch = async (name, input) => {
    if (name === "identity.status") return person ? { exists: true, username: person.username, id: person.id } : { exists: false, username: null, id: null };
    if (name === "identity.create") {
      person = { username: input.username, id: "id_alex" };
      return { username: input.username, id: "id_alex", recoveryKey: "R1-TEST-KEY", url: `https://vyre.run/u/${input.username}` };
    }
    if (name === "spaces.list") return [];
    if (name === "wink.install.issue") {
      const line = input.os === "mac"
        ? "curl -fsSL vyre.run/box/install-mac-server.sh | VYRE_CODE=abc VYRE_STORE=auto sh"
        : "curl -fsSL vyre.run/i | VYRE_CODE=abc VYRE_STORE=auto sh";
      return { line, expires: Math.floor(Date.now() / 1000) + 1800, os: input.os };
    }
    if (name === "wink.install.status") return opt.status || { issued: true, owned: false, locked: false, expires: Math.floor(Date.now() / 1000) + 1800 };
    if (name === "wink.install.complete") throw Object.assign(new Error("not yet"), { code: opt.completeCode || "bad_state" });
    if (name === "spaces.invites.create") return { link: "https://vyre.run/i/abcdefghijk" };
    if (name === "wink.phone.open") return { qr: "vyre://wink/2?p=phoneseed", link: "vyre://wink/2?p=phoneseed", expires: 1_900_000_000_000, code: "WINK-ABCD-EFGH" };
    if (name === "spaces.invites.accept") {
      const link = String(input.link || "");
      if (link.includes("adminlink")) return { space: "spc_juniper", name: "juniper", role: "admin", server: "https://juniper.vyre.run" };
      return { space: "spc_juniper", name: "juniper", role: "member", server: "https://juniper.vyre.run" };
    }
    if (name === "devices.signin") {
      assert.equal("password" in input, true);
      return { ok: true, username: input.username || "alex", server: input.server, live: true, device: "aaaaaaaaaaaaaaaa" };
    }
    if (name === "vault.space.create") {
      if (made.has(input.space)) throw Object.assign(new Error("exists"), { code: "exists" });
      made.add(input.space);
      return { generation: 1 };
    }
    if (name === "identity.github.link") return { login: input.login };
    throw Object.assign(new Error(`missing ${name}`), { code: "no_such_tool" });
  };
  registerFirstRun(ctx, { save: (p) => saved.push(p) });
  return { tools, saved, calls, ctx };
}

test("the first-run tools are the ones the app calls, and an access change is marked outward", () => {
  const { tools } = harness();
  const names = [...tools.keys()].sort();
  assert.deepEqual(names, [
    "onboard.agent.list", "onboard.agent.signin", "onboard.computer.add", "onboard.first.done", "onboard.first.progress", "onboard.first.progress.save",
    "onboard.github.finish", "onboard.github.start", "onboard.join.read", "onboard.member.link",
    "onboard.person.create", "onboard.person.lookup", "onboard.person.status", "onboard.phone.add",
    "onboard.space.current", "onboard.space.join", "onboard.space.list", "onboard.space.open", "onboard.space.poll",
  ]);
  const manifest = JSON.parse(fs.readFileSync(new URL("./module.json", import.meta.url), "utf8"));
  const rows = new Map(manifest.does.tools.filter((t) => typeof t === "object").map((t) => [t.name, t]));
  for (const name of ["onboard.person.create", "onboard.github.finish", "onboard.space.join", "onboard.space.open", "onboard.space.current", "onboard.member.link", "onboard.computer.add", "onboard.phone.add"]) {
    assert.equal(rows.get(name).outward, true, name);
    assert.equal(rows.get(name).effect, "write", name);
    assert.equal(rows.get(name).reach, "anyone", name);
  }
  for (const name of ["onboard.person.lookup", "onboard.person.status", "onboard.github.start", "onboard.join.read", "onboard.space.poll", "onboard.space.list"]) {
    assert.equal(rows.get(name).outward, undefined, name);
    assert.equal(rows.get(name).effect, "read", name);
  }
  assert.equal(rows.get("onboard.first.done").effect, "write");
  assert.equal(rows.get("onboard.first.done").reach, "person");
  assert.equal(rows.get("onboard.first.done").outward, undefined);
});

test("github start returns the address from the kernel config and nothing else", async () => {
  const quiet = harness();
  const none = await quiet.tools.get("onboard.github.start").run({}, {});
  assert.equal(none.url, null);
  assert.deepEqual(none.pending, ["github.start"]);
  const { tools, ctx } = harness();
  ctx.config = { github: { start: "https://github.com/login/device" } };
  const started = await tools.get("onboard.github.start").run({}, {});
  assert.equal(started.url, "https://github.com/login/device");
  assert.equal(started.pending, undefined);
  ctx.config = { github: { start: "http://github.com/login/device" } };
  const refused = await tools.get("onboard.github.start").run({}, {});
  assert.equal(refused.url, null);
});

test("creating a person calls identity.create and never puts the password in the card line", async () => {
  const { tools, calls } = harness();
  const made = await tools.get("onboard.person.create").run({ username: "alex", password: "correct horse battery", confirm: "correct horse battery" }, { caller: "cli" });
  const created = calls.filter((c) => c.name === "identity.create");
  assert.equal(created.length, 1);
  assert.equal(calls.some((c) => c.name === "identity.status"), true);
  assert.equal(created[0].input.code, undefined);
  assert.equal(made.recoveryKey, "R1-TEST-KEY");
  assert.equal(made.route, "https://vyre.run/u/alex");
  assert.equal(made.once, true);
  const line = lineOfOp("onboard.person.create", { username: "alex", password: "correct horse battery" }, "An assistant");
  assert.match(line, /alex/);
  assert.doesNotMatch(line, /horse/);
  await assert.rejects(() => tools.get("onboard.person.create").run({ username: "alex", password: "short" }, {}), /12 characters/);
});

test("the install command is the pairing line, and an invite goes through the spaces tool", async () => {
  const { tools, calls } = harness();
  const opened = await tools.get("onboard.space.open").run({ kind: "linux", name: "juniper" }, { caller: "cli" });
  assert.equal(calls.some((c) => c.name === "wink.install.issue" && c.input.os === "linux"), true);
  assert.equal(commandOk(opened.command), true);
  assert.match(opened.command, /VYRE_CODE=/);
  assert.equal(opened.code, undefined);
  const mac = await tools.get("onboard.space.open").run({ kind: "mac" }, {});
  assert.match(mac.command, /install-mac-server\.sh/);
  const polled = await tools.get("onboard.space.poll").run({ id: opened.id }, { caller: "cli" });
  assert.equal(polled.online, false);
  assert.equal(calls.some((c) => c.name === "wink.install.complete"), true);
  const link = await tools.get("onboard.member.link").run({ role: "member", ttlDays: 7, space: "juniper" }, {});
  assert.equal(link.link, "https://vyre.run/i/abcdefghijk");
  const read = await tools.get("onboard.join.read").run({ link: link.link }, {});
  assert.equal(read.role, "member");
  assert.equal(read.space, "juniper");
  const join = await tools.get("onboard.space.join").run({ link: link.link }, {});
  assert.equal(join.joined, true);
  assert.equal(calls.some((c) => c.name === "spaces.invites.accept"), true);
  const invitesBefore = calls.filter((c) => c.name === "spaces.invites.create").length;
  const phone = await tools.get("onboard.phone.add").run({ space: "juniper" }, {});
  assert.equal(phone.link, "vyre://wink/2?p=phoneseed");
  assert.equal(phone.role, "device");
  assert.equal(phone.code, "WINK-ABCD-EFGH");
  assert.equal(calls.some((c) => c.name === "wink.phone.open"), true, "a phone is paired as the person's own device");
  assert.equal(calls.filter((c) => c.name === "spaces.invites.create").length, invitesBefore, "adding a phone makes no invite for a second person");
  const computer = await tools.get("onboard.computer.add").run({ url: "https://juniper.vyre.run", username: "alex", password: "correct horse battery" }, {});
  assert.equal(computer.url, "https://juniper.vyre.run");
  assert.equal(computer.username, "alex");
  assert.equal("password" in computer, false);
  assert.equal(calls.some((c) => c.name === "devices.signin"), true);
  assert.equal(calls.some((c) => c.name === "spaces.owner.transfer"), false);
  // The card for adding a computer names the server it will sign in to.
  assert.match(lineOfOp("onboard.computer.add", { url: "https://juniper.vyre.run", username: "alex" }, "An assistant"), /juniper\.vyre\.run/);
});

test("one identity is owner of one space and admin of another, and a computer signs into both servers", async () => {
  const { tools, calls } = harness();
  const made = await tools.get("onboard.person.create").run({ username: "alex", password: "correct horse battery", confirm: "correct horse battery" }, { caller: "cli" });
  assert.equal(made.already, false);
  assert.equal(made.id, "id_alex");
  const again = await tools.get("onboard.person.create").run({ username: "other", password: "correct horse battery", confirm: "correct horse battery" }, { caller: "cli" });
  assert.equal(again.already, true);
  assert.equal(again.username, "alex");
  assert.equal(again.id, "id_alex");
  assert.equal(again.recoveryKey, null);
  assert.equal(calls.filter((c) => c.name === "identity.create").length, 1);

  const opened = await tools.get("onboard.space.open").run({ kind: "linux", name: "studio" }, { caller: "cli" });
  assert.equal(opened.role, "owner");
  const join = await tools.get("onboard.space.join").run({ link: "https://vyre.run/i/adminlink1" }, { caller: "cli" });
  assert.equal(join.role, "admin");
  assert.equal(join.space, "juniper");
  assert.equal(join.server, "https://juniper.vyre.run");

  const list = await tools.get("onboard.space.list").run({}, {});
  assert.equal(list.person, "alex");
  assert.equal(list.id, "id_alex");
  assert.equal(list.spaces.length, 2);
  const byName = Object.fromEntries(list.spaces.map((s) => [s.name, s]));
  assert.equal(byName.studio.role, "owner");
  assert.equal(byName.studio.server, null);
  assert.equal(byName.juniper.role, "admin");
  assert.equal(byName.juniper.server, "https://juniper.vyre.run");

  const chosen = await tools.get("onboard.space.current").run({ space: byName.juniper.id }, {});
  assert.equal(chosen.role, "admin");
  assert.equal((await tools.get("onboard.space.list").run({}, {})).current, byName.juniper.id);
  await assert.rejects(() => tools.get("onboard.space.current").run({ space: "spc_missing" }, {}), /not one this identity/);

  const computer = await tools.get("onboard.computer.add").run({ url: "https://studio.vyre.run", username: "alex", password: "correct horse battery" }, {});
  const signins = calls.filter((c) => c.name === "devices.signin");
  assert.deepEqual(signins.map((c) => c.input.server).sort(), ["https://juniper.vyre.run", "https://studio.vyre.run"]);
  assert.equal(signins.every((c) => c.input.username === "alex" && c.input.password === "correct horse battery"), true);
  assert.equal(computer.added, true);
  assert.deepEqual(computer.missing, []);
  assert.equal("password" in computer, false);
  assert.equal("carry" in computer, false);
  const againList = await tools.get("onboard.space.list").run({}, {});
  assert.equal(againList.spaces.find((s) => s.name === "studio").server, "https://studio.vyre.run");
  assert.equal(againList.id, "id_alex");
  const againComputer = await tools.get("onboard.computer.add").run({ username: "alex", password: "correct horse battery" }, {});
  const both = calls.filter((c) => c.name === "devices.signin");
  assert.equal(both.length, 4);
  assert.deepEqual(both.slice(2).map((c) => c.input.server).sort(), ["https://juniper.vyre.run", "https://studio.vyre.run"]);
  assert.deepEqual(againComputer.servers.slice().sort(), ["https://juniper.vyre.run", "https://studio.vyre.run"]);
  assert.equal(againComputer.added, true);
  assert.equal(againComputer.live, true);
  assert.equal(againComputer.devices.length, 2);
  const line = lineOfOp("onboard.computer.add", { username: "alex", password: "correct horse battery" }, "An assistant");
  assert.doesNotMatch(line, /horse/);
  const shown = lineOfOp("onboard.space.current", { space: "juniper" }, "An assistant");
  assert.match(shown, /juniper/);
  assert.equal(calls.some((c) => c.name === "spaces.owner.transfer"), false);
});

test("a person poll makes the space vault once the server has adopted the creator", async () => {
  const space = "spc_aaaaaaaaaa";
  const status = { issued: true, owned: true, locked: true, space, expires: Math.floor(Date.now() / 1000) + 1800 };
  const { tools, calls } = harness({ status });
  const opened = await tools.get("onboard.space.open").run({ kind: "linux", name: "juniper" }, { caller: "cli" });
  const polled = await tools.get("onboard.space.poll").run({ id: opened.id }, { caller: "cli" });
  assert.equal(polled.online, true);
  assert.equal(polled.space, space);
  const creates = calls.filter((c) => c.name === "vault.space.create");
  assert.equal(creates.length, 1);
  assert.equal(creates[0].input.space, space);
  const again = await tools.get("onboard.space.poll").run({ id: opened.id }, { caller: "cli" });
  assert.equal(again.online, true);
  assert.equal(again.space, space);
  assert.equal(calls.filter((c) => c.name === "vault.space.create").length, 2);
  const list = await tools.get("onboard.space.list").run({}, {});
  assert.equal(list.spaces.find((s) => s.name === "juniper").id, space);
  const agent = harness({ status });
  const opened2 = await agent.tools.get("onboard.space.open").run({ kind: "linux", name: "studio" }, { caller: "mcp" });
  const agentPoll = await agent.tools.get("onboard.space.poll").run({ id: opened2.id }, { caller: "mcp" });
  assert.equal(agentPoll.online, true);
  assert.equal(agentPoll.space, space);
  assert.equal(agent.calls.some((c) => c.name === "vault.space.create"), false);
  assert.equal(calls.some((c) => c.name === "spaces.owner.transfer"), false);
});

test("first run does not transfer ownership from a phone or ask for a typed code", () => {
  const src = fs.readFileSync(new URL("./first-run.js", import.meta.url), "utf8");
  const screen = fs.readFileSync(new URL("../../apps/app/screens/first-run/FirstRun.tsx", import.meta.url), "utf8");
  for (const text of [src, screen]) {
    assert.equal(/spaces\.owner\.transfer|grants\.transferOwner|wink\.phone\.open|Face ID signature|MatchWords|four words|Solo/.test(text), false);
  }
});

test("a poll stops hard when another server answered the install line first", async () => {
  const { tools } = harness({ completeCode: "contested" });
  await tools.get("onboard.person.create").run({ username: "alex", password: "correct horse battery", confirm: "correct horse battery" }, { caller: "cli" });
  const opened = await tools.get("onboard.space.open").run({ kind: "linux", name: "studio" }, { caller: "cli" });
  const polled = await tools.get("onboard.space.poll").run({ id: opened.id }, { caller: "cli" });
  assert.equal(polled.online, false);
  assert.equal(polled.contested, true);
  assert.match(String(polled.message), /Another server answered/);
  const waiting = harness();
  await waiting.tools.get("onboard.person.create").run({ username: "alex", password: "correct horse battery", confirm: "correct horse battery" }, { caller: "cli" });
  const w = await waiting.tools.get("onboard.space.open").run({ kind: "linux", name: "studio" }, { caller: "cli" });
  const p = await waiting.tools.get("onboard.space.poll").run({ id: w.id }, { caller: "cli" });
  assert.equal(p.contested, undefined, "an ordinary wait is not a hard stop");
});
