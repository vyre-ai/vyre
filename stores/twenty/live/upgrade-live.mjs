// The Personal to My Cloud upgrade against a real Twenty. Run on a test box: node stores/twenty/live/upgrade-live.mjs <space-label>
// Personal is the built-in SQLite store; My Cloud is a Space provisioned for real (docker), with the kernel on top of the Twenty store. Carries contacts and leads with links, checks ids, links, a rerun, and removes the Space.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { provisionSpace, names, spaceDir, realRunner } from "../provision.js";
import { createTwentyStore } from "../store.js";
import { TwentyClient } from "../client.js";
import { createKernel } from "../../../kernel/index.js";
import { createSqliteStore } from "../../../kernel/store/sqlite.js";
import { CONTACT, LEAD } from "../../../kernel/conformance/suite.js";
import { CORE_TYPES } from "../../../records/core-types.js";
import { planUpgrade, runUpgrade } from "../../../lib/spaces/upgrade.js";

const label = process.argv[2] ?? "upg";
const N = Number(process.env.N || 20);
const home = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-home-"));
const n = names(label);
const t0 = Date.now(); const lap = (s) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`);
const PERSONAL = "spc_" + "c".repeat(12), CLOUD = "spc_" + "d".repeat(12), ME = "per_" + "m".repeat(26);
let clockT = Date.now(); const clock = () => ++clockT;
const presence = { check: async () => null };
try {
  const p = await provisionSpace({ home, space: label, runner: realRunner(), reach: "ip", memory: "standard", log: () => {} });
  lap("My Cloud's Twenty is up");
  const store = createTwentyStore({ space: CLOUD, client: new TwentyClient({ url: p.url, key: () => fs.readFileSync(p.keyFile, "utf8").trim() }), dir: path.join(spaceDir(home, label), "state"), webhookSecret: "x" });
  await store.define({ add_types: [...CORE_TYPES] });
  const pk = await createKernel({ space: PERSONAL, owner: ME, owner_uid: 501, key: Buffer.alloc(32, 1), clock, presence, store: createSqliteStore({ db: new DatabaseSync(":memory:") }) });
  const ck = await createKernel({ space: CLOUD, owner: ME, owner_uid: 501, key: Buffer.alloc(32, 2), clock, presence, store });
  const chainOf = (k) => k.chains.fromFacts({ kind: "device", device_key_id: "d1", person: ME, path: "direct" });
  const local = { space: PERSONAL, records: pk.gateway.records, definitions: (c) => pk.gateway.definitions(c), chain: chainOf(pk) };
  const remote = { space: CLOUD, records: ck.gateway.records, definitions: (c) => ck.gateway.definitions(c), chain: chainOf(ck) };
  await local.records.define(local.chain, { add_types: [CONTACT, LEAD] });
  const ids = [];
  for (let i = 0; i < N; i++) ids.push((await local.records.create(local.chain, "contact", { name: `Person ${i}`, age: i })).id);
  const leads = [];
  for (let i = 0; i < N; i++) leads.push((await local.records.create(local.chain, "lead", { title: `Lead ${i}`, contact: { urn: `vyre://${PERSONAL}/contact/${ids[i]}` }, referrers: [{ urn: `vyre://${PERSONAL}/contact/${ids[(i + 1) % N]}` }] })).id);
  lap(`personal filled: ${N} contacts, ${N} leads`);
  const plan = await planUpgrade({ local, to: CLOUD });
  const started = await pk.gateway.upgrade.start(local.chain, { to: CLOUD, plan_hash: plan.hash }, { presence: { payload_hash: "x", nonce: "n" } }).catch((e) => ({ refused: e.code }));
  console.log("start without a real approval:", JSON.stringify(started));
  const t1 = Date.now();
  const report = await runUpgrade({ plan, local, remote });
  lap(`upgrade ran in ${((Date.now() - t1) / 1000).toFixed(1)}s: ${JSON.stringify(report.moved.records)} notMoved ${report.notMoved.length}`);
  let ok = 0;
  for (let i = 0; i < N; i++) {
    const l = await remote.records.get(remote.chain, "lead", leads[i]);
    if (l.data.contact && l.data.contact.urn === `vyre://${CLOUD}/contact/${ids[i]}` && l.data.referrers.length === 1) ok++;
  }
  console.log(`CHECK links rewritten and present: ${ok}/${N}`);
  const again = await runUpgrade({ plan, local, remote });
  console.log("CHECK rerun:", JSON.stringify(again.moved.records), "notMoved", again.notMoved.length);
} finally {
  try { execFileSync("docker", ["compose", "-p", n.project, "down", "-v"], { stdio: "ignore", timeout: 120000 }); } catch { /* gone */ }
  lap("removed");
}
