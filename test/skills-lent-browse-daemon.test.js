// @ts-check
// Lent-session contract: skills.browse on the thread socket is the same browse path as a direct registry call on the box.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { openThreadSocket, lentRequest } from "../core/daemon/threadsock.js";
import { tempHome } from "./helpers.js";
import { canonical } from "../kernel/core/canonical.js";
import { SCRATCH } from "./scratch.mjs";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const realManifest = JSON.parse(fs.readFileSync(new URL("../core/switchboard/module.json", import.meta.url), "utf8"));
const used = new Set();
const presence = { check: async (/** @type {any} */ q) => (q.chain && q.proof && q.proof.op === q.op && canonical(q.proof.fields) === canonical(q.fields) && !used.has(q.proof.n) && (used.add(q.proof.n), true) ? null : "wrong_payload") };
const skill = (/** @type {string} */ name) => `---\nname: ${name}\ndescription: Use when the lent browse contract is exercised.\n---\n\n# ${name}\n\nSteps.\n`;

test("lent session: skills.browse matches the box browse path for the same session", { timeout: 120_000 }, async (t) => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: presence });
  t.after(() => d.stop());
  const owner = d.kernel.id.owner;
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
  const meta = async () => ({ token: (await d.kernel.surfaces.open(ownerChain, {})).token });
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => {
    const r = await d.registry.call(tool, input, "cli", await meta());
    if (r.error) throw Object.assign(new Error(`${tool}: ${r.error.message}`), { code: r.error.code, error: r.error });
    return r.data;
  };
  const dr = await call("skills.draft", { name: "lent-browse", level: "space", body: skill("lent-browse") });
  await call("skills.approve", { name: "lent-browse", level: "space", version: dr.version });

  const thread = "t_lent_skills_browse";
  const dir = fs.mkdtempSync(path.join(SCRATCH, "skills-lent-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sock = await openThreadSocket({ handler: d.registry.context(realManifest).handler, thread, agent: "kit", dir, pids: async () => ({ pids: [] }) });
  t.after(() => sock.close());

  const onBox = await call("skills.browse", { level: "space" });
  const lentAns = await lentRequest(thread, "POST", "/v1/tools/skills.browse", { "x-vyre-caller": "mcp" }, JSON.stringify({ level: "space" }));
  assert.equal(lentAns && lentAns.status, 200, JSON.stringify(lentAns));
  const lent = JSON.parse(/** @type {any} */ (lentAns).body).data;
  assert.equal(lent.role, onBox.role);
  const boxIds = (onBox.skills || []).map((/** @type {any} */ s) => s.id).sort();
  const lentIds = (lent.skills || []).map((/** @type {any} */ s) => s.id).sort();
  assert.ok(lentIds.includes("space/lent-browse"), `lent browse sees the approved skill: ${lentIds.join(", ")}`);
  assert.deepEqual(lentIds, boxIds, "the lent browse path lists the same skills as the box");
});
