// rc-smoke only, run inside the throwaway box as uid vyre: one person-only call, proved the way
// a paired phone proves it. vault.connect is person-only, and the smoke has no person at a
// terminal (docker exec has none, so the CLI says no_terminal) and no Touch ID. So this enrolls a
// fresh P-256 device key straight into the smoke's OWN box db (a temp volume nothing else uses),
// signs that one call with it (ADR 0018's device proof), sends it to vyred's socket, and removes
// the key again. vyred's checks are the real ones, unchanged: nothing here is a seam in vyred.
//
// A `docker exec` process has parent 0, so vyred's leader check (core/daemon's above()) names
// this node process itself as an unknown server and answers presence_required with its
// { exe, pid, started }. A person proves that server once (session.trust, signed over exactly
// that object, the same key); then the call goes again with its own proof.
//
//   node /opt/rc/person.mjs <tool> '<json input>'   prints vyred's JSON answer
//
// The box's own uid can write its db, which is why this works and why it is only ever the
// smoke's temp home, mounted at /opt/rc for the smoke alone and never shipped in the image.

import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";

const VYRE = "/opt/vyre";
const home = process.env.VYRE_HOME || "/home/vyre/.vyre";
const { open } = await import(path.join(VYRE, "core/store/index.js"));
const { Presence, inputHash } = await import(path.join(VYRE, "core/presence/index.js"));

const [, , tool, raw = "{}"] = process.argv;
const input = JSON.parse(raw);

const db = open(path.join(home, "vyre.db"));
const presence = new Presence({ db, role: "box", touchid: null, writeTty: () => {}, who: async () => [], env: {} });
const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const { id } = presence.enroll({ kind: "device", name: "rc-smoke person", public_key: publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7 });

const sign = (t, over) => {
  const ts = String(Date.now()), nonce = crypto.randomBytes(12).toString("base64url");
  const sig = crypto.sign("sha256", Buffer.from(`vyre-presence-v1\n${t}\n${inputHash(over)}\n${ts}\n${nonce}`), { key: privateKey, dsaEncoding: "der" }).toString("base64url");
  return `device key=${id} ts=${ts} nonce=${nonce} sig=${sig}`;
};
const post = (t, over, proof) => {
  const body = JSON.stringify(over);
  return new Promise(resolve => {
    const req = http.request({ socketPath: path.join(home, "vyred.sock"), method: "POST", path: `/v1/tools/${t}`,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), "x-vyre-caller": "cli", "x-vyre-presence": proof } }, r => {
      let b = "";
      r.setEncoding("utf8");
      r.on("data", d => (b += d)).on("end", () => resolve(b));
    });
    req.on("error", e => resolve(JSON.stringify({ error: { code: "unreachable", message: e.message } })));
    req.end(body);
  });
};
const serverOf = raw => { try { const e = JSON.parse(raw).error; return e && e.code === "presence_required" && e.server ? e.server : null; } catch { return null; } };

let out;
try {
  out = await post(tool, input, sign(tool, input));
  const server = serverOf(out);
  if (server) {
    // Trust this server once, on the same call: a tool that needs no proof of its own goes
    // through here; one that does (vault.connect) is refused for the mismatched proof, so it goes
    // once more with its own.
    out = await post(tool, input, sign("session.trust", server));
    if (/"presence_required"/.test(out)) out = await post(tool, input, sign(tool, input));
  }
} finally {
  // Always: a thrown request must not leave the smoke's key enrolled.
  presence.remove(id);
  db.close();
}
process.stdout.write(out + "\n");
