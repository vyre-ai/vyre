// @ts-check
// The built-in provider: Claude Code, on the Agent SDK when it is loaded, else on the CLI runner.
// Both speak the same wire (core/sessions/conformance.js) and both pass conform().

import { argsFor, run as runCli } from "../switchboard/runner.js";
import { run as runSdk } from "./claude.js";

/**
 * @param {{ sdk?: { module: any, bin: string|null }|null, bin: string, run?: typeof runCli }} o
 *   sdk: the loaded SDK (null: the CLI); bin: the `claude` for the CLI, or a test double for both;
 *   run: the CLI runner (tests swap it)
 */
export function claudeProvider(o) {
  const cli = o.run || runCli;
  return {
    id: "claude",
    driver: o.sdk ? "sdk" : "cli",
    capabilities: { streaming: true, resume: true, interrupt: true, modes: true, questions: true, transcripts: true },
    /** @param {any} s */
    run(s) {
      return o.sdk
        ? runSdk(o.sdk.module, { ...s, bin: o.bin || o.sdk.bin })
        : cli({ ...s, bin: o.bin || "claude", args: argsFor(s) });
    },
  };
}
