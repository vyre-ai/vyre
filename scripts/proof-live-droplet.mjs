#!/usr/bin/env node
// scripts/proof-live-droplet.mjs: the live walk on a fresh droplet. Makes an 8 GB Ubuntu 24.04 droplet, runs `proof-install.mjs --live --host root@<ip>` against it, and destroys it at the end,
// whatever happened. The droplet is the only thing that costs money, and it lives for the length of one walk.
//
//   DIGITALOCEAN_TOKEN=... node scripts/proof-live-droplet.mjs [--expect-version X.Y.Z] [--channel beta] [--region nyc3] [--size s-4vcpu-8gb] [--out DIR] [--keep]
//
// Run it on a test box (the app side of the walk runs here). The token comes from the environment and is never printed or written. The droplet carries a throwaway ssh key made for this run
// (registered on the account for the run and removed again), and the tag vyre-live-walk so a stray one can be found: `doctl compute droplet list --tag-name vyre-live-walk`.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const take = (/** @type {string} */ f, /** @type {string} */ d = "") => { const i = argv.indexOf(f); return i < 0 ? d : argv[i + 1]; };
const token = process.env.DIGITALOCEAN_TOKEN || "";
if (!token) { console.error("proof-live-droplet: DIGITALOCEAN_TOKEN is not set"); process.exit(64); }
const out = path.resolve(take("--out", path.join(os.tmpdir(), `live-walk-${Date.now()}`)));
const region = take("--region", "nyc3"), size = take("--size", "s-4vcpu-8gb"), keep = argv.includes("--keep");
const HERE = path.dirname(fileURLToPath(import.meta.url));
fs.mkdirSync(out, { recursive: true });

const api = async (/** @type {string} */ method, /** @type {string} */ p, /** @type {any} */ body) => {
  const r = await fetch(`https://api.digitalocean.com/v2${p}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  if (!r.ok && !(method === "DELETE" && r.status === 404)) throw new Error(`${method} ${p}: ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
};
const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));

// the throwaway key: ssh-keygen is on every test box
const keyFile = path.join(out, "walk-key");
fs.rmSync(keyFile, { force: true }); fs.rmSync(`${keyFile}.pub`, { force: true });
if (spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", keyFile, "-C", "vyre-live-walk"]).status !== 0) { console.error("proof-live-droplet: ssh-keygen failed"); process.exit(1); }
const pub = fs.readFileSync(`${keyFile}.pub`, "utf8").trim();
const sshConfig = path.join(out, "ssh_config");
const name = `vyre-live-walk-${crypto.randomBytes(3).toString("hex")}`;

/** @type {number | null} */ let id = null;
/** @type {number | null} */ let keyId = null;
let code = 1;
const destroy = async () => {
  if (keyId !== null) { try { await api("DELETE", `/account/keys/${keyId}`); } catch (e) { console.error(`could not remove the account key ${keyId}: ${/** @type {Error} */ (e).message}`); } }
  if (id === null || keep) { if (keep && id !== null) console.log(`kept droplet ${id} (${name}); destroy it with: curl -X DELETE -H "Authorization: Bearer $DIGITALOCEAN_TOKEN" https://api.digitalocean.com/v2/droplets/${id}`); return; }
  try { await api("DELETE", `/droplets/${id}`); console.log(`destroyed droplet ${id}`); } catch (e) { console.error(`COULD NOT DESTROY droplet ${id} (${name}): ${/** @type {Error} */ (e).message}`); }
};
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { destroy().finally(() => process.exit(130)); });
try {
  const t0 = Date.now();
  // DigitalOcean puts an account key in root's authorized_keys at first boot (a cloud-init key is not honoured for root there); the key is removed from the account again at the end.
  keyId = (await api("POST", "/account/keys", { name, public_key: pub })).ssh_key.id;
  const made = await api("POST", "/droplets", { name, region, size, image: "ubuntu-24-04-x64", tags: ["vyre-live-walk"], ssh_keys: [keyId] });
  id = made.droplet.id;
  let ip = "";
  for (let i = 0; i < 60 && !ip; i++) {
    await sleep(5000);
    const d = (await api("GET", `/droplets/${id}`)).droplet;
    ip = (d.networks.v4 || []).find((/** @type {any} */ n) => n.type === "public")?.ip_address || "";
  }
  if (!ip) throw new Error("the droplet got no public address in five minutes");
  // a host alias so the walk's plain `ssh <host>` uses the throwaway key (the walk also logs in as a second user, `walker`, which it makes itself over this root login)
  fs.writeFileSync(sshConfig, `Host walkdroplet\n  HostName ${ip}\n  User root\n  IdentityFile ${keyFile}\n  IdentitiesOnly yes\n  StrictHostKeyChecking accept-new\n  UserKnownHostsFile ${path.join(out, "known_hosts")}\n`);
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { up = spawnSync("ssh", ["-F", sshConfig, "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "walkdroplet", "cloud-init status --wait >/dev/null 2>&1; echo up"], { encoding: "utf8" }).stdout.includes("up"); if (!up) await sleep(5000); }
  if (!up) throw new Error(`ssh to ${ip} never answered`);
  console.log(`PASS  make a fresh droplet (Ubuntu 24.04, ${size}): droplet ${id} at ${ip} in ${Math.round((Date.now() - t0) / 1000)} s`);
  // the walk reads ssh's config through ~/.ssh/config only, so pass it as an included file via the environment-free route: a per-run HOME-less -F is not available to it. Write the alias where ssh looks.
  const userCfg = path.join(os.homedir(), ".ssh", "config");
  fs.mkdirSync(path.dirname(userCfg), { recursive: true });
  const before = fs.existsSync(userCfg) ? fs.readFileSync(userCfg, "utf8") : "";
  const marker = "# vyre-live-walk (temporary)";
  const block = `${marker}\n${fs.readFileSync(sshConfig, "utf8")}# end vyre-live-walk\n`;
  fs.writeFileSync(userCfg, `${before.replace(/# vyre-live-walk \(temporary\)[\s\S]*?# end vyre-live-walk\n/g, "")}${block}`, { mode: 0o600 });
  try {
    const args = ["scripts/proof-install.mjs", "--live", "--host", "walkdroplet", "--out", out, ...(take("--expect-version") ? ["--expect-version", take("--expect-version")] : []), ...(take("--channel") ? ["--channel", take("--channel")] : [])];
    const child = spawn(process.execPath, args, { cwd: path.join(HERE, ".."), stdio: "inherit", env: { ...process.env, DIGITALOCEAN_TOKEN: "" } });
    code = await new Promise(res => child.on("close", c => res(c ?? 1)));
  } finally {
    const now = fs.readFileSync(userCfg, "utf8");
    fs.writeFileSync(userCfg, now.replace(/# vyre-live-walk \(temporary\)[\s\S]*?# end vyre-live-walk\n/g, ""), { mode: 0o600 });
  }
} catch (e) {
  console.error(`FAIL  ${/** @type {Error} */ (e).message}`);
} finally {
  await destroy();
}
process.exit(code);
