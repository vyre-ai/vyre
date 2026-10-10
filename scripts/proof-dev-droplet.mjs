#!/usr/bin/env node
// scripts/proof-dev-droplet.mjs: journeys on a fresh DEVELOPMENT-build droplet, labelled as such. A release server takes the owner's yes only from a hardware key, so signing, Publish and the other
// yes-moments cannot be walked headlessly on the shipped build; on a droplet whose server is installed by `install-box.sh --from` with VYRE_DEV_SIGN=unsigned (no release signature, developer switches
// on) a stand-in signer gives the yes. This proves the product's flows, NOT the shipped build's signature or hardware-key path. The droplet lives for the length of one run and is destroyed at the end.
//
//   DIGITALOCEAN_TOKEN=... node scripts/proof-dev-droplet.mjs --tree DIR --out DIR [--journeys J2,J4] [--size s-4vcpu-8gb] [--region nyc3] [--keep]
//
// The tree (a checkout of the build under test) is copied to the droplet, its dependencies are installed there, the pinned test Chrome is fetched, and each journey runs as `walker` with VYRE_JOURNEY_BOX=1.
// Everything the journeys write comes back to --out. Secrets: the token is read from the environment and never printed or written.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const take = (/** @type {string} */ f, /** @type {string} */ d = "") => { const i = argv.indexOf(f); return i < 0 ? d : argv[i + 1]; };
const token = process.env.DIGITALOCEAN_TOKEN || "";
if (!token) { console.error("proof-dev-droplet: DIGITALOCEAN_TOKEN is not set"); process.exit(64); }
const tree = path.resolve(take("--tree", ""));
if (!take("--tree") || !fs.existsSync(path.join(tree, "package.json"))) { console.error("proof-dev-droplet: --tree DIR must be a checkout of the build under test"); process.exit(64); }
const out = path.resolve(take("--out", path.join(os.tmpdir(), `dev-droplet-${Date.now()}`)));
const journeys = take("--journeys", "J2,J4").split(",").filter(Boolean);
const region = take("--region", "nyc3"), size = take("--size", "s-4vcpu-8gb"), keep = argv.includes("--keep");
fs.mkdirSync(out, { recursive: true });
const api = async (/** @type {string} */ method, /** @type {string} */ p, /** @type {any} */ body) => {
  const r = await fetch(`https://api.digitalocean.com/v2${p}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  if (!r.ok && !(method === "DELETE" && r.status === 404)) throw new Error(`${method} ${p}: ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
};
const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));
const keyFile = path.join(out, "walk-key");
fs.rmSync(keyFile, { force: true }); fs.rmSync(`${keyFile}.pub`, { force: true });
if (spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", keyFile, "-C", "vyre-dev-walk"]).status !== 0) { console.error("ssh-keygen failed"); process.exit(1); }
const pub = fs.readFileSync(`${keyFile}.pub`, "utf8").trim();
const cfg = path.join(out, "ssh_config");
const name = `vyre-dev-walk-${crypto.randomBytes(3).toString("hex")}`;
/** @type {number | null} */ let id = null; /** @type {number | null} */ let keyId = null;
let code = 1;
const destroy = async () => {
  if (keyId !== null) { try { await api("DELETE", `/account/keys/${keyId}`); } catch (e) { console.error(`could not remove the account key ${keyId}: ${/** @type {Error} */ (e).message}`); } }
  if (id === null || keep) { if (keep && id !== null) console.log(`kept droplet ${id} (${name})`); return; }
  try { await api("DELETE", `/droplets/${id}`); console.log(`destroyed droplet ${id}`); } catch (e) { console.error(`COULD NOT DESTROY droplet ${id} (${name}): ${/** @type {Error} */ (e).message}`); }
};
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { destroy().finally(() => process.exit(130)); });
const sshBase = ["-F", cfg, "-o", "BatchMode=yes"];
const remote = (/** @type {string} */ cmd, /** @type {string} */ user = "root", timeout = 3600) => spawnSync("ssh", [...sshBase, "-l", user, "-o", "ServerAliveInterval=30", "walkdroplet", cmd], { encoding: "utf8", timeout: timeout * 1000, maxBuffer: 64 * 1024 * 1024 });
const step = (/** @type {string} */ label, /** @type {{ status: number | null, stdout: string, stderr: string }} */ r) => {
  const ok = r.status === 0;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `: ${(r.stdout + r.stderr).trim().split("\n").slice(-4).join(" | ").slice(0, 400)}`}`);
  if (!ok) throw new Error(`${label} failed`);
};
try {
  const t0 = Date.now();
  keyId = (await api("POST", "/account/keys", { name, public_key: pub })).ssh_key.id;
  id = (await api("POST", "/droplets", { name, region, size, image: "ubuntu-24-04-x64", tags: ["vyre-dev-walk"], ssh_keys: [keyId] })).droplet.id;
  let ip = "";
  for (let i = 0; i < 60 && !ip; i++) { await sleep(5000); ip = ((await api("GET", `/droplets/${id}`)).droplet.networks.v4 || []).find((/** @type {any} */ n) => n.type === "public")?.ip_address || ""; }
  if (!ip) throw new Error("the droplet got no public address in five minutes");
  fs.writeFileSync(cfg, `Host walkdroplet\n  HostName ${ip}\n  IdentityFile ${keyFile}\n  IdentitiesOnly yes\n  StrictHostKeyChecking accept-new\n  UserKnownHostsFile ${path.join(out, "known_hosts")}\n`);
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { up = remote("cloud-init status --wait >/dev/null 2>&1; echo up", "root", 120).stdout.includes("up"); if (!up) await sleep(5000); }
  if (!up) throw new Error(`ssh to ${ip} never answered`);
  console.log(`PASS  make a fresh droplet (Ubuntu 24.04, ${size}): droplet ${id} at ${ip} in ${Math.round((Date.now() - t0) / 1000)} s. THIS IS A DEVELOPMENT-BUILD WALK (no release signature, a stand-in signer gives the yes).`);
  step("install Docker, Node 24 and the tools the journeys need", remote("export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq curl git unzip rsync ca-certificates >/dev/null && curl -fsSL https://get.docker.com | sh >/dev/null 2>&1 && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null 2>&1 && apt-get install -y -qq nodejs >/dev/null && (id walker >/dev/null 2>&1 || adduser --disabled-password --gecos '' walker >/dev/null) && echo 'walker ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/walker && chmod 440 /etc/sudoers.d/walker && usermod -aG docker walker && mkdir -p /home/walker/.ssh /home/walker/vyre && cp /root/.ssh/authorized_keys /home/walker/.ssh/ && chown -R walker:walker /home/walker && node -v", "root", 1500));
  step("copy the build under test to the droplet", spawnSync("rsync", ["-az", "-e", `ssh ${sshBase.join(" ")} -l walker`, "--exclude", "node_modules", "--exclude", ".git", `${tree}/`, "walkdroplet:/home/walker/vyre/"], { encoding: "utf8", timeout: 900_000 }));
  step("install its dependencies and the pinned test Chrome", remote("cd vyre && npm ci --no-audit --no-fund >/dev/null 2>&1 && (cd apps/app && npm ci --ignore-scripts --no-audit --no-fund >/dev/null 2>&1) && node scripts/install-test-chrome.mjs", "walker", 1800));
  const chrome = remote("cd vyre && node scripts/install-test-chrome.mjs", "walker", 120).stdout.trim().split("\n").pop() || "";
  let failed = 0;
  for (const j of journeys) {
    const r = remote(`cd vyre && sudo rm -rf /srv/vyre; sg docker -c 'CI=1 VYRE_JOURNEY_BOX=1 CHROME_BIN="${chrome}" node scripts/journeys/run.mjs ${j} --out /home/walker/out-${j}' 2>&1`, "walker", 5400);
    fs.writeFileSync(path.join(out, `${j}.log`), r.stdout + r.stderr);
    for (const l of (r.stdout + r.stderr).split("\n")) if (/^(PASS|FAIL|SKIP)  /.test(l)) console.log(l.slice(0, 330));
    if (/^FAIL  /m.test(r.stdout) || r.status !== 0) failed++;
    spawnSync("rsync", ["-az", "-e", `ssh ${sshBase.join(" ")} -l walker`, `walkdroplet:/home/walker/out-${j}/`, path.join(out, `out-${j}/`)], { encoding: "utf8", timeout: 300_000 });
  }
  code = failed ? 1 : 0;
} catch (e) {
  console.error(`FAIL  ${/** @type {Error} */ (e).message}`);
} finally {
  await destroy();
}
process.exit(code);
