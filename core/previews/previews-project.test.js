// @ts-check
// A preview shared with "the project" opens for the project's people, not the whole Space (the product ruling for previews: "in a project, everyone in it"), and "anyone with the link" works through Publish with
// one yes. On a real daemon with a real kernel: the owner, a member on the project's team, a member who is not, and a model acting for each.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { start } from "../daemon/index.js";
import { mayOpen, mayManage } from "./access.js";
import { tempHome, present } from "../../test/helpers.js";
import { SCRATCH } from "../../test/scratch.mjs";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
process.env.VYRE_PREVIEW_THUMBS = "0";

test("a project preview opens for the project's people only; a model lists what the person it acts for may open; ", { timeout: 180_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box" }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const owner = d.kernel.id.owner, CAROL = "per_" + "c".repeat(26), BOB = "per_" + "b".repeat(26);
  const chainOf = (/** @type {string} */ person) => d.kernel.chains.fromFacts({ kind: "device", device_key_id: "dev-" + person.slice(4, 10), person, path: "direct", session: "s" });
  const tokens = /** @type {Record<string, string>} */ ({});
  const tokenOf = async (/** @type {string} */ p) => tokens[p] || (tokens[p] = (await d.kernel.surfaces.open(chainOf(p), {})).token);
  const as = async (/** @type {string} */ person, /** @type {string} */ tool, /** @type {any} */ input = {}, caller = "cli") => d.registry.call(tool, input, caller, { token: await tokenOf(person) });
  for (const p of [CAROL, BOB]) await d.kernel.gateway.grants.setRole(chainOf(owner), { person: p, role: "member" }, { presence: { method: "stand-in" } });

  const made = await as(owner, "work.project.create", { name: "Acme", slug: "acme" });
  assert.ok(!made.error, JSON.stringify(made.error));
  await d.kernel.gateway.records.create(chainOf(owner), "team-member", { name: "Carol", actor: { actor: { kind: "person", id: CAROL, space: d.kernel.space } }, kind: "person", project: { urn: made.data.project } });

  const dir = fs.mkdtempSync(path.join(SCRATCH, "pvp-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "index.html"), "<h1>Acme</h1>");
  const opened = await as(owner, "previews.open", { title: "Acme site", path: dir, project: "acme" });
  assert.ok(!opened.error, JSON.stringify(opened.error));
  const id = opened.data.preview.id;
  assert.equal(opened.data.preview.access, "project", "in a project, a preview is shared with the project by default");

  const sees = async (/** @type {string} */ p) => !(await as(p, "previews.get", { id })).error;
  assert.equal(await sees(owner), true);
  assert.equal(await sees(CAROL), true, "a person on the project's team opens it");
  assert.equal(await sees(BOB), false, "a member of the Space who is not on the project does not: that was the whole Space before");
  const listed = async (/** @type {string} */ p, caller = "cli") => ((await as(p, "previews.list", {}, caller)).data || { previews: [] }).previews.map((/** @type {any} */ x) => x.id);
  assert.deepEqual(await listed(BOB), [], "Bob's list does not show it");
  assert.deepEqual(await listed(CAROL), [id]);
  assert.deepEqual(await listed(BOB, "mcp"), [], "nor does the list of a model acting for Bob");
  assert.deepEqual(await listed(CAROL, "mcp"), [id], "a model acting for Carol sees it");
  assert.equal((await as(BOB, "previews.share", { id, access: "team" })).error?.code, "denied", "Bob cannot widen what he cannot open");

  // the maker widens it to the whole team, and Bob then opens it
  assert.equal((await as(owner, "previews.share", { id, access: "team" })).data.preview.access, "team");
  assert.equal(await sees(BOB), true);
  // a preview with no project cannot be shared "with the project"
  const loose = await as(owner, "previews.open", { title: "Loose", path: dir });
  assert.equal((await as(owner, "previews.share", { id: loose.data.preview.id, access: "project" })).error?.code, "bad_input");
});

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "standin-directory.mjs");
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = /** @type {any} */ (s.address()).port; s.close(() => res(p)); }); });

