// @ts-check
// `vyre presence` keys and remove, with their aliases (list, ls, rm), against a fake vyred on a
// unix socket in a temp home: what the CLI asks vyred, what it prints, --json, and the refusals.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tempHome } from "../../../test/helpers.js";
import * as config from "../../config/index.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin", "vyre");

/** A fake vyred holding two keys. presence.remove drops one by id, or says there is no such key. */
async function fakeVyred(t) {
  const root = tempHome(t);
  const socket = config.paths(root).socket;
  if (path.dirname(socket) !== root) config.privateSocketDir();
  const keys = [
    { id: "k_capsule", kind: "capsule", label: "alex's Mac", created: Date.UTC(2026, 8, 1) },
    { id: "k_deck", kind: "passkey", label: "juno", created: Date.UTC(2026, 8, 20) },
  ];
  const calls = /** @type {{ tool: string, body: any }[]} */ ([]);
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", c => { raw += c; });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const send = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      const tool = decodeURIComponent(String(req.url).replace("/v1/tools/", ""));
      calls.push({ tool, body });
      if (tool === "presence.keys") return send(200, { data: { keys } });
      // A code needs a person: this fake asks for one, as vyred does without a proof.
      if (tool === "presence.code") return send(403, { error: { code: "presence_required", message: "presence.code needs you", methods: ["tty"] } });
      if (tool === "presence.remove") {
        const i = keys.findIndex(k => k.id === body.id);
        if (i < 0) return send(400, { error: { code: "bad_input", message: `no key ${body.id}` } });
        keys.splice(i, 1);
        return send(200, { data: { removed: body.id } });
      }
      send(404, { error: { code: "no_such_tool", message: `no tool ${tool}` } });
    });
  });
  await new Promise(r => server.listen(socket, () => r(undefined)));
  t.after(() => new Promise(r => server.close(() => r(undefined))));
  return { root, calls, keys };
}

function vyre(root, args) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [BIN, ...args], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, VYRE_HOME: root, NO_COLOR: "1" } });
    let out = "", err = "";
    p.stdout.on("data", c => { out += c; });
    p.stderr.on("data", c => { err += c; });
    p.on("close", code => resolve({ code, out, err, all: out + err }));
  });
}

test("presence cli: keys, list and ls print the same keys; --json is the array", async t => {
  const { root } = await fakeVyred(t);
  const keys = await vyre(root, ["presence", "keys"]);
  assert.equal(keys.code, 0, keys.all);
  assert.match(keys.out, /k_capsule capsule alex's Mac 2026-09-01/);
  assert.match(keys.out, /k_deck passkey juno 2026-09-20/);
  assert.equal((await vyre(root, ["presence", "list"])).out, keys.out);
  assert.equal((await vyre(root, ["presence", "ls"])).out, keys.out);
  assert.equal((await vyre(root, ["presence"])).out, keys.out, "keys is the default");
  const j = await vyre(root, ["presence", "ls", "--json"]);
  assert.equal(j.code, 0);
  assert.deepEqual(JSON.parse(j.out).map(k => k.id), ["k_capsule", "k_deck"]);
});

test("presence cli: remove and rm drop a key by id; --json says which", async t => {
  const { root, calls, keys } = await fakeVyred(t);
  const r = await vyre(root, ["presence", "remove", "k_deck"]);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /removed key k_deck/);
  assert.deepEqual(calls.at(-1), { tool: "presence.remove", body: { id: "k_deck" } });
  assert.deepEqual(keys.map(k => k.id), ["k_capsule"]);
  const rm = await vyre(root, ["presence", "rm", "k_capsule", "--json"]);
  assert.equal(rm.code, 0, rm.all);
  assert.deepEqual(JSON.parse(rm.out), { removed: "k_capsule" });
  assert.equal(keys.length, 0);
  assert.match((await vyre(root, ["presence", "keys"])).out, /no keys enrolled/);
});

test("presence cli: remove with no id, or an unknown verb, is a usage error (exit 2) with a next step", async t => {
  const { root, calls } = await fakeVyred(t);
  const bare = await vyre(root, ["presence", "remove"]);
  assert.equal(bare.code, 2, bare.all);
  assert.match(bare.all, /vyre presence remove needs a key id/);
  assert.match(bare.all, /next: vyre presence keys lists them/);
  const j = await vyre(root, ["presence", "rm", "--json"]);
  assert.equal(j.code, 2);
  assert.deepEqual(JSON.parse(j.out).error, { code: "bad_input", message: "vyre presence remove needs a key id", next: "vyre presence keys lists them" });
  assert.equal(calls.length, 0, "a usage error never reaches vyred");
  const odd = await vyre(root, ["presence", "forget", "k_deck"]);
  assert.equal(odd.code, 2);
  assert.match(odd.all, /vyre presence forget: not a subcommand/);

  // vyred's own refusal is a failure (exit 1), not a usage error.
  const ghost = await vyre(root, ["presence", "remove", "k_ghost"]);
  assert.equal(ghost.code, 1, ghost.all);
  assert.match(ghost.all, /no key k_ghost/);
});

/** Every stdout line of a --view run, parsed. @param {string} s */
const frames = s => s.trim().split("\n").map(l => JSON.parse(l));

test("presence cli: vyre commands lists every verb run() handles, with aliases", async t => {
  const root = tempHome(t);
  const r = await vyre(root, ["commands", "presence", "--json"]);
  assert.equal(r.code, 0, r.all);
  const verbs = JSON.parse(r.out).commands[0].verbs;
  assert.deepEqual(verbs.map(v => [v.verb, v.aliases || [], Boolean(v.read), Boolean(v.person)]),
    [["keys", ["list", "ls"], true, false], ["code", [], false, true], ["remove", ["rm"], false, true]]);
  assert.deepEqual(verbs.find(v => v.verb === "remove").args, [{ name: "id", required: true }]);
});

test("presence cli: --view draws the keys as a table, and a verb that needs a person never prompts", async t => {
  const { root, keys } = await fakeVyred(t);
  const k = await vyre(root, ["presence", "keys", "--view"]);
  assert.equal(k.code, 0, k.all);
  const f = frames(k.out);
  assert.deepEqual([f[0].cmd, f[0].view.kind, f[0].view.columns.map(c => c.key)], ["presence keys", "table", ["id", "kind", "label", "created"]]);
  assert.deepEqual(f[0].data, keys, "data is what --json prints");
  assert.deepEqual(f.at(-1), { v: 1, done: true, exit: 0 });
  // presence.code asks for a person: under --view that is exit 3 with no prompt, as an error frame.
  const c = await vyre(root, ["presence", "code", "--view"]);
  assert.equal(c.code, 3, c.all);
  const e = frames(c.out);
  assert.deepEqual([e[0].view.kind, e[0].view.code], ["error", "no_terminal"]);
  assert.match(e[0].view.next, /your own terminal/);
  assert.doesNotMatch(c.err, /Type the code/, "no prompt was written");
});
