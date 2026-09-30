// @ts-check
// vyred for CLI tests that run over ssh on the testbox: the real verifier, plus trust for the
// terminal server the test runs under (the root sshd, which vyred cannot read and so asks for one
// presence proof per server). Every other refusal is the real verifier's. It refuses any home
// outside the temp folder, so it can never stand in for the user's own vyred. vyred itself never
// builds this verifier.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { start } from "../../core/daemon/index.js";
import { home, load } from "../../core/config/index.js";
import { Presence } from "../../core/presence/index.js";

const root = home();
const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
if (!(real(root) + path.sep).startsWith(real(os.tmpdir()) + path.sep) || real(root) === real(path.join(os.homedir(), ".vyre"))) {
  console.error("vyred-leader: only for a temp VYRE_HOME");
  process.exit(1);
}
process.env.VYRE_NO_DIALOGS = "1";
const cfg = load(root);
const presence = deps => Object.assign(new Presence({ ...deps, role: cfg.role, network: () => cfg.network || {} }), { trustsServer: () => true });
const d = await start({ root, presence }).catch(e => { console.error("vyred: " + e.message); process.exit(1); });
const quit = async () => { await d.stop(); process.exit(0); };
process.on("SIGTERM", quit);
process.on("SIGINT", quit);
