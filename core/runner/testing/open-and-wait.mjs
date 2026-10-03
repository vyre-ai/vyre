// Child process for the watchdog test: opens a workspace for a fake space, prints the folder, and waits to be killed.
import { createRunner } from "../runner.js";
import { fakeSpace } from "./fake-space.js";
const [base] = process.argv.slice(2);
const sp = fakeSpace({ key: Buffer.alloc(32, 7) });
const r = createRunner({ base, space: "harlow", device: "kit", vault: sp.vault, sync: sp.sync, grants: () => ({ spaceAllows: true, memberAccepts: true }) });
await r.open();
console.log("ready " + r.dir);
setInterval(() => {}, 1000);
