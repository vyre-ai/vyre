// @ts-check
// Vyre Computer over the link: a box's agent says "on my Mac" and the Mac's own Chrome does it, but only for a class of work (look, act, files) the person allowed for the box on that Mac. Two real
// vyreds (test/link-harness.js), a fake extension on the Mac. Nothing the person did not allow runs; the box cannot send the call except through the computer module.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { until, pair } from "./link-harness.js";
import { fakeExtension } from "../local/hands-chrome-mac/fake-extension.js";

async function world(/** @type {any} */ t) {
  const sockDir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-comp-"));
  t.after(() => fs.rmSync(sockDir, { recursive: true, force: true }));
  const sockPath = path.join(sockDir, "chrome.sock");
  const s = await pair(t, { macConfig: { modules: { disable: ["hands"] }, chrome: { sockPath, extensionOrigin: null } } });
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
