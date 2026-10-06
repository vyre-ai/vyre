// @ts-check
// A throwaway world for the phone apps: the Deck's world (web/test/world.js: the fictional
// corpus, two projects, two held Gate items) on a box, with every request looking like alex's
// phone on the tailnet. A test helper, not part of the product. Never touches ~/.vyre.
//
//   node apps/test/world.js [port]      default 4800; 0 picks a free port. Prints the URL, runs
//                                       until SIGINT/SIGTERM, then removes the home.
//
// How a request becomes the phone's without weakening production: vyred runs in this process,
// and the proxy hands each request to the daemon's own router the way the names listener does
// after `tailscale whois`, with caller tailnet:alex@example.com and the phone as the peer. No
// production code reads a caller from a header; only this script, which owns the listener, says
// who is calling. vyred's own socket still answers only local callers.
//
// Endpoints the proxy answers itself, never passed to vyred:
//   POST /__test/code   a one-time presence code, minted as a module would, for enrolling a device key
//   POST /__test/hold   holds another Gate item (the body, or a fictional email to Dana)
//   POST /__test/ask    starts a thread on a fake claude that asks to write a file: an open ask
//   POST /__test/outbox what the Gate sent, as the local fake mail and billing servers got it
//
// Nothing leaves the machine. Both Gate senders point at a fake server on 127.0.0.1, with fake
// credentials in the file-keystore vault, so an approval from the phone really sends, to it.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildHome, makeProjects, makeAgents, heldItems } from "../../web/test/world.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { asOwner } from "../../test/helpers.js";
import { setPeerHosting } from "../../core/daemon/peer.js";

// This world hosts vyred in its own process and drives it from that process and its children:
// the one seam the caller check keeps for a test (core/daemon/peer.js).
setPeerHosting(true);

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = process.argv[2] === undefined ? 4800 : Number(process.argv[2]);
const OWNER = "alex@example.com";
const ADDRESS = "https://vyre.example.ts.net";
const PHONE = { node: "alex-phone", stableId: "nTEST", login: OWNER };

const root = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vy-mobile-")));
// alex's folders sit outside VYRE_HOME: the security floor refuses writes into Vyre's own state.
const alexRoot = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vy-mobile-alex-")));
const ALEX = path.join(alexRoot, "alex");
process.on("exit", () => { for (const d of [root, alexRoot]) try { fs.rmSync(d, { recursive: true, force: true }); } catch {} });

// No real Claude Code, no hooks in the user's settings, no login keychain: a fake claude that
// speaks stream-json, a harness dir inside the home, and the file keystore.
process.env.VYRE_HOME = root;
process.env.VYRE_NO_DIALOGS = "1";
process.env.VYRE_CLAUDE_BIN = path.join(REPO, "core", "switchboard", "testing", "fake-claude.js");
// The fake speaks the CLI's stream-json, so threads run on the CLI runner, not the Agent SDK.
process.env.VYRE_SESSIONS_DRIVER = "cli";
process.env.VYRE_HARNESS_DIR = path.join(root, "no-harness");
process.env.FAKE_CLAUDE_LOG = path.join(root, "claude.log");

// The fake outside world: a Gmail-shaped API and the billing host, both recording what reaches them.
/** @type {{ at: number, method: string, path: string, body: string }[]} */
const sent = [];
const outbox = http.createServer((req, res) => {
  let body = ""; req.on("data", c => (body += c));
  req.on("end", () => { sent.push({ at: Date.now(), method: String(req.method), path: String(req.url), body }); res.writeHead(200, { "content-type": "application/json" }); res.end('{"id":"m1","threadId":"t1"}'); });
});
await new Promise(r => outbox.listen(0, "127.0.0.1", () => r(undefined)));
const OUT = `http://127.0.0.1:${/** @type {any} */ (outbox.address()).port}`;

const w = buildHome(root, {
  // A box, so the box's rules apply: no terminal codes, a code enrolls only from the owner's device.
  role: "box",
  network: { owner: OWNER, address: ADDRESS },
  vault: { keystore: "file" },
  gate: { senders: {
    mail: { type: "gmail", vault: "harlow-gmail", from: "alex@harlowlegal.com", base: OUT },
    billing: { type: "http", vault: "northwind-ads", hosts: [OUT] },
  } },
  files: { roots: [path.join(ALEX, "Work")] },
  // Nothing here listens on the network, starts containers or opens a browser: the proxy below is
  // the only listener, and no box module reaches Tailscale, Docker or Chrome.
  modules: { disable: ["names", "onboard", "link", "computers", "glass", "hands-chrome", "hands-desktop"] },
}, ALEX);

const { start } = await import("../../core/daemon/index.js");
const d = await start({ root });
// the world's own calls as "cli" arrive as the owner's device, as on the real socket (the chat gate refuses a caller with no person)
asOwner(d, root);
const handle = d.registry.deps.handler({});
// PW-1: on a box a one-time code enrols a key only from the owner's own PAIRED device (a confirmed Wink record), not from a tailnet login. This world is alex's phone on the tailnet and no real pairing runs here, so the
// phone stands in for the paired owner device: the presence layer's `ownerDevice` answers true for exactly the world's one caller. (The real rule is tested in core/presence and test/wink-paired.test.js.)
d.registry.deps.presence.ownerDevice = async (/** @type {string} */ caller) => String(caller || "").toLowerCase() === `tailnet:${OWNER}`.toLowerCase();

