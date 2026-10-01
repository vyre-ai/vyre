// @ts-check
// vyred for tests of what happens after a person approves: the same daemon, with a presence
// verifier that finds a person at every call. It refuses any home outside the temp folder, so it
// can never stand in for the user's own vyred. vyred itself never builds this verifier.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { start } from "../../core/daemon/index.js";
import { setSocketTrust } from "../../core/daemon/peer.js";
import { home } from "../../core/config/index.js";
import { present } from "../helpers.js";

const root = home();
// Both sides resolved: on macOS $TMPDIR is /var/folders/..., and a realpath'd home is /private/var/folders/....
const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
if (!(real(root) + path.sep).startsWith(real(os.tmpdir()) + path.sep) || real(root) === real(path.join(os.homedir(), ".vyre"))) {
  console.error("vyred-present: only for a temp VYRE_HOME");
  process.exit(1);
}
// A test vyred (temp home only, checked above) has no terminal in front of its CLI children: the label is trusted as it was before the socket inversion.
setSocketTrust("label");
process.env.VYRE_NO_DIALOGS = "1";
// A test's fixture modules in this temp home stand in for Vyre's own (a probe using the built in
// only vault.fetch, ADR 0047), so they load as first party. This launcher decides that itself;
// nothing reaches it from config, the environment or the command line, and vyred never does it.
const d = await start({ root, presence: present, firstPartyRoots: [path.join(root, "modules")] }).catch(e => { console.error("vyred: " + e.message); process.exit(1); });
const quit = async () => { await d.stop(); process.exit(0); };
process.on("SIGTERM", quit);
process.on("SIGINT", quit);
