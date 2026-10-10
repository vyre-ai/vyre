// @ts-check
// Run INSIDE the vyre container of a real installer box, as the daemon's user, to walk the daemon's side of a site's server against the REAL root helper: the build context is handed over as the module does
// (core/builder `buildByHelper`), the server is started and replaced through the helper driver as appmods does, and what a visitor and the app can reach is looked at from where each stands.
// Driven by scripts/proof/pub-helper-proof.sh, which does the root-side looking. One line per check: PASS or FAIL.
//   docker exec -u vyre vyre-vyre-1 node /tmp/pub-helper-inside.mjs <step> [args]
// Steps: build (prints the image id), up <name> <secret>, get <name>, ws <name>, stop, down, refuse (a Dockerfile root must refuse).
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { buildByHelper } from "/opt/vyre/core/builder/index.js";
import { checkDockerfile } from "/opt/vyre/lib/publish/dockerfile.js";
import { askHelper } from "/opt/vyre/stores/twenty/helper.js";
import { createHelperDriver } from "/opt/vyre/core/appmods/helper-driver.js";
import { publishedManifest } from "/opt/vyre/core/appmods/published.js";

const HOME = process.env.VYRE_HOME || path.join(os.homedir(), ".vyre");
const SPC = "spc_proofproof12", DEP = "dep_00000000000000a1";
const NAME = "proofsite";
const SERVER = `const http = require("http"), fs = require("fs"), crypto = require("crypto");
http.createServer((q, r) => {
  let root = "root-read-only"; try { fs.writeFileSync("/etc/x", "1"); root = "root-writable"; } catch {}
  let data = "data-writable"; try { fs.writeFileSync("/data/n", "1"); } catch { data = "data-read-only"; }
  const k = process.env.GREETING_PHRASE;
  r.end(JSON.stringify({ root, data, key: k ? crypto.createHash("sha256").update(k).digest("hex").slice(0, 8) : null, uid: process.getuid() }));
}).on("upgrade", (q, sock) => {
  const accept = crypto.createHash("sha1").update(q.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  sock.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: " + accept + "\\r\\n\\r\\n");
  const m = Buffer.from("ws-ok"); sock.write(Buffer.concat([Buffer.from([0x81, m.length]), m])); sock.on("error", () => {});
}).listen(8080);
`;
const DOCKERFILE = `FROM node:22-alpine\nRUN mkdir /data && chown node /data\nWORKDIR /app\nCOPY server.js .\nUSER node\nEXPOSE 8080\nCMD ["node", "server.js"]\n`;
const say = (/** @type {boolean} */ ok, /** @type {string} */ what, /** @type {string} */ more = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}${more ? `: ${more}` : ""}`); if (!ok) process.exitCode = 1; };
const driver = createHelperDriver({ home: HOME });
const manifest = (/** @type {number} */ version, /** @type {string} */ image, /** @type {string[]} */ secrets) => publishedManifest({ id: DEP, name: NAME, version, runtime: { kind: "image", image, port: 8080 }, secrets }, { catalogNames: ["documents", "pdf"], public: true });
const stateFile = path.join(HOME, "proof-image");

const [step, ...args] = process.argv.slice(2);
if (step === "build") {
  const ctx = { paths: { root: HOME } };
  const files = [{ path: "Dockerfile", content: Buffer.from(DOCKERFILE) }, { path: "server.js", content: Buffer.from(SERVER) }];
  const t0 = Date.now();
  const r = await buildByHelper(ctx, { ask: askHelper }, { id: DEP, space: SPC, name: NAME, version: 1 }, files, 8080, []);
  say(/^sha256:[0-9a-f]{64}$/.test(r.image), "the helper built the image from the folder the daemon wrote", `${r.image.slice(0, 19)} in ${Math.round((Date.now() - t0) / 1000)} s`);
  say(!fs.existsSync(path.join(HOME, "publish", SPC, "servers", DEP)), "and took the folder (nothing of ours is left in it)");
  fs.writeFileSync(stateFile, r.image);
} else if (step === "up") {
  const [, secret] = args;
  const image = fs.readFileSync(stateFile, "utf8").trim();
  const m = manifest(1, image, ["GREETING_PHRASE"]);
  const up = await driver.up(/** @type {any} */ ({ space: "spc_x", manifest: m, vars: {}, secrets: { GREETING_PHRASE: secret }, publishSpace: SPC }));
  say(up.origin === `http://vyre-app-${NAME}:8080`, "the helper started the server and it is reachable by its name from the daemon", up.origin);
  say(!fs.existsSync(path.join(HOME, "publish", SPC, "servers", DEP)), "the folder with the secret was taken");
} else if (step === "get") {
  const r = await fetch(`http://vyre-app-${NAME}:8080/`, { signal: AbortSignal.timeout(8000) });
  const j = /** @type {any} */ (await r.json());
  const want = args[1] ? crypto.createHash("sha256").update(args[1]).digest("hex").slice(0, 8) : null;
  say(j.root === "root-read-only" && j.data === "data-writable", "the root is read-only and /data is writable", `${j.root}, ${j.data}`);
  say(j.key === want, "the granted secret is in the process", `key ${j.key}`);
  say(j.uid !== 0, "and it does not run as root", `uid ${j.uid}`);
} else if (step === "ws") {
  const got = await new Promise(resolve => {
    const c = net.connect(8080, `vyre-app-${NAME}`, () => c.write(`GET /live HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    let b = ""; c.on("data", d => { b += d; if (b.includes("ws-ok")) { c.destroy(); resolve(b); } }); c.on("error", () => resolve(b)); setTimeout(() => { c.destroy(); resolve(b); }, 5000).unref();
  });
  say(/^HTTP\/1\.1 101 /.test(String(got)) && String(got).includes("ws-ok"), "a WebSocket opens on the server");
} else if (step === "stop") {
  await driver.stop({ manifest: manifest(1, fs.readFileSync(stateFile, "utf8").trim(), ["GREETING_PHRASE"]) });
  say(true, "stop was answered");
} else if (step === "down") {
  await driver.down({ manifest: manifest(1, fs.readFileSync(stateFile, "utf8").trim(), ["GREETING_PHRASE"]) }, {});
  say(true, "down was answered");
} else if (step === "refuse") {
  // a Dockerfile root must refuse, asked of the helper itself
  const bad = [{ path: "Dockerfile", content: Buffer.from("FROM evil.example/x\nEXPOSE 8080\n") }];
  try { checkDockerfile("FROM evil.example/x\nEXPOSE 8080\n"); say(false, "the shared rule refuses it"); } catch { say(true, "the shared rule refuses it"); }
  try { await buildByHelper({ paths: { root: HOME } }, { ask: askHelper }, { id: "dep_00000000000000a2", space: SPC, name: NAME, version: 1 }, bad, 8080, []); say(false, "the helper refused a base that is not allowed"); }
  catch (e) { say(/starts from evil\.example/.test(String(/** @type {Error} */ (e).message)), "the helper refused a base that is not allowed", String(/** @type {Error} */ (e).message).slice(0, 110)); }
} else { console.error("steps: build | up <name> <secret> | get <name> <secret> | ws | stop | down | refuse"); process.exit(64); }
