// @ts-check
// `vyre connect` and `vyre mcp` as a person runs them: the real `vyre` binary in a child process
// against a real vyred in a temp home (with `present` as its verifier, so the vault grant needs
// no dialog), fake MCP servers and the fake Google. Never a real server, Google or `claude`.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { start } from "../../daemon/index.js";
import { tempHome, present } from "../../../test/helpers.js";
import { startFakeMcpHttp } from "../../mcp/testing/fake-mcp.js";
import { startFakeGoogle } from "../../connectors/testing/fake-google.js";
import { INSTALL_LINE } from "./mcp.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "..", "..", "bin", "vyre");
const FAKE = path.join(HERE, "..", "..", "mcp", "testing", "fake-mcp.js");
const fake = label => `fixture-${label}-${crypto.randomBytes(12).toString("hex")}`;
const S = "https://www.googleapis.com/auth/";

/** Run `vyre` as a person would. @param {string} root @param {string[]} args @param {Record<string, string>} [env] */
function vyre(root, args, env = {}) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, VYRE_HOME: root, NO_COLOR: "1", ...env } });
    let out = "", err = "";
    p.stdout.on("data", c => { out += c; });
    p.stderr.on("data", c => { err += c; });
    p.on("close", code => resolve({ code, out, err, all: out + err }));
    p.stdin.end();
  });
}

async function vyred(t) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const cli = (tool, input = {}) => d.registry.call(tool, input, "cli");
  const put = async (name, fields, kind = "api-key") => assert.ok((await cli("vault.put", { name, kind, fields })).data, `vault.put ${name}`);
  return { root, d, cli, put };
}

test("connect: add, list, test and remove MCP servers, granting their vault items on the way", async t => {
  const v = await vyred(t);
  const gh = fake("gh"), token = fake("tracker");
  await v.put("gh-token", { value: gh });
  await v.put("tracker-token", { value: token });

  const empty = await vyre(v.root, ["connect"]);
  assert.equal(empty.code, 0, empty.all);
  assert.match(empty.out, /nothing connected yet/);

  // stdio, with an env var from the vault that the server refuses to start without.
  const log = path.join(v.root, "fake.log");
  const added = await vyre(v.root, ["connect", "add", "mcp", "local-tracker", "--project", "harlow-site", "--agent", "juno",
    "--env", "GH_TOKEN=gh-token", "--var", "FAKE_MCP_REQUIRE_ENV=GH_TOKEN", "--var", `FAKE_MCP_LOG=${log}`, "--", process.execPath, FAKE, "--stdio"]);
  assert.equal(added.code, 0, added.all);
  assert.match(added.out, /added local-tracker · mcp stdio · projects harlow-site · agents juno/);
  assert.match(added.out, /granted gh-token to mcp/);
  assert.match(added.out, /ok local-tracker has 6 tools/);

  // http, with a bearer token the fake requires.
  const http = await startFakeMcpHttp(t, { requireAuth: `Bearer ${token}` });
  const web = await vyre(v.root, ["connect", "add", "mcp", "tracker", "--url", http.url, "--auth", "bearer", "--item", "tracker-token"]);
  assert.equal(web.code, 0, web.all);
  assert.match(web.out, /added tracker · mcp http · every project · every agent/);
  assert.match(web.out, /granted tracker-token to mcp/);
  assert.match(web.out, /ok tracker has 6 tools/);

  // Mistakes are said before anything reaches vyred.
  assert.match((await vyre(v.root, ["connect", "add", "mcp", "x", "--auth", "bearer", "--url", http.url])).out, /--auth bearer needs --item/);
  assert.match((await vyre(v.root, ["connect", "add", "mcp", "x"])).out, /say how to reach it/);
  assert.match((await vyre(v.root, ["connect", "add", "mcp", "x", "--env", "GH_TOKEN", "--", "node"])).out, /never a value/);
  const secretHeader = await vyre(v.root, ["connect", "add", "mcp", "x", "--url", http.url, "--header", `Authorization:Bearer ${fake("hdr")}`]);
  assert.equal(secretHeader.code, 1);
  assert.match(secretHeader.out, /bad_input/);

  const list = await vyre(v.root, ["connect", "list"]);
  assert.equal(list.code, 0, list.all);
  assert.match(list.out, /local-tracker\s+mcp stdio\s+running\s+6 tools/);
  assert.match(list.out, /env gh-token · projects harlow-site · agents juno/);
  assert.match(list.out, /tracker\s+mcp http\s+running\s+6 tools/);
  assert.match(list.out, /bearer tracker-token · every project · every agent/);

  const tested = await vyre(v.root, ["connect", "test", "tracker"]);
  assert.equal(tested.code, 0, tested.all);
  assert.match(tested.out, /ok tracker has 6 tools/);

  const removed = await vyre(v.root, ["connect", "remove", "local-tracker"]);
  assert.equal(removed.code, 0, removed.all);
  assert.match(removed.out, /removed local-tracker/);
  const none = await vyre(v.root, ["connect", "test", "local-tracker"]);
  assert.equal(none.code, 1);
  assert.match(none.out, /nothing connected is named local-tracker/);

  for (const r of [added, web, list, tested, removed]) for (const s of [gh, token]) assert.ok(!r.all.includes(s), "a value reached the terminal");
});

