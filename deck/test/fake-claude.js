#!/usr/bin/env node
// The Switchboard's fake claude (core/switchboard/testing/fake-claude.js) for a Deck world, plus the
// one thing the world also asks of claude that the fake does not answer: `claude --version`
// (onboarding's Claude step). Never the real claude.
if (process.argv.includes("--version")) { process.stdout.write("2.1.283 (Claude Code)\n"); process.exit(0); }
await import("../../core/switchboard/testing/fake-claude.js");
