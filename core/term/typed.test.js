// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { LineTracker, asksForSecret } from "./typed.js";

const lines = (...chunks) => { const t = new LineTracker(); return chunks.flatMap(c => t.feed(c)).map(l => [l.text, l.known]); };

test("typed: a line is what was typed up to Enter, however the keys were chunked", () => {
  assert.deepEqual(lines("ls -la\r"), [["ls -la", true]]);
  assert.deepEqual(lines("l", "s", " ", "-l", "a", "\r"), [["ls -la", true]]);
  assert.deepEqual(lines("a\rb\r"), [["a", true], ["b", true]]);
  assert.deepEqual(lines("a\r\n"), [["a", true]]);
  assert.deepEqual(lines("\r"), []);
});

test("typed: Backspace, Ctrl-U, Ctrl-W edit the line; Ctrl-C and Ctrl-D abandon it", () => {
  assert.deepEqual(lines("lsx\x7f -l\r"), [["ls -l", true]]);
  assert.deepEqual(lines("oops\x15pwd\r"), [["pwd", true]]);
  assert.deepEqual(lines("git commit\x17status\r"), [["git status", true]]);
  assert.deepEqual(lines("rm -rf /\x03", "ls\r"), [["ls", true]]);
  assert.deepEqual(lines("exit\x04", "ls\r"), [["ls", true]]);
});

test("typed: lines the shell builds itself (history, tab, cursor keys) are unknown, never guessed", () => {
  assert.deepEqual(lines("\x1b[A\r"), [["", false]]);
  assert.deepEqual(lines("git ch\t\r"), [["git ch", false]]);
  assert.deepEqual(lines("ab\x1b[Dc\r"), [["abc", false]]);
  assert.deepEqual(lines("ab\x1bOD\r"), [["ab", false]]);
  assert.deepEqual(lines("\x12git\r"), [["git", false]]);
  // The next line is clean again.
  assert.deepEqual(lines("\x1b[A\rls\r"), [["", false], ["ls", true]]);
});

test("typed: bracketed paste is the text pasted, and a newline in it does not run the line", () => {
  assert.deepEqual(lines("\x1b[200~echo a\necho b\x1b[201~\r"), [["echo a echo b", true]]);
  assert.deepEqual(lines("\x1b[200~ls\x1b[201~", "\r"), [["ls", true]]);
});

test("typed: start() runs once per line, at its first key, and rides on the finished line", () => {
  let n = 0;
  const t = new LineTracker({ start: () => ++n });
  assert.deepEqual(t.feed("ab").length, 0);
  assert.equal(n, 1);
  const [l] = t.feed("c\r");
  assert.equal(l.mark, 1);
  t.feed("\r");
  assert.equal(n, 1);
  t.feed("x\r");
  assert.equal(n, 2);
});

test("typed: the prompts that ask for a secret", () => {
  assert.ok(asksForSecret("Password: "));
  assert.ok(asksForSecret("[sudo] password for alex: "));
  assert.ok(asksForSecret("Enter passphrase for key '/home/alex/.ssh/id_ed25519': "));
  assert.ok(asksForSecret("\x1b[1mPassword\x1b[0m: "));
  assert.ok(!asksForSecret("alex@juno:~$ "));
  assert.ok(!asksForSecret("the password rotated\nalex@juno:~$ "));
});
