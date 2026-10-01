// Make and start ONE computer through Vyre's own DockerDriver and the restricted proxy, the way the
// pool does (create, seed .boot, start), without the rest of vyred. For the image and isolation
// checks. Writes the computer's secrets to <out>.json (0600) under the proof folder.
//   node computer-up.mjs <proxy-url> <bearer-file> <agent> <out.json> [image] [network]
import fs from "node:fs";
import crypto from "node:crypto";
import { DockerDriver } from "../../core/computers/driver/docker.js";
import { readFileSync } from "node:fs";

const [url, bearerFile, agent, out, image = "csproof-computer:test", network = "csproof-net"] = process.argv.slice(2);
const d = new DockerDriver({ url, bearer: readFileSync(bearerFile, "utf8").trim(), labelPrefix: "csproof", network });
const token = crypto.randomBytes(24).toString("base64url");
const vnc = crypto.randomBytes(6).toString("base64url").slice(0, 8);
const { id } = await d.create({ agent, image, network, env: { SCREEN: "1440x900" }, cpus: 2, memoryMb: 2048, size: { w: 1440, h: 900 },
  labels: { "csproof.computer": agent, "csproof.managed": "true" }, volume: `csproof-home-${agent}`, browserVolume: `csproof-browser-${agent}` });
await d.seed(id, { computerd_token: token, vnc_password: vnc });
await d.start(id);
fs.writeFileSync(out, JSON.stringify({ id, name: `csproof-computer-${agent}`, token, vnc }), { mode: 0o600 });
console.log("started", id.slice(0, 12));
