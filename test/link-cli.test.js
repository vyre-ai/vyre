// @ts-check
// `vyre link` as a person runs it: the real bin/vyre in a child process against the Mac and the
// box of test/link-harness.js (two vyreds in temp homes, the tailnet simulated at both ends).
// A browser is a fake `open` that writes down what it was asked to open. No Tailscale, no dialogs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { present } from "./helpers.js";
import { pair, until, OWNER, MAC } from "./link-harness.js";

/** A GET that resolves with the status and body. */
const get = url => new Promise((resolve, reject) => {
  http.get(url, { agent: false }, res => { let b = ""; res.setEncoding("utf8"); res.on("data", c => (b += c)); res.on("end", () => resolve({ status: res.statusCode, body: b })); }).on("error", reject);
});

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "vyre");

/** @returns {Promise<{ code: number, out: string, stdout: string }>} */
const run = (root, args, env = {}) => new Promise(resolve =>
  execFile(process.execPath, [BIN, ...args], { env: { ...process.env, VYRE_HOME: root, NO_COLOR: "1", VYRE_NO_DIALOGS: "1", ...env }, timeout: 30_000 },
    (err, stdout, stderr) => resolve({ code: err ? Number(/** @type {any} */ (err).code ?? 1) : 0, out: stdout + stderr, stdout })));

test("link cli: pair on the Mac, approve on the box, status both sides, signin, signout, unpair", async t => {
  // The box's page takes the owner's passkey for a person session; a stand-in says it did.
  const passkeyPage = { ...present, required: tool => tool === "presence.person.start", verify: async () => ({ ok: true, method: "passkey", keyId: "k1" }) };
  const s = await pair(t, { approve: false, router: true, boxPresence: passkeyPage });

  const before = await run(s.macRoot, ["link", "--json"]);
  assert.equal(before.code, 0, before.out);
  assert.equal(JSON.parse(before.stdout).linked, false);
  const notYet = await run(s.macRoot, ["link"]);
  assert.match(notYet.out, /not paired with a server/);
  assert.match(notYet.out, /vyre link pair <address>/);

  // pair: no address is a usage mistake, with an example.
  const bare = await run(s.macRoot, ["link", "pair"]);
  assert.equal(bare.code, 2, bare.out);
  assert.match(bare.out, /next: vyre link pair <address>/);
  const shown = await run(s.macRoot, ["link", "pair", s.address]);
  assert.equal(shown.code, 0, shown.out);
  assert.match(shown.out, /with the code\s+\d{3}-\d{3}/);
  const p = await run(s.macRoot, ["link", "pair", s.address, "--json"]);
  assert.equal(p.code, 0, p.out);
  const { code } = JSON.parse(p.stdout);
  assert.match(code, /^\d{3}-\d{3}$/);

  // The box lists the waiting Mac, and never its code.
  const waiting = await run(s.boxRoot, ["link", "--json"]);
  assert.equal(waiting.code, 0, waiting.out);
  const w = JSON.parse(waiting.stdout);
  assert.equal(w.role, "box");
  // Two requests: the Mac forgot the first when it asked again, and the box keeps it until it expires.
  assert.ok(w.waiting.length >= 1, waiting.stdout);
  assert.ok(w.waiting.every(q => q.node === "test-mac"));
  assert.deepEqual(w.macs, []);
  assert.ok(!waiting.stdout.includes(code.replace("-", "")));
  assert.match((await run(s.boxRoot, ["link"])).out, /0 paired Macs · [12] waiting/);

  assert.equal((await run(s.boxRoot, ["link", "approve"])).code, 2, "approve needs the code");
  const ok = await run(s.boxRoot, ["link", "approve", code]);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /paired with/);
  await until(async () => (await s.macCall("link.status")).data.linked);

  const linked = await run(s.macRoot, ["link"]);
  assert.equal(linked.code, 0, linked.out);
  assert.match(linked.out, /linked to testbox/);
  assert.match(linked.out, /not signed in on the box: vyre link signin/);
  const macs = JSON.parse((await run(s.boxRoot, ["link", "--json"])).stdout).macs;
  assert.equal(macs.length, 1);
  assert.equal(macs[0].node, "test-mac");

  // signin: the address of the box's page, then the page opens in the browser (a fake open).
  const signinJson = await run(s.macRoot, ["link", "signin", "--json"]);
  assert.equal(signinJson.code, 0, signinJson.out);
  const url = JSON.parse(signinJson.stdout).url;
  assert.equal(new URL(url).pathname, "/person/signin");
  const opened = path.join(s.macRoot, "opened.txt");
  const open = path.join(s.macRoot, "fake-open");
  fs.writeFileSync(open, `#!/bin/sh\necho "$1" >> "${opened}"\n`, { mode: 0o755 });
  const signin = await run(s.macRoot, ["link", "signin"], { VYRE_OPEN_BIN: open });
  assert.equal(signin.code, 0, signin.out);
  assert.ok(signin.out.includes(`confirm with your passkey on your box's page: ${url}`), signin.out);
  await until(() => fs.existsSync(opened) && fs.readFileSync(opened, "utf8").trim() === url, 5000);

  // The person confirms on the box's page, which sends the browser back to the Mac's loopback.
  const u = new URL(url);
  const page = await s.boxCall("presence.person.start", { cc: u.searchParams.get("cc"), return: u.searchParams.get("return") }, `tailnet:${OWNER}`, { peer: MAC });
  assert.ok(!page.error, JSON.stringify(page.error));
  const landed = /** @type {any} */ (await get(page.data.redirect));
  assert.equal(landed.status, 200, landed.body);
  assert.match((await run(s.macRoot, ["link"])).out, /signed in on the box until/);

  const signout = await run(s.macRoot, ["link", "signout"]);
  assert.equal(signout.code, 0, signout.out);
  assert.match(signout.out, /signed out on the box/);
  assert.match((await run(s.macRoot, ["link", "signout"])).out, /was not signed in/);

  const unpair = await run(s.macRoot, ["link", "unpair"]);
  assert.equal(unpair.code, 0, unpair.out);
  assert.match(unpair.out, /^\s+unpaired$/m);
  assert.match((await run(s.macRoot, ["link", "unpair"])).out, /was not paired/);
  assert.equal(JSON.parse((await run(s.macRoot, ["link", "--json"])).stdout).linked, false);

  assert.equal((await run(s.macRoot, ["link", "bogus"])).code, 2);
});

