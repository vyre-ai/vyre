// Provision a brand-new Space's Twenty for real (docker on this machine), install the estate planning
// kit's types, and exercise the store once. Run on testbox: node stores/twenty/live/provision-live.mjs <space>
// Then remove it: docker compose -p vyre-<space>-twenty down -v
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { provisionSpace, names, spaceDir, realRunner } from "../provision.js";
import { createTwentyStore } from "../store.js";
import { mintUuid } from "../../../kernel/core/ids.js";
import { TwentyClient } from "../client.js";
import { compile } from "../../../records/language/compile.js";
import { CORE_TYPES } from "../../../records/core-types.js";

const space = process.argv[2] ?? "livetest";
const home = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-home-"));
const t0 = Date.now();
const lap = (s) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`);
const p = await provisionSpace({ home, space, reach: "ip", runner: realRunner(), log: lap });
lap(`provisioned; workspace ${p.workspaceId}; reachable at ${p.url}`);
const n = names(space);
console.log("published ports:", execFileSync("docker", ["ps", "--filter", `label=com.docker.compose.project=${n.project}`, "--format", "{{.Names}} {{.Ports}}"]).toString().trim().split("\n").map((l) => l.replace(/\/tcp/g, "")).join(" | "));
console.log("network internal:", execFileSync("docker", ["network", "inspect", n.network, "-f", "{{.Internal}}"]).toString().trim());
console.log("service.key mode:", (fs.statSync(p.keyFile).mode & 0o777).toString(8));
const kit = compile(fs.readFileSync(new URL("../../../records/kits/estate-planning/kit.ts", import.meta.url), "utf8"));
const store = createTwentyStore({ space, client: new TwentyClient({ url: p.url, key: () => fs.readFileSync(p.keyFile, "utf8").trim() }), space, dir: path.join(spaceDir(home, space), "state"), webhookSecret: fs.readFileSync(p.webhookSecretFile, "utf8").trim() });
await store.define({ add_types: [...CORE_TYPES] }); // the kit links to core types (organization)
const d = await store.define({ add_types: kit.types });
lap(`kit types defined: ${d.changes.join(", ")}`);
const c = await store.create("contact", mintUuid(), { name: "Sam Rivera", email: "sam@example.test", ssn: { sealed: "ssn", ref: "sv_1", present: true, valid_format: true, set_at: Date.now() } });
const m = await store.create("matter", mintUuid(), { title: "Estate plan for Sam Rivera", client: { urn: `vyre://${space}/contact/${c.id}` }, plan: "Trust", fee: { amount: 3500, currency: "USD" }, stage: "Intake" });
lap(`contact ${c.id} and matter ${m.id} created`);
const back = await store.get("matter", m.id);
console.log("matter stage:", back.data.stage, "fee:", JSON.stringify(back.data.fee), "client ref kept:", back.data.client.urn.endsWith(c.id), "version:", back.version);
console.log("health:", JSON.stringify(await store.health()), "version:", JSON.stringify(await store.version()));
lap("done");
console.log("HOME", home);
