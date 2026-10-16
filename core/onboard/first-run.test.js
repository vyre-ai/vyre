// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { JOIN_COPY, PHASES, afterIdentity, commandOk, mentionsServer, parseInvite, passwordOk, usernameOf } from "../../lib/first-run-shape.js";
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
  assert.equal(commandOk("curl -fsSL vyre.run/box/install-mac-server.sh | sh"), true);
  assert.equal(commandOk("vyre words"), false);
  assert.equal(commandOk("curl -fsSL vyre.run/i | sh; vyre words"), false);
});

test("the join path never names a server, and identity leads to the path the person chose", () => {
  for (const text of Object.values(JOIN_COPY)) assert.equal(mentionsServer(text), false, text);
  assert.deepEqual(PHASES, ["Identity", "Space", "Ready"]);
  assert.equal(afterIdentity({ path: "join" }), "join.link");
  assert.equal(afterIdentity({ path: "join", heldInvite: "https://vyre.run/i/abcdefgh" }), "join.review");
  assert.equal(afterIdentity({ path: "create" }), "create.kind");
  assert.equal(afterIdentity({}), "space.choice");
  assert.equal(afterIdentity({ path: "computer" }), "computer.add");
  assert.equal(afterIdentity({ path: "phone" }), "phone.add");
});

/** @returns {{ tools: Map<string, any>, saved: any[] }} */
function harness() {
  const tools = new Map();
  const saved = [];
  const ctx = {
    tool: (name, def) => tools.set(name, def),
    events: { emit() {} },
  };
  const tryCall = async () => ({ __error: "missing" });
  registerFirstRun(ctx, { call: async () => { throw new Error("missing"); }, tryCall, save: (p) => saved.push(p) });
  return { tools, saved };
}

test("the first-run tools are the ones the app calls, and an access change is marked outward", () => {
  const { tools } = harness();
  const names = [...tools.keys()].sort();
  assert.deepEqual(names, [
    "onboard.computer.add", "onboard.first.done", "onboard.github.finish", "onboard.github.start", "onboard.join.read", "onboard.member.link",
    "onboard.person.create", "onboard.person.lookup", "onboard.phone.add", "onboard.space.join", "onboard.space.open", "onboard.space.poll",
  ]);
  const manifest = JSON.parse(fs.readFileSync(new URL("./module.json", import.meta.url), "utf8"));
  const rows = new Map(manifest.does.tools.filter((t) => typeof t === "object").map((t) => [t.name, t]));
  for (const name of ["onboard.person.create", "onboard.github.finish", "onboard.space.join", "onboard.space.open", "onboard.member.link", "onboard.computer.add", "onboard.phone.add"]) {
    assert.equal(rows.get(name).outward, true, name);
    assert.equal(rows.get(name).effect, "write", name);
    assert.equal(rows.get(name).reach, "anyone", name);
  }
  for (const name of ["onboard.person.lookup", "onboard.github.start", "onboard.join.read", "onboard.space.poll"]) {
    assert.equal(rows.get(name).outward, undefined, name);
    assert.equal(rows.get(name).effect, "read", name);
  }
  assert.equal(rows.get("onboard.first.done").effect, "write");
  assert.equal(rows.get("onboard.first.done").reach, "person");
  assert.equal(rows.get("onboard.first.done").outward, undefined);
});

