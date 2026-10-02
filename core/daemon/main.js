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
// Started by the Windows app: it hands over the name of its pipe on stdin, once (core/daemon/app-handoff.js).
if (process.env.VYRE_SUPERVISOR === "app") await (await import("./app-handoff.js")).takeHandoff();
// On a Mac with vyre-core installed, the relay's keys (box, route and device) live in core, not in a
// file at this login. Decided here, never inside start(), so an in-process test can't reach the
// real core. createCoreKeys checks the socket is core's before every call.
let coreKeys = null;
if (process.platform === "darwin") {
  const { readCoreConfig } = await import("../../lib/vyre-core-client.js");
  if (readCoreConfig()) coreKeys = (await import("../../lib/vyre-core-keys.js")).createCoreKeys();
}
d = await start({ coreKeys }).catch(e => { console.error("vyred: " + e.message); process.exit(1); });
// Asked to stop while starting: now that it has started, stop it.
if (stopping) { await d.stop(); process.exit(0); }
