// @ts-check
// deploy/digitalocean: the 1-Click image installs nothing of Vyre itself, only the signed installer at first boot (so it is never stale).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "deploy", "digitalocean");
const read = (/** @type {string} */ f) => fs.readFileSync(path.join(DIR, f), "utf8");

test("digitalocean image: first boot runs the signed installer from vyre.run, once", () => {
  const s = read("vyre-firstboot.sh");
  assert.match(s, /curl -fsSL https:\/\/vyre\.run\/i \| sh -s -- --yes/);
  assert.match(s, /vyre-firstboot\.done/);
  for (const f of ["vyre-firstboot.sh", "99-vyre-motd"]) assert.equal(spawnSync("sh", ["-n", path.join(DIR, f)]).status, 0, `${f} parses`);
});

test("digitalocean image: the Packer template ends with DigitalOcean's cleanup and image check, tags the build droplet, and holds no secret", () => {
  const t = JSON.parse(read("vyre-marketplace.json"));
  const last = t.provisioners.slice(-2).map((/** @type {any} */ p) => p.script);
  assert.deepEqual(last, ["marketplace-partners/scripts/cleanup.sh", "marketplace-partners/scripts/img_check.sh"]);
  assert.deepEqual(t.builders[0].tags, ["vyre-test"]);
  assert.match(t.variables.token, /env `DIGITALOCEAN_API_TOKEN`/);
  assert.deepEqual(t["sensitive-variables"], ["token"]);
  assert.match(read("vyre-firstboot.service"), /ConditionPathExists=!\/var\/lib\/vyre-firstboot\.done/);
});
