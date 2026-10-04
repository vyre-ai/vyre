// Two-box proof of the space-side checkpoint store (runner, 4 Oct). Roles, each on its own box:
//   home <host> <port> <root>        the home: serves core/runner/checkpoint-store.js over the wire (token -> the session's chain)
//   lender <url> <base> <label>      a lent session: the real runner, sandbox and encrypted workspace, checkpointing to the home over the wire;
//                                    prints "turn N sent" lines; the orchestrator kills it with SIGKILL in the middle of a turn
//   resume <url> <base> <label>      another box: resumes the session from the home's copy and reports what it found
//   peek <url>                       what the home holds: checkpoint turn, files, transcript lines
// Driven by scripts/runner-ckpt-e2e.sh. Test boxes only (hosted-guard).
import "../core/runner/testing/hosted-guard.js";
import fs from "node:fs"; import path from "node:path"; import http from "node:http"; import crypto from "node:crypto";
import { createRunner } from "../core/runner/runner.js";
import { createCheckpointStore } from "../core/runner/checkpoint-store.js";
import { createCheckpointServer, remoteSync } from "../core/runner/checkpoint-wire.js";
import { fakeSpace } from "../core/runner/testing/fake-space.js";

const [role, ...a] = process.argv.slice(2);
const SES = process.env.SESSION || "s1";
const SPACE = "spc_harlow000001", TOKEN = "e2e-session-token";
const chain = { space: SPACE, hops: [{ actor: { kind: "person", id: "per_alex", space: SPACE } }], labels: { trust: "member", red: "internal", source_spaces: [SPACE] } };
const t0 = Date.now(), log = (...x) => console.log(String(Math.round((Date.now() - t0) / 100) / 10).padStart(6) + "s", ...x);
const sleep = ms => new Promise(r => setTimeout(r, ms));

if (role === "home") {
  const [host, port, root] = a;
  // The kernel's authorize, stood in: only this session token's person may write or read this Space's session state.
  const store = createCheckpointStore({ space: SPACE, root, authorize: async i => ({ effect: i.chain.hops[0].actor.id === "per_alex" ? "allow" : "deny" }) });
  const srv = createCheckpointServer({ store, authenticate: t => (t === TOKEN ? chain : null) });
  srv.listen(Number(port), host, () => log("home listening", host + ":" + port, "root", root));
} else if (role === "peek") {
  const s = remoteSync({ url: a[0], token: () => TOKEN });
  const cp = await s.getCheckpoint(SES), lines = await s.getTranscript(SES, 1);
  console.log(JSON.stringify({ turn: cp?.turn ?? 0, seq: cp?.seq ?? 0, files: Object.keys(cp?.manifest || {}), transcriptLines: lines.length }));
} else if (role === "lender" || role === "resume") {
  const [url, base, label] = a;
  const sync = remoteSync({ url, token: () => TOKEN });
  const agentDir = path.join(base, "agent"); fs.mkdirSync(agentDir, { recursive: true });
  fs.copyFileSync(new URL("../core/runner/testing/fake-agent.js", import.meta.url), path.join(agentDir, "agent.js"));
  const up = http.createServer((req, res) => res.end("ok")); await new Promise(r => up.listen(0, "127.0.0.1", r));
  const sp = fakeSpace();   // the lease and the provider credential are not what is under test; the checkpoints go to the home
  const r = createRunner({ base: path.join(base, "rn"), space: "harlow", device: label, vault: sp.vault, sync, grants: () => ({ spaceAllows: true, memberAccepts: true }), watchdog: false, verifyState: () => true,
    onEvent: e => { if (e.type === "checkpoint" || e.type === "sync" || e.type === "exit") log("event", JSON.stringify(e).slice(0, 300)); } });
  const routes = [{ prefix: "/provider", upstream: `http://127.0.0.1:${up.address().port}`, credential: { ref: "vault://provider", header: "x-api-key" }, allow: [{ method: "GET", path: "/v1/messages" }] }];
  const h = await r.start({ session: SES, resume: role === "resume", command: process.execPath, args: [path.join(agentDir, "agent.js")], readOnly: [agentDir, path.dirname(process.execPath)], routes, env: {} });
  log(role, "started pid", h.pid, "resumed", JSON.stringify(h.resumed ? { turn: h.resumed.turn, seq: h.resumed.seq } : null));
  h.child.stdout.on("data", d => { for (const l of String(d).split("\n").filter(Boolean)) log("agent>", l.slice(0, 400)); });
  const homeTurn = async () => (await sync.getCheckpoint(SES))?.turn || 0;
  if (role === "lender") {
    for (const [n, w] of [[1, "alpha"], [2, "bravo"]]) { h.send("turn " + w); for (let i = 0; i < 120 && (await homeTurn()) < n; i++) await sleep(500); log("home holds checkpoint", await homeTurn()); }
    h.send("turn charlie"); log("turn 3 sent");
    // KILL_AFTER_MS later this process and everything under it (the sandbox, the agent) are SIGKILLed: during the turn, during the checkpoint, or after it.
    await sleep(Number(process.env.KILL_AFTER_MS || 0)); process.kill(-process.pid, "SIGKILL");
    await sleep(600000);
  } else {
    await sleep(8000);
    h.send("turn delta"); for (let i = 0; i < 120 && (await homeTurn()) < (h.resumed?.turn || 0) + 1; i++) await sleep(500);
    log("after resume the home holds checkpoint", await homeTurn());
    await h.stop(); await r.lock(); process.exit(0);
  }
}
