// @ts-check
// A Mac server made by the REAL installer, on the hosted macOS runner: scripts/install-mac-server.sh with the runner's own passwordless sudo, against a test release signed with a throwaway key
// (scripts/mac-proof/release.mjs, the way scripts/mac-proof/run.sh does it), with the one-time code the app's install line carries in VYRE_CODE. Never on a person's Mac: it installs a system service
// and makes an account. vyred runs under launchd as the runner's user, so the stand-ins on loopback are its relay and names directory.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

/** @param {{ dir: string, repo: string, code: string, store: "records" | "plain", relayForServer: string, namesForServer: string }} o */
export async function startMacServer(o) {
  if (process.env.GITHUB_ACTIONS !== "true" || process.platform !== "darwin") throw new Error("the Mac server runs on a GitHub macOS runner only: it installs a system service and makes an account");
  const work = path.join(process.env.RUNNER_TEMP || "/tmp", "mac-proof-install");
  fs.rmSync(work, { recursive: true, force: true }); fs.mkdirSync(work, { recursive: true });
  const rel = spawnSync(process.execPath, [path.join(o.repo, "scripts/mac-proof/release.mjs"), work], { encoding: "utf8" });
  if (rel.status !== 0) throw new Error(`the test release was not made: ${rel.stderr.slice(0, 300)}`);
  const key = fs.readFileSync(path.join(work, "release-key.pub"), "utf8").trim();
  const script = path.join(work, "install-mac-server.sh");
  fs.writeFileSync(script, fs.readFileSync(path.join(o.repo, "scripts/install-mac-server.sh"), "utf8").replace(/^RELEASE_KEY=.*/m, `RELEASE_KEY=${key}`));
  const vhome = path.join(process.env.HOME || "/tmp", ".vyre-proof"), sdir = path.join(process.env.HOME || "/tmp", ".vyre-server");
  fs.mkdirSync(vhome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(vhome, "config.json"), JSON.stringify({ relay: { enabled: true, url: o.relayForServer }, network: { directory: o.namesForServer }, names: { directory: o.namesForServer } }));
  // The test release is signed with a throwaway key, so its modules are not first party and the relay would not start ("modules from outside Vyre run only under the module supervisor"): the
  // development path rule lets them run. This is the one difference from a published release, and it is why this walk proves the install and the pairing, not the release signature.
  fs.writeFileSync(path.join(vhome, "vyre.env"), "VYRE_KERNEL_PATH_RULE=1\n", { mode: 0o600 });
  const env = { ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", VYRE_BOX_URL: `file://${work}/site/`, VYRE_HOME: vhome, VYRE_SERVER_DIR: sdir, ...(o.code ? { VYRE_CODE: o.code } : {}), VYRE_NO_DIALOGS: "1", VYRE_STORE: o.store === "plain" ? "sqlite" : "auto" };
  const child = spawn("sh", [script, "--yes"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let all = ""; child.stdout.on("data", d => { all += d; }); child.stderr.on("data", d => { all += d; });
  const exit = await new Promise(res => child.on("close", res));
  fs.mkdirSync(o.dir, { recursive: true });
  fs.writeFileSync(path.join(o.dir, "install.log"), all.replace(/VYRE_CODE=\S+/g, "VYRE_CODE=<hidden>"));
  if (exit !== 0) throw new Error(`the Mac installer exited ${exit}: ${all.split("\n").filter(Boolean).slice(-4).join(" | ").slice(0, 400)}`);
  const m = all.match(/Check words:\s*(?:\x1b\[[0-9;]*m)*([a-z]+(?: [a-z]+){3})/);
  const call = (/** @type {string} */ tool, /** @type {any} */ input = {}) => spawnSync(process.execPath, [path.join(o.repo, "bin/vyre"), "call", tool, JSON.stringify(input)], { encoding: "utf8", env: { ...process.env, VYRE_HOME: vhome } });
  return {
    kind: "mac", store: o.store, logs: /** @type {string[]} */ ([]),
    async words() {
      if (m) return m[1];
      // the Mac installer prints no check words yet; read them from the server and say so
      const r = call("relay.setup.status"); const w = /"words"\s*:\s*"([a-z ]+)"/.exec(String(r.stdout));
      if (!w) throw new Error("the Mac installer printed no check words and the server gave none");
      return w[1];
    },
    /** @param {string} tool @param {any} [input] */
    async operator(tool, input = {}) { const r = call(tool, input); let j = null; try { j = JSON.parse(r.stdout); } catch { /* plain */ } if (r.status !== 0) throw new Error(`${tool}: ${(r.stderr || r.stdout).slice(0, 200)}`); return j && j.data !== undefined ? j.data : j; },
    printedWords: Boolean(m),
    async stop() {
      try { for (const f of fs.readdirSync(path.join(vhome, "logs"))) fs.copyFileSync(path.join(vhome, "logs", f), path.join(o.dir, `vyred-${f}`)); } catch { /* a courtesy */ }
      spawnSync("sh", [script, "--uninstall", "--purge", "--yes"], { env, stdio: "ignore" });
    },
  };
}
