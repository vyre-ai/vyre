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
import { personWorld } from "../lib/proof/person-world.mjs";
import { createRun } from "../lib/proof/run.mjs";
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
/** @type {any} */ let pw = null;
try {
  // the world: a dev-build installer box, a person under a chosen name, the stand-in owner key enrolled in the box's sealer (person-world.mjs; throws with the first refusal if the box will not take it)
  pw = await personWorld({ kind: "box", name: `walker${Math.random().toString(36).slice(2, 6).replace(/[0-9]/g, "x")}`, run, out });
  const J = stepper(run, { id: "PUBLISH", owner: "operations" });
  /** @type {string} */ let space = "";
  /** @type {any} */ let dep = null;
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => pw.call(tool, { space, ...input });
  const decide = async (/** @type {any} */ held) => { const r = await call("publish.decide", { task: held.task, approve: true }); return r; };
  const op = (/** @type {string} */ tool, /** @type {any} */ input = {}) => { const r = inBox(`vyre call ${tool} '${JSON.stringify(input)}'`); try { return JSON.parse(r.stdout); } catch { return null; } };
  /** A stranger at the apps' front, from inside the box's container: the Host is the site's own, the cookie is made up, nothing of Vyre's. */
  const visit = (/** @type {string} */ method, /** @type {string} */ p, /** @type {Record<string, string>} */ headers = {}) => {
    const port = (op("appmods.front") || {}).port, host = dep && dep.hostname;
    const script = `const http=require("http");const r=http.request({host:"127.0.0.1",port:${Number(port)},path:${JSON.stringify(p)},method:${JSON.stringify(method)},headers:Object.assign({host:${JSON.stringify(host)}},${JSON.stringify(headers)})},res=>{let b="";res.on("data",d=>b+=d);res.on("end",()=>console.log(JSON.stringify({status:res.statusCode,headers:res.headers,body:b})))});r.on("error",e=>console.log(JSON.stringify({error:String(e)})));r.end();`;
    const r = sh(`docker exec -u vyre vyre-vyre-1 node -e ${JSON.stringify(script)}`);
    try { return JSON.parse(String(r.stdout).trim().split("\n").pop() || "null"); } catch { return null; }
  };

  await J.step("a team Space on the box: the app claims one under a name, as a person does", async () => {
    const team = await pw.mac.createTeamSpace(`wk${pw.person.slice(-5)}`);
    space = team.space;
    return space;
  });
  await J.step("the folder is written in the daemon's home and Publish makes the draft", async () => {
    const put = (/** @type {string} */ f, /** @type {string} */ body) => { const r = sh(`printf %s ${JSON.stringify(Buffer.from(body).toString("base64"))} | docker exec -i -u vyre vyre-vyre-1 sh -c 'mkdir -p /home/vyre/${NAME} && base64 -d > /home/vyre/${NAME}/${f}'`); if (r.status !== 0) throw new Error(r.stderr); };
    put("Dockerfile", DOCKERFILE); put("server.js", SERVER);
    const r = await call("publish.create", { name: NAME, source: { kind: "folder", ref: `/home/vyre/${NAME}` }, build: { image: "dockerfile" } });
    dep = r.deployment;
    return `${dep.id} ${dep.stage}`;
  });
  await J.step("a secret in the Vault granted to the server for running: a card, the owner's signed yes", async () => {
    await pw.call("vault.put", { name: "greeting-key", kind: "secret", description: "walk", value: "first-secret" });
    const g = await call("publish.secret.grant", { deployment: dep.id, ref: "vault://greeting-key", name: "GREETING_PHRASE", use: ["runtime"] });
    if (!g.held) throw new Error(`a secret grant is held for the person: ${JSON.stringify(g).slice(0, 200)}`);
    await decide(g);
    return "held, decided";
  });
  await J.step("preview builds the image by the root helper (rootless BuildKit on its own network)", async () => {
    const pv = await call("publish.preview", { deployment: dep.id });
    if (!pv.deployment || pv.deployment.stage !== "Preview") throw new Error(JSON.stringify(pv).slice(0, 300));
    return pv.deployment.stage;
  });
  await J.step("going live is held; the owner's signed yes starts the server through the root helper", async () => {
    const held = await call("publish.go", { deployment: dep.id });
    if (!held.held) throw new Error(JSON.stringify(held).slice(0, 300));
    const live = await decide(held);
    if (!live.deployment || live.deployment.stage !== "Production") throw new Error(JSON.stringify(live).slice(0, 300));
    dep = live.deployment;
    return `${dep.stage} ${dep.hostname || ""}`;
  });
  await J.step("a stranger reaches it over HTTP with its secret, and the walls hold (read-only root, writable data, not Vyre's cookie)", async () => {
    const got = visit("GET", "/hello?a=1", { cookie: "vyre_app=FORGED; theme=dark", "x-vyre-viewer": "owner" });
    assert(got && got.status === 200, JSON.stringify(got).slice(0, 300));
    const j = JSON.parse(got.body);
    assert(j.root === "root-read-only" && j.data === "data-writable", `${j.root} ${j.data}`);
    assert(j.key === hexSha("first-secret"), "the granted secret reached the process");
    assert(j.cookie === "theme=dark" && j.vyre.length === 0, "the visitor's cookie, never Vyre's");
    return "200";
  });
  await J.step("the root-side walls: no host mount, capabilities dropped, no way out, no door in", async () => {
    const ins = JSON.parse(sh("docker inspect vyre-app-northwind").stdout)[0];
    assert(ins.HostConfig.ReadonlyRootfs === true && ins.HostConfig.Privileged === false && ins.HostConfig.CapDrop.includes("ALL"), "hardening");
    assert(!(ins.Mounts || []).some((/** @type {any} */ m) => m.Type === "bind"), "no host mount");
    const net = JSON.parse(sh("docker network inspect vyre-app-northwind_net").stdout)[0];
    assert(net.Internal === true, "an internal network");
    const rules = sh("docker exec -u root vyre-vyre-1 iptables -S").stdout;
    assert(/vyre-app:northwind/.test(rules) && !/--dport 4300/.test(rules.split("vyre-app:northwind").join("")), "walled in the vyre container's namespace");
    return "ok";
  });
  await J.step("rotate the secret: revoke and grant the new one (a card, the yes); the server restarts with it", async () => {
    await call("publish.secret.revoke", { deployment: dep.id, name: "GREETING_PHRASE" });
    await pw.call("vault.put", { name: "greeting-key-2", kind: "secret", description: "walk", value: "second-secret" });
    const g = await call("publish.secret.grant", { deployment: dep.id, ref: "vault://greeting-key-2", name: "GREETING_PHRASE", use: ["runtime"] });
    if (g.held) await decide(g);
    await sleep(4000);
    const j = JSON.parse((visit("GET", "/") || {}).body || "{}");
    assert(j.key === hexSha("second-secret"), `the new secret is in the process: ${j.key}`);
    return "restarted with the new secret";
  });
  await J.step("a WebSocket opens for a stranger through the front", async () => {
    const port = (op("appmods.front") || {}).port;
    const script = `const net=require("net");const c=net.connect(${Number(port)},"127.0.0.1",()=>c.write("GET /live HTTP/1.1\\r\\nHost: ${dep.hostname}\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZQ==\\r\\nSec-WebSocket-Version: 13\\r\\nCookie: vyre_app=FORGED; theme=dark\\r\\n\\r\\n"));let b="";c.on("data",d=>{b+=d;if(b.includes("theme"))process.stdout.write(b)});setTimeout(()=>process.exit(),4000)`;
    const r = sh(`docker exec -u vyre vyre-vyre-1 node -e ${JSON.stringify(script)}`);
    assert(/^HTTP\/1\.1 101 /.test(String(r.stdout)) && /"cookie":"theme=dark"/.test(String(r.stdout)), String(r.stdout).slice(0, 300));
    return "101";
  });
  await J.step("an update: the vyre container is made again and the helper walls the server again", async () => {
    const up = sh(`cd /srv/vyre && docker compose -p vyre up -d --force-recreate vyre 2>&1`, { timeout: 600_000 });
    assert(up.status === 0, String(up.stdout).slice(-200));
    for (let i = 0; i < 60; i++) { if (sh("docker inspect -f '{{.State.Health.Status}}' vyre-vyre-1").stdout.trim() === "healthy") break; await sleep(5000); }
    await sleep(15000);
    const rules = sh("docker exec -u root vyre-vyre-1 iptables -S").stdout;
    assert(/vyre-app:northwind/.test(rules), "the server is walled again in the new container");
    const j = JSON.parse((visit("GET", "/") || {}).body || "{}");
    assert(j.key === hexSha("second-secret"), "and still reachable with its secret");
    return "re-walled";
  });
  await J.step("retire takes the server down and keeps the data", async () => {
    await call("publish.retire", { deployment: dep.id });
    assert(sh("docker ps -aq --filter name=^vyre-app-northwind$").stdout.trim() === "", "the container is gone");
    assert(sh("docker volume ls -q --filter name=vyre-app-northwind_data").stdout.includes("data"), "the data stays");
    const gone = visit("GET", "/");
    assert(!gone || gone.status === 404 || gone.error, `the host stops answering: ${JSON.stringify(gone).slice(0, 120)}`);
    return "retired";
  });
  code = run.finish();
} catch (e) {
  console.error(String(/** @type {Error} */ (e).stack || e));
  code = run.finish();
} finally {
  if (pw && process.env.WALK_KEEP !== "1") await pw.close().catch(() => {});
}
if (code !== 0 && process.env.WALK_KEEP === "1") { console.error("WALK_KEEP: the stand-ins and the box stay up for 25 minutes"); await new Promise(r => setTimeout(r, 25 * 60_000)); }
process.exit(code);

/** @param {any} v @param {string} m */
function assert(v, m) { if (!v) throw new Error(m); }
