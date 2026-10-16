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
  assert.equal(commandOk("curl -fsSL vyre.run/i | VYRE_CODE=abc VYRE_STORE=auto sh"), true);
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

/** @returns {{ tools: Map<string, any>, saved: any[], calls: { name: string, input: any }[] }} */
function harness() {
  const tools = new Map();
  const saved = [];
  const calls = [];
  const ctx = {
    tool: (name, def) => tools.set(name, def),
    events: { emit() {} },
  };
  const call = async (name, input) => {
    calls.push({ name, input });
    if (name === "identity.create") return { username: input.username, recoveryKey: "R1-TEST-KEY", url: `https://vyre.run/u/${input.username}` };
    if (name === "wink.install.issue") {
      const line = input.os === "mac"
        ? "curl -fsSL vyre.run/box/install-mac-server.sh | VYRE_CODE=abc VYRE_STORE=auto sh"
        : "curl -fsSL vyre.run/i | VYRE_CODE=abc VYRE_STORE=auto sh";
      return { line, expires: Math.floor(Date.now() / 1000) + 1800, os: input.os };
    }
    if (name === "wink.install.status") return { issued: true, owned: false, locked: false, expires: Math.floor(Date.now() / 1000) + 1800 };
    if (name === "wink.install.complete") throw Object.assign(new Error("not yet"), { code: "bad_state" });
    if (name === "spaces.invites.create") return { link: "https://vyre.run/i/abcdefghijk" };
    if (name === "spaces.invites.accept") return { space: "juniper", role: "member" };
    if (name === "devices.signin") {
      assert.equal("password" in input, true);
      return { ok: true, username: input.username || "alex", server: input.server };
    }
    if (name === "identity.github.link") return { login: input.login };
    throw Object.assign(new Error(`missing ${name}`), { code: "no_such_tool" });
  };
  registerFirstRun(ctx, { call, tryCall: async () => ({ __error: "missing" }), save: (p) => saved.push(p) });
  return { tools, saved, calls };
}

test("the first-run tools are the ones the app calls, and an access change is marked outward", () => {
  const { tools } = harness();
  const names = [...tools.keys()].sort();
  assert.deepEqual(names, [
    "onboard.computer.add", "onboard.github.finish", "onboard.github.start", "onboard.join.read", "onboard.member.link",
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
});

test("creating a person calls identity.create and never puts the password in the card line", async () => {
  const { tools, calls } = harness();
  const made = await tools.get("onboard.person.create").run({ username: "alex", password: "correct horse battery", confirm: "correct horse battery" }, { caller: "cli" });
  assert.equal(calls[0].name, "identity.create");
  assert.equal(calls[0].input.code, undefined);
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
  const phone = await tools.get("onboard.phone.add").run({ space: "juniper" }, {});
  assert.match(phone.link, /^https:\/\/vyre\.run\/i\//);
  const computer = await tools.get("onboard.computer.add").run({ url: "https://juniper.vyre.run", username: "alex", password: "correct horse battery" }, {});
  assert.equal(computer.url, "https://juniper.vyre.run");
  assert.equal(computer.username, "alex");
  assert.equal("password" in computer, false);
  assert.equal(calls.some((c) => c.name === "devices.signin"), true);
  assert.equal(calls.some((c) => c.name === "spaces.owner.transfer"), false);
});

test("first run does not transfer ownership from a phone or ask for a typed code", () => {
  const src = fs.readFileSync(new URL("./first-run.js", import.meta.url), "utf8");
  const screen = fs.readFileSync(new URL("../../apps/app/screens/first-run/FirstRun.tsx", import.meta.url), "utf8");
  for (const text of [src, screen]) {
    assert.equal(/spaces\.owner\.transfer|grants\.transferOwner|wink\.phone\.open|Face ID signature|MatchWords|four words|Solo/.test(text), false);
  }
});
