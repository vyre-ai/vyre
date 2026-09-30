// @ts-check
// Run vyred in the foreground. `vyre up` starts this detached; launchd and systemd run it
// directly. It stops cleanly on SIGTERM and SIGINT, removing its socket and pid file.
//
// The handlers go on first, before vyred's code is even loaded: a stop that arrives while vyred
// is still starting (a container stopped right after a restart) waits for start to settle and
// then drains like any other stop, instead of the signal killing it half started (ADR 0029, R7).

import { installCrashHandler } from "./crash.js";

// An uncaught error or rejection: log the stack, exit non-zero, and let the supervisor restart us.
installCrashHandler();

/** @type {{ stop(): Promise<void> } | null} */
let d = null;
let stopping = false;
const quit = async () => {
  if (stopping) return;
  stopping = true;
  if (d) await d.stop();
  process.exit(0);
};
process.on("SIGTERM", quit);
process.on("SIGINT", quit);

const { start } = await import("./index.js");
d = await start().catch(e => { console.error("vyred: " + e.message); process.exit(1); });
// Asked to stop while starting: now that it has started, stop it.
if (stopping) { await d.stop(); process.exit(0); }
