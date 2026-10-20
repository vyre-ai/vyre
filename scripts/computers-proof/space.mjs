// The one-computer proof (0.6): a throwaway vyred with NO computers.browse setting (the default) whose computers module drives the real Docker driver through the restricted proxy.
// It shows which model served an agent with a computer: the Space's one computer (container csproof-computer-browser-shared), the agent as its own Linux user inside it, its Chrome its own
// (not a context of the shared headless browser), and no per-agent container. Stops at the first FAIL.
//   PROOF_DIR=<folder> PROXY_URL=http://127.0.0.1:<port> BEARER_FILE=<file> node space.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { setPeerHosting } from "../../core/daemon/peer.js";
import { callSocket } from "./lib.mjs";
import { Cdp } from "../../lib/cdp.js";

process.env.VYRE_TEST_HOSTED = "1";
setPeerHosting(true);
const DIR = process.env.PROOF_DIR, PROXY = process.env.PROXY_URL, BEARER = process.env.BEARER_FILE;
if (!DIR || !PROXY || !BEARER) throw new Error("set PROOF_DIR, PROXY_URL and BEARER_FILE");
const HOME = path.join(DIR, "space-home"), VHOME = path.join(DIR, "space-vyre-home");
for (const d of [HOME, VHOME]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
process.env.HOME = HOME; process.env.VYRE_HOME = VHOME; process.env.VYRE_NO_DIALOGS = "1"; process.env.VYRE_ALLOW_DIALOGS = "0";

const PREFIX = "csproof", AGENT = "kit", SHARED = `${PREFIX}-computer-browser-shared`;
const sh = (args, opts = {}) => execFileSync("docker", args, { encoding: "utf8", timeout: 60_000, ...opts }).trim();
const shOk = args => { try { return sh(args, { stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { return `ERR ${String(e.stdout || "").trim()} ${String(e.stderr || e.message).trim()}`.trim(); } };
function check(ok, name, evidence) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${evidence !== undefined ? `: ${typeof evidence === "string" ? evidence : JSON.stringify(evidence)}` : ""}`);
  if (!ok) throw new Error(`step failed: ${name}`);
}

// no `browse` here on purpose: with per-agent users on (agentUsers: true) the Space's computer serves the agent, never the shared browser
fs.writeFileSync(path.join(VHOME, "config.json"), JSON.stringify({
  role: "box", machine: "server", name: "csproof-space",
  modules: { disable: ["names", "network", "hooks", "apps", "relay", "releases", "link", "sync", "push", "github", "google", "mail", "import", "sessions", "chat", "sight"] },
  computers: { docker: PROXY, dockerBearerFile: BEARER, image: "csproof-computer:test", network: "csproof-net", labelPrefix: PREFIX,
    cpus: 2, memoryMb: 3072, screens: 2, sweepMs: 0, bootMs: 120_000, waitMs: 30_000, freezeMs: 600_000, idleMs: 600_000, agentdWaitMs: 120_000, autoUpdate: false, agentUsers: true },
}, null, 2));

const logs = [];
const { start } = await import("../../core/daemon/index.js");
const d = await start({ root: VHOME, log: (m, x) => logs.push(m + (x ? " " + JSON.stringify(x) : "")) });
const person = (tool, input) => callSocket(d.paths.socket, tool, input, "cli");
setTimeout(() => { console.log("FAIL watchdog: the space proof ran over 8 minutes\n" + logs.slice(-40).join("\n")); process.exit(3); }, 8 * 60_000).unref();

let code = 0;
try {
  let r = await person("agents.create", { name: AGENT, computer: true });
  check(!r.error && r.data && r.data.computer === true, "agents.create kit computer:true", r.error || { name: r.data.name });
  // A fresh box, before any agent used a browser: no computer exists, and the Computer tab is told this is a first start (no problem, no driver words). The person presses Wake, and that makes it.
  const before = await person("computers.agent.status", { agent: AGENT });
  check(!before.error && before.data.firstStart === true && !before.data.problem, "before Wake: status says the computer's first start, and names no problem", before.error || before.data);
  const none = shOk(["ps", "-a", "--filter", `name=${PREFIX}-`, "--format", "{{.Names}}"]);
  check(none === "", "before Wake: no computer exists", none);
  const woke = await person("computers.agent.wake", { agent: AGENT });
  check(!woke.error, "the person presses Wake", woke.error || woke.data);
  let live = null;
  for (let i = 0; i < 40 && !(live && live.state === "live"); i++) {
    const s = await person("computers.agent.status", { agent: AGENT });
    live = s.data || null;
    if (!(live && live.state === "live")) await new Promise(r => setTimeout(r, 3000));
  }
  check(Boolean(live && live.state === "live" && !live.problem && !live.firstStart), "after Wake: the agent's computer is live, with no problem and no longer a first start", live);
  const made = shOk(["ps", "-a", "--filter", `name=${PREFIX}-`, "--format", "{{.Names}}|{{.Status}}"]).split("\n").filter(Boolean);
  check(made.length === 1 && made[0].startsWith(SHARED + "|Up"), "Wake made the Space's one computer, through the real driver and the restricted proxy", made);
  r = await person("computers.checkout", { agent: AGENT, why: "csproof" });
  check(!r.error && r.data.model === "computer", "computers.checkout says the model that served it: the Space's computer", r.error || r.data);
  const ps = shOk(["ps", "-a", "--filter", `name=${PREFIX}-`, "--format", "{{.Names}}|{{.Status}}"]).split("\n").filter(Boolean);
  check(ps.length === 1 && ps[0].startsWith(SHARED + "|Up"), "one container, the Space's computer, and no container of the agent's own", ps);
  const st = await person("computers.agent.status", { agent: AGENT });
  check(!st.error, "the agent has a place on the computer", st.error || st.data);
  const user = shOk(["exec", "-u", "0", SHARED, "sh", "-c", "getent passwd | grep -E '^ag2[0-9]{4}:' | head -3"]);
  check(/^ag2\d{4}:/m.test(user), "agent users exist in the Space's computer (ag2xxxx)", user.split("\n")[0]);
  const ep = await d.registry.call("computers.helper", { agent: AGENT }, "module:vyred");
  check(!ep.error && ep.data.url && ep.data.token, "computers.helper names the agent's own Chrome link", ep.error || { url: ep.data.url });
  // Chrome is still starting for a few seconds after the wake; the hands ask computers.endpoint again on every call, so each try asks again
  let c = null, ok = false, lastErr = "";
  for (let i = 0; i < 30 && !ok; i++) {
    try {
      const e2 = await d.registry.call("computers.helper", { agent: AGENT }, "module:vyred");
      if (e2.error) throw new Error(e2.error.message);
      c = new Cdp({ cdpUrl: `${String(e2.data.url).replace(/\/+$/, "")}/cdp`, token: e2.data.token });
      await c.connect(); ok = true;
    } catch (e) { lastErr = String(e.message); await new Promise(r => setTimeout(r, 2000)); }
  }
  check(ok, "the agent's Chrome answers over the link", lastErr || undefined);
  const procs = shOk(["exec", "-u", "0", SHARED, "sh", "-c", "ps -eo user,args | grep -E 'agentd-chrome|^agb2' | grep -v grep | cut -c1-120 | head -5"]);
  check(/agb2\d{4}/.test(procs), "that Chrome runs as the agent's own browser uid (agb2xxxx), not as the shared browser's uid", procs.split("\n")[0]);
  check(logs.some(l => /agent browser: kit is served by its own Linux user on the Space's computer/.test(l)), "vyred logged the model in use");
  check(!logs.some(l => /shared browser \(computers\.browse is "browser" on purpose\)/.test(l)), "and did not log the shared browser");
  c.ws && c.ws.close();
  console.log("space proof: all checks passed");
} catch (e) {
  code = 1;
  if (!/^step failed/.test(e.message)) console.log(`FAIL error: ${e.stack || e.message}`);
  console.log("--- last vyred log lines\n" + logs.slice(-25).join("\n"));
  console.log("--- every csproof container\n" + shOk(["ps", "-a", "--filter", `name=${PREFIX}-`, "--format", "{{.Names}}|{{.Status}}"]));
  const both = cmd => { try { return execFileSync("sh", ["-c", cmd], { encoding: "utf8", timeout: 60_000 }).trim(); } catch (e) { return String(e.stdout || e.message); } };
  console.log("--- container log (both streams)\n" + both(`docker logs --tail 80 ${SHARED} 2>&1`).slice(-6000));
  console.log("--- processes\n" + shOk(["exec", "-u", "0", SHARED, "sh", "-c", "ps -eo user,pid,args | grep -E 'agb2|ag2|agentd|python3' | grep -v grep | cut -c1-200 | head -30"]));
  console.log("--- agent status\n" + JSON.stringify((await person("computers.agent.status", { agent: AGENT })).data || null));
  console.log("--- the holder by hand as the agent's browser uid (8 s)\n" + both(`docker exec -u 21000 ${SHARED} sh -c 'timeout 8 python3 -I /opt/agentd/agentd-chrome.py 2>&1 | grep -v -i dbus | head -15'`));
}
process.exit(code);
