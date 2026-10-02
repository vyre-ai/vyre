// The box image carries the provider CLIs the sign-in and the sessions spawn as an account's uid, and the spawner is told where they are.
// A real install failed with "grok is not a program the spawner starts": the image had no Grok and the spawner's list had no entry. This reads files only.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LOGINS } from "../core/sessions/signin.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const docker = fs.readFileSync(path.join(root, "box", "Dockerfile"), "utf8");
const spawner = fs.readFileSync(path.join(root, "core", "spawner", "main.js"), "utf8");
const arg = name => (new RegExp(`^ARG ${name}=(\\S+)`, "m").exec(docker) || [])[1];

test("box image: Codex, its ACP adapter and Grok Build are pinned, and Grok is checked against a sum per architecture", () => {
  assert.match(arg("CODEX_VERSION") || "", /^\d+\.\d+\.\d+$/, "an exact Codex version, never latest");
  assert.match(arg("CODEX_ACP_VERSION") || "", /^\d+\.\d+\.\d+$/);
  assert.match(arg("GROK_VERSION") || "", /^\d+\.\d+\.\d+$/);
  assert.match(arg("GROK_SHA256_AMD64") || "", /^[0-9a-f]{64}$/);
  assert.match(arg("GROK_SHA256_ARM64") || "", /^[0-9a-f]{64}$/);
  assert.notEqual(arg("GROK_SHA256_AMD64"), arg("GROK_SHA256_ARM64"));
  assert.match(docker, /npm install -g "@openai\/codex@\$\{CODEX_VERSION\}" "@agentclientprotocol\/codex-acp@\$\{CODEX_ACP_VERSION\}"/);
  assert.match(docker, /echo "\$sum  \/tmp\/grok" \| sha256sum -c -[^\n]*\\\n[^\n]*install -m 0755 \/tmp\/grok \/usr\/local\/bin\/grok/, "the sum is checked before the binary is installed");
});

test("box image: the spawner starts the image's own codex, codex-acp and grok, and the sign-in and the drivers name exactly those programs", () => {
  for (const p of ["/usr/local/bin/codex", "/usr/local/bin/codex-acp", "/usr/local/bin/grok"]) assert.ok(spawner.includes(`"${p}"`), `${p} is on the spawner's list`);
  assert.equal(LOGINS.codex.bin, "codex");
  assert.equal(LOGINS.grok.bin, "grok");
  assert.match(fs.readFileSync(path.join(root, "core", "sessions", "drivers", "codex.js"), "utf8"), /bin: o\.bin \|\| "codex-acp"/);
  assert.match(fs.readFileSync(path.join(root, "core", "sessions", "drivers", "grok.js"), "utf8"), /bin: o\.bin \|\| "grok"/);
});
