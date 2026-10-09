// @ts-check
// Vyre Computer over the link: a box's agent says "on my Mac" and the Mac's own Chrome does it, but only for a class of work (look, act, files) the person allowed for the box on that Mac. Two real
// vyreds (test/link-harness.js), a fake extension on the Mac. Nothing the person did not allow runs; the box cannot send the call except through the computer module.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { until, pair } from "./link-harness.js";
import { fakeExtension } from "../local/hands-chrome-mac/fake-extension.js";

async function world(/** @type {any} */ t, /** @type {any} */ extra = {}) {
  const sockDir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-comp-"));
  t.after(() => fs.rmSync(sockDir, { recursive: true, force: true }));
  const sockPath = path.join(sockDir, "chrome.sock");
  const s = await pair(t, { macConfig: { modules: { disable: ["hands"] }, chrome: { sockPath, extensionOrigin: null }, ...extra } });
  const macs = await until(async () => { const m = (await s.boxCall("link.macs")).data; return m.length === 1 && m[0].online && m; });
  /** @type {any[]} */ const seen = [];
  const x = await fakeExtension(sockPath, { handler: (op, args) => {
    seen.push({ op, args });
    if (op === "tabs.use") return { tab: { id: 1, url: "https://mail.example.com/inbox", title: "Inbox" } };
    if (op === "page.snapshot") return { title: "Inbox", url: "https://mail.example.com/inbox", controls: [{ role: "button", name: "Compose" }] };
    return { ok: true };
  } });
  t.after(() => { x.sock.destroy(); });
  await until(async () => (await s.macCall("chrome.status")).data.connected);
  return { ...s, seen, name: macs[0].name };
}
const KIT = "mcp agent:kit";

test("'on my Mac' runs in the Mac's Chrome only for a class the person allowed there, and stops when it is taken back", { timeout: 120_000 }, async t => {
  const s = await world(t);
  const look = () => s.boxCall("computer.use", { do: "look", on: s.name }, KIT);
  const before = await look();
  assert.ok(before.error, JSON.stringify(before));
  assert.match(JSON.stringify(before), /has not allowed the box|link\.computer\.allow/);
  assert.equal(s.seen.filter(x => x.op === "page.snapshot").length, 0, "nothing ran on the Mac");

  assert.deepEqual((await s.macCall("link.computer.allow", { class: "look" })).data.classes, ["look"]);
  assert.deepEqual((await s.macCall("link.computer.list")).data.classes, ["look"]);
  const out = await look();
  assert.ok(!out.error, JSON.stringify(out));
  assert.equal(out.data.computer, s.name);
  assert.equal(out.data.title, "Inbox");
  assert.ok(s.seen.some(x => x.op === "page.snapshot"), "the Mac's own Chrome was read");

  // another class is its own yes
  const open = await s.boxCall("computer.use", { do: "open", on: s.name, url: "https://example.org/" }, KIT);
  assert.ok(open.error, JSON.stringify(open));
  assert.match(JSON.stringify(open), /act on this Mac|link\.computer\.allow act/);

  assert.equal((await s.macCall("link.computer.revoke", { class: "look" })).data.revoked, true);
  assert.ok((await look()).error, "revoked: the box's look no longer runs");
});

test("the box can send computer.call only through the computer module, and the Mac refuses anything that is not a computer action", { timeout: 120_000 }, async t => {
  const s = await world(t);
  await s.macCall("link.computer.allow", { class: "look" });
  const call = { tool: "computer.call", input: { action: "look", args: {} } };
  for (const caller of ["module:flows", "module:connectors", "mcp", "deck", "cli"]) assert.ok((await s.boxCall("link.macs.call", call, caller)).error, `${caller} may not send computer.call`);
  const ok = await s.boxCall("link.macs.call", call, "module:computer");
  assert.equal(ok.data[0].ok, true, JSON.stringify(ok));
  // an action that is not one a computer does, and a pre-approved one, are refused on the Mac whatever the box says
  const odd = await s.boxCall("link.macs.call", { tool: "computer.call", input: { action: "eval", args: { expression: "1" } } }, "module:computer");
  assert.equal(odd.data[0].ok, false); assert.equal(odd.data[0].error.code, "denied");
  assert.ok((await s.boxCall("link.macs.call", { tool: "computer.call", input: { action: "look", approved: true } }, "module:computer")).error, "no outward path");
  // the person's list is theirs alone: an assistant cannot widen it
  assert.ok((await s.macCall("link.computer.allow", { class: "act" }, "mcp agent:kit")).error, "a model may not allow itself");
});

test("files: the box finds and brings a file from Downloads, Desktop or Documents once the person allowed it, and from nowhere else", { timeout: 120_000 }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vc-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const d of ["Downloads", "Documents", "Library", ".ssh"]) fs.mkdirSync(path.join(home, d));
  const big = crypto.randomBytes(2_500_000);
  fs.writeFileSync(path.join(home, "Downloads", "report-q3.bin"), big);
  fs.writeFileSync(path.join(home, "Library", "report-secret.txt"), "not for the box");
  fs.writeFileSync(path.join(home, ".ssh", "key"), "PRIVATE");
  fs.symlinkSync(path.join(home, "Library", "report-secret.txt"), path.join(home, "Downloads", "report-link.txt"));
  fs.writeFileSync(path.join(home, "Downloads", "huge-report.bin"), Buffer.alloc(9 * 1024 * 1024));
  const s = await world(t, { computer: { home }, files: { roots: ["Downloads", "Documents", "Library"].map(d => path.join(home, d)) } });
  const find = (/** @type {string} */ q) => s.boxCall("computer.use", { do: "find", on: s.name, args: { q } }, KIT);
  const get = (/** @type {string} */ p) => s.boxCall("computer.use", { do: "get", on: s.name, args: { path: p } }, KIT);
  assert.match(JSON.stringify(await find("report")), /link\.computer\.allow files|has not allowed/, "off until the person allows files");
  await s.macCall("link.computer.allow", { class: "files" });
  const found = await find("report");
  assert.ok(!found.error, JSON.stringify(found));
  const names = found.data.results.map((/** @type {any} */ r) => path.basename(r.path));
  assert.ok(names.includes("report-q3.bin"));
  assert.ok(!names.includes("report-secret.txt"), "Library is not on the list");
  // a file arrives whole, in parts, and is the same bytes
  const got = await get(path.join(home, "Downloads", "report-q3.bin"));
  assert.ok(!got.error, JSON.stringify(got).slice(0, 300));
  assert.equal(got.data.size, big.length);
  assert.deepEqual(crypto.createHash("sha256").update(fs.readFileSync(got.data.saved)).digest("hex"), crypto.createHash("sha256").update(big).digest("hex"));
  assert.ok(got.data.saved.includes(path.join("computer", "inbox", "kit")), got.data.saved);
  // nowhere else: another folder, a path that climbs, a symlink out, a dotfile, a file that is too big
  for (const bad of [path.join(home, "Library", "report-secret.txt"), path.join(home, "Downloads", "..", ".ssh", "key"), path.join(home, "Downloads", "report-link.txt"), path.join(home, ".ssh", "key")]) {
    const r = await get(bad);
    assert.ok(r.error, `${bad} must be refused`);
  }
  const huge = await get(path.join(home, "Downloads", "huge-report.bin"));
  assert.match(JSON.stringify(huge), /the most brought at once/);
  assert.equal((await s.macCall("link.computer.revoke", { class: "files" })).data.revoked, true);
  assert.ok((await get(path.join(home, "Downloads", "report-q3.bin"))).error, "revoked");
});
