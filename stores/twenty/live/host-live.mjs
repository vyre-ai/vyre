// The whole records path against a real Twenty, one Space from nothing, on the test box:
//   provision (with a memory profile) -> core types + Estate planning Kit through kernel.records -> six concurrent Stripe
//   deliveries run the Kit's Flow -> memory under load -> backup -> restore as a second Space (a move) -> read it back -> tear down.
//   node stores/twenty/live/host-live.mjs <space> <memory: small|standard> [keep]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { provisionSpace, backupSpace, restoreSpace, names, spaceDir, realRunner } from "../provision.js";
import { createTwentyStore } from "../store.js";
import { TwentyClient } from "../client.js";
import { compile } from "../../../records/language/compile.js";
import { createRecordsHost } from "../../../records/host.js";
import { createStripeHandler, signForTest } from "../../../records/connectors/stripe/stripe.js";

const [space = "hostlive", profile = "small", keep] = process.argv.slice(2);
const home = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-home-"));
const t0 = Date.now();
const lap = (s) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`);
const stats = (sp) => execFileSync("docker", ["stats", "--no-stream", "--format", "{{.Name}} {{.MemUsage}} {{.MemPerc}}", ...execFileSync("docker", ["ps", "-q", "--filter", `label=com.docker.compose.project=${names(sp).project}`]).toString().trim().split("\n")]).toString().trim().split("\n").map((l) => l.replace(`${names(sp).project}-`, "")).sort().join("\n  ");
const oom = (sp) => execFileSync("docker", ["inspect", "-f", "{{.Name}} oom={{.State.OOMKilled}} restarts={{.RestartCount}}", ...execFileSync("docker", ["ps", "-aq", "--filter", `label=com.docker.compose.project=${names(sp).project}`]).toString().trim().split("\n")]).toString().trim().split("\n").join(" | ");
const mkStore = (p, sp) => createTwentyStore({ space: sp, client: new TwentyClient({ url: p.url, key: () => fs.readFileSync(p.keyFile, "utf8").trim() }), dir: path.join(spaceDir(home, sp), "state"), webhookSecret: fs.readFileSync(p.webhookSecretFile, "utf8").trim() });

const p = await provisionSpace({ home, space, reach: "ip", runner: realRunner(), memory: profile, log: lap });
lap(`provisioned (${profile})`);
console.log("idle memory:\n  " + stats(space));
const spaceId = "spc_hostlive0001";
const store = mkStore(p, space);
const host = createRecordsHost({ space: spaceId, owner: "per_owner", store });
const kit = compile(fs.readFileSync(new URL("../../../records/kits/estate-planning/kit.ts", import.meta.url), "utf8"));
const tcore = Date.now(); await host.defineCore(); lap(`core types defined (${((Date.now() - tcore) / 1000).toFixed(1)}s)`);
const tkit = Date.now(); const inst = await host.installKit(kit); lap(`kit installed: types ${inst.types.join(",")}, ${inst.flows.length} flow (${((Date.now() - tkit) / 1000).toFixed(1)}s)`);

// kernel.records.* on real Twenty
const c = host.ownerChain();
const sam = await host.kernel.records.create(c, "contact", { name: "Pat Juniper", email: "pat@example.test", ssn: { sealed: "us-ssn", ref: "sv_1", present: true, valid_format: true, set_at: Date.now() } });
const up = await host.kernel.records.update(c, "contact", sam.id, { phone: "555 0100" }, sam.version);
console.log(`kernel.records: contact v${sam.version} -> v${up.version}; log verify=${host.log.verify().ok}`);
const denied = await host.kernel.records.get(host.chains.fromFacts({ kind: "socket", surface: "mcp", uid: 1, pid: 1, inside_model_process: true }), "contact", sam.id).then((r) => (r ? "SEEN" : "absent"), (e) => `refused:${e.code}`);
console.log("a model chain with no grant ->", denied);

// Stripe: six concurrent deliveries of three events for one payment
const SECRET = "whsec_test_sample_secret";
const handle = createStripeHandler({ secret: SECRET, host });
const stamp = Date.now(), email = `sam.${stamp}@example.test`, cus = `cus_${stamp}`, pi = `pi_${stamp}`;
const mk = (type, id, obj) => ({ id, type, livemode: false, created: Math.floor(Date.now() / 1000), data: { object: obj } });
const events = [
  mk("checkout.session.completed", `evt_${stamp}_1`, { id: `cs_${stamp}`, payment_status: "paid", payment_intent: pi, amount_total: 350000, currency: "usd", customer: cus, customer_details: { email, name: "Sam Rivera" }, metadata: { plan: "Trust" } }),
  mk("payment_intent.succeeded", `evt_${stamp}_2`, { id: pi, amount: 350000, amount_received: 350000, currency: "usd", customer: cus, receipt_email: email }),
  mk("charge.succeeded", `evt_${stamp}_3`, { id: `ch_${stamp}`, paid: true, amount: 350000, currency: "usd", customer: cus, payment_intent: pi, billing_details: { name: "Sam Rivera", email } }),
];
const post = (ev) => { const raw = JSON.stringify(ev); return handle({ "stripe-signature": signForTest(raw, SECRET) }, raw); };
const ts = Date.now();
const rs = await Promise.all([...events, ...events].map(post));
console.log(`six concurrent deliveries -> ${rs.map((r) => r.status).join(",")} in ${Date.now() - ts} ms`);
const contacts = (await store.query("contact", { filter: { field: "stripe_customer", op: "eq", value: cus }, page: { limit: 10 } })).rows;
const matters = (await store.query("matter", { filter: { field: "stripe_payment", op: "eq", value: pi }, page: { limit: 10 } })).rows;
console.log(`contacts for this customer: ${contacts.length} | matters for this payment: ${matters.length} | payment.received events: ${host.log.read({ type: "payment.received" }).length} | matter.created by ${host.log.read({ type: "matter.created" }).at(-1)?.actor}`);

// a little load: 150 contacts and a query over them
const tl = Date.now();
for (let i = 0; i < 150; i += 10) await Promise.all(Array.from({ length: 10 }, (_, j) => host.kernel.records.create(c, "contact", { name: `Load ${i + j}`, email: `load${i + j}@example.test` })));
const page = await host.kernel.records.query(c, "contact", { filter: { field: "name", op: "contains", value: "Load 1" }, page: { limit: 50 } });
lap(`150 contacts written through the gateway and queried (${page.rows.length} rows) in ${((Date.now() - tl) / 1000).toFixed(1)}s`);
console.log("memory under load:\n  " + stats(space));
console.log("containers:", oom(space));

// backup and move
const tb = Date.now();
const b = await backupSpace({ home, space, log: lap });
const sizes = Object.entries(b.manifest.parts).map(([f, m]) => `${f} ${m.bytes}B`).join(", ");
lap(`backup ${b.seconds}s: ${sizes}`);
const moved = `${space}-m`;
const r = await restoreSpace({ home, space: moved, from: b.dir, reach: "ip", log: lap });
lap(`restored as ${moved} in ${r.seconds}s (backup + restore ${((Date.now() - tb) / 1000).toFixed(1)}s)`);
const store2 = mkStore(r, moved);
await store2.define({ add_types: [...(await Promise.all([]))] }).catch(() => {});
const n2 = (await store2.query("contact", { page: { limit: 200 } })).rows.length, m2 = (await store2.query("matter", { page: { limit: 10 } })).rows.length;
console.log(`moved Space reads back: ${n2} contacts, ${m2} matters, same key=${fs.readFileSync(r.keyFile, "utf8") === fs.readFileSync(p.keyFile, "utf8")}`);
console.log("moved Space memory:\n  " + stats(moved));

if (keep !== "keep") {
  for (const sp of [space, moved]) { execFileSync("docker", ["compose", "-p", names(sp).project, "down", "-v"], { cwd: spaceDir(home, sp) }); }
  fs.rmSync(home, { recursive: true, force: true });
  lap("torn down");
} else console.log("HOME", home);
