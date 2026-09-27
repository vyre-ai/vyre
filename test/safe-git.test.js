// @ts-check
// safe git (lib/git/safe.js): a folder someone else can write to never runs its own commands
// through vyred's git. A planted core.fsmonitor, textconv, filter driver or hook leaves a marker if
// it runs; none may.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { tempHome } from "./helpers.js";
import { safeGitArgs, safeGitEnv } from "../lib/git/safe.js";
import { gitState } from "../core/vault/envfiles.js";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

/** A repo whose own config names a command for every hook point, each writing to `ran`. */
function planted(t) {
  const root = tempHome(t);
  const dir = path.join(root, "harlow"), ran = path.join(root, "ran");
  const cmd = path.join(root, "cmd");
  fs.writeFileSync(cmd, `#!/bin/sh\necho "$0 $*" >> ${JSON.stringify(ran)}\ncat >/dev/null 2>&1\nexit 0\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(root, "hooks"));
  for (const h of ["post-merge", "pre-commit", "post-checkout"]) fs.writeFileSync(path.join(root, "hooks", h), `#!/bin/sh\necho hook >> ${JSON.stringify(ran)}\n`, { mode: 0o755 });
  const g = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "ignore", env: safeGitEnv() });
  fs.mkdirSync(dir);
  g("init", "-q");
  g("config", "user.email", "kit@northwind.test"); g("config", "user.name", "kit");
  fs.writeFileSync(path.join(dir, ".env"), "NORTHWIND_TOKEN=not-a-real-token\n");
  fs.writeFileSync(path.join(dir, "notes.txt"), "hello\n");
  g("add", "."); g("commit", "-qm", "a");
  // Only now the traps: what an agent that can write the folder would plant.
  g("config", "core.fsmonitor", cmd);
  g("config", "core.hooksPath", path.join(root, "hooks"));
  g("config", "diff.x.textconv", cmd);
  g("config", "filter.y.clean", cmd);
  g("config", "filter.y.smudge", cmd);
  fs.writeFileSync(path.join(dir, ".gitattributes"), "* diff=x filter=y\n");
  return { root, dir, ran };
}
const runs = ran => (fs.existsSync(ran) ? fs.readFileSync(ran, "utf8").trim().split("\n").filter(Boolean) : []);

test("safe git: the vault's tracked and ignored checks never run a planted fsmonitor", t => {
  const { dir, ran } = planted(t);
  // The trap works: plain git runs it (so the test would see a regression).
  try { execFileSync("git", ["-C", dir, "ls-files", "--error-unmatch", "--", ".env"], { stdio: "ignore" }); } catch {}
  assert.ok(runs(ran).length > 0, "the planted fsmonitor runs under plain git");
  fs.rmSync(ran, { force: true });
  assert.deepEqual(gitState(path.join(dir, ".env")), { tracked: true, ignored: false });
  assert.deepEqual(runs(ran), [], "nothing planted ran");
});

test("safe git: status, ls-files, check-ignore, diff and log with the safe arguments run nothing planted", t => {
  const { dir, ran } = planted(t);
  fs.writeFileSync(path.join(dir, "notes.txt"), "changed\n");
  for (const args of [["status", "--porcelain"], ["ls-files", "--error-unmatch", "--", ".env"], ["check-ignore", "-q", "--", ".env"],
    ["diff", "--numstat"], ["diff", "HEAD"], ["log", "-p", "-1"], ["rev-parse", "HEAD"], ["checkout", "--", "notes.txt"]]) {
    try { execFileSync("git", [...safeGitArgs(dir), "-C", dir, ...args], { stdio: "ignore", env: safeGitEnv(), timeout: 10_000 }); } catch {}
    assert.deepEqual(runs(ran), [], `git ${args.join(" ")} ran something planted`);
  }
});

test("safe git: every git vyred starts goes through the safe arguments", () => {
  // The person's own terminal (core/cli) runs git as they would; everything vyred runs does not.
  const bad = [];
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { if (!["node_modules", "testing", "cli", ".build"].includes(e.name)) walk(f); continue; }
      if (!f.endsWith(".js") || f.endsWith(".test.js")) continue;
      const src = fs.readFileSync(f, "utf8");
      for (const m of src.matchAll(/(?:execFile|execFileSync|spawn|spawnSync)\(\s*"git"\s*,\s*\[([^\]]*)/g)) {
        if (!/SAFE_GIT_ARGS|safeGitArgs\(/.test(m[1])) bad.push(`${path.relative(REPO, f)}: git ${m[1].slice(0, 60)}`);
      }
    }
  };
  for (const d of ["core", "local", "modules", "lib"]) walk(path.join(REPO, d));
  assert.deepEqual(bad, []);
});