test("connect: a Google account with domain-wide delegation, and the scopes Workspace refused", async t => {
  const S_READ = [S + "calendar.readonly", S + "gmail.readonly"];
  const g = await startFakeGoogle(t, { allowedScopes: S_READ });
  const v = await vyred(t);
  const sa = g.serviceAccount("alex@example.com");
  await v.put("work-google", { value: sa }, "secret");

  const added = await vyre(v.root, ["connect", "add", "google", "work", "--email", "alex@example.com", "--item", "work-google", "--dwd", "--base", g.base]);
  assert.equal(added.code, 1, "a refused scope is a failed test");
  assert.match(added.out, /added work · google alex@example.com · service-account/);
  assert.match(added.out, /granted work-google to google/);
  assert.match(added.out, /refused calendar\.events, gmail\.compose, gmail\.send/);
  assert.match(added.out, /Domain-wide delegation/);
  const acct = (await v.cli("google.accounts")).data[0];
  assert.deepEqual(acct.auth, { type: "service-account", item: "work-google", subject: "alex@example.com" });
  assert.equal(g.apiCalls().filter(c => c.method !== "GET").length, 0, "a service account's test knocks on no write");

  const list = await vyre(v.root, ["connect", "list"]);
  assert.match(list.out, /work\s+google\s+connected\s+alex@example.com/);
  assert.match(list.out, /service-account work-google · acts as alex@example.com/);

  assert.match((await vyre(v.root, ["connect", "add", "google", "home", "--item", "x"])).out, /--email <address> --item <vault item>/);

  const gone = await vyre(v.root, ["connect", "remove", "google", "work"]);
  assert.equal(gone.code, 0, gone.all);
  assert.match(gone.out, /removed work/);
  assert.equal((await v.cli("google.accounts")).data.length, 0);
  for (const line of sa.split("\n")) if (line.length > 24) assert.ok(!(added.all + list.all).includes(line), "a key line reached the terminal");
});

test("vyre mcp: serves JSON-RPC and nothing else on stdout; install prints the line and runs claude only with --yes", async t => {
  const v = await vyred(t);
  const help = await vyre(v.root, ["help"]);
  assert.match(help.out, /vyre mcp \[install \[--yes\]\]\s+the Vyre MCP server on stdio, for plain claude/);
  assert.match(help.out, /vyre connect/);

  // A fake claude that writes down what it was asked to do.
  const bin = path.join(v.root, "bin");
  fs.mkdirSync(bin);
  const said = path.join(v.root, "claude-args");
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\necho "$@" > "${said}"\n`, { mode: 0o755 });
  const env = { PATH: `${bin}:${process.env.PATH}` };

  const dry = await vyre(v.root, ["mcp", "install"], env);
  assert.equal(dry.code, 0, dry.all);
  assert.equal(dry.out.split("\n")[0].trim(), "claude mcp add -s user vyre -- vyre mcp");
  assert.equal(INSTALL_LINE, "claude mcp add -s user vyre -- vyre mcp");
  assert.ok(!fs.existsSync(said), "without --yes, claude is not run");
  const yes = await vyre(v.root, ["mcp", "install", "--yes"], env);
  assert.equal(yes.code, 0, yes.all);
  assert.equal(fs.readFileSync(said, "utf8").trim(), "mcp add -s user vyre -- vyre mcp");

  const p = spawn(process.execPath, [BIN, "mcp"], { env: { ...process.env, VYRE_HOME: v.root, VYRE_AGENT: "", VYRE_AGENT_KEY: "" } });
  let raw = "";
  const replies = new Map();
  p.stdout.on("data", c => {
    raw += c;
    for (const l of raw.split("\n").slice(0, -1)) { const m = JSON.parse(l); replies.get(m.id)?.(m); }
    raw = raw.slice(raw.lastIndexOf("\n") + 1);
  });
  let all = "";
  p.stdout.on("data", c => { all += c; });
  const rpc = (id, method, params) => new Promise(r => { replies.set(id, r); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  assert.equal((await rpc(1, "initialize", { protocolVersion: "2025-06-18" })).result.serverInfo.name, "vyre");
  const tools = (await rpc(2, "tools/list", {})).result.tools;
  assert.ok(tools.some(x => x.name === "system_echo"));
  const exit = new Promise(r => p.on("close", r));
  p.stdin.end();
  assert.equal(await exit, 0, "it ends when stdin closes");
  for (const l of all.split("\n").filter(Boolean)) assert.equal(JSON.parse(l).jsonrpc, "2.0", `not JSON-RPC on stdout: ${l.slice(0, 80)}`);
});
