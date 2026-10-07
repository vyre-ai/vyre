// Key rotation against a real Twenty: make a Space (from the saved database when there is one), rotate its API key by force, and check the new key works, the old one is dead and the files moved.
//   node stores/twenty/live/rotate-check.mjs <space> [golden folder]   (then: docker compose -p vyre-<space>-twenty down -v)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { provisionSpace, rotateApiKey, keyHealth, spaceDir, realRunner, findGolden, TWENTY_TESTED_REF } from "../provision.js";
import { TwentyClient } from "../client.js";

const space = process.argv[2] ?? "rot", dirArg = process.argv[3];
const home = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-home-"));
const t0 = Date.now();
const lap = (s) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`);
const golden = findGolden({ image: process.env.TWENTY_IMAGE_REF || TWENTY_TESTED_REF, ...(dirArg ? { dirs: [dirArg] } : {}) });
const runner = realRunner();
const p = await provisionSpace({ home, space, reach: "ip", runner, ...(golden ? { golden } : { golden: false }), log: () => {} });
lap(`Space ready${golden ? " (from the saved database)" : ""}`);
const old = fs.readFileSync(p.keyFile, "utf8").trim();
const before = JSON.parse(fs.readFileSync(path.join(spaceDir(home, space), "key.json"), "utf8"));
const r = await rotateApiKey({ home, space, runner, reach: "ip", force: true, log: lap });
const fresh = fs.readFileSync(p.keyFile, "utf8").trim();
const works = async (key) => { try { await new TwentyClient({ url: p.url, key: () => key }).gql("metadata", "query Chk { objects(paging: { first: 1 }) { edges { node { id } } } }"); return true; } catch { return false; } };
const after = JSON.parse(fs.readFileSync(path.join(spaceDir(home, space), "key.json"), "utf8"));
console.log("rotated:", r.rotated, "| key changed:", fresh !== old, "| new key works:", await works(fresh), "| old key works:", await works(old), "| key.json previous is the old id:", after.previous === before.apiKeyId, "| health:", JSON.stringify(keyHealth({ home, space })));
console.log("HOME", home);
