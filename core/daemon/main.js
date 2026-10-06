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
  // Still starting (d is null): do not exit here. The line after start() stops it once it has started, so a half-started daemon never leaves a socket or a pid file behind.
  if (!d) return;
  await d.stop();
  process.exit(0);
};
process.on("SIGTERM", quit);
process.on("SIGINT", quit);
// A supervisor or a test that started this with an IPC channel hears that stops are now handled, so it never has to guess how long node takes to boot (no channel, no message).
if (typeof process.send === "function") process.send({ vyred: "stop-handlers-installed" }, () => {});

const { start } = await import("./index.js");
// On a Mac with vyre-core installed, the relay's keys (box, route and device) live in core, not in a
// file at this login. Decided here, never inside start(), so an in-process test can't reach the
// real core. createCoreKeys checks the socket is core's before every call.
let coreKeys = null;
if (process.platform === "darwin") {
  const { readCoreConfig } = await import("../../lib/vyre-core-client.js");
  if (readCoreConfig()) coreKeys = (await import("../../lib/vyre-core-keys.js")).createCoreKeys();
}
d = await start({ coreKeys, deviceIdentity: async () => { const r = await d.registry.call("spaces.identity.device", {}, "module:vyred"); return r && r.data ? r.data : null; } }).catch(e => { console.error(e.code === "windows_home" ? e.message : "vyred: " + e.message); process.exit(e.code === "windows_home" ? 0 : 1); });
// Asked to stop while starting: now that it has started, stop it.
if (stopping) { await d.stop(); process.exit(0); }
