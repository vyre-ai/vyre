// @ts-check
// R031-72, "references, not values", everywhere a definition is stored. A Flow, a Kit, a skill, an Engineer draft or a module's or app's config names a credential by reference (vault://item, a Connection's
// name); it never holds the key. Two halves: (1) everything this repo ships that becomes a stored definition (kits, the app catalog, module manifests, the skills) is scanned for anything shaped like a
// credential (lib/credential-shapes.js findSecrets); (2) on a real daemon, each way a definition is written is tried with a key in it, and the home is searched afterwards: the key is refused where it was
// written and is in no file the daemon keeps. A test box, never a Mac.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../core/daemon/index.js";
import { findSecrets } from "../lib/credential-shapes.js";
import { secretsIn } from "../kernel/flows/no-secrets.js";
import { tempHome, present } from "./helpers.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Built at run time so the test file itself holds no key-shaped text. */
const KEY = ["gh", "p_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join("");

/** @param {string} dir @param {(f: string) => boolean} want @returns {string[]} */
function files(dir, want) {
  /** @type {string[]} */ const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", "testing"].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p, want)); else if (want(p)) out.push(p);
  }
  return out;
}

test("what this repo ships as stored definitions holds references, never values: kits, the app catalog, module manifests, skills", () => {
  const json = [...files(path.join(ROOT, "records", "kits"), f => f.endsWith(".json")), ...files(path.join(ROOT, "core"), f => /(^|\/)(module|[a-z-]+\.kit|[a-z-]+)\.json$/.test(f) && /\/(module\.json|catalog\/[^/]+\.json)$/.test(f))];
  assert.ok(json.length > 20, "the scan found the definitions it is meant to read");
  const bad = [];
  for (const f of json) for (const x of secretsIn(JSON.parse(fs.readFileSync(f, "utf8")))) bad.push(`${path.relative(ROOT, f)}: ${x.path || "(root)"} looks like ${x.kind}`);
  const skills = [...files(path.join(ROOT, "harness"), f => /\.(md|json)$/.test(f)), ...files(path.join(ROOT, "core"), f => /(^|\/)skills\/.*\.md$/.test(f))];
  assert.ok(skills.length > 3, "the scan found the skills");
  for (const f of skills) { const s = findSecrets(fs.readFileSync(f, "utf8")); if (s.length) bad.push(`${path.relative(ROOT, f)}: looks like ${s[0].kind}`); }
  assert.deepEqual(bad, [], "a shipped definition names the Vault, not a value");
});

test("each way a definition is written refuses a key and keeps it out of every file the daemon holds; the reference form is accepted", { timeout: 180_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "alex", vault: { keystore: "file" } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const owner = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  const as = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "cli", { token: (await d.kernel.surfaces.open(owner, {})).token });
  const space = d.kernel.id.space;
  const flow = (/** @type {string} */ body) => ({ format: 1, name: "notify", authorship: "human", trigger: { on: "manual" }, steps: [{ id: "c", kind: "call", action: "email.send", resource: `vyre://${space}/mail/*`, input: { body } }] });

  // a Flow: the key is refused where it sits, and the refusal does not repeat it
  const bad = await as("flows.define", { flow: flow(`token ${KEY}`) });
  assert.equal(bad.data.ok, false);
  assert.match(JSON.stringify(bad.data.errors), /a Flow never holds a key, a password or a token/);
  assert.ok(!JSON.stringify(bad).includes(KEY), "the refusal does not carry the value");
  // the same Flow naming the Vault is not refused for holding a key
  const named = await as("flows.define", { flow: flow("vault://deepgram") });
  assert.ok(!/never holds a key/.test(JSON.stringify(named)), JSON.stringify(named).slice(0, 300));

  // a skill (what an Engineer or an assistant drafts and every AI that uses it would copy)
  const skill = await as("skills.draft", { name: "deploy-helper", level: "personal", kind: "skill", body: `---\nname: deploy-helper\ndescription: deploy a site\n---\nUse the token ${KEY}\n` });
  assert.ok(skill.error, "a skill with a key in it is refused");
  assert.ok(!JSON.stringify(skill).includes(KEY));

  // a Kit proposal (the Engineer's draft of a record type and its Flows)
  const kit = await as("flows.kit.propose", { kit: { format: 1, id: "notify-kit", version: 1, name: "Notify", flows: [flow(`token ${KEY}`)] } });
  assert.equal(kit.data.ok, false);
  assert.match(JSON.stringify(kit.data.errors), /a Kit never holds a key, a password or a token/);
  assert.match(JSON.stringify(kit.data.errors), /kit\.flows\[0\]\.steps\[0\]\.input\.body/, "it says where");
  assert.ok(!JSON.stringify(kit).includes(KEY), "a Kit proposal's answer does not carry the key");

  // nowhere the daemon writes holds it
  /** @type {string[]} */ const hits = [];
  (function walk(/** @type {string} */ dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else { try { if (fs.readFileSync(p).includes(KEY)) hits.push(path.relative(root, p)); } catch { /* unreadable socket or fifo */ } } } })(root);
  assert.deepEqual(hits, [], "no file of the home holds the key");
});
