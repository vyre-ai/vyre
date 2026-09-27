// npm's postinstall for `npm i -g vyre`: one line with the mark, and a warning when another
// `vyre` on PATH would answer instead of this one (an old prototype did, on a user's first run).
// npm hides a script's output, so it writes to the terminal itself; with no terminal it says
// nothing. It never fails the install.
import fs from "node:fs";
import path from "node:path";

try {
  // Only a global install puts a command on PATH; `npm ci` in a checkout says nothing.
  if (process.env.npm_config_global !== "true" && process.env.npm_config_location !== "global") process.exit(0);
  const { mark } = await import("../core/cli/brand.js");
  const { shadows } = await import("../core/cli/shadow.js");
  let tty;
  try { tty = fs.openSync("/dev/tty", "w"); } catch { process.exit(0); }
  const stream = { isTTY: true };
  const say = s => fs.writeSync(tty, s + "\n");
  const prefix = process.env.npm_config_prefix || "";
  const binDir = prefix ? (process.platform === "win32" ? prefix : path.join(prefix, "bin")) : undefined;
  say("");
  say(`  ${mark(stream)}  Vyre installed. Run: vyre up`);
  const s = shadows({ binDir });
  const first = s.others.find(o => o.first);
  if (first) {
    say(`  Another vyre comes first on your PATH: ${first.path}${first.target !== first.path ? " -> " + first.target : ""}`);
    say(`  Remove it (rm ${first.path}), then run: hash -r`);
  } else if (binDir && !s.ours) {
    say(`  npm's folder ${binDir} is not on your PATH, so "vyre" will not be found. Add it to PATH.`);
  }
  say("");
  fs.closeSync(tty);
} catch { /* never fail an install over a message */ }
process.exit(0);
