// @ts-check
// Where the real sandbox and the encrypted workspace MUST work (the hosted Linux job that installs bubblewrap and gocryptfs sets VYRE_REQUIRE_SANDBOX=1), a test file that imports this fails loudly
// when they do not, instead of skipping: a skip on the machine where every merge is checked would mean the real sandbox path is never tested. Elsewhere it prints the reason and lets the test skip.
import { unavailable } from "../sandbox.js";
import { workspaceUnavailable } from "../workspace.js";

const why = unavailable() || workspaceUnavailable(undefined, {}) || "";
if (why && process.env.VYRE_REQUIRE_SANDBOX === "1") throw new Error(`the real sandbox is required here and is not available: ${why}`);
if (why) console.log(`# runner tests that need the real sandbox are SKIPPED on this machine: ${why}`);
export const SANDBOX_WHY = why;
