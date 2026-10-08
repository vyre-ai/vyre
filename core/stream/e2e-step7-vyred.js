// @ts-check
// The vyred process of STEP 7 (team/0.3/E2E-RUN.md), started by core/stream/e2e-step7.test.js as a child process on a temp home, never by anything else. It is the real daemon
// (core/daemon start: the kernel on, the real Switchboard running the fake claude, core/sessions, the stream, the durable turns store) with one test-only seam, the `presence` option of start()
// that vyred's own main.js never passes (finds a person). Its front
// door is a small HTTP and WebSocket harness on 127.0.0.1 (the daemon itself listens on a unix socket only): POST /call runs a tool as a person (their kernel surface token), a WebSocket
// upgrade goes to the stream's own upgrade handler (the ticket stream.open handed out is the whole authority, as in production), GET /info, POST /add-carol.
// Run only with a temp VYRE_HOME, on the test box.
// A development build lets the home reserve each walk name itself (a release build takes a code from vyre.run/setup).
process.env.VYRE_TEST_SELF_RESERVE ??= "1";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { start } from "../daemon/index.js";
import * as config from "../config/index.js";
import { open } from "../store/index.js";
import { homeIdentity } from "../../kernel/home.js";
import net from "node:net";
import { fileURLToPath } from "node:url";

import { present } from "../../test/helpers.js";

const root = config.home();
const real = (/** @type {string} */ p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
if (!(real(root) + path.sep).startsWith(real(os.tmpdir()) + path.sep) || real(root) === real(path.join(os.homedir(), ".vyre"))) { console.error("e2e-step7-vyred: only for a temp VYRE_HOME"); process.exit(1); }
process.env.VYRE_NO_DIALOGS = "1";

const stateFile = path.join(root, "e2e-state.json");
/** @type {{ chat?: string, record?: string, recordError?: string }} */ let state = {};
try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { /* first boot */ }
const ALEX_ID = homeIdentity(root).owner;
// carol is a REAL claimed identity (the real path for a second person's device, windows' member-device enrolment in core/spaces, the shape of test/one-registry.test.js): her name is claimed at a
// stand-in names directory this harness starts (its storage kept in --state, so a restart of this harness keeps every claim), made by her own home on the same directory, and the Space finds
// her identity list there.
const { spawn } = await import("node:child_process");
const { call: callTool } = await import("../daemon/client.js");
const dirPort = await new Promise(res => { const n = net.createServer(); n.listen(0, "127.0.0.1", () => { const p = /** @type {any} */ (n.address()).port; n.close(() => res(p)); }); });
const dirChild = spawn(process.execPath, [path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "standin-directory.mjs"), "--port", String(dirPort), "--state", path.join(root, "dir-state.bin"), "--claims-per-ip", "50"], { stdio: ["ignore", "pipe", "inherit"] });
process.on("exit", () => { try { dirChild.kill("SIGTERM"); } catch { /* gone */ } });
await new Promise((res, rej) => { dirChild.stdout.on("data", d => { if (String(d).includes("stand-in names directory")) res(null); }); dirChild.on("exit", c => rej(new Error(`the stand-in directory exited early (${c})`))); });
/** @type {{ chat?: string, carol?: { id: string, eid: string } }} */
const carolState = state;
if (!carolState.carol) {
  const carolRoot = path.join(root, "carol-home");
  fs.mkdirSync(carolRoot, { recursive: true });
  fs.writeFileSync(path.join(carolRoot, "config.json"), JSON.stringify({ name: "carol-home", transcripts: [], vault: { keystore: "file" }, names: { directory: `http://127.0.0.1:${dirPort}` }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const carolDaemon = await start({ root: carolRoot, kernel: true, log: () => {} });
  const made = /** @type {any} */ (await callTool("spaces.identity.create", { name: "carolwalk" }, { root: carolRoot, caller: "cli" }));
  if (made.error) { console.error("carol: " + JSON.stringify(made.error)); process.exit(1); }
  carolState.carol = { id: made.data.id, eid: made.data.eid };
  await carolDaemon.stop();
  fs.writeFileSync(stateFile, JSON.stringify(carolState));
}
const carolId = carolState.carol;
const CAROL = carolId.id;
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
  // step 8: a record with a sealed ssn, made by the owner through the kernel's gateway: the plain value goes to the sealing process and the record keeps only the reference
  const SSN_TYPE = { name: "contact", label: "Contact", fields: [{ name: "name", kind: "text", label: "Name", required: true }, { name: "ssn", kind: "sealed", label: "SSN", seal: { level: "ai", class: "us-ssn" } }] };
  try {
    await sk.gateway.records.define(oc, { add_types: [SSN_TYPE] }, { presence: sg.proof(oc, "records.define", { resource: `vyre://${sk.id.space}/definition/types` }) });
    const rec = await sk.gateway.records.create(oc, "contact", { name: "Jane Doe" });
    const put = await sk.gateway.seal.put(oc, { record: rec.urn, field: "ssn", class: "us-ssn", value: "123-45-6789" });
    await sk.gateway.records.update(oc, "contact", rec.id, { ssn: put && put.ref ? put.ref : put }, rec.version);
    state.record = rec.urn;
  } catch (e) { state.recordError = String(/** @type {Error} */ (e).message); }
  fs.writeFileSync(stateFile, JSON.stringify(state));
  await sk.stop();
  await sealer.close();
  sdb.close();
}
// The home's names directory is the stand-in started above (the Space reads carol's identity list from it); the spaces module stays ON.
{ const cp = path.join(root, "config.json"); /** @type {any} */ let c = {}; try { c = JSON.parse(fs.readFileSync(cp, "utf8")); } catch { /* none yet */ } c.names = { ...(c.names || {}), directory: `http://127.0.0.1:${dirPort}` }; fs.writeFileSync(cp, JSON.stringify(c)); }
const d = await start({ root, presence: present, kernel: true, log: m => console.log(`${new Date().toISOString()} ${m}`) }).catch(e => { console.error("vyred: " + e.stack); process.exit(1); });
const k = /** @type {any} */ (d.kernel);
// the Space has verified carol's name (written when an invite is redeemed): the one row the member-device enrolment reads
d.registry.deps.db.prepare("INSERT OR REPLACE INTO spaces_kv (key, value) VALUES (?, ?)").run(`person-name/${CAROL}`, JSON.stringify("carolwalk"));
const ALEX = k.id.owner;
const ownerChain = k.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: ALEX, path: "direct", session: "s" });
const G = k.gateway.grants;
// What the daemon proves about a connection and hands the module as meta.kernelFacts (core/daemon/index.js callerFacts): the owner's deck on the 0600 socket, and a member's paired device. The
// harness stands in for the listener that proved them; a person's call carries FACTS, never a session token (a token is an assistant session's, and a session's chain may not open another).
/** @type {Record<string, any>} */ const facts = {
  alex: { kind: "socket", surface: "deck", uid: process.getuid ? process.getuid() : 0, pid: 0, inside_model_process: false, capsule_verified: false },
  carol: { kind: "device", device_key_id: carolId.eid, person: CAROL, path: "wink" } };

const body = (/** @type {any} */ req) => new Promise(res => { /** @type {Buffer[]} */ const b = []; req.on("data", (/** @type {Buffer} */ c) => b.push(c)); req.on("end", () => { try { res(JSON.parse(Buffer.concat(b).toString() || "{}")); } catch { res({}); } }); });
const send = (/** @type {any} */ res, /** @type {any} */ o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/info") return send(res, { chat: state.chat, alex: ALEX, carol: CAROL, pid: process.pid, record: state.record || null, recordError: state.recordError || null });
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
