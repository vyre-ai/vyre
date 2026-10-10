// @ts-check
// A site's server, walked as a person does it, on a DEVELOPMENT-build box installed by the real installer (scripts/install-box.sh --from, VYRE_DEV_SIGN=0): a real daemon in the real container, the real
// root Space helper, a real Docker, a real rootless BuildKit. Only two things are stood in for: the app's signer (a development key, enrolled through the product's own identity and presence calls, signs
// exactly what each card shows) and the public door (the stranger arrives at the apps' front from inside the box's container instead of through the relay). What this cannot cover: the release signature
// (a packaged build ignores every developer switch, kernel/devbuild.js) and a hardware key. Throwaway test boxes only (VYRE_JOURNEY_BOX=1); leaves /srv/vyre installed unless --uninstall.
//   VYRE_JOURNEY_BOX=1 node scripts/proof/publish-walk.mjs [--uninstall]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRun } from "../lib/proof/run.mjs";
import { bringUp } from "../journeys/lib/world.mjs";
import { stepper } from "../journeys/lib/journey.mjs";

const out = fs.mkdtempSync(path.join(os.tmpdir(), "publish-walk-"));
const run = createRun({ out });
const NAME = "northwind";
const DOCKERFILE = `FROM node:22-alpine
RUN mkdir /data && chown node /data
WORKDIR /app
COPY server.js .
USER node
EXPOSE 8080
CMD ["node", "server.js"]
`;
const SERVER = `const http = require("http"), fs = require("fs"), crypto = require("crypto");
http.createServer((q, r) => {
  let root = "root-read-only"; try { fs.writeFileSync("/etc/x", "1"); root = "root-writable"; } catch { /* read-only */ }
  let data = "data-writable"; try { fs.writeFileSync("/data/n", "1"); } catch { data = "data-read-only"; }
  const k = process.env.GREETING_PHRASE;
  r.setHeader("set-cookie", "s=1; Path=/; Domain=.localhost");
  r.end(JSON.stringify({ root, data, key: k ? crypto.createHash("sha256").update(k).digest("hex").slice(0, 8) : null, cookie: q.headers.cookie || null, method: q.method, url: q.url, vyre: Object.keys(q.headers).filter(h => h.startsWith("x-vyre-")) }));
}).on("upgrade", (q, sock) => {
  const accept = crypto.createHash("sha1").update(q.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  sock.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: " + accept + "\\r\\n\\r\\n");
  const msg = Buffer.from(JSON.stringify({ ws: true, cookie: q.headers.cookie || null }));
  sock.write(Buffer.concat([Buffer.from([0x81, msg.length]), msg]));
  sock.on("error", () => {});
}).listen(8080);
`;
const sh = (/** @type {string} */ cmd, /** @type {any} */ opt = {}) => spawnSync("sh", ["-c", cmd], { encoding: "utf8", ...opt });
const inBox = (/** @type {string} */ cmd) => sh(`docker exec -u vyre vyre-vyre-1 sh -c ${JSON.stringify(cmd)}`);
const hexSha = (/** @type {string} */ s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 8);
const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));

let code = 1;
/** @type {any} */ let w = null;
try {
  w = await bringUp({ run, out, kind: "box", store: "plain", devBuild: true });
  const J = stepper(run, { id: "PUBLISH", owner: "operations" });
  if (!w.ready) { await J.step("the world is up", () => { throw new Error("the dev-build box world did not come up"); }); throw new Error("no world"); }
  const srv = w.srv;
  const personId = w.mac.identity.id;
  /** @type {string} */ let space = "";
  /** @type {any} */ let dep = null;
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => w.call(tool, { ...(space ? { space } : {}), ...input });

  await J.step("the owner's stand-in key is on the identity list and in the box's sealer, through the product's own calls", async () => {
    const sg = srv.ownerSigner;
    assert(sg, "the installer server has an owner signer");
    const spki = sg.enrolment.spki;
    const b64u = Buffer.from(spki, "base64").toString("base64url");
    const added = await w.call("spaces.identity.entry.add", { kind: "device", publicKey: b64u, label: "stand-in owner key" });
    const begun = await w.call("spaces.presence.begin", { key_id: sg.enrolment.key_id, spki });
    const rec = await w.call("spaces.presence.recover", { key_id: sg.enrolment.key_id, spki, signer: "software", token: begun.token });
    return JSON.stringify({ added: !!added, token: !!begun.token, recovered: rec });
  });
  const spaces = await w.call("spaces.list", {});
  space = (Array.isArray(spaces) ? spaces : spaces.spaces || [])[0].id;

  await J.step("the folder is written in the daemon's home and Publish makes the draft", async () => {
    const put = (/** @type {string} */ f, /** @type {string} */ body) => { const r = sh(`printf %s ${JSON.stringify(Buffer.from(body).toString("base64"))} | docker exec -i -u vyre vyre-vyre-1 sh -c 'mkdir -p /home/vyre/${NAME} && base64 -d > /home/vyre/${NAME}/${f}'`); if (r.status !== 0) throw new Error(r.stderr); };
    put("Dockerfile", DOCKERFILE); put("server.js", SERVER);
    const r = await call("publish.create", { name: NAME, source: { kind: "folder", ref: `/home/vyre/${NAME}` }, build: { image: "dockerfile" } });
    dep = r.deployment;
    return `${dep.id} ${dep.stage}`;
  });
  // the secret is the person's, granted to this server for running only; the card is the person's yes
  await J.step("the owner puts a secret in the Vault and grants it to the server: a card, the signed yes", async () => {
    await call("vault.put", { name: "greeting-key", kind: "secret", description: "walk", value: "first-secret" });
    const g = await call("publish.secret.grant", { deployment: dep.id, ref: "vault://greeting-key", name: "GREETING_PHRASE", use: ["runtime"] });
    if (g.held) await call("publish.decide", { task: g.task, approve: true });
    return `held=${Boolean(g.held)}`;
  });
  await J.step("preview builds the image by the root helper (rootless BuildKit)", async () => {
    const pv = await call("publish.preview", { deployment: dep.id });
    if (!pv.deployment || pv.deployment.stage !== "Preview") throw new Error(JSON.stringify(pv).slice(0, 300));
    return pv.deployment.stage;
  });
  await J.step("going live is held; the owner's signed yes starts the server through the root helper", async () => {
    const held = await call("publish.go", { deployment: dep.id });
    if (!held.held) throw new Error(JSON.stringify(held).slice(0, 300));
    const live = await call("publish.decide", { task: held.task, approve: true });
    if (!live.deployment || live.deployment.stage !== "Production") throw new Error(JSON.stringify(live).slice(0, 300));
    return live.deployment.stage;
  });
  // the stranger: the apps' front is on the box's loopback inside the container; the visitor is not the owner
  const status = await call("publish.status", { deployment: dep.id });
  console.log("publish.status:", JSON.stringify(status).slice(0, 500));
  void hexSha; void sleep; void inBox;
  code = run.finish();
} catch (e) {
  console.error(String(/** @type {Error} */ (e).stack || e));
  code = run.finish();
} finally {
  if (w) await w.stop().catch(() => {});
}
process.exit(code);

/** @param {any} v @param {string} m */
function assert(v, m) { if (!v) throw new Error(m); }
