// @ts-check
// The vyred process of STEP 7 (team/0.3/E2E-RUN.md), started by core/stream/e2e-step7.test.js as a child process on a temp home, never by anything else. It is the real daemon
// (core/daemon start: the kernel on, the real Switchboard running the fake claude, core/sessions, the stream, the durable turns store) with two test-only seams, both options of start()
// that vyred's own main.js never passes: `presence` (finds a person) and `kernelPresence` (accepts any proof for a grants act, so a member and a chat can be made headless). Its front
// door is a small HTTP and WebSocket harness on 127.0.0.1 (the daemon itself listens on a unix socket only): POST /call runs a tool as a person (their kernel surface token), a WebSocket
// upgrade goes to the stream's own upgrade handler (the ticket stream.open handed out is the whole authority, as in production), GET /info, POST /add-carol.
// Run only with a temp VYRE_HOME, on the test box.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { start } from "../daemon/index.js";
import { home } from "../config/index.js";
import { present } from "../../test/helpers.js";

const root = home();
const real = (/** @type {string} */ p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
if (!(real(root) + path.sep).startsWith(real(os.tmpdir()) + path.sep) || real(root) === real(path.join(os.homedir(), ".vyre"))) { console.error("e2e-step7-vyred: only for a temp VYRE_HOME"); process.exit(1); }
process.env.VYRE_NO_DIALOGS = "1";

const kernelPresence = { check: async (/** @type {any} */ i) => (i && i.chain && i.proof ? null : "no_proof") };
// A person's token is a SESSION chain on a real daemon (kernel/core/surfaces.js chainFor), and a session chain may not open another session (CH-7), which the stream's own write of a person's
// words needs (it opens the person's session from the call's chain). The daemon has no way yet to hand a module a person's DIRECT chain for a Deck call (reported to platform), so this
// harness maps each person's token to their direct chain, as the in-process rigs do (group-ks-live.test.js), through a test-only seam of start().
/** @type {Map<string, any>} */ const direct = new Map();
const kernelForWrap = (/** @type {(m: any) => any} */ kf) => (/** @type {any} */ m) => { const h = kf(m); return Object.freeze({ ...h, chain: async (/** @type {any} */ meta) => (meta && direct.get(meta.token)) || h.chain(meta) }); };
const d = await start({ root, presence: present, kernelPresence, kernelForWrap, kernel: true, log: m => console.log(`${new Date().toISOString()} ${m}`) }).catch(e => { console.error("vyred: " + e.stack); process.exit(1); });
const k = /** @type {any} */ (d.kernel);
const ALEX = k.id.owner, CAROL = "per_carol";
const ownerChain = k.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: ALEX, path: "direct", session: "s" });
const G = k.gateway.grants;
const proof = { op: "test", n: 1 };
const stateFile = path.join(root, "e2e-state.json");
/** @type {{ chat?: string }} */ let state = {};
try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { /* first boot */ }
if (!state.chat) {
  const r = { person: CAROL, role: "member" };
  await G.setRole(ownerChain, r, { presence: proof });
  const chat = await G.chats.create(ownerChain, { people: [], assistants: ["assistant"] });
  state.chat = chat.id;
  fs.writeFileSync(stateFile, JSON.stringify(state));
}
// a surface for each person on every boot: the tokens do not survive a restart, the people and the chat do
const chainOf = { alex: k.chains.fromFacts({ kind: "device", device_key_id: "d-alex", person: ALEX, path: "direct" }), carol: k.chains.fromFacts({ kind: "device", device_key_id: "d-carol", person: CAROL, path: "direct" }) };
/** @type {Record<string, string>} */ const tokens = {};
for (const [n, c] of Object.entries(chainOf)) { tokens[n] = (await k.surfaces.open(c, {})).token; direct.set(tokens[n], c); }

const body = (/** @type {any} */ req) => new Promise(res => { /** @type {Buffer[]} */ const b = []; req.on("data", (/** @type {Buffer} */ c) => b.push(c)); req.on("end", () => { try { res(JSON.parse(Buffer.concat(b).toString() || "{}")); } catch { res({}); } }); });
const send = (/** @type {any} */ res, /** @type {any} */ o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/info") return send(res, { chat: state.chat, alex: ALEX, carol: CAROL, pid: process.pid });
    if (req.method === "POST" && req.url === "/add-carol") { await G.chats.change(ownerChain, state.chat, { add_people: [CAROL] }); return send(res, { ok: true }); }
    if (req.method === "POST" && req.url === "/call") {
      const j = /** @type {any} */ (await body(req));
      return send(res, await d.registry.call(String(j.tool), j.input || {}, "deck", { token: tokens[String(j.who)] }));
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
