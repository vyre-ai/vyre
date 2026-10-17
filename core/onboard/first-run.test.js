// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { claim } from "../../lib/github-verified.js";
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
});

/** @param {{ status?: any, config?: any, fetch?: typeof fetch }} [opt] @returns {{ tools: Map<string, any>, saved: any[], calls: { name: string, input: any }[], ctx: any }} */
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
    config: opt.config || {},
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
    if (name === "spaces.invites.preview") { if (opt.preview) return opt.preview(input); throw Object.assign(new Error("no card"), { code: "not_found" }); }
    if (name === "spaces.invites.accept") {
      const link = String(input.link || "");
      if (link.includes("adminlink")) return { space: "spc_juniper", name: "juniper", role: "admin", server: "https://juniper.vyre.run" };
      return { space: "spc_juniper", name: "juniper", role: "member", server: "https://juniper.vyre.run" };
    }
    if (name === "vault.space.create") {
      if (made.has(input.space)) throw Object.assign(new Error("exists"), { code: "exists" });
      made.add(input.space);
      return { generation: 1 };
    }
    if (name === "identity.github.link") return { login: input.login };
    throw Object.assign(new Error(`missing ${name}`), { code: "no_such_tool" });
  };
  registerFirstRun(ctx, { save: (p) => saved.push(p), fetch: opt.fetch });
  return { tools, saved, calls, ctx };
}

