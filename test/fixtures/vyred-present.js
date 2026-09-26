// @ts-check
// vyred for tests of what happens after a person approves: the same daemon, with a presence
// verifier that finds a person at every call. It refuses any home outside the temp folder, so it
// can never stand in for the user's own vyred. vyred itself never builds this verifier.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { start } from "../../core/daemon/index.js";
import { home } from "../../core/config/index.js";
import { present } from "../helpers.js";

const root = home();
// Both sides resolved: on macOS $TMPDIR is /var/folders/..., and a realpath'd home is /private/var/folders/....
const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
if (!(real(root) + path.sep).startsWith(real(os.tmpdir()) + path.sep) || real(root) === real(path.join(os.homedir(), ".vyre"))) {
  console.error("vyred-present: only for a temp VYRE_HOME");
  process.exit(1);
}
process.env.VYRE_NO_DIALOGS = "1";
const d = await start({ root, presence: present }).catch(e => { console.error("vyred: " + e.message); process.exit(1); });
const quit = async () => { await d.stop(); process.exit(0); };
process.on("SIGTERM", quit);
process.on("SIGINT", quit);
