// @ts-check
// A server made by the REAL installer, on a throwaway CI runner with docker: scripts/install-box.sh run from this checkout (--from, signed with a throwaway key for this server only), with the
// one-time code and the store choice the app's install line carries (VYRE_CODE, VYRE_STORE). The box's relay and names directory are the stand-ins on this runner, written into the box's home
// before it first starts (the way scripts/matrix/j1.sh does). The four words are the ones the installer printed on its terminal, which is what a person reads.
// Refuses to run anywhere but a CI runner: it uses the fixed /srv/vyre folder and container names, and a shared test box already has a stack there.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const sh = (/** @type {string} */ cmd, /** @type {any} */ opt = {}) => spawnSync("sh", ["-c", cmd], { encoding: "utf8", ...opt });

/** @param {{ dir: string, repo: string, code: string, store: "records" | "plain", relayForServer: string, namesForServer: string, relayPort?: number, hostIp?: string, noCodeProbe?: boolean }} o */
export async function startInstallerServer(o) {
  if (!process.env.CI) throw new Error("the installer server runs on a CI runner only (CI is unset): it uses /srv/vyre and the container names vyre-*, which a shared test box already holds");
  const script = path.join(o.repo, "scripts", "install-box.sh");
  fs.mkdirSync(o.dir, { recursive: true });
  const dir = process.env.VYRE_DIR || "/srv/vyre";
  sh(`sudo mkdir -p ${dir} && sudo chown "$(id -u):$(id -g)" ${dir}`);
  // the box's home volume with its config, made before the first start so it never talks to a production service
  sh("docker volume create --label com.docker.compose.project=vyre --label com.docker.compose.volume=vyre-home vyre_vyre-home >/dev/null");
  const cfg = JSON.stringify({ relay: { enabled: true, url: o.relayForServer }, network: { directory: o.namesForServer }, names: { directory: o.namesForServer } });
  const seeded = sh(`docker run --rm -v vyre_vyre-home:/home/vyre -e C='${cfg}' busybox sh -c 'mkdir -p /home/vyre/.vyre && printf "%s\\n" "$C" >/home/vyre/.vyre/config.json && chown -R 1000:1000 /home/vyre && chmod 700 /home/vyre/.vyre && chmod 600 /home/vyre/.vyre/config.json'`);
  if (seeded.status !== 0) throw new Error(`could not seed the box's home: ${seeded.stderr}`);
  const logFile = path.join(o.dir, "install.log");
  const env = { ...process.env, ...(o.code ? { VYRE_CODE: o.code } : {}), VYRE_STORE: o.store === "plain" ? "sqlite" : "auto", VYRE_DIR: dir };
  // The line the app shows is `curl -fsSL vyre.run/i | VYRE_CODE=... VYRE_STORE=... sh`. Here the same script runs from this checkout with the same two variables. `--from` is the installer's own way to install a build that is
  // not a published release: it packs the checkout and signs it with a throwaway key for this server only (dev_sign), since a build that is not signed by Vyre's release key cannot run its modules.
  const child = spawn("sh", [script, "--yes", "--from", o.repo], { env, stdio: ["ignore", "pipe", "pipe"] });
  let all = "";
  child.stdout.on("data", d => { all += d; }); child.stderr.on("data", d => { all += d; });
  const exit = await new Promise(res => child.on("close", res));
  fs.writeFileSync(logFile, all.replace(/VYRE-?CODE=\S+/g, "VYRE_CODE=<hidden>"));
  if (exit !== 0 && !o.noCodeProbe) throw new Error(`the installer exited ${exit}: ${all.split("\n").filter(Boolean).slice(-4).join(" | ").slice(0, 400)}`);
  if (o.noCodeProbe) {
    // the line run with no code from the app: what it printed, and whether it started a pairing of its own (a QR, a long code or a typed code)
    sh(`cd ${dir} && docker compose -p vyre down -v --remove-orphans >/dev/null 2>&1`);
    return { output: all, exit };
  }
  const m = all.match(/Your four words:\s*(?:\x1b\[[0-9;]*m)*([a-z]+(?: [a-z]+){3})/);
  const printed = m ? m[1] : "";
  const exec = (/** @type {string} */ tool, /** @type {any} */ input = {}) => {
    const r = spawnSync("docker", ["exec", "-u", "vyre", "vyre-vyre-1", "vyre", "call", tool, JSON.stringify(input)], { encoding: "utf8" });
    return r;
  };
  return {
    kind: "installer", store: o.store, logs: /** @type {string[]} */ ([]),
    /** The four words the installer printed on its terminal. */
    async words() { if (!printed) throw new Error("the installer printed no check words (IR-1: show_words)"); return printed; },
    /** @param {string} tool @param {any} [input] */
    async operator(tool, input = {}) { const r = exec(tool, input); let j = null; try { j = JSON.parse(r.stdout); } catch { /* plain text */ } if (r.status !== 0) throw new Error(`${tool}: ${(r.stderr || r.stdout).slice(0, 200)}`); return j && j.data !== undefined ? j.data : j; },
    async stop() {
      const l = sh(`docker exec -u vyre vyre-vyre-1 sh -c 'for f in ~/.vyre/logs/*; do echo "== $f"; tail -n 300 "$f"; done' 2>&1; docker logs --tail 100 vyre-vyre-1 2>&1`); try { fs.writeFileSync(path.join(o.dir, "vyred.log"), String(l.stdout || "")); } catch { /* a courtesy */ }
      sh(`cd ${dir} && docker compose -p vyre down -v --remove-orphans >/dev/null 2>&1`);
    },
  };
}
