// Computer use and Mac data (the 4 Oct cb69aea6d marked these tools `effect: "read"` or "write" and open to anyone): every tool a local module registers names who may call it, in its own code, and no
// list names a guest, an anonymous or an unknown caller. The modules only run on a Mac, so this reads their source: a tool added without a callers list, or with a wide one, fails here.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULES = ["apps", "capsule", "hands-chrome-mac", "hands-mac", "screen-mac", "sideview"];
const WIDE = /["'](anonymous|unknown|tailnet-guest|guest|invitee|web|setup|onboard|hook|link|anyone)["']/;

for (const m of MODULES) {
  const files = fs.readdirSync(path.join(ROOT, "local", m)).filter(f => f.endsWith(".js") && !f.endsWith(".test.js"));
  test(`local/${m}: every read it registers names its callers, and none is a guest, anonymous or unknown caller`, () => {
    let sites = 0;
    for (const f of files) {
      const src = fs.readFileSync(path.join(ROOT, "local", m, f), "utf8");
      const lines = src.split("\n");
      lines.forEach((line, i) => {
        if (!/\bctx\.tool\(/.test(line)) return;
        sites++;
        // the call's own block: up to the next ctx.tool( or 14 lines
        const block = lines.slice(i, i + 14).join("\n");
        // a tool that changes state and names no callers is the person's surfaces and modules only (the registry's once-only default); a read with no callers would be open to every kind
        assert.ok(/callers:|internal: true|effect: "write"/.test(block), `${m}/${f}:${i + 1}: this tool names no callers and is not a write, so it is open to every caller kind`);
      });
      for (const line of lines) if (/callers:/.test(line)) assert.ok(!WIDE.test(line), `${m}/${f}: a callers list names a wide class: ${line.trim().slice(0, 140)}`);
    }
    assert.ok(sites > 0, `${m}: found its tool registrations`);
  });
}
