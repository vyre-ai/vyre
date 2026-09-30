// A model binary that exits before it reads its prompt must fail the one call, not crash vyred: the
// write to its stdin errors with EPIPE as an event, and unhandled that is an uncaught exception
// (found on a docs run with a fake claude). Runs in a child process so a crash shows as its exit.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("claudeOnce: a binary that exits before reading its prompt rejects the call and the process survives", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-epipe-"));
  try {
    const bin = path.join(dir, "claude");
    fs.writeFileSync(bin, "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    const reader = new URL("./reader.js", import.meta.url).href;
    const code = `import { claudeOnce } from ${JSON.stringify(reader)};
      const ask = claudeOnce({ bin: ${JSON.stringify(bin)} });
      let msg = "resolved";
      try { await ask({ system: "s", prompt: "x".repeat(4 * 1024 * 1024), model: "haiku", maxUsd: 0.01 }); } catch (e) { msg = e.message; }
      await new Promise(r => setTimeout(r, 200));
      console.log("survived:" + msg);`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 20_000 });
    assert.equal(r.status, 0, `the process died: ${r.stderr.slice(0, 300)}`);
    assert.match(r.stdout, /survived:exit 3/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
