// Hosted-Mac diagnosis: why does the home seatbelt profile deny writes to the folders it allows back? Builds the profile the test rig builds, runs
// `sandbox-exec` with variants of it (one rule group removed each) and prints which variants can write into the project folder.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { homeSeatbelt } from "../core/runner/homesandbox.js";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "diag-"));
const home = base, proj = path.join(home, "proj"), temp = path.join(home, "tmp-session"), sock = path.join(home, ".vyre", "run", "sessions", "s1.sock");
for (const d of [proj, temp, path.dirname(sock)]) fs.mkdirSync(d, { recursive: true });
const o = { home, vyreHome: path.join(home, ".vyre"), sessionSocket: sock, workdirs: [proj], temp, daemonPorts: [49999] };
const full = homeSeatbelt(o);
console.log("realpath(base):", fs.realpathSync(base), " base:", base);
console.log("---- profile\n" + full + "----");
const lines = full.split("\n");
const lastAllow = lines.findLastIndex(l => l.startsWith("(allow file* (subpath"));
const variants = {
  A_full: lines,
  B_no_final_denies: lines.filter((l, i) => !(i > lastAllow && l.startsWith("(deny file*"))),
  C_no_home_denies: lines.filter((l, i) => !(i < lastAllow && l.startsWith("(deny file*"))),
  D_no_blanket_write_deny: lines.filter(l => l !== "(deny file-write*)" && !l.startsWith('(allow file-write* (literal "/dev/null")')),
  E_allow_write_only: lines.map(l => l.startsWith("(allow file* (subpath") ? l.replace("(allow file* ", "(allow file-write* ") : l),
  F_allow_write_and_read: lines.flatMap(l => l.startsWith("(allow file* (subpath") ? [l, l.replace("(allow file* ", "(allow file-write-create file-write-data file-write-unlink file-write-mode ")] : [l]),
};
for (const [name, ls] of Object.entries(variants)) {
  const f = path.join(base, name + ".sb"); fs.writeFileSync(f, ls.join("\n") + "\n");
  for (const [what, dir] of [["proj", proj], ["temp", temp]]) {
    const r = spawnSync("/usr/bin/sandbox-exec", ["-f", f, "/bin/sh", "-c", `echo x > "${dir}/f" && cat "${dir}/f" && rm "${dir}/f"`], { encoding: "utf8", timeout: 20000 });
    console.log(`${name.padEnd(26)} write ${what.padEnd(5)} -> ${r.status === 0 ? "OK" : "FAIL"} ${(r.stderr || "").trim().slice(0, 140)}`);
  }
}
fs.rmSync(base, { recursive: true, force: true });
