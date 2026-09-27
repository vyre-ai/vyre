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
import { CLIENT_PUT } from "./connect.js";

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

/**
 * Run `vyre` with stdin left open, as a person at a terminal would, never a TTY and never with
 * dialogs. `line(re)` waits for a stdout line that matches.
 * @param {string} root @param {string[]} args
 */
function live(root, args) {
  const p = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, VYRE_HOME: root, NO_COLOR: "1", VYRE_NO_DIALOGS: "1" } });
  let out = "", err = "";
  /** @type {{ re: RegExp, resolve: (s: string) => void }[]} */ const waits = [];
  const check = () => {
    for (const w of [...waits]) {
      const hit = out.split("\n").find(l => w.re.test(l));
      if (hit !== undefined) { waits.splice(waits.indexOf(w), 1); w.resolve(hit); }
    }
  };
  p.stdout.on("data", c => { out += c; check(); });
  p.stderr.on("data", c => { err += c; });
  const done = new Promise(resolve => p.on("close", code => resolve({ code, out, err, all: out + err })));
  /** @param {RegExp} re @returns {Promise<string>} */
  const line = re => Promise.race([new Promise(resolve => { waits.push({ re, resolve }); check(); }),
    done.then(r => { throw new Error(`vyre ended before ${re}: ${r.all}`); })]);
  return { p, line, done };
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

