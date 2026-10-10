// @ts-check
// A server made by the REAL installer, on a throwaway CI runner with docker: scripts/install-box.sh run from this checkout (--from, signed with a throwaway key for this server only), with the
// one-time code and the store choice the app's install line carries (VYRE_CODE, VYRE_STORE). The box's relay and names directory are the stand-ins on this runner, written into the box's home
// before it first starts (the way scripts/matrix/j1.sh does). The four words are the ones the installer printed on its terminal, which is what a person reads.
// Refuses to run anywhere but a CI runner: it uses the fixed /srv/vyre folder and container names, and a shared test box already has a stack there.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const sh = (/** @type {string} */ cmd, /** @type {any} */ opt = {}) => spawnSync("sh", ["-c", cmd], { encoding: "utf8", ...opt });

/** @param {{ devBuild?: boolean, recreate?: boolean, ownerId?: string, dir: string, repo: string, code: string, store: "records" | "plain", relayForServer: string, namesForServer: string, relayPort?: number, hostIp?: string, noCodeProbe?: boolean, release?: { oldBox: string, oldUrl: string, newUrl: string, newVersion: string, pub: string } }} o
 * `release` (the update proof): the server is the OLD release, installed by that release's own installer from a local release site, and its update unit is pointed at the candidate's site (signed by the same throwaway key). */
