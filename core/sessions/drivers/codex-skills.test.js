// @ts-check
// A Codex session is given the Space's approved skills through a CODEX_HOME of its own (R031-19): the account's sign-in linked in, Vyre's config, and the skills folder linked. With no library it is the account's own
// folder. Checked against the real Codex CLI when it is installed (`codex debug prompt-input` lists the skills a model would be offered); no key and no model call.
import "../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { codexHomeFor } from "./codex.js";

const tmp = () => fs.mkdtempSync(path.join(os.homedir(), "vyre-codex-home-"));

test("no library: the account's own CODEX_HOME; a library: a home of its own that links the sign-in and the skills, named by the skills' content", () => {
  const home = tmp();
  try {
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(home, ".codex", "auth.json"), '{"token":"x"}');
    assert.equal(codexHomeFor(home, undefined), path.join(home, ".codex"));
    assert.equal(codexHomeFor(home, path.join(home, "nowhere")), path.join(home, ".codex"), "a library with no skills folder is ignored");
    const lib = path.join(home, "materialised", "codex", "abc123");
    fs.mkdirSync(path.join(lib, "skills", "house-style"), { recursive: true });
    fs.writeFileSync(path.join(lib, "skills", "house-style", "SKILL.md"), "---\nname: house-style\ndescription: Use when writing in the house style of this firm.\n---\nWrite plainly.\n");
    const dir = codexHomeFor(home, lib);
    assert.equal(dir, path.join(home, ".codex-lib", "abc123"));
    assert.equal(fs.readlinkSync(path.join(dir, "skills")), path.join(lib, "skills"));
    assert.equal(fs.readlinkSync(path.join(dir, "auth.json")), path.join(home, ".codex", "auth.json"), "the sign-in is linked, never copied");
    assert.match(fs.readFileSync(path.join(dir, "config.toml"), "utf8"), /approval_policy = "on-request"/);
    assert.equal(codexHomeFor(home, lib), dir, "the same skills are the same home, and a second start changes nothing");
    const bin = path.join(os.homedir(), "codex-cli", "node_modules", ".bin", "codex");
    if (fs.existsSync(bin)) {
      const out = execFileSync(bin, ["debug", "prompt-input"], { env: { ...process.env, CODEX_HOME: dir }, encoding: "utf8", timeout: 60_000 });
      assert.match(out, /house-style: Use when writing in the house style of this firm\./, "the real Codex offers the skill in the session that has it");
      const bare = execFileSync(bin, ["debug", "prompt-input"], { env: { ...process.env, CODEX_HOME: path.join(home, ".codex") }, encoding: "utf8", timeout: 60_000 });
      assert.doesNotMatch(bare, /house-style/, "and not in one without it");
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