test("connect --json: list, add, test and remove print one JSON value; --json after -- is the server's", async t => {
  const v = await vyred(t);
  const token = fake("tracker");
  await v.put("tracker-token", { value: token });
  const j = async args => {
    const r = await vyre(v.root, args);
    assert.equal(r.out.trim().split("\n").length, 1, `one line of JSON: ${r.all}`);
    return { code: r.code, data: JSON.parse(r.out), all: r.all };
  };

  assert.deepEqual((await j(["connect", "--json"])).data, { mcp: [], google: [] });

  const http = await startFakeMcpHttp(t, { requireAuth: `Bearer ${token}` });
  const web = await j(["connect", "add", "mcp", "tracker", "--url", http.url, "--auth", "bearer", "--item", "tracker-token", "--json"]);
  assert.equal(web.code, 0, web.all);
  assert.equal(web.data.added.name, "tracker");
  assert.deepEqual(web.data.grants, [{ item: "tracker-token", module: "mcp", status: "active", ...(web.data.grants[0].id ? { id: web.data.grants[0].id } : {}) }]);
  assert.equal(web.data.test.ok, true);
  assert.equal(web.data.test.tools.length, 6);

  // After `--`, --json is the server command's own argument, and is kept.
  const local = await j(["connect", "add", "mcp", "local", "--json", "--", process.execPath, FAKE, "--stdio", "--json"]);
  assert.equal(local.code, 0, local.all);
  assert.deepEqual(local.data.added.args, [FAKE, "--stdio", "--json"]);
  assert.deepEqual(local.data.grants, []);
  assert.equal(local.data.test.ok, true);

  const list = await j(["connect", "list", "--json"]);
  assert.deepEqual(list.data.mcp.map(s => [s.name, s.transport]).sort(), [["local", "stdio"], ["tracker", "http"]]);
  assert.deepEqual(list.data.google, []);

  const tested = await j(["connect", "test", "tracker", "--json"]);
  assert.equal(tested.code, 0);
  assert.equal(tested.data.ok, true);

  const bad = await j(["connect", "add", "mcp", "x", "--json"]);
  assert.equal(bad.code, 1);
  assert.equal(bad.data.error.code, "bad_input");
  assert.match(bad.data.error.message, /say how to reach it/);
  const nobody = await j(["connect", "test", "nobody", "--json"]);
  assert.equal(nobody.code, 1);
  assert.match(nobody.data.error.message, /nothing connected is named nobody/);

  const removed = await j(["connect", "remove", "local", "--json"]);
  assert.equal(removed.code, 0);
  assert.equal(removed.data.kind, "mcp");
  assert.equal(removed.data.name, "local");
  for (const r of [web, list, tested]) assert.ok(!r.all.includes(token), "a value reached the terminal");
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
  assert.match(help.out, /vyre mcp \[serve \| install \[--yes\]\] \[--json\]\s+the Vyre MCP server on stdio, for plain claude/);
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

test("connect: Sign in with Google from the terminal, over the loopback", async t => {
  const g = await startFakeGoogle(t);
  const v = await vyred(t);
  const client = g.oauthClient();
  await v.put("google-oauth-client", client, "env-set");

  const run = live(v.root, ["connect", "add", "google", "home", "--sign-in", "--base", g.base]);
  const url = (await run.line(/^https?:\/\//)).trim();
  assert.ok(url.startsWith(`${g.base}/o/oauth2/v2/auth?`), url);
  const page = await fetch(g.consent(url));
  assert.equal(page.status, 200);
  const r = await run.done;
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /granted google-oauth-client to google/);
  assert.match(r.out, /Open this address in a browser\. Signing in on another device\? Paste the address it lands on here\./);
  assert.match(r.out, /added home alex@example\.com/);
  assert.match(r.out, /ok home/);
  assert.deepEqual((await v.cli("google.accounts")).data.map(a => [a.name, a.email, a.auth.item]), [["home", "alex@example.com", "google-home"]]);
  for (const s of [client.client_secret, ...g.issued.keys()]) assert.ok(!r.all.includes(s), "a value reached the terminal");
});

test("connect: Sign in with Google on another device, by pasting the address it landed on", async t => {
  const g = await startFakeGoogle(t);
  const v = await vyred(t);
  await v.put("bakery-client", g.oauthClient(), "env-set");

  const run = live(v.root, ["connect", "add", "google", "bakery", "--sign-in", "--client", "bakery-client", "--base", g.base]);
  const url = (await run.line(/^https?:\/\//)).trim();
  await run.line(/Paste the address it lands on here/);
  const back = g.consent(url, { email: "kit@northwindbakery.com" });
  run.p.stdin.write("not an address\n");
  run.p.stdin.write(back + "\n");
  const r = await run.done;
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /that is not an address/);
  assert.match(r.out, /added bakery kit@northwindbakery\.com/);
  assert.match(r.out, /ok bakery/);
  assert.ok(!r.all.includes(new URL(back).searchParams.get("code") || "-"), "the code reached the terminal");
});

test("connect: Sign in with Google without a client item says how to put one, and does nothing else", async t => {
  const v = await vyred(t);
  const r = await vyre(v.root, ["connect", "add", "google", "home", "--sign-in"], { VYRE_NO_DIALOGS: "1" });
  assert.equal(r.code, 1, r.all);
  assert.match(r.out, /the vault has no google-oauth-client/);
  assert.match(r.out, /Desktop app OAuth client from the Google Cloud console/);
  assert.ok(r.out.split("\n").some(l => l.trim() === CLIENT_PUT), r.out);
  assert.equal(CLIENT_PUT, "vyre vault put google-oauth-client --kind env-set --field client_id --field client_secret");
  const events = v.d.registry.deps.events.since(0, { limit: 5000 });
  assert.deepEqual(events.filter(e => e.type.startsWith("google.") || /grant/.test(e.type)).map(e => e.type), []);
  assert.equal((await v.cli("google.accounts")).data.length, 0);
});

test("connect: --sign-in refuses --email, --item and --dwd, and --client needs --sign-in", async t => {
  const v = await vyred(t);
  for (const extra of [["--email", "alex@example.com"], ["--item", "work-google"], ["--dwd"]]) {
    const r = await vyre(v.root, ["connect", "add", "google", "home", "--sign-in", ...extra]);
    assert.equal(r.code, 1, r.all);
    assert.match(r.out, new RegExp(`--sign-in finds the address itself; leave out ${extra[0]}`));
  }
  const r = await vyre(v.root, ["connect", "add", "google", "home", "--client", "x", "--email", "alex@example.com", "--item", "y"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /--client goes with --sign-in/);
  const help = await vyre(v.root, ["connect", "help"]);
  assert.match(help.out, /vyre connect add google <name> --sign-in \[--client <vault item>\]/);
});

test("connect: Ctrl-C cancels an open sign-in and stores nothing", async t => {
  const g = await startFakeGoogle(t);
  const v = await vyred(t);
  await v.put("google-oauth-client", g.oauthClient(), "env-set");

  const run = live(v.root, ["connect", "add", "google", "home", "--sign-in", "--base", g.base]);
  const url = (await run.line(/^https?:\/\//)).trim();
  await run.line(/Paste the address it lands on here/);
  run.p.kill("SIGINT");
  const r = await run.done;
  assert.equal(r.code, 1, r.all);
  assert.match(r.out, /cancelled, nothing stored/);
  const failed = v.d.registry.deps.events.since(0, { limit: 5000 }).filter(e => e.type === "google.connect-failed");
  assert.equal(failed.length, 1);
  assert.match(String((failed[0].payload ?? failed[0].data).error), /cancelled/);
  const late = await fetch(g.consent(url)).then(x => x.status, () => "closed");
  assert.notEqual(late, 200, "the cancelled sign-in no longer takes the browser's return");
  assert.equal((await v.cli("google.accounts")).data.length, 0);
});

test("connect: an empty stdin that is not a terminal does not cancel; the loopback still finishes the sign-in", async t => {
  const g = await startFakeGoogle(t);
  const v = await vyred(t);
  await v.put("google-oauth-client", g.oauthClient(), "env-set");

  const run = live(v.root, ["connect", "add", "google", "home", "--sign-in", "--base", g.base]);
  run.p.stdin.end();
  const url = (await run.line(/^https?:\/\//)).trim();
  await run.line(/Paste the address it lands on here/);
  const page = await fetch(g.consent(url));
  assert.equal(page.status, 200);
  const r = await run.done;
  assert.equal(r.code, 0, r.all);
  assert.doesNotMatch(r.out, /cancelled/);
  assert.match(r.out, /added home alex@example\.com/);
  assert.match(r.out, /ok home/);
});

test("connect rm: the short name for remove, a usage mistake without a name, and a second rm finds nothing", async t => {
  const v = await vyred(t);
  const added = await vyre(v.root, ["connect", "add", "mcp", "northwind", "--", process.execPath, FAKE, "--stdio"]);
  assert.equal(added.code, 0, added.all);

  const bare = await vyre(v.root, ["connect", "rm"]);
  assert.equal(bare.code, 2, bare.all);
  assert.match(bare.all, /vyre connect remove needs one name/);
  assert.match(bare.all, /next: vyre connect remove \[mcp\|google\] <name> · vyre connect list shows them/);
  const extra = await vyre(v.root, ["connect", "rm", "mcp", "northwind", "juno", "--json"]);
  assert.equal(extra.code, 2);
  assert.equal(JSON.parse(extra.out).error.code, "bad_input");
  assert.equal((await vyre(v.root, ["connect", "test"])).code, 2, "test shares the same check");
  assert.deepEqual(JSON.parse((await vyre(v.root, ["connect", "--json"])).out).mcp.map(s => s.name), ["northwind"], "nothing was removed");

  const gone = await vyre(v.root, ["connect", "rm", "mcp", "northwind", "--json"]);
  assert.equal(gone.code, 0, gone.all);
  const g = JSON.parse(gone.out);
  assert.equal(g.kind, "mcp");
  assert.equal(g.name, "northwind");
  assert.deepEqual(JSON.parse((await vyre(v.root, ["connect", "list", "--json"])).out).mcp, []);

  const again = await vyre(v.root, ["connect", "rm", "northwind"]);
  assert.equal(again.code, 1);
  assert.match(again.out, /nothing connected is named northwind · vyre connect list/);
});

test("connect: vyre commands lists every verb run() handles; help is reachable as vyre help connect and as a table", async t => {
  const root = tempHome(t);
  const verbs = JSON.parse((await vyre(root, ["commands", "connect", "--json"])).out).commands[0].verbs;
  assert.deepEqual(verbs.map(v => [v.verb, v.aliases || []]), [["list", []], ["add", []], ["remove", ["rm"]], ["test", []], ["help", []]]);
  assert.deepEqual(verbs.filter(v => v.read).map(v => v.verb), ["list", "help"]);
  const add = verbs.find(v => v.verb === "add");
  assert.deepEqual(add.args.slice(0, 2), [{ name: "choice", required: true, choices: ["mcp", "google"] }, { name: "name", required: true }]);
  assert.ok(["url", "auth", "item", "env", "email", "dwd", "sign-in", "client"].every(n => add.flags.some(f => f.name === n)), "add names its flags");

  // vyre help connect prints every form, like vyre connect help, without starting vyred.
  const h = await vyre(root, ["help", "connect"]);
  assert.equal(h.code, 0, h.all);
  assert.match(h.out, /vyre connect list\|add\|remove\|rm\|test\|help/);
  assert.match(h.out, /vyre connect add google <name> --sign-in/);
  assert.match(h.out, /vyre connect remove \[mcp\|google\] <name>/);
  const hj = JSON.parse((await vyre(root, ["connect", "help", "--json"])).out);
  assert.ok(hj.verbs.some(v => v.usage.startsWith("vyre connect test")), "help --json lists the forms");
  const hv = (await vyre(root, ["connect", "help", "--view"])).out.trim().split("\n").map(l => JSON.parse(l));
  assert.deepEqual([hv[0].cmd, hv[0].view.kind, hv[0].view.title], ["connect help", "table", "vyre connect"]);
  assert.deepEqual(hv.at(-1), { v: 1, done: true, exit: 0 });

  // Any other verb is a usage mistake, exit 2, before vyred is asked anything.
  const bad = await vyre(root, ["connect", "frob", "--json"]);
  assert.equal(bad.code, 2, bad.all);
  assert.equal(JSON.parse(bad.out).error.code, "bad_input");
  assert.equal((await vyre(root, ["connect", "add", "slack", "x"])).code, 2);
  // The read with no vyred: exit 5, an error frame under --view.
  const down = await vyre(root, ["connect", "list", "--view"]);
  assert.equal(down.code, 5, down.all);
  assert.equal(JSON.parse(down.out.split("\n")[0]).view.code, "unreachable");
  assert.ok(!fs.existsSync(path.join(root, "vyred.pid")));
});
