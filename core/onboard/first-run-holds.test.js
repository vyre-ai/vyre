// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { loginAdapters, sessionCaller } from "../../lib/agent-adapters.js";

/** Every outward onboard write from module.json. */
function outwardOnboardWrites() {
  const manifest = JSON.parse(fs.readFileSync(new URL("./module.json", import.meta.url), "utf8"));
  return manifest.does.tools
    .filter((x) => x && typeof x === "object" && x.outward && x.effect === "write")
    .map((x) => x.name)
    .sort();
}

const PASS = "correct horse battery";

/** Minimal valid input per tool so validation reaches the outward hold. */
const SAMPLE = {
  "onboard.person.create": { username: "alex", password: PASS, confirm: PASS },
  "onboard.member.link": { role: "member", ttlDays: 7, space: "juniper" },
  "onboard.space.join": { link: "https://vyre.run/i/abcdefghijk" },
  "onboard.space.open": { kind: "linux", name: "juniper" },
  "onboard.space.current": { space: "juniper" },
  "onboard.github.finish": { login: "alex", subject: "gh-1" },
  "onboard.agent.signin": { provider: "claude", label: "Claude" },
  "onboard.windows": { label: "Office PC", name: "office-pc", type: "windows", fingerprint: "abcd12345678" },
};

test("onboard write tools are outward in module.json", () => {
  const names = outwardOnboardWrites();
  assert.ok(names.includes("onboard.person.create"));
  assert.ok(names.includes("onboard.agent.signin"));
  assert.deepEqual(names, Object.keys(SAMPLE).sort(), "keep SAMPLE in sync with outward writes");
});

for (const tool of outwardOnboardWrites()) {
  test(`each login-able adapter is held on ${tool}`, async (t) => {
    const root = tempHome(t);
    const d = await start({ root, log: () => {} });
    t.after(() => d.stop());
    const input = SAMPLE[tool];
    for (const id of loginAdapters(d.registry.providers.keys())) {
      const caller = sessionCaller(id, { agent: "kit" });
      const r = await d.registry.call(tool, input, caller);
      assert.equal(r.error && r.error.code, "held_for_approval", `${id}: ${JSON.stringify(r.error)}`);
      assert.equal(r.data, undefined);
      assert.doesNotMatch(String(r.error && r.error.line || ""), /horse|battery|SECRET/i);
    }
  });
}
