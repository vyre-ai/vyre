// @ts-check
// A plugin server's hub row is named by a hash of the plugin, server, level and scope, so no two plugins share a row (and so none shares the grants made to a row's watchers); the deny list covers the loader and
// tool-config variables.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { keyRowName, pluginProblems } from "./skill-library.js";

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
