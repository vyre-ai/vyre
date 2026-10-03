// @ts-check
// The app's side of a real-install pairing proof (docs/work/tailnet.md, "Real install"). Two real vyred daemons from this checkout in temp
// homes, "app" (the person's computer) and "phone", driven over a 127.0.0.1 control port, so a script or a person can interleave their calls
// with the real i.sh running on a box. Presence is FAKED the way test/wink.test.js does it (a lenient presence double accepts any proof);
// that is the one stand-in: a headless box cannot give Touch ID. Nothing here is the product's own code path for presence.
//
//   node scripts/install/app-side.mjs --relay ws://HOST:PORT [--control 39600] [--root DIR] [--srv]
//   curl -s localhost:39600/call -d '{"who":"app","tool":"wink.pair.targets","input":{}}'
//   curl -s localhost:39600/call -d '{"who":"app","tool":"wink.pair.server","input":{...},"proof":true}'
//
// Not run in CI and never on a person's Mac (the daemon's host guard refuses a real home); run it on a test box.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { start } from "../../core/daemon/index.js";
import { HUMAN_ONLY } from "../../core/presence/index.js";

const arg = (/** @type {string} */ k, /** @type {string} */ d = "") => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const relay = arg("relay");
if (!relay) { console.error("needs --relay ws://host:port (a relay that answers /v1/wink/code)"); process.exit(2); }
const control = Number(arg("control", "39600"));
const base = arg("root") || fs.mkdtempSync(path.join(os.tmpdir(), "wink-app-"));

const lenient = {
  required: (/** @type {string} */ tool, /** @type {any} */ def, /** @type {any} */ input) => HUMAN_ONLY.has(tool) || Boolean(def && def.presence && (typeof def.presence.when !== "function" || input === undefined || def.presence.when(input))),
  verify: async (/** @type {any} */ { proof }) => (proof ? { ok: true, method: "passkey", keyId: "k1" } : { ok: false, message: "needs a person", methods: ["passkey"] }),
  challenge: async () => ({ error: { code: "bad_input", message: "no challenges here" } }),
  summary: async () => "",
  covered: () => false,
  coverage: () => ({ covered: false, since: null, expires: null }),
  enrolled: /** @type {any[]} */ ([]),
  enroll(/** @type {any} */ k) { this.enrolled.push(k); return { id: `kh${this.enrolled.length}`, kind: k.kind, name: k.name }; },
};

/** @type {Record<string, any>} */
const worlds = {};
// --srv adds a third vyred, "srv", to stand in as a server with a screen (presence faked) so wink.server.reset, which a headless Docker box cannot give presence for, runs for real.
for (const who of process.argv.includes("--srv") ? ["app", "phone", "srv"] : ["app", "phone"]) {
  const root = path.join(base, who);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", name: who, transcripts: [], network: { name: who }, relay: { enabled: true, url: relay }, modules: { disable: ["names", "onboard"] } }));
  const d = await start({ presence: lenient, root, log: (/** @type {string} */ m) => console.log(`[${who}]`, m) });
  /** @type {any[]} */ const events = [];
  d.events.on("*", (/** @type {any} */ e) => events.push([e.type, e.payload]));
  worlds[who] = { d, root, events };
}
const PROOF = { proof: { method: "passkey", id: "x" } };

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", c => { body += c; });
  req.on("end", async () => {
    try {
      const b = JSON.parse(body || "{}");
      if (req.url === "/events") { res.end(JSON.stringify(worlds[b.who].events.slice(-(b.n || 20)))); return; }
      const w = worlds[b.who];
      const meta = { peer: { stableId: `node-${b.who}`, node: b.who }, person: { id: `ps-${b.who}` }, ...(b.proof ? PROOF : {}) };
      // `caller` overrides the default device caller (a server's own screen is "cli", which wink.server.reset requires).
      const out = await w.d.registry.call(b.tool, b.input || {}, b.caller || "device:abcdefghijklmnop", meta);
      res.end(JSON.stringify(out));
    } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: String(e) })); }
  });
});
server.listen(control, "127.0.0.1", () => console.log(`app-side ready: control 127.0.0.1:${control}, homes ${base}, relay ${relay}`));
const stop = async () => { server.close(); for (const w of Object.values(worlds)) await w.d.stop(); process.exit(0); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
