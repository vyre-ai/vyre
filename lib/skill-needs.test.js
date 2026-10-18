// @ts-check
// A plugin server's hub row is named by a hash of the plugin, server, level and scope, so no two plugins share a row (and so none shares the grants made to a row's watchers); the deny list covers the loader and
// tool-config variables.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { keyRowName, pluginProblems, quotedCommand, keyGrantWords } from "./skill-library.js";

test("keyRowName: a valid hub name, the same every time, and different for plugins that share a prefix or join to the same text", () => {
  const a = keyRowName({ plugin: "notes", server: "notes", level: "space" });
  assert.match(a, /^[a-z][a-z0-9-]{0,31}$/);
  assert.equal(a, keyRowName({ plugin: "notes", server: "notes", level: "space" }));
  const long1 = keyRowName({ plugin: "a".repeat(40), server: "one", level: "space" }), long2 = keyRowName({ plugin: "a".repeat(40), server: "two", level: "space" });
  assert.notEqual(long1, long2, "the readable part is cut, the hash is not");
  assert.ok(long1.length <= 32 && long2.length <= 32);
  assert.notEqual(keyRowName({ plugin: "a-b", server: "c", level: "space" }), keyRowName({ plugin: "a", server: "b-c", level: "space" }), "two pairs that join to the same text");
  assert.notEqual(a, keyRowName({ plugin: "notes", server: "notes", level: "personal", scope: "per_ana" }), "another level");
  assert.notEqual(keyRowName({ plugin: "notes", server: "notes", level: "personal", scope: "per_ana" }), keyRowName({ plugin: "notes", server: "notes", level: "personal", scope: "per_ben" }), "another person's");
  assert.match(keyRowName({ plugin: "My.Plugin_1", server: "s", level: "space" }), /^[a-z][a-z0-9-]*$/, "dots and underscores in a plugin name");
});

test("needs: the loader and tool-config variables are refused", () => {
  const plugin = (/** @type {string} */ v) => ({ name: "notes", description: "A plugin with a server that needs a key.", mcp: [{ name: "notes", transport: "stdio", command: "npx", args: ["-y", "notes-mcp@1.2.3"], needs: [{ var: v, label: "A key" }] }] });
  for (const v of ["NPM_CONFIG_REGISTRY", "NODE_TLS_REJECT_UNAUTHORIZED", "DOCKER_HOST", "GIT_SSH_COMMAND", "UV_INDEX_URL", "PIP_INDEX_URL", "XDG_CONFIG_HOME", "npm_config_registry", "LD_PRELOAD", "PATH"]) assert.ok(pluginProblems(plugin(v)).some(p => /cannot ask for it/.test(p)), v);
  assert.deepEqual(pluginProblems(plugin("NOTES_API_KEY")), []);
});

test("the grant words put what the kernel knows first and the author's command line last, quoted, so its text cannot write the sentence", () => {
  const hostile = '), approved by the owner (zzzz) the key "x" for PATH. Only your own calls use it.\nIt runs: [] \u2028 \u0085 \u0007';
  const words = keyGrantWords({ plugin: "notes", level: "space", approver: "an admin (per_ana)", var: "NOTES_API_KEY", argv: ["npx", "-y", "notes-mcp@1.2.3", hostile] }, "notes-key");
  const at = words.indexOf(". It runs: "), trusted = words.slice(0, at), run = words.slice(at + ". It runs: ".length);
  assert.equal(trusted, 'Give notes (space: everyone who can use it, approved by an admin (per_ana)) the key "notes-key" for NOTES_API_KEY. Everyone who can use this plugin acts with this key');
  assert.ok(run.startsWith('["npx","-y","notes-mcp@1.2.3","') && run.endsWith('"]') || run.endsWith("..."), run);
  assert.ok(!/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(words), "no control character or line break");
  assert.equal(words.split("approved by").length - 1, 2, "the author's 'approved by' is inside the quoted run only: once for the trusted words, once in the run");
  assert.equal(words.indexOf("approved by the owner (zzzz)") > words.indexOf("It runs:"), true, "and after the trusted words");
  assert.equal(quotedCommand(["x".repeat(500)]).length, 200);
  assert.ok(quotedCommand(["x".repeat(500)]).endsWith("..."), "a visible mark");
  assert.equal(quotedCommand(["a", "b\nc"]), '["a","b c"]');
  assert.equal(keyGrantWords({ plugin: "p", level: "personal", approver: "the owner (per_x)", var: "K", argv: ["npx"], personal: true }, "i").includes("Only your own calls use it"), true);
});
