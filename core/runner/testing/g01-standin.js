#!/usr/bin/env node
// @ts-check
// The stand-in Claude of the two-process G01 proof (scripts/g01-two-process.mjs): the fake Claude, writing its session file the way Claude Code does, under the HOME it was given
// (a computer's runner gives it a private HOME; the server gives it the server user's). Swap it for a real `claude` and the same proof runs unchanged.
import path from "node:path";
process.env.FAKE_CLAUDE_TRANSCRIPTS = path.join(process.env.HOME || "/tmp", ".claude", "projects");
await import("../../switchboard/testing/fake-claude.js");
