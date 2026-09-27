// @ts-check
// The Changes row of a permission ask: line counts for Edit, MultiEdit and Write from their
// input, and for a git push from `git diff --numstat` in a temp repo with a bare "remote".

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { tempHome } from "../../test/helpers.js";
import { lines, countDiff, editChanges, pushDir, pushChanges, parseNumstat, MAX_ROWS } from "./changes.js";

test("changes: lines are counted the way git counts them", () => {
  assert.deepEqual(lines(""), []);
  assert.equal(lines("a\nb\n").length, 2, "a trailing newline is not an empty line");
  assert.equal(lines("a\nb").length, 2);
  assert.deepEqual(countDiff("a\n", "a"), { added: 1, removed: 1 }, "losing the last newline changes the line, as in git");
  assert.deepEqual(countDiff("", "one\ntwo\n"), { added: 2, removed: 0 });
  assert.deepEqual(countDiff("a\nb\nc\n", "a\nB\nc\nd\n"), { added: 2, removed: 1 });
  assert.deepEqual(countDiff("x\ny\nz\n", "x\ny\nz\n"), { added: 0, removed: 0 });
  // An LCS, not a positional compare: a line moved from the top to the bottom is one out, one in.
  assert.deepEqual(countDiff("1\n2\n3\n4\n", "2\n3\n4\n1\n"), { added: 1, removed: 1 });
  // Bounded: over 2000 changed lines on a side counts as all removed and all added.
  const big = Array.from({ length: 2500 }, (_, i) => `l${i}`).join("\n") + "\n";
  const other = Array.from({ length: 2500 }, (_, i) => (i % 2 ? `l${i}` : `m${i}`)).join("\n") + "\n";
  // (The last line is shared and trimmed; an LCS would have found 1250 more in common.)
  assert.deepEqual(countDiff(big, other), { added: 2499, removed: 2499 });
  // The common ends are trimmed first, so a small change in a big file is still exact.
  assert.deepEqual(countDiff(big, big.replace("l1200\n", "L1200\nnew\n")), { added: 2, removed: 1 });
});

test("changes: Edit, MultiEdit and Write asks get per-file counts and totals", t => {
  const dir = tempHome(t);
  const edit = editChanges("Edit", { file_path: "/w/menu.md", old_string: "- Summer tart, 4.00\n", new_string: "- Pumpkin loaf, 5.50\n- Apple cider donut, 3.25\n" });
  assert.deepEqual(edit, { changes: [{ file: "/w/menu.md", added: 2, removed: 1 }], totals: { files: 1, added: 2, removed: 1 } });

  const multi = editChanges("MultiEdit", { file_path: "/w/menu.md", edits: [
    { old_string: "a\nb", new_string: "a\nc" }, { old_string: "x", new_string: "x\ny\nz" }] });
  assert.deepEqual(multi, { changes: [{ file: "/w/menu.md", added: 3, removed: 1 }], totals: { files: 1, added: 3, removed: 1 } }, "one row for the file, summed");

  // An edit's strings are fragments: no line of theirs is the file's last, so no newline marker.
  assert.deepEqual(editChanges("Edit", { file_path: "/w/a", old_string: "x", new_string: "x\ny" })?.totals, { files: 1, added: 1, removed: 0 });

  // Counted from the full strings, before the display cap (8000 characters).
  const long = Array.from({ length: 3000 }, (_, i) => `row ${i}`).join("\n") + "\n";
  assert.equal(editChanges("Edit", { file_path: "/w/a", old_string: "", new_string: long })?.totals.added, 3000);

  const file = path.join(dir, "notes.md");
  assert.deepEqual(editChanges("Write", { file_path: file, content: "one\ntwo\nthree\n" })?.changes, [{ file, added: 3, removed: 0 }], "a new file is all added");
  fs.writeFileSync(file, "one\ntwo\nthree\n");
  assert.deepEqual(editChanges("Write", { file_path: file, content: "one\n2\nthree\nfour\n" })?.changes, [{ file, added: 2, removed: 1 }], "an existing file is diffed");
  assert.deepEqual(editChanges("Write", { file_path: "notes.md", content: "one\n" }, dir)?.changes, [{ file: "notes.md", added: 0, removed: 2 }], "a relative path is read from the cwd, and shown as given");
  fs.writeFileSync(file, "x\n".repeat(600_000));
  assert.deepEqual(editChanges("Write", { file_path: file, content: "x\n" })?.changes, [{ file, added: 1, removed: 0 }], "over 1 MB is not read");

  const token = "sk-ant-api03-" + "Z".repeat(90);
  assert.ok(!editChanges("Edit", { file_path: `/w/${token}`, old_string: "a", new_string: "b" })?.changes[0].file.includes(token), "the path is redacted like detail.file");
  assert.equal(editChanges("Bash", { command: "ls" }), null);
  assert.equal(editChanges("Edit", {}), null);
});