// Fake credentials for both senders, put and granted to the Gate by alex at the Mac with a Capsule
// key that is removed again at once, so the phone starts with nothing but a code to enroll with.
{
  const presence = d.registry.deps.presence;
  const cap = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const key = presence.enroll({ kind: "capsule", name: "setup", public_key: cap.publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7 });
  const { inputHash } = await import("../../core/presence/index.js");
  const person = (tool, input) => {
    const ts = String(Date.now()), nonce = crypto.randomBytes(12).toString("base64url");
    const sig = crypto.sign("sha256", Buffer.from(`vyre-presence-v1\n${tool}\n${inputHash(input)}\n${ts}\n${nonce}`), { key: cap.privateKey, dsaEncoding: "der" }).toString("base64url");
    return d.registry.call(tool, input, "cli", { proof: { method: "capsule", key: key.id, ts, nonce, sig } });
  };
  for (const name of ["harlow-gmail", "northwind-ads"]) {
    const put = await person("vault.put", { name, kind: "api-key", fields: { value: "fixture-" + crypto.randomBytes(8).toString("hex") } });
    const grant = await person("vault.grant", { name, module: "gate" });
    if (put.error || grant.error) console.error(`mobile world: could not set up ${name}: ${(put.error || grant.error).message}`);
  }
  // The token juno and kit are recorded with; nothing here starts either of them.
  const token = await person("vault.put", { name: "claude-setup-token", kind: "secret", fields: { value: "fixture-" + crypto.randomBytes(8).toString("hex") } });
  if (token.error) console.error(`mobile world: could not set up claude-setup-token: ${token.error.message}`);
  presence.remove(key.id);
}

// Let the first Recall pass land so search sees the corpus, then the projects and held items.
await new Promise(r => setTimeout(r, 1500));
await makeProjects(w);
await makeAgents(root);
// An agent's item names it by caller. One that names a thread comes in as the Deck world's does,
// with no caller at all: vyred confirms a thread only for a session it launched.
// gate.request declares its callers (core/gate/index.js) and "anonymous" is not among them, so a thread item comes in as a plain mcp caller.
const agentCaller = body => (body && typeof body.agent === "string" && typeof body.thread !== "string" ? `mcp:agent:${body.agent}` : "mcp");
// The Deck world's items, with the billing request pointed at the local fake host.
const local = item => item.via !== "billing" ? item
  : { ...item, to: [OUT], content: { ...item.content, url: OUT + new URL(item.content.url).pathname } };
for (const item of heldItems(w.threads).map(local)) {
  // A thread is confirmed only for a session vyred launched, which this world has none of: the item is held without it (the registry refuses an unconfirmable thread).
  const { thread: _thread, ...held } = item;
  const r = await d.registry.call("gate.request", held, agentCaller(item));
  if (r.error) console.error(`mobile world: could not hold an item: ${r.error.message}`);
}

const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const readBody = req => new Promise(resolve => {
  let s = ""; req.on("data", c => (s += c)); req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch { resolve(null); } });
});
const reply = (res, r) => json(res, r.error ? 400 : 200, r);

/** The test endpoints. Each calls the registry directly, as a module or a model would. */
const TEST = {
  // presence.code is no longer open to module callers (it needs the person), so the world mints the code on the presence store itself, as a test helper.
  "/__test/code": async () => ({ data: await d.registry.deps.presence.mintCode() }),
  "/__test/outbox": async () => ({ data: sent }),
  "/__test/hold": async body => {
    const item = body && body.kind ? body : { kind: "send", via: "mail", to: ["dana@harlowlegal.com"], project: "harlow-legal",
      why: "A reply to a client waits for you.", content: { subject: "Intake form, next steps", body: "Hi Dana,\n\nThe intake form is ready for a last look. Two fields changed since Friday.\n\nAlex" } };
    return d.registry.call("gate.request", item, agentCaller(body));
  },
  "/__test/asks": async () => d.registry.call("threads.asks", {}, "cli"),
  "/__test/ask": async () => {
    const cwd = path.join(w.work, "harlow-site");
    const file = path.join(cwd, `notes-${Date.now()}.txt`);
    const started = await d.registry.call("threads.start", { cwd, name: "Intake notes", prompt: `write ${file}`, surface: "deck" }, "cli");
    if (started.error) return started;
    const thread = started.data.id;
    for (let i = 0; i < 100; i++) {
      const open = await d.registry.call("threads.asks", { thread }, "cli");
      if (open.data && open.data.length) return { data: { thread, ask: open.data[0].id } };
      await new Promise(r => setTimeout(r, 100));
    }
    return { error: { code: "failed", message: "the fake thread did not ask in time" } };
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://world");
  if (url.pathname.startsWith("/__test/")) {
    const fn = TEST[url.pathname];
    if (!fn || req.method !== "POST") return json(res, 404, { error: { code: "not_found", message: url.pathname } });
    const body = await readBody(req);
    try { return reply(res, await fn(body)); } catch (e) { return json(res, 500, { error: { code: "failed", message: /** @type {Error} */ (e).message } }); }
  }
  // The names listener's checks (core/names/service.js), so an app that would fail on the box fails here.
  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.origin;
    const isJson = /^application\/json\b/.test(String(req.headers["content-type"] || ""));
    if (!isJson || (origin && origin.toLowerCase() !== `http://${String(req.headers.host || "").toLowerCase()}`)) {
      return json(res, 403, { error: { code: "denied", message: "cross-site request" } });
    }
  }
  return handle(req, res, `tailnet:${OWNER}`, PHONE);
});

server.listen(PORT, "127.0.0.1", () => {
  const port = /** @type {any} */ (server.address()).port;
  console.log(`mobile world: http://127.0.0.1:${port}/  (home ${root})`);
});

let quitting = false;
const quit = async () => {
  if (quitting) return;
  quitting = true;
  server.closeAllConnections();
  server.close();
  try { await d.stop(); } catch {}
  outbox.close();
  process.exit(0);
};
process.on("SIGINT", quit);
process.on("SIGTERM", quit);