export async function startInstallerServer(o) {
  if (!process.env.CI && process.env.VYRE_JOURNEY_BOX !== "1") throw new Error("the installer server runs on a CI runner only (CI is unset): it uses /srv/vyre and the container names vyre-*, which a shared test box already holds (a test box that holds nothing there says so with VYRE_JOURNEY_BOX=1)");
  const script = path.join(o.repo, "scripts", "install-box.sh");
  fs.mkdirSync(o.dir, { recursive: true });
  const dir = process.env.VYRE_DIR || "/srv/vyre";
  sh(`sudo mkdir -p ${dir} && sudo chown "$(id -u):$(id -g)" ${dir}`);
  // the box's home volume with its config, made before the first start so it never talks to a production service
  sh("docker volume create --label run.vyre=1 --label com.docker.compose.project=vyre --label com.docker.compose.volume=vyre-home vyre_vyre-home >/dev/null");
  // The box reaches the names directory through lib/http.js, which refuses plain http and any address that is not public, except the box's OWN loopback (the way a person points a box at their own
  // directory). The stand-in listens on the runner, so the box is told 127.0.0.1:<port> and a forwarder inside its container (below) carries that port to the runner.
  const dirPort = new URL(o.namesForServer).port, dirHost = new URL(o.namesForServer).hostname;
  const namesLoop = `http://127.0.0.1:${dirPort}`;
  const cfg = JSON.stringify({ relay: { enabled: true, url: o.relayForServer }, network: { directory: namesLoop }, names: { directory: namesLoop } });
  const seeded = sh(`docker run --rm -v vyre_vyre-home:/home/vyre -e C='${cfg}' busybox sh -c 'mkdir -p /home/vyre/.vyre && printf "%s\\n" "$C" >/home/vyre/.vyre/config.json && chown -R 1000:1000 /home/vyre && chmod 700 /home/vyre/.vyre && chmod 600 /home/vyre/.vyre/config.json'`);
  if (seeded.status !== 0) throw new Error(`could not seed the box's home: ${seeded.stderr}`);
  if (o.release) {
    // The notice the app shows is the box's remembered look at the releases (update.json in its home); the box has no way to read this runner's release site itself (it only fetches over https or from its own loopback), so the look is written
    // as the daemon writes it, naming the candidate. What happens after the person's click is all real: the request file, the root unit, the signature check, the swap.
    const seen = JSON.stringify({ checkedAt: Date.now(), latest: o.release.newVersion, channel: "stable", notes: [{ version: o.release.newVersion, notes: "The build under test." }], announced: o.release.newVersion, requestedFor: null, error: null });
    const w = sh(`docker run --rm -v vyre_vyre-home:/home/vyre -e S='${seen}' busybox sh -c 'printf "%s" "$S" >/home/vyre/.vyre/update.json && chown 1000:1000 /home/vyre/.vyre/update.json && chmod 600 /home/vyre/.vyre/update.json'`);
    if (w.status !== 0) throw new Error(`could not seed the box's update look: ${w.stderr}`);
  }
  const logFile = path.join(o.dir, "install.log");
  // A DEVELOPMENT build of the box (install-box.sh --from with VYRE_DEV_SIGN=0: no release signature), whose sealing process takes the three developer switches from vyre.env: a stand-in owner key can then
  // give the person's yes. A packaged build ignores all of them (kernel/devbuild.js). Only for a throwaway test box; this is how Publish's card and the signed yes are walked without a hardware key.
  if (o.devBuild) fs.writeFileSync(path.join(dir, "vyre.env"), "VYRE_SEAL_DEV=1\nVYRE_SEAL_SOFTWARE=1\nVYRE_SEAL_UNATTESTED=1\nVYRE_KERNEL_PATH_RULE=1\n", { mode: 0o600 });
  const env = { ...process.env, ...(o.code ? { VYRE_CODE: o.code } : {}), VYRE_STORE: o.store === "plain" ? "sqlite" : "auto", VYRE_DIR: dir, ...(o.devBuild ? { VYRE_DEV_SIGN: "unsigned", VYRE_MODULES_TRIES: "0" } : {}) };
  // The line the app shows is `curl -fsSL vyre.run/i | VYRE_CODE=... VYRE_STORE=... sh`. Here the same script runs from this checkout with the same two variables. `--from` is the installer's own way to install a build that is
  // not a published release: it packs the checkout and signs it with a throwaway key for this server only (dev_sign), since a build that is not signed by Vyre's release key cannot run its modules.
  const child = o.release
    ? spawn("sh", [path.join(o.release.oldBox, "install-box.sh"), "--yes"], { env: { ...env, VYRE_BOX_URL: o.release.oldUrl, VYRE_BUILD: "tgz", VYRE_DEV_SIGN: "0", VYRE_MODULES_TRIES: "0" }, stdio: ["ignore", "pipe", "pipe"] })
    : spawn("sh", [script, "--yes", "--from", o.repo], { env, stdio: ["ignore", "pipe", "pipe"] });
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
  if (o.release && exit === 0) {
    // the root unit that acts on the app's request reads the candidate's site and the throwaway key from its own unit file (a systemd drop-in); nothing of the unit's code changes
    const conf = `[Service]\nEnvironment=VYRE_BOX_URL=${o.release.newUrl}\nEnvironment=VYRE_RELEASES_API=\nEnvironment=VYRE_RELEASE_KEY=${o.release.pub}\nEnvironment=VYRE_UPDATE_MIN_GAP=0\nEnvironment=VYRE_UPDATE_WAIT=300\n`;
    const d = sh(`sudo mkdir -p /etc/systemd/system/vyre-update.service.d && printf '${conf}' | sudo tee /etc/systemd/system/vyre-update.service.d/proof.conf >/dev/null && sudo systemctl daemon-reload && systemctl is-active vyre-update.path`);
    fs.appendFileSync(logFile, `\nupdate unit drop-in: ${d.status} ${String(d.stdout || d.stderr).trim()}\n`);
  }
  // (a walk that only needs the person's yes leaves the box as the installer started it: VYRE_SEAL_DEV and VYRE_SEAL_SOFTWARE pass through a root run, and a second start would be a second server on the same setup code)
  if (o.devBuild && o.recreate !== false && exit === 0) {
    // A root run of compose passes on only the few settings it checks, so the developer switches in vyre.env (the path rule, the sealer's) never reached the container the installer started. This is a
    // throwaway development box: its stack is started again as the person who owns the folder, which reads vyre.env whole. The setup code is still in vyre.env and still within its hour.
    const again = sh(`cd ${dir} && docker compose -p vyre up -d --force-recreate vyre 2>&1`);
    fs.appendFileSync(logFile, `\nrecreated for the developer switches: ${again.status} ${String(again.stdout || again.stderr).slice(-200)}\n`);
    if (again.status !== 0) throw new Error(`could not start the development box with its switches: ${String(again.stdout || again.stderr).slice(-300)}`);
  }
  if (exit === 0) {
    // the forwarder: the container's 127.0.0.1:<port> to the stand-in directory on the runner (node is in the image; it stops with the container)
    const fwd = `const net=require("net");net.createServer(c=>{const u=net.connect(${Number(dirPort)},${JSON.stringify(dirHost)});c.on("error",()=>u.destroy());u.on("error",()=>c.destroy());c.pipe(u);u.pipe(c);}).listen(${Number(dirPort)},"127.0.0.1");`;
    const f = sh(`docker exec -d -u vyre vyre-vyre-1 node -e '${fwd}'`);
    fs.appendFileSync(logFile, `\ndirectory forwarder: ${f.status} ${String(f.stdout || f.stderr).trim()}\n`);
  }
  const m = all.match(/Your four words:\s*(?:\x1b\[[0-9;]*m)*([a-z]+(?: [a-z]+){3})/);
  const printed = m ? m[1] : "";
  const exec = (/** @type {string} */ tool, /** @type {any} */ input = {}) => {
    const r = spawnSync("docker", ["exec", "-u", "vyre", "vyre-vyre-1", "vyre", "call", tool, JSON.stringify(input)], { encoding: "utf8" });
    return r;
  };
  const ownerSigner = o.devBuild && o.ownerId ? (await import("../../../kernel/seal/testing.js")).signer(o.ownerId) : null;
  return {
    kind: "installer", store: o.store, logs: /** @type {string[]} */ ([]), ownerSigner,
    /** The owner's yes for a call the box answered presence_required to: a development key signs the exact act (only on a development build box that enrolled this key). @param {string} personId */
    yesFor: ownerSigner ? (/** @type {string} */ personId, /** @type {any} */ signer = ownerSigner) => async (/** @type {{ op: string, space: string, fields: Record<string, any> }} */ sign) => {
      const proof = signer.proof({ space: sign.space, hops: [{ actor: { kind: "person", id: personId, space: sign.space } }] }, sign.op, sign.fields);
      return Buffer.from(JSON.stringify(proof)).toString("base64url");
    } : undefined,
    /** The four words the installer printed on its terminal. */
    async words() {
      if (printed) return printed;
      if (!o.devBuild) throw new Error("the installer printed no check words (IR-1: show_words)");
      // a development box starts its modules after the installer's last look: the words are read from the box once its relay module answers
      for (let i = 0; i < 90; i++) { const r = exec("relay.setup.status"); const w = /"words":\s*"([a-z]+(?: [a-z]+){3})"/.exec(String(r.stdout || "")); if (w) return w[1]; await new Promise(res => setTimeout(res, 2000)); }
      throw new Error("the development box showed no check words in three minutes");
    },
    /** @param {string} tool @param {any} [input] */
    async operator(tool, input = {}) { const r = exec(tool, input); let j = null; try { j = JSON.parse(r.stdout); } catch { /* plain text */ } if (r.status !== 0) throw new Error(`${tool}: ${(r.stderr || r.stdout).slice(0, 200)}`); return j && j.data !== undefined ? j.data : j; },
    async stop() {
      const l = sh(`docker exec -u vyre vyre-vyre-1 sh -c 'echo "== config.json"; cat ~/.vyre/config.json; for f in ~/.vyre/logs/*; do echo "== $f"; tail -n 300 "$f"; done' 2>&1; docker logs --tail 100 vyre-vyre-1 2>&1`); try { fs.writeFileSync(path.join(o.dir, "vyred.log"), String(l.stdout || "")); } catch { /* a courtesy */ }
      sh(`cd ${dir} && docker compose -p vyre down -v --remove-orphans >/dev/null 2>&1`);
    },
  };
}
