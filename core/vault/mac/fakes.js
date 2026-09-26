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
 * Write the fakes into `dir` and return commands for `vault.testHelpers`.
 * @param {string} dir
 */
export function writeFakes(dir, { typeMode = "ok" } = {}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const w = (n, s) => { const p = path.join(dir, n); fs.writeFileSync(p, s); return p; };
  const clip = w("fake-clip.cjs", FAKE_CLIP), watch = w("fake-watch.cjs", FAKE_WATCH), type = w("fake-type.cjs", FAKE_TYPE);
  const state = { clip: path.join(dir, "clip.json"), trigger: path.join(dir, "signal"), type: path.join(dir, "type.json") };
  return {
    state,
    helpers: {
      clip: [process.execPath, clip, state.clip],
      watch: [process.execPath, watch, state.trigger],
      type: [process.execPath, type, state.type, typeMode],
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
