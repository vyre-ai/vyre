// The child of test/stop-quiet.test.js: start the full registry in the given home, wait, stop, then run two more seconds
// with the store closed and print what any module did after the stop as JSON (module named by the path in the stack).
// A child process, so an uncaught error is ours to record and not the test runner's to fail on.
import path from "node:path";
import { start } from "../core/daemon/index.js";

const [root, afterMs] = [process.argv[2], Number(process.argv[3] || 0)];
const late = [];
let stopped = false;
const moduleOf = e => { const m = /\/(?:core|local|modules)\/([a-z0-9-]+)\//.exec(String((e && e.stack) || e)); return m ? m[1] : "unknown"; };
const note = e => { if (stopped) late.push({ module: moduleOf(e), message: String((e && e.message) || e).slice(0, 160) }); };
process.on("unhandledRejection", note);
process.on("uncaughtException", note);
const d = await start({ root, log: () => {}, firstPartyRoots: [path.join(root, "modules")] });
const running = d.registry.status().filter(m => m.state === "running").length;
if (afterMs) await new Promise(r => setTimeout(r, afterMs));
await d.stop();
stopped = true;
await new Promise(r => setTimeout(r, 2000));
console.log("RESULT " + JSON.stringify({ running, late }));
process.exit(0);
