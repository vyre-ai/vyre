// The updater runs as the PERSON (no sudo) when they type `vyre update`, and root's private folders ($UPD_PRIV, $UPD_ROOT) are not theirs to write. v0.3.0 stopped Vyre and then died on
// `rm -f "$UPD_PRIV/release.swapped"` because that line was not allowed to fail: a server was left stopped. So in box/vyre every write (rm, mv, mkdir, chmod, cp, put_*, a redirect) to those
// folders must either tolerate failure (`|| true`, `|| return`, `|| {`), go through sudo, or sit in a function that only ever runs as root (listed below, each with the reason).
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

/** Functions that only run as root, with the reason. A new name here needs the same kind of reason. */
export const ROOT_ONLY = {
  publish_release: "returns early through `sudo -n publish-release` unless it is root (checked below), so its writes are root's",
  restore_release: "starts with a read of root's private marker; a person cannot read it, so it returns before any write",
  update_from_request: "the root unit's entry point (vyre-update.service)",
  updater: "`vyre updater install` and its verbs are run with sudo",
  raise_floor_root: "the body of `sudo vyre raise-floor`: the verb's case refuses any caller but root before it is called, and a person's update reaches it only through `sudo -n`",
};
const WRITE = /(^|[\s;&(])(rm|mv|rmdir|mkdir|chmod|cp|put_text|put_file|rename_over|install|ln|touch)\s|>\s*"?\$|:\s*>/;
const TOLERANT = /\|\|\s*(true|return|\{|exit|:)|\bsudo\b/;

/** The lines that write to root's folders and are allowed to fail nowhere. @param {string} text @returns {{ fn: string, n: number, line: string }[]} */
export function untolerated(text) {
  const bad = [];
  let fn = "";
  text.split("\n").forEach((line, i) => {
    const m = /^([a-zA-Z_][a-zA-Z0-9_-]*)\(\) \{/.exec(line);
    if (m) fn = m[1];
    if (line.startsWith("}")) fn = "";
    if (!/\$\{?UPD_(PRIV|ROOT)\b/.test(line) || !WRITE.test(line)) return;
    if (/^\s*#/.test(line) || TOLERANT.test(line) || Object.hasOwn(ROOT_ONLY, fn)) return;
    bad.push({ fn, n: i + 1, line: line.trim().slice(0, 160) });
  });
  return bad;
}

test("every write to root's updater folders in the person's path can fail without stopping the update", () => {
  assert.deepEqual(untolerated(fs.readFileSync(new URL("../box/vyre", import.meta.url), "utf8")), []);
});

test("v0.3.0's line is caught: a bare rm of release.swapped in update()", () => {
  const old = 'update() {\n  compose stop vyre >/dev/null 2>&1 || true\n  rm -f "$UPD_PRIV/release.swapped"\n  publish_release "$tmp" || roll_back\n}\n';
  const bad = untolerated(old);
  assert.equal(bad.length, 1);
  assert.match(bad[0].line, /release\.swapped/);
  assert.equal(untolerated(old.replace('release.swapped"', 'release.swapped" 2>/dev/null || true')).length, 0);
});

test("publish_release returns before any write unless it is root", () => {
  const text = fs.readFileSync(new URL("../box/vyre", import.meta.url), "utf8");
  const body = text.slice(text.indexOf("\npublish_release() {"));
  const guard = body.indexOf('if [ "$(id -u)" != "$ROOT_UID" ]; then');
  const firstWrite = body.indexOf('"$UPD_PRIV/release.prev"');
  assert.ok(guard > 0 && firstWrite > guard, "the root guard comes first");
  assert.match(body.slice(guard, guard + 200), /sudo -n "\$WRAPPER" publish-release/);
});