test("creating a person returns one recovery key when the vault does, and never puts the password in the card line", async () => {
  const tools = new Map();
  const ctx = { tool: (name, def) => tools.set(name, def), events: { emit() {} } };
  const tryCall = async (name) => (name === "vault.account.create" ? { recoverySecret: "R1-TEST-KEY" } : { __error: "missing" });
  registerFirstRun(ctx, { call: async () => ({}), tryCall, save() {} });
  const made = await tools.get("onboard.person.create").run({ username: "alex", password: "correct horse battery", confirm: "correct horse battery" }, {});
  assert.equal(made.recoveryKey, "R1-TEST-KEY");
  assert.equal(made.route, "https://vyre.run/u/alex");
  assert.equal(made.once, true);
  const line = lineOfOp("onboard.person.create", { username: "alex", password: "correct horse battery" }, "An assistant");
  assert.match(line, /alex/);
  assert.doesNotMatch(line, /horse/);
  const device = lineOfOp("onboard.computer.add", { name: "Desk", type: "windows", fingerprint: "ab12cd34ef56", password: "correct horse battery" }, "An assistant (mcp)");
  assert.match(device, /An assistant \(mcp\)/);
  assert.match(device, /Desk/);
  assert.match(device, /windows/);
  assert.match(device, /ab12cd34ef56/);
  assert.doesNotMatch(device, /horse/);
  await assert.rejects(() => tools.get("onboard.person.create").run({ username: "alex", password: "short" }, {}), /12 characters/);
});

test("the install command is one curl line, and an invite link is the public form until the spaces tool answers", async () => {
  const { tools } = harness();
  const opened = await tools.get("onboard.space.open").run({ kind: "linux", name: "juniper" }, {});
  assert.equal(commandOk(opened.command), true);
  assert.equal(opened.command, "curl -fsSL vyre.run/i | sh");
  assert.deepEqual(opened.pending, ["wink.install.issue", "spaces.pair.install"]);
  const mac = await tools.get("onboard.space.open").run({ kind: "mac" }, {});
  assert.match(mac.command, /vyre\.run\/i/);
  const link = await tools.get("onboard.member.link").run({ role: "member", ttlDays: 7, space: "juniper" }, {});
  assert.match(link.link, /^https:\/\/vyre\.run\/i\/[A-Za-z0-9_-]+$/);
  const read = await tools.get("onboard.join.read").run({ link: link.link }, {});
  assert.equal(read.role, "member");
  assert.equal(read.space, "juniper");
  const join = await tools.get("onboard.space.join").run({ link: link.link }, {});
  assert.equal(join.joined, true);
  const phone = await tools.get("onboard.phone.add").run({ space: "juniper" }, {});
  assert.match(phone.link, /^https:\/\/vyre\.run\/i\//);
  const computer = await tools.get("onboard.computer.add").run({ url: "https://juniper.vyre.run", username: "alex", password: "correct horse battery" }, {});
  assert.equal(computer.url, "https://juniper.vyre.run");
  assert.equal(computer.username, "alex");
  assert.equal("password" in computer, false);
  assert.ok(computer.pending.includes("devices.signin"));
  assert.ok(computer.pending.includes("identity.unlock"));
});

test("a space uses the install line, and a computer uses the sign-in, when those tools answer", async () => {
  const tools = new Map();
  const ctx = { tool: (name, def) => tools.set(name, def), events: { emit() {} } };
  const tryCall = async (name) => {
    if (name === "identity.create") return { username: "alex", recoveryKey: "R1-FROM-IDENTITY" };
    if (name === "wink.install.issue") return { line: "curl -fsSL vyre.run/i | sh" };
    if (name === "wink.install.status") return { owned: true };
    if (name === "wink.install.complete") return { ok: true };
    if (name === "devices.signin") return { username: "alex", unlocked: true };
    return { __error: "missing" };
  };
  registerFirstRun(ctx, { call: async () => ({}), tryCall, save() {} });
  const made = await tools.get("onboard.person.create").run({ username: "alex", password: "correct horse battery" }, {});
  assert.equal(made.recoveryKey, "R1-FROM-IDENTITY");
  assert.equal(made.pending, undefined);
  const opened = await tools.get("onboard.space.open").run({ kind: "linux" }, {});
  assert.equal(opened.pending, undefined);
  const polled = await tools.get("onboard.space.poll").run({ id: opened.id }, {});
  assert.equal(polled.online, true);
  const computer = await tools.get("onboard.computer.add").run({ url: "https://juniper.vyre.run", username: "alex", password: "correct horse battery" }, {});
  assert.equal(computer.unlocked, true);
  assert.equal(computer.pending, undefined);
});
