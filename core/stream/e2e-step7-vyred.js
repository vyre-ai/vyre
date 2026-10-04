// @ts-check
// The vyred process of STEP 7 (team/0.3/E2E-RUN.md), started by core/stream/e2e-step7.test.js as a child process on a temp home, never by anything else. It is the real daemon
// (core/daemon start: the kernel on, the real Switchboard running the fake claude, core/sessions, the stream, the durable turns store) with one test-only seam, the `presence` option of start()
// that vyred's own main.js never passes (finds a person). Its front
// door is a small HTTP and WebSocket harness on 127.0.0.1 (the daemon itself listens on a unix socket only): POST /call runs a tool as a person (their kernel surface token), a WebSocket
// upgrade goes to the stream's own upgrade handler (the ticket stream.open handed out is the whole authority, as in production), GET /info, POST /add-carol.
// Run only with a temp VYRE_HOME, on the test box.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { start } from "../daemon/index.js";
import * as config from "../config/index.js";
import { open } from "../store/index.js";
import { homeIdentity } from "../../kernel/home.js";

import { present } from "../../test/helpers.js";

const root = config.home();
const real = (/** @type {string} */ p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
if (!(real(root) + path.sep).startsWith(real(os.tmpdir()) + path.sep) || real(root) === real(path.join(os.homedir(), ".vyre"))) { console.error("e2e-step7-vyred: only for a temp VYRE_HOME"); process.exit(1); }
process.env.VYRE_NO_DIALOGS = "1";

const stateFile = path.join(root, "e2e-state.json");
/** @type {{ chat?: string }} */ let state = {};
try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { /* first boot */ }
const ALEX_ID = homeIdentity(root).owner, CAROL = "per_carol";
if (!state.chat) {
  // The home is seeded once, BEFORE the daemon starts, by a kernel booted on the same home with a sealing process that allows an unattested software key (the daemon's own sealer cannot:
  // no production path enrols one). The owner's signer is that key; the one held act (a member joining) carries a real signed proof the real sealer checks. The daemon then boots on the
  // seeded home with its own sealer and the same checks everywhere; nothing in core/daemon is switched off.
  const { startSealer } = await import("../../kernel/seal/client.js");
  const { bootHomeKernel } = await import("../../kernel/home.js");
  const { signer } = await import("../../kernel/seal/testing.js");
  const { canonical, sha256 } = await import("../../kernel/core/canonical.js");
  const pp = config.ensure(root);
  const sdb = open(pp.db);
  const idf = homeIdentity(root);
  const sealer = startSealer({ dir: path.join(idf.dir, "seal"), dev: true, unattested: true });
  await sealer.health();
  const sk = await bootHomeKernel({ db: sdb, root, log: () => {}, isFirstParty: () => false, sealer });
  const sg = signer(idf.owner);
  const atDeck = sk.chains.fromFacts({ kind: "socket", surface: "deck", uid: process.getuid ? process.getuid() : 0 });
  const begun = await sealer.begin({ chain: atDeck, person: idf.owner, key_id: sg.enrolment.key_id, spki: sg.enrolment.spki });
  await sealer.enrol({ chain: atDeck, person: idf.owner, key_id: sg.enrolment.key_id, spki: sg.enrolment.spki, signer: sg.enrolment.signer, token: begun.token });
  const oc = sk.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: idf.owner, path: "direct", session: "s" });
  const r = { person: CAROL, role: "member" };
  const input_hash = sha256(canonical({ action: "grants.role", input: r }));
  await sk.gateway.grants.setRole(oc, r, { presence: sg.proof(oc, "grant.role", { resource: `vyre://${sk.id.space}/member/${CAROL}`, input_hash }) });
  const chat = await sk.gateway.grants.chats.create(oc, { people: [], assistants: ["assistant"] });
  state.chat = chat.id;
  fs.writeFileSync(stateFile, JSON.stringify(state));
  await sk.stop();
  await sealer.close();
  sdb.close();
}
// Devices enrol per Space (the spaces module answers spaces.devices.enrolled, and a device not enrolled gets no kernel chain). This harness has no claimed identity to enrol carol's paired device
// with, so the spaces module is switched off for this home: with no list every device is enrolled (core/daemon deviceEnrolled). A stand-in, named in team/0.3/E2E-RUN.md.
{ const cp = path.join(root, "config.json"); /** @type {any} */ let c = {}; try { c = JSON.parse(fs.readFileSync(cp, "utf8")); } catch { /* none yet */ } c.modules = { ...(c.modules || {}), disable: [...new Set([...((c.modules && c.modules.disable) || []), "spaces"])] }; fs.writeFileSync(cp, JSON.stringify(c)); }
const d = await start({ root, presence: present, kernel: true, log: m => console.log(`${new Date().toISOString()} ${m}`) }).catch(e => { console.error("vyred: " + e.stack); process.exit(1); });
const k = /** @type {any} */ (d.kernel);
const ALEX = k.id.owner;
const ownerChain = k.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: ALEX, path: "direct", session: "s" });
const G = k.gateway.grants;
// What the daemon proves about a connection and hands the module as meta.kernelFacts (core/daemon/index.js callerFacts): the owner's deck on the 0600 socket, and a member's paired device. The
// harness stands in for the listener that proved them; a person's call carries FACTS, never a session token (a token is an assistant session's, and a session's chain may not open another).
/** @type {Record<string, any>} */ const facts = {
  alex: { kind: "socket", surface: "deck", uid: process.getuid ? process.getuid() : 0, pid: 0, inside_model_process: false, capsule_verified: false },
  carol: { kind: "device", device_key_id: "d-carol", person: CAROL, path: "wink" } };

const body = (/** @type {any} */ req) => new Promise(res => { /** @type {Buffer[]} */ const b = []; req.on("data", (/** @type {Buffer} */ c) => b.push(c)); req.on("end", () => { try { res(JSON.parse(Buffer.concat(b).toString() || "{}")); } catch { res({}); } }); });
const send = (/** @type {any} */ res, /** @type {any} */ o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/info") return send(res, { chat: state.chat, alex: ALEX, carol: CAROL, pid: process.pid });
    if (req.method === "POST" && req.url === "/add-carol") { await G.chats.change(ownerChain, state.chat, { add_people: [CAROL] }); return send(res, { ok: true }); }
    if (req.method === "POST" && req.url === "/call") {
      const j = /** @type {any} */ (await body(req));
      return send(res, await d.registry.call(String(j.tool), j.input || {}, "deck", { kernelFacts: facts[String(j.who)] }));
    }
    res.writeHead(404); res.end();
  } catch (e) { send(res, { error: { code: "harness", message: String(/** @type {Error} */ (e).message) } }); }
});
server.on("upgrade", (req, socket, head) => {
  const h = d.registry.upgrades.get("stream/session");
  if (!h) { socket.destroy(); return; }
  h.handler(req, socket, head, { caller: "deck", url: new URL(req.url || "/", "http://vyred") });
});
await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
fs.writeFileSync(path.join(root, "e2e-harness.json"), JSON.stringify({ port: /** @type {any} */ (server.address()).port, pid: process.pid }));
const quit = async () => { server.closeAllConnections(); server.close(); await d.stop(); process.exit(0); };
process.on("SIGTERM", quit);
process.on("SIGINT", quit);
