// @ts-check
// A test release for the Mac server walk: this checkout packed like vyre.tgz, the pinned release key swapped for a throwaway one in the files that carry it (the way scripts/dev-sign.mjs does for a
// box), the signed first-party module list (modules.json) made from the tree as it then is, and the whole site (vyre.tgz, manifest.json, modules.json, SHA256SUMS, SHA256SUMS.sig) signed with the
// throwaway key. scripts/mac-proof/release.mjs makes the same without modules.json, which leaves every module "from outside Vyre" and the relay unable to start. The key is never written.
//
//   node scripts/lib/proof/mac-release.mjs OUTDIR     writes OUTDIR/site/* and OUTDIR/release-key.pub
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { signRelease } from "../../sign-manifest.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
if (!process.argv[2]) { console.error("usage: mac-release.mjs OUTDIR"); process.exit(2); }
const out = path.resolve(process.argv[2]);
const site = path.join(out, "site"), pack = path.join(out, "pack"), tree = path.join(out, "tree");
for (const d of [site, pack, tree]) fs.mkdirSync(d, { recursive: true });
const name = execFileSync("npm", ["pack", "--silent", "--pack-destination", pack], { encoding: "utf8", cwd: repo }).trim().split("\n").pop() || "";
execFileSync("tar", ["-xzf", path.join(pack, name), "-C", tree]);
const top = path.join(tree, "package");

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const spki = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const sigFile = path.join(top, "lib", "release-sig.js");
const OLD = /^export const RELEASE_KEY = "(.*)";/m.exec(fs.readFileSync(sigFile, "utf8"))?.[1];
if (!OLD) throw new Error("the pinned key was not found in lib/release-sig.js");
for (const f of ["core/vyre-core/release.js", "box/vyre", "lib/release-sig.js", "scripts/install-mac-server.sh"]) {
  const p = path.join(top, f);
  if (!fs.existsSync(p)) continue;
  const t = fs.readFileSync(p, "utf8");
  if (t.includes(OLD)) fs.writeFileSync(p, t.split(OLD).join(spki));
}
const version = JSON.parse(fs.readFileSync(path.join(top, "package.json"), "utf8")).version;
execFileSync(process.execPath, [path.join(repo, "scripts/modules-manifest.mjs"), top, "--counter", "1", "--release", version, "--out", path.join(site, "modules.json")]);
execFileSync("tar", ["-czf", path.join(site, "vyre.tgz"), "-C", tree, "package"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
signRelease({ dir: site, version, channel: "test", pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), key: spki });
fs.writeFileSync(path.join(out, "release-key.pub"), spki);
fs.rmSync(tree, { recursive: true, force: true }); fs.rmSync(pack, { recursive: true, force: true });
console.log(`test release ${version} with a signed module list in ${site}`);