test("anyone with the link: the share sheet hands the folder to Publish, which holds it for one yes; the yes puts it live; a model, a stranger and a running server cannot", { timeout: 240_000 }, async t => {
  const port = await freePort();
  const child = spawn(process.execPath, [SCRIPT, "--port", String(port)], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { child.kill("SIGTERM"); });
  await new Promise((res, rej) => { child.stdout.on("data", d => { if (String(d).includes("stand-in names directory")) res(null); }); child.on("exit", c => rej(new Error(`the stand-in exited early (${c})`))); });
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "bakery-box", vault: { keystore: "file" }, names: { directory: `http://127.0.0.1:${port}` } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const BOB = "per_" + "b".repeat(26);
  const chainOf = (/** @type {string} */ person) => d.kernel.chains.fromFacts({ kind: "device", device_key_id: "dev-" + person.slice(4, 10), person, path: "direct", session: "s" });
  const as = async (/** @type {string} */ tool, /** @type {any} */ input = {}, person = d.kernel.id.owner, caller = "cli") => d.registry.call(tool, input, caller, { token: (await d.kernel.surfaces.open(chainOf(person), {})).token });
  assert.ok(!(await as("spaces.identity.create", { name: "alex" })).error);
  assert.ok(!(await as("spaces.create", { name: "bakery", home: { kind: "this-computer", confirmed: true } })).error);
  const site = fs.mkdtempSync(path.join(root, "site-"));
  fs.writeFileSync(path.join(site, "index.html"), "<h1>Northwind</h1>");
  const opened = await as("previews.open", { title: "Northwind site", path: site });
  assert.ok(!opened.error, JSON.stringify(opened.error));
  const id = opened.data.preview.id;

  assert.notEqual((await as("previews.share", { id, access: "public" }, d.kernel.id.owner, "mcp")).data?.held, true, "a model cannot make it public");
  assert.notEqual((await as("previews.share", { id, access: "public" }, BOB)).data?.held, true, "nor someone who may not manage it");
  const pub = await as("previews.share", { id, access: "public" });
  assert.ok(!pub.error, JSON.stringify(pub.error));
  assert.equal(pub.data.held, true, "held for the person's one yes");
  assert.ok(pub.data.task && pub.data.plan, "with the task to decide and what would change");
  const yes = await as("publish.decide", { task: pub.data.task, approve: true, plan_hash: pub.data.plan.hash, space: "bakery.vyre.run" });
  assert.ok(!yes.error, JSON.stringify(yes.error));
  assert.equal(yes.data.deployment.stage, "Production", "one yes and it is live");
  assert.ok(yes.data.deployment.url, "with an address");
});

test("access rules: a project preview is for the project's people, a Personal project's is its person's alone (not even an admin's), and an unknown project opens for no one", () => {
  const row = { access: "project", created_by: "per_maker" }, proj = { people: ["per_maker", "per_carol"], personal_of: null };
  assert.equal(mayOpen(row, { id: "per_carol", role: "member" }, proj), true);
  assert.equal(mayOpen(row, { id: "per_bob", role: "member" }, proj), false, "a member of the Space who is not on the project");
  assert.equal(mayOpen(row, { id: "per_carol", role: null }, proj), false, "someone who is not in the Space at all");
  assert.equal(mayOpen(row, { id: "per_carol", role: "member" }, null), false, "no answer about the project: closed");
  assert.equal(mayOpen(row, { id: "per_carol", role: "member" }, { people: [], personal_of: null, missing: true }), false, "a project that is not there");
  assert.equal(mayManage(row, { id: "per_admin", role: "admin" }, proj), true, "an admin manages any project's preview");
  const mine = { people: ["per_maker"], personal_of: "per_maker" };
  assert.equal(mayManage({ access: "project", created_by: "per_other" }, { id: "per_admin", role: "admin" }, mine), false, "not another person's Personal project");
  assert.equal(mayOpen(row, { id: "per_maker", role: "member" }, mine), true);
  assert.equal(mayOpen({ access: "team", created_by: "x" }, { id: "per_bob", role: "member" }), true, "team is still the whole Space");
});