test("changes: only a plain git push is read as one, and its folder is followed", () => {
  const cwd = "/w/site";
  assert.equal(pushDir("git push", cwd), cwd);
  assert.equal(pushDir("git push origin main", cwd), cwd);
  assert.equal(pushDir("git -C app push -u origin main", cwd), "/w/site/app");
  assert.equal(pushDir("git -C /w/other -c push.default=current push", cwd), "/w/other");
  assert.equal(pushDir("cd app && git push", cwd), "/w/site/app");
  assert.equal(pushDir("npm test && git push 2>&1 | tail -5", cwd), cwd);
  assert.equal(pushDir("GIT_SSH_COMMAND='ssh -v' git push", cwd), cwd);
  assert.equal(pushDir("git commit -m 'push it' && git push", cwd), cwd, "a quoted push is not a push");
  assert.equal(pushDir("git commit -m 'push it'", cwd), null);
  assert.equal(pushDir("git status", cwd), null);
  assert.equal(pushDir("echo git push", cwd), null);
  assert.equal(pushDir("git push && git -C x push", cwd), null, "two pushes: not certain which");
  assert.equal(pushDir("git -C $(pwd) push", cwd), null, "command substitution: not certain");
  assert.equal(pushDir("cd \"$DIR\" && git push", cwd), null);
  assert.equal(pushDir("git --git-dir=x push", cwd), null);
  assert.equal(pushDir("(cd app && git push)", cwd), null);
  assert.equal(pushDir("git push 'unclosed", cwd), null);
  assert.equal(pushDir(undefined, cwd), null);
});

test("changes: numstat rows, renames and binaries", () => {
  assert.deepEqual(parseNumstat("3\t1\ta.txt\0-\t-\tlogo.png\0" + "2\t0\t\0old.md\0new.md\0"), [
    { file: "a.txt", added: 3, removed: 1 }, { file: "logo.png", added: null, removed: null, binary: true }, { file: "new.md", added: 2, removed: 0 }]);
  assert.deepEqual(parseNumstat(""), []);
});

/** A temp repo with a bare "remote" that main was pushed to. */
function repo(t) {
  const root = tempHome(t);
  const env = { ...process.env, GIT_AUTHOR_NAME: "alex", GIT_AUTHOR_EMAIL: "alex@example.com", GIT_COMMITTER_NAME: "alex", GIT_COMMITTER_EMAIL: "alex@example.com",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"), GIT_TERMINAL_PROMPT: "0" };
  const remote = path.join(root, "remote.git"), work = path.join(root, "site");
  const git = (...a) => execFileSync("git", a, { cwd: work, env, stdio: ["ignore", "pipe", "pipe"] }).toString();
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote], { env });
  fs.mkdirSync(work);
  git("init", "-q", "-b", "main");
  git("remote", "add", "origin", remote);
  fs.writeFileSync(path.join(work, "menu.md"), "# Northwind Bakery\n\n- Sourdough loaf, 6.50\n- Summer tart, 4.00\n");
  fs.writeFileSync(path.join(work, "about.md"), "Baked each morning.\n");
  git("add", ".");
  git("commit", "-q", "-m", "menu");
  git("push", "-q", "-u", "origin", "main");
  git("remote", "set-head", "origin", "main");
  return { root, work, git };
}

test("changes: a push's rows come from what is ahead of the remote, binaries counted but not in line totals", async t => {
  const { work, git } = repo(t);
  fs.writeFileSync(path.join(work, "menu.md"), "# Northwind Bakery\n\n- Sourdough loaf, 6.50\n- Pumpkin loaf, 5.50\n- Apple cider donut, 3.25\n");
  fs.writeFileSync(path.join(work, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1, 2, 0, 3]));
  fs.rmSync(path.join(work, "about.md"));
  git("add", "-A");
  git("commit", "-q", "-m", "autumn");
  const got = await pushChanges(work);
  assert.ok(got);
  const byFile = Object.fromEntries(got.changes.map(r => [r.file, r]));
  assert.deepEqual(byFile["menu.md"], { file: "menu.md", added: 2, removed: 1 });
  assert.deepEqual(byFile["about.md"], { file: "about.md", added: 0, removed: 1 });
  assert.deepEqual(byFile["logo.png"], { file: "logo.png", added: null, removed: null, binary: true });
  assert.deepEqual(got.totals, { files: 3, added: 2, removed: 2 });
  assert.equal("truncated" in got, false);

  // In a subfolder, paths are still the repo's.
  fs.mkdirSync(path.join(work, "docs"));
  assert.ok((await pushChanges(path.join(work, "docs")))?.changes.some(r => r.file === "menu.md"));

  // A branch with no upstream: the merge-base with origin's default branch.
  git("checkout", "-q", "-b", "specials");
  fs.writeFileSync(path.join(work, "specials.md"), "Pumpkin loaf\n");
  git("add", ".");
  git("commit", "-q", "-m", "specials");
  const branch = await pushChanges(work);
  assert.deepEqual(branch?.totals, { files: 4, added: 3, removed: 2 }, "both commits since main left");

  // Nothing ahead: an empty list, not an absent one.
  git("checkout", "-q", "main");
  git("push", "-q");
  assert.deepEqual(await pushChanges(work), { changes: [], totals: { files: 0, added: 0, removed: 0 } });
});

test("changes: no remote, no git, or no time means no changes", async t => {
  const root = tempHome(t);
  assert.equal(await pushChanges(root), null, "not a repo");
  const { work, git } = repo(t);
  git("remote", "remove", "origin");
  assert.equal(await pushChanges(work), null, "no upstream and no origin");
  assert.equal(await pushChanges(work, 0), null, "out of time");
});

test("changes: a push of many files keeps 200 rows and totals for all", async t => {
  const { work, git } = repo(t);
  for (let i = 0; i < MAX_ROWS + 5; i++) fs.writeFileSync(path.join(work, `f${i}.txt`), "a\nb\n");
  git("add", ".");
  git("commit", "-q", "-m", "many");
  const got = await pushChanges(work);
  assert.equal(got?.changes.length, MAX_ROWS);
  assert.deepEqual(got?.totals, { files: MAX_ROWS + 5, added: (MAX_ROWS + 5) * 2, removed: 0 });
  assert.equal(got?.truncated, true);
});
