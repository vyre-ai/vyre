// @ts-check
// The Claude plugin layout the skill library lays down for a session (Claude and Grok read it): the manifest file and the hook events a plugin may name. A provider fact, so it lives with the drivers;
// lib/skill-library.js takes it as an argument.
export const PLUGIN_LAYOUT = Object.freeze({
  manifest: ".claude-plugin/plugin.json",
  events: Object.freeze(["PreToolUse", "PostToolUse", "SessionStart", "UserPromptSubmit", "Stop"]),
});
