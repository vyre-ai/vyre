// @ts-check
// fakes: stand-ins for the Swift helpers and for pbcopy/pbpaste, for tests only. They speak the
// same JSON lines as the real helpers, never touch the real pasteboard or type into an app, and
// record only SHA-256 hashes of what they were handed, so a test can check the value arrived
// without a value landing in a file.

import fs from "node:fs";
import path from "node:path";

export const FAKE_CLIP = `
const fs = require("node:fs"), crypto = require("node:crypto"), rl = require("node:readline");
const file = process.argv[2];
const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const st = { count: 0, hash: null, mine: null, copies: 0, eofCleared: false };
const save = () => fs.writeFileSync(file, JSON.stringify(st));
const out = o => process.stdout.write(JSON.stringify(o) + "\\n");
save();
const r = rl.createInterface({ input: process.stdin });
r.on("line", line => {
  let m; try { m = JSON.parse(line); } catch { return out({ ok: false, error: "bad request" }); }
  if (m.op === "copy") { st.count++; st.hash = sha(m.text); st.mine = st.count; st.copies++; save(); return out({ ok: true, count: st.count }); }
  if (m.op === "clear") { if (m.ifCount === st.count) { st.count++; st.hash = null; st.mine = null; save(); return out({ ok: true, cleared: true }); } return out({ ok: true, cleared: false }); }
  if (m.op === "bump") { st.count++; st.hash = "someone-else"; save(); return out({ ok: true, count: st.count }); }
  out({ ok: false, error: "unknown op" });
});
r.on("close", () => { if (st.mine !== null && st.mine === st.count) { st.count++; st.hash = null; st.mine = null; st.eofCleared = true; } save(); process.exit(0); });
`;

export const FAKE_WATCH = `
const fs = require("node:fs");
const trigger = process.argv[2];
process.stdout.write(JSON.stringify({ ready: true }) + "\\n");
setInterval(() => {
  let s; try { s = fs.readFileSync(trigger, "utf8").trim(); fs.rmSync(trigger); } catch { return; }
  if (s) process.stdout.write(JSON.stringify({ signal: s }) + "\\n");
}, 20);
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
`;

export const FAKE_TYPE = `
const fs = require("node:fs"), crypto = require("node:crypto");
const [file, mode = "ok"] = process.argv.slice(2);
const sha = s => crypto.createHash("sha256").update(String(s)).digest("hex");
let buf = "";
process.stdin.on("data", d => { buf += d; });
process.stdin.on("end", () => {
  const m = JSON.parse(buf.split("\\n")[0]);
  fs.writeFileSync(file, JSON.stringify({ bundle: m.bundle, pid: m.pid, browser: m.browser, hosts: m.hosts, username: sha(m.username), password: sha(m.password) }));
  if (mode === "ok") process.stdout.write(JSON.stringify({ ok: true, filled: ["username", "password"], via: "ax" }) + "\\n");
  else process.stdout.write(JSON.stringify({ ok: false, code: mode, message: "fixed words for " + mode }) + "\\n");
});
`;

/**
 * The Secure Enclave helper's stand-in. The "enclave key" is an ordinary P-256 key in the blob,
 * which is exactly what the real one is not; it exists so the Node side can be tested without a
 * fingerprint. Mode "refuse" answers derive as a cancelled Touch ID; each reason is appended to
 * the state file so a test can check what the person would have read.
 */
export const FAKE_ENCLAVE = `
const fs = require("node:fs"), crypto = require("node:crypto");
const [file, mode = "ok"] = process.argv.slice(2);
let buf = "";
const out = o => { process.stdout.write(JSON.stringify(o) + "\\n"); process.exit(0); };
process.stdin.on("data", d => { buf += d; });
process.stdin.on("end", () => {
  const m = JSON.parse(buf.split("\\n")[0]);
  if (m.op === "available") return out({ ok: true, available: true });
  if (m.op === "auth") { fs.appendFileSync(file, JSON.stringify({ auth: m.reason }) + "\\n"); return out(mode === "refuse" ? { ok: false, code: "refused", message: "the person did not confirm" } : { ok: true }); }
  if (m.op === "create") { const e = crypto.createECDH("prime256v1"); const pub = e.generateKeys(); return out({ ok: true, blob: e.getPrivateKey().toString("base64"), pub: pub.toString("base64") }); }
  if (m.op === "derive") {
    fs.appendFileSync(file, JSON.stringify({ reason: m.reason }) + "\\n");
    if (mode === "refuse") return out({ ok: false, code: "refused", message: "Touch ID was not confirmed" });
    const e = crypto.createECDH("prime256v1"); e.setPrivateKey(Buffer.from(m.blob, "base64"));
    return out({ ok: true, shared: e.computeSecret(Buffer.from(m.peerPub, "base64")).toString("base64") });
  }
  out({ ok: false, code: "bad_request", message: "unknown op" });
});
`;

/**
 * Write the fakes into `dir` and return commands for `vault.testHelpers`.
 * @param {string} dir
 */
export function writeFakes(dir, { typeMode = "ok", enclaveMode = "ok" } = {}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const w = (n, s) => { const p = path.join(dir, n); fs.writeFileSync(p, s); return p; };
  const clip = w("fake-clip.cjs", FAKE_CLIP), watch = w("fake-watch.cjs", FAKE_WATCH), type = w("fake-type.cjs", FAKE_TYPE);
  const enclave = w("fake-enclave.cjs", FAKE_ENCLAVE);
  const state = { clip: path.join(dir, "clip.json"), trigger: path.join(dir, "signal"), type: path.join(dir, "type.json"), enclave: path.join(dir, "enclave.log") };
  return {
    state,
    helpers: {
      clip: [process.execPath, clip, state.clip],
      watch: [process.execPath, watch, state.trigger],
      type: [process.execPath, type, state.type, typeMode],
      enclave: [process.execPath, enclave, state.enclave, enclaveMode],
    },
  };
}

/** Fake pbcopy and pbpaste that keep the "clipboard" in one file outside any Vyre home. */
export function writeFakePb(dir, clipFile) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "pbcopy"), `#!/bin/sh\ncat > "${clipFile}"\n`, { mode: 0o700 });
  fs.writeFileSync(path.join(dir, "pbpaste"), `#!/bin/sh\ncat "${clipFile}" 2>/dev/null\n`, { mode: 0o700 });
  return { PATH: `${dir}:/usr/bin:/bin` };
}
