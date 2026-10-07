// Make a Space from the saved database and time it, then check it works: node stores/twenty/live/golden-check.mjs <space> [golden folder]  (then: docker compose -p vyre-<space>-twenty down -v)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { provisionSpace, spaceDir, realRunner, findGolden, TWENTY_TESTED_REF } from "../provision.js";
import { createTwentyStore } from "../store.js";
import { defineCore } from "../space-store.js";
import { mintUuid } from "../../../kernel/core/ids.js";
import { TwentyClient } from "../client.js";

const space = process.argv[2] ?? "gold", dirArg = process.argv[3];
const home = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-home-"));
const t0 = Date.now();
const lap = (s) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`);
const golden = findGolden({ image: process.env.TWENTY_IMAGE_REF || TWENTY_TESTED_REF, ...(dirArg ? { dirs: [dirArg] } : {}) });
if (!golden) { console.log("no saved database for this image"); process.exit(2); }
const p = await provisionSpace({ home, space, reach: "ip", runner: realRunner(), golden, ...(process.env.MEM ? { memory: process.env.MEM } : {}), log: lap }); // MEM=tiny|small: the memory profile (tiny is the 4 GB server's)
lap("Space ready (provisioned from the saved database)");
const store = createTwentyStore({ space, client: new TwentyClient({ url: p.url, key: () => fs.readFileSync(p.keyFile, "utf8").trim() }), dir: path.join(spaceDir(home, space), "state"), webhookSecret: fs.readFileSync(p.webhookSecretFile, "utf8").trim() });
await defineCore(store, lap);
lap(`types present after defineCore: ${(await store.types()).length}`);
const c = await store.create("contact", mintUuid(), { name: "Sam Rivera", email: `sam.${Date.now()}@example.test` });
const back = await store.get("contact", c.id);
lap(`a contact made and read back: ${back.data.name}`);
console.log("rows before this check:", (await store.query("contact", { page: { limit: 5 } })).rows.length, "(a built-from-clean saved database has none but ours)");
console.log("compose file still names the restore step:", /restore/.test(fs.readFileSync(path.join(spaceDir(home, space), "compose.yml"), "utf8")), "| golden.dump left behind:", fs.existsSync(path.join(spaceDir(home, space), "golden.dump")));
console.log("HOME", home);
