// A child's stdin is a stream: when the child exits before it reads, the write fails with EPIPE as an
// 'error' event, and an event nobody listens for is an uncaught exception that takes vyred down.
// try/catch does not see it. Any source that writes or ends a spawned child's stdin must attach an
// error listener to it. This reads the source only; it boots nothing.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const skip = new Set(["node_modules", ".git", "testing", "spike"]);
function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith(".js") && !e.name.endsWith(".test.js")) yield p;
  }
}

test("every file that writes a child's stdin listens for its errors", () => {
  const bad = [];
  for (const top of ["core", "lib", "local", "packages"]) {
    const dir = path.join(root, top);
    if (!fs.existsSync(dir)) continue;
    for (const f of walk(dir)) {
      const src = fs.readFileSync(f, "utf8");
      // A child's stdin: child.stdin, proc.stdin, c.stdin, p.stdin, r.child.stdin, dst.stdin. Not process.stdin.
      const writes = /\b(?!process\b)\w+(?:\.child)?\.stdin\??\.(?:write|end)\(/.test(src);
      const listens = /\bstdin\??\.(?:on|once)\(\s*["']error["']/.test(src);
      if (writes && !listens) bad.push(path.relative(root, f));
    }
  }
  assert.deepEqual(bad, [], "add child.stdin.on(\"error\", () => {}) before the write");
});