test("link cli: approve without the owner's passkey points at the Deck (exit 3); deny refuses a request", async t => {
  // The box asks for a passkey to approve, which a terminal cannot give.
  const passkey = { ...present, required: tool => tool === "link.pair.approve",
    verify: async () => ({ ok: false, message: "approving a Mac needs your passkey", methods: ["passkey"] }) };
  const s = await pair(t, { approve: false, boxPresence: passkey });
  const { code } = JSON.parse((await run(s.macRoot, ["link", "pair", s.address, "--json"])).stdout);

  const refused = await run(s.boxRoot, ["link", "approve", code]);
  assert.equal(refused.code, 3, refused.out);
  assert.match(refused.out, /approve it in the Deck/);
  assert.ok(refused.out.includes(`the code is ${code}`));
  assert.equal((await s.macCall("link.status")).data.linked, false);

  const [req] = JSON.parse((await run(s.boxRoot, ["link", "--json"])).stdout).waiting;
  assert.ok(req && req.id);
  const noId = await run(s.boxRoot, ["link", "deny"]);
  assert.equal(noId.code, 1, noId.out);
  assert.match(noId.out, /no such pairing request/);
  const deny = await run(s.boxRoot, ["link", "deny", req.id]);
  assert.equal(deny.code, 0, deny.out);
  assert.match(deny.out, /refused/);
  assert.deepEqual(JSON.parse((await run(s.boxRoot, ["link", "--json"])).stdout).waiting, []);
});
