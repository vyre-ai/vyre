// @ts-check
// The vault and Drive on the kernel's grants and events: decide, run once, record without a value; a refusal looks like absence; the summary
// says what a credential was used for; today's audit rows and agent grants fold into the same shapes.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createGuard, summarise, foldAudit, grantFromAgent, ACTIONS, credentialAction, safePath, segment } from "./uses.js";
import { overlaps, assertPlacement, writeReference, sealDir } from "./placement.js";
import { person, tmp, SPACE } from "./testing.js";

const kernel = effect => {
  const events = [], asked = [];
  return { events, asked, authorize: async i => { asked.push(i); return { effect, decision: "dec_1", reason: effect === "deny" ? "no_grant" : "ok" }; }, append: async (chain, e) => { events.push(e); } };
};

test("allow: the use runs once and one event says what for, with no secret and no input", async t => {
  const k = kernel("allow"), g = createGuard(k); let runs = 0;
  const r = await g.useCredential(person(), { item: "gmail-login", service: "Gmail", run: async () => { runs++; return { sent: true }; } });
  assert.deepEqual(r, { status: "done", result: { sent: true } }); assert.equal(runs, 1);
  assert.deepEqual(k.asked[0].action, "vault.read"); assert.equal(k.asked[0].resource, `vyre://${SPACE}/credential/gmail-login`);
  assert.equal(k.events.length, 1);
  assert.deepEqual(k.events[0], { type: "vault.used", sv: 1, subject: `vyre://${SPACE}/credential/gmail-login`, data: { action: "vault.read", service: "Gmail", kind: "api", method: "GET" }, cause: "dec_1" });
});

test("deny looks like absence to the caller, runs nothing, and the true reason goes to the log; ask returns the decision and runs nothing", async t => {
  const d = kernel("deny"), a = kernel("ask"); let runs = 0;
  const run = async () => { runs++; };
  assert.deepEqual(await createGuard(d).useCredential(person(), { item: "x", service: "Gmail", run }), { status: "refused", error: { code: "not_found" } });
  assert.equal(d.events[0].type, "access.refused"); assert.equal(d.events[0].data.reason, "no_grant");
  assert.deepEqual(await createGuard(a).useCredential(person(), { item: "x", service: "Gmail", run }), { status: "ask", decision: "dec_1" });
  assert.equal(runs, 0); assert.equal(a.events.length, 0);
});

test("Drive reads go through the same decision and write file.accessed", async () => {
  const k = kernel("allow"), g = createGuard(k);
  await g.readFile(person(), { path: "projects/jane/engagement.pdf", run: async () => 1 });
  assert.equal(k.asked[0].action, "drive.read"); assert.equal(k.events[0].type, "file.accessed");
});

test("the summary says what a credential was used for today, in plain words", () => {
  const now = 1_000_000_000_000, ev = (service, ago, type = "vault.used") => ({ type, time: now - ago, data: { service } });
  const s = summarise([ev("Gmail", 1000), ev("Gmail", 2000), ev("Gmail", 3000), ev("Stripe", 4000), ev("Gmail", 90_000_000), ev("Slack", 5, "vault.refused")], now);
  assert.equal(s.text, "Used for Gmail 3 times, Stripe once today.");
  assert.equal(summarise([], now).text, "Not used today.");
});

test("today's vault audit rows and agent grants fold into events and kernel grants", () => {
  assert.deepEqual(foldAudit({ action: "fill", name: "drive", ok: 1, origin: "https://app.northwind.test", surface: "capsule", at: 5 }), { type: "vault.used", sv: 1, data: { action: "vault.fill", kind: "fill", item: "drive", service: "https://app.northwind.test", via: "capsule" }, time: 5 });
  assert.equal(foldAudit({ action: "fill", ok: 0, at: 1 }).type, "access.refused");
  assert.equal(foldAudit({ action: "unlock", ok: 1, at: 1 }), null);
  const g = grantFromAgent({ agent: "kit", item: "harlow-drive", origin: "https://app.northwind.test", expires: 123 }, SPACE);
  assert.deepEqual(g.actions, ["vault.fill", "vault.totp"]); assert.equal(g.resource.prefix, `vyre://${SPACE}/credential/harlow-drive`);
  assert.deepEqual(g.conditions.when, { expires: 123 }); assert.deepEqual(g.conditions.audience, ["app.northwind.test"]);
});

test("the registry fragment: unique actions, reveal is admin, delivery and sharing are outward, only the fill step is sealed_ok", () => {
  assert.equal(new Set(ACTIONS.map(a => a.action)).size, ACTIONS.length);
  const by = Object.fromEntries(ACTIONS.map(a => [a.action, a]));
  assert.equal(by["seal.reveal"].risk, "admin"); assert.equal(by["seal.deliver"].risk, "outward.send"); assert.equal(by["vault.share"].risk, "outward.share"); assert.equal(by["drive.delete"].risk, "outward.delete");
  assert.deepEqual(ACTIONS.filter(a => a.sealed_ok).map(a => a.action), ["seal.use"]);
  for (const a of ACTIONS) assert.match(a.action, /^[a-z]+\.[a-z]+$/);
});

