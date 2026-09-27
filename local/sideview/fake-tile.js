#!/usr/bin/env node
// @ts-check
// A fake vyre-tile for tests: one request line in, one answer out, from a scenario in FAKE_TILE.
// Windows live in a JSON file (scenario.state/windows.json) so a set changes what the next
// frames sees, as on a real Mac. Scenario keys: front, screens, windows (the first state),
// notTrusted, minWidth ({ "<pid>": width } a window refuses to go below), log (a file each
// request is appended to).

import fs from "node:fs";
import path from "node:path";

const s = JSON.parse(process.env.FAKE_TILE || "{}");
const file = path.join(s.state, "windows.json");
const load = () => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : (s.windows || []);
const out = (/** @type {any} */ o) => { process.stdout.write(JSON.stringify(o) + "\n"); process.exit(0); };

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", d => { buf += d; });
process.stdin.on("end", () => {
  const req = JSON.parse(buf.split("\n")[0]);
  if (s.log) fs.appendFileSync(s.log, JSON.stringify(req) + "\n");
  if (req.cmd === "trust") return out({ trusted: !s.notTrusted, prompted: false });
  if (s.notTrusted) return out({ error: "not allowed", code: "not_trusted" });
  if (req.cmd === "frames") {
    const ws = load().filter((/** @type {any} */ w) => (req.bundles || []).includes(w.bundle) || (req.pids || []).includes(w.pid));
    return out({ front: s.front || {}, screens: s.screens || [], windows: ws });
  }
  if (req.cmd === "set") {
    const ws = load();
    const results = (req.moves || []).map((/** @type {any} */ m) => {
      const w = ws.find((/** @type {any} */ x) => x.pid === m.pid && x.index === m.index);
      if (!w) return { pid: m.pid, index: m.index, ok: false, code: "gone" };
      const min = (s.minWidth || {})[String(m.pid)] || 0;
      w.frame = { ...m.frame, w: Math.max(m.frame.w, min) };
      return { pid: m.pid, index: m.index, ok: true, frame: w.frame, exact: w.frame.w === m.frame.w };
    });
    fs.writeFileSync(file, JSON.stringify(ws));
    return out({ results, activated: req.activate || [] });
  }
  out({ error: "unknown command", code: "bad_request" });
});
