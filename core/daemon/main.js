// @ts-check
// Run vyred in the foreground. `vyre up` starts this detached; launchd and systemd run it
// directly. It stops cleanly on SIGTERM and SIGINT, removing its socket and pid file.

import { start } from "./index.js";

const d = await start().catch(e => { console.error("vyred: " + e.message); process.exit(1); });
const quit = async () => { await d.stop(); process.exit(0); };
process.on("SIGTERM", quit);
process.on("SIGINT", quit);