test("placement: the sealing folder is private and outside every sandbox root, as the box compose file lays it out", () => {
  const compose = fs.readFileSync(path.resolve(import.meta.dirname, "../../box/compose.yml"), "utf8");
  const mounts = [...compose.matchAll(/^\s+- (vyre-[a-z-]+):(\/[^\s:]+)/gm)].map(m => ({ vol: m[1], at: m[2] }));
  const at = v => mounts.find(m => m.vol === v)?.at;
  const home = at("vyre-home");
  assert.equal(home, "/home/vyre");
  const dir = sealDir(`${home}/.vyre`), sandboxes = [at("vyre-work"), at("vyre-agent-home"), at("vyre-accounts"), "/home/vyre-agent", "/home/acct", "/work"].filter(Boolean);
  assert.deepEqual(overlaps(dir, sandboxes), [], "no sandbox root holds the sealing folder");
  assert.deepEqual(overlaps("/work/seal", sandboxes).length > 0, true, "the check does fire");
  // The tailscale container mounts only /work (VyreDrive), never vyre-home.
  const tail = compose.slice(compose.indexOf("tailscale:"), compose.indexOf("\n  vyre:")).split("\n").filter(l => !/^\s*#/.test(l)).join("\n");
  assert.ok(!tail.includes("vyre-home"));
});

test("placement: other users cannot read the folder, and a reference file holds the output's name and slots but never a value", () => {
  const d = tmp("place"); fs.chmodSync(d, 0o755);
  assert.throws(() => assertPlacement(d, []), /readable by other users/);
  fs.chmodSync(d, 0o700); assertPlacement(d, []);
  assert.throws(() => assertPlacement(d, [path.dirname(d)]), /overlap/);
  const f = writeReference(d, "Engagement letter (Jane).docx", { output_ref: `vyre://${SPACE}/sealed-output/out_abc`, sealed_slots: [{ slot: "ssn", class: "us-ssn" }] });
  const t = fs.readFileSync(f, "utf8");
  assert.ok(f.endsWith("Engagement_letter__Jane_.docx.sealed.json")); assert.match(t, /out_abc/); assert.ok(!/\d{3}-\d{2}-\d{4}/.test(t));
});

test("K3 item 2: what a credential is used for decides its risk: a read is a read, any other request is outward", async () => {
  const by = Object.fromEntries(ACTIONS.map(a => [a.action, a]));
  const act = (kind, method) => by[credentialAction(kind, method)];
  assert.equal(act("fill").risk, "write"); assert.equal(act("totp").risk, "write");
  assert.equal(act("api", "GET").risk, "read"); assert.equal(act("api", "head").risk, "read");
  assert.equal(act("api").risk, "read");
  for (const m of ["POST", "PUT", "PATCH", "DELETE", "post", "PROPFIND", ""]) assert.equal(act("api", m).risk, "outward.send", JSON.stringify(m));
  assert.equal(act("surprise").risk, "outward.send", "an unknown kind is outward");
  assert.equal(act("run").risk, "admin");
  const k = kernel("allow"), g = createGuard(k);
  await g.useCredential(person(), { item: "stripe-key", service: "Stripe", kind: "api", method: "POST", run: async () => 1 });
  assert.equal(k.asked[0].action, "vault.call");
  assert.equal(k.events[0].data.method, "POST");
});

test("K3 item 3: dot segments, encoded dots and slashes, backslashes and control characters never reach a path or a URN", async () => {
  for (const bad of ["../x", "a/../../credential/x", "a/./b", "a/%2e%2e/b", "a/%2E%2E/b", "a%2fb", "a%5cb", "a\\b", "a\u0000b", "a\nb", "/abs", "a//b", "", "..", "a/..", "\u2024\u2024/x"]) assert.throws(() => safePath(bad), /bad_input/, JSON.stringify(bad));
  for (const ok of ["projects/jane/engagement.pdf", "a b/c-d_e.txt", "..hidden/x", "x..y/z"]) assert.equal(safePath(ok), ok);
  for (const bad of ["a/b", "..", ".", "%2e", "a%2fb", "a\\b", ""]) assert.throws(() => segment(bad), /bad_input/, bad);
  const k = kernel("allow"), g = createGuard(k);
  await assert.rejects(g.readFile(person(), { path: "proj/../../credential/x", run: async () => 1 }), /bad_input/);
  await assert.rejects(g.useCredential(person(), { item: "../x", service: "s", run: async () => 1 }), /bad_input/);
  assert.equal(k.asked.length, 0, "nothing was authorised or run for a refused path");
});
