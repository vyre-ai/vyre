// @ts-check
// spaces: the files a space's home is made of, on this machine. `keys` holds a space's ROOT key (`<home>/spaces/<id>/root.key`, mode
// 0600, never logged, never in an event or a reply). `homeHost.apply` writes the unit's files (`<home>/spaces/<id>/unit/`) with the
// modes lib/spaces/home-unit.js names and returns; it never runs Docker. A later step on the home starts the containers.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SPACE_ID_RE } from "../../lib/spaces/home-unit.js";
import { newKeyPair, privateKeyOf, writePrivate } from "./identity.js";

/** @param {string} dir the `<home>/spaces` folder */
export function spaceFiles(dir) {
  const spaceDir = (/** @type {string} */ id) => {
    if (!SPACE_ID_RE.test(String(id))) throw new Error("that is not a space id");
    return path.join(dir, id);
  };
  const keyFile = (/** @type {string} */ id) => path.join(spaceDir(id), "root.key");

  const keys = {
    generate: async () => newKeyPair(),
    /** Overwrites. The private half goes only here. */
    hold: async (/** @type {string} */ id, /** @type {string} */ privateKey) => { writePrivate(keyFile(id), privateKey + "\n"); },
    discard: async (/** @type {string} */ id) => { fs.rmSync(keyFile(id), { force: true }); },
    has: (/** @type {string} */ id) => fs.existsSync(keyFile(id)),
    /** The space's signer pieces, or null when this machine does not hold the key. */
    load(/** @type {string} */ id) {
      let text;
      try { text = fs.readFileSync(keyFile(id), "utf8").trim(); } catch { return null; }
      const priv = privateKeyOf(text);
      const publicKey = crypto.createPublicKey(priv).export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
      return { publicKey, sign: async (/** @type {Buffer} */ m) => crypto.sign(null, m, priv) };
    },
  };

  const homeHost = {
    /** Replace the unit's files as a whole. @param {{ spaceId: string, home: any, unit: { files: { path: string, mode: number, content: string }[], manifest: any } }} a */
    async apply(a) {
      const unit = path.join(spaceDir(a.spaceId), "unit");
      fs.rmSync(unit, { recursive: true, force: true });
      fs.mkdirSync(unit, { recursive: true, mode: 0o700 });
      for (const f of a.unit.files) {
        if (path.basename(f.path) !== f.path) throw new Error("a unit file stays inside its folder");
        const target = path.join(unit, f.path);
        fs.writeFileSync(target, f.content, { mode: f.mode });
        try { fs.chmodSync(target, f.mode); } catch { /* win32 */ }
      }
      fs.writeFileSync(path.join(unit, "manifest.json"), JSON.stringify(a.unit.manifest, null, 2) + "\n", { mode: 0o644 });
      return { ok: true };
    },
    /** A server joined as compute or as the new home: nothing to run here; the server's own side does the rest. */
    async join() { return { ok: true }; },
  };

  return { keys, homeHost, dir: spaceDir };
}
