// A throwaway Vyre box for the Windows VM checks. Everything under BOX (default /srv/vyre-test/box), never
// /srv/vyre. It is a real vyred with the real relay module pointed at the hosted relay (ciphertext only), a
// stand-in for the Drive tools, and presence that takes any proof, so this is a TEST box and nothing else.
// Run from a repo checkout:  node scripts/testbox-win11/box.mjs
// To pair a PC: write the 13 words its pairing page shows into BOX/words.txt; the box mints that ticket.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../../core/daemon/index.js";
import { HUMAN_ONLY } from "../../core/presence/index.js";
import { wordsToSeed } from "../../relay/client/seedwords.js";
import { nodeCrypto } from "../../relay/client/nodecrypto.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const BOX = process.env.BOX || "/srv/vyre-test/box";
if (BOX === "/srv/vyre" || BOX.startsWith("/srv/vyre/")) throw new Error("the test box never lives under /srv/vyre");
const root = path.join(BOX, "home");
const RELAY = process.env.BOX_RELAY || "wss://relay.vyre.run";
// No network.name: a box with a claimed handle AND an own-domain address is refused by the app (handle and address disagree).
const ADDRESS = process.env.BOX_ADDRESS || "https://vyre-lab.invalid";   // an own-domain style address, so the confirm window shows its own-domain line
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
  role: "box", name: "winlab", transcripts: [], network: { address: ADDRESS },
  relay: { enabled: false, url: RELAY }, modules: { disable: ["names", "onboard"] },
}));

// Presence that takes any proof. Only a test box has this.
const lenient = {
  required: (tool, def, input) => HUMAN_ONLY.has(tool) || Boolean(def && def.presence && (typeof def.presence.when !== "function" || input === undefined || def.presence.when(input))),
  verify: async ({ proof }) => (proof ? { ok: true, method: "passkey", keyId: "k1" } : { ok: false, message: "needs a person", methods: [] }),
  challenge: async () => ({ error: { code: "bad_input", message: "no challenges here" } }),
  summary: async () => "", covered: () => false, coverage: () => ({ covered: false, since: null, expires: null }),
  enrolled: [], enroll(k) { this.enrolled.push(k); return { id: `kh${this.enrolled.length}`, kind: k.kind, name: k.name }; },
};
const PROOF = { proof: { method: "passkey", id: "x" } };
const log = (m) => console.log(`${new Date().toISOString()} ${m}`);

const d = await start({ presence: lenient, root, log: (m) => log("vyred: " + m) });
log(`box up, home ${root}, relay ${RELAY}`);
for (const ev of ["device.paired", "relay.paired", "relay.connected", "relay.disconnected", "device.removed"]) {
  try { d.events.on ? d.events.on(ev, (e) => log(`event ${ev} ${JSON.stringify(e).slice(0, 200)}`)) : null; } catch {}
}

const wordsFile = path.join(BOX, "words.txt");
let busy = false;
const tick = async () => {
  if (busy || !fs.existsSync(wordsFile)) return;
  busy = true;
  try {
    const words = fs.readFileSync(wordsFile, "utf8");
    // The file is written by an ssh `cat > words.txt`: it can exist empty or half written. Wait for all 13 words.
    if (words.trim().split(/\s+/).filter(Boolean).length < 13) { busy = false; return; }
    fs.rmSync(wordsFile, { force: true });
    const seed = await wordsToSeed(words, nodeCrypto());
    const r = await d.registry.call("relay.pair.ticket", { seed: Buffer.from(seed).toString("base64url") }, "cli", PROOF);
    log(`ticket for the app's seed: ${r && r.error ? "ERROR " + JSON.stringify(r.error) : "minted (record registered at the relay)"}`);
  } catch (e) { log("ticket failed: " + e.message); }
  busy = false;
};
const timer = setInterval(tick, 2000);
const stop = async () => { clearInterval(timer); await d.stop(); process.exit(0); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);