test("the first-run tools are the ones the app calls, and an access change is marked outward", () => {
  const { tools } = harness();
  const names = [...tools.keys()].sort();
  assert.deepEqual(names, [
    "onboard.agent.list", "onboard.agent.signin", "onboard.first.done", "onboard.first.progress", "onboard.first.progress.save",
    "onboard.github.finish", "onboard.github.start", "onboard.join.read", "onboard.member.link",
    "onboard.person.create", "onboard.person.lookup", "onboard.person.status",
    "onboard.space.current", "onboard.space.join", "onboard.space.list", "onboard.space.open", "onboard.space.poll",
  ]);
  const manifest = JSON.parse(fs.readFileSync(new URL("./module.json", import.meta.url), "utf8"));
  const rows = new Map(manifest.does.tools.filter((t) => typeof t === "object").map((t) => [t.name, t]));
  for (const name of ["onboard.person.create", "onboard.github.finish", "onboard.space.join", "onboard.space.open", "onboard.space.current", "onboard.member.link"]) {
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

test("github finish reads the numeric account id from GitHub and does not take it from the caller", async () => {
  /** @type {{ url: string, body: any, method: string }[]} */
  const seen = [];
  const token = "gho_testtokenvalue";
  const fetch = async (url, init) => {
    const body = init && init.body ? JSON.parse(String(init.body)) : null;
    seen.push({ url: String(url), body, method: String(init && init.method || "GET") });
    if (String(url) === "https://github.com/login/oauth/access_token") return { ok: true, status: 200, json: async () => ({ access_token: token, token_type: "bearer" }) };
    if (String(url) === "https://api.github.com/user") {
      assert.equal(init && init.headers && init.headers.authorization, `Bearer ${token}`);
      return { ok: true, status: 200, json: async () => ({ id: 4242, login: "Alex-GH" }) };
    }
    if (String(url).startsWith("https://api.github.com/applications/") && init && init.method === "DELETE") return { ok: true, status: 204, json: async () => ({}) };
    throw new Error(String(url));
  };
  const { tools, calls } = harness({
    fetch,
    config: { github: { clientId: "Ov23ct6h9OU5wJHjbqBl", clientSecret: "secret-value-not-returned", redirect: "https://vyre.example/github" } },
  });
  const skipped = await tools.get("onboard.github.finish").run({ login: "alex-gh", subject: "99999" }, { caller: "cli" });
  assert.equal(skipped.linked, false);
  assert.deepEqual(skipped.pending, ["github.start"]);
  assert.equal(calls.some((c) => c.name === "identity.github.link"), false);
  const done = await tools.get("onboard.github.finish").run({ login: "alex-gh", code: "the-login-code", subject: "99999" }, { caller: "cli" });
  assert.equal(done.linked, true);
  assert.equal(done.login, "alex-gh");
  assert.equal(done.vault, "password");
  assert.equal(JSON.stringify(done).includes(token), false);
  assert.equal(JSON.stringify(done).includes("secret-value"), false);
  const link = calls.find((c) => c.name === "identity.github.link");
  assert.ok(link);
  assert.equal(link.input.login, "alex-gh");
  assert.equal(link.input.subject, "4242");
  assert.equal(claim("alex-gh", "99999"), false, "an id the caller typed has no receipt");
  assert.equal(claim("alex-gh", "4242"), true, "the id GitHub returned was vouched for the link");
  const exchange = seen.find((s) => s.url === "https://github.com/login/oauth/access_token");
  assert.ok(exchange);
  assert.equal(exchange.body.code, "the-login-code");
  assert.equal(exchange.body.client_id, "Ov23ct6h9OU5wJHjbqBl");
  assert.equal(seen.some((s) => s.method === "DELETE"), true);
  const line = lineOfOp("onboard.github.finish", { login: "alex-gh", code: "the-login-code", subject: "99999" }, "An assistant");
  assert.match(line, /alex-gh/);
  assert.doesNotMatch(line, /the-login-code/);
  assert.doesNotMatch(line, /99999/);
  await assert.rejects(() => tools.get("onboard.github.finish").run({ login: "other-person", code: "the-login-code" }, {}), /not the account/);
});

test("github finish after start reads the account id from the device sign-in", async () => {
  const fetch = async (url, init) => {
    const u = String(url);
    const body = init && init.body ? JSON.parse(String(init.body)) : null;
    if (u === "https://github.com/login/device/code") return { ok: true, status: 200, json: async () => ({ device_code: "devicecodevalue", user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", expires_in: 900 }) };
    if (u === "https://github.com/login/oauth/access_token") {
      assert.equal(body.device_code, "devicecodevalue");
      assert.equal(body.grant_type, "urn:ietf:params:oauth:grant-type:device_code");
      assert.equal(body.client_secret, undefined);
      return { ok: true, status: 200, json: async () => ({ access_token: "gho_device" }) };
    }
    if (u === "https://api.github.com/user") return { ok: true, status: 200, json: async () => ({ id: 4242, login: "alex-gh" }) };
    throw new Error(u);
  };
  const { tools, calls } = harness({ fetch, config: { github: { start: "https://github.com/login/device", clientId: "Ov23ct6h9OU5wJHjbqBl" } } });
  const started = await tools.get("onboard.github.start").run({}, {});
  assert.equal(started.url, "https://github.com/login/device");
  assert.equal(started.exchange, true);
  const done = await tools.get("onboard.github.finish").run({ login: "alex-gh" }, { caller: "cli" });
  assert.equal(done.linked, true);
  assert.equal(JSON.stringify(done).includes("gho_device"), false);
  const link = calls.find((c) => c.name === "identity.github.link");
  assert.ok(link);
  assert.equal(link.input.subject, "4242");
  assert.equal(link.input.login, "alex-gh");
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
});

test("one identity is owner of one space and admin of another, and the spaces list names both servers", async () => {
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

test("a shared vyre.run/i link names no server, so the review still shows the space and the role from the invite card; a card that cannot be read leaves the name empty", async () => {
  const link = "https://vyre.run/i/inv_0123456789abcdef0123456789abcdef.eyJjaGFpbiI6e319";
  const { tools, calls } = harness({ preview: (/** @type {any} */ input) => (input.link === link ? { space: "juniper.vyre.run", label: "Juniper Studio", role: "admin" } : null) });
  const read = await tools.get("onboard.join.read").run({ link }, {});
  assert.deepEqual([read.space, read.role, read.link], ["juniper", "admin", link]);
  assert.ok(calls.some((c) => c[0] === "spaces.invites.preview" || (c.name === "spaces.invites.preview")), "the invite card was asked");
  const blind = harness().tools;
  const none = await blind.get("onboard.join.read").run({ link }, {});
  assert.deepEqual([none.space, none.role], [null, "member"]);
  const own = await blind.get("onboard.join.read").run({ link: "https://juniper.vyre.run/join/abcdefgh.ijklmnop" }, {});
  assert.deepEqual([own.space, own.role], ["juniper", "member"], "a space's own link names its space without asking");
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
