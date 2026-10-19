// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { openExternalWith, openableUrl } from "./open-external-model.js";

test("only a web address, a mail link or a phone link is ever opened", () => {
  for (const ok of ["https://github.com/login", "http://localhost:3000/x", "mailto:a@b.co", "tel:+15550100"]) assert.equal(openableUrl(ok), ok);
  for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "vyreapp://box", "", null, "https://a b"]) assert.equal(openableUrl(bad), null, String(bad));
});

test("in the Mac app a web address goes to the shell's open and no window is made", async () => {
  const calls = [];
  const r = await openExternalWith("https://claude.ai/oauth", { name: "vyre-github", features: "width=520" }, { shellOpen: async (u) => { calls.push(["shell", u]); }, windowOpen: () => { calls.push(["window"]); return null; } });
  assert.deepEqual(r, { opened: true, via: "shell", window: null });
  assert.deepEqual(calls, [["shell", "https://claude.ai/oauth"]]);
});

test("in a browser a window opens, and its handle comes back for a sign-in popup; a blocked popup says so; a noopener window is not called blocked", async () => {
  const handle = { closed: false };
  const seen = [];
  const win = (u, n, f) => { seen.push([u, n, f]); return handle; };
  assert.deepEqual(await openExternalWith("https://x.test/", { name: "vyre-github", features: "width=520,height=720" }, { windowOpen: win }), { opened: true, via: "window", window: handle });
  assert.deepEqual(seen[0], ["https://x.test/", "vyre-github", "width=520,height=720"]);
  assert.equal((await openExternalWith("https://x.test/", { name: "p", features: "width=520" }, { windowOpen: () => null })).opened, false, "blocked");
  assert.equal((await openExternalWith("https://x.test/", {}, { windowOpen: () => null })).opened, true, "noopener answers null and still opens");
});

test("a shell that fails falls back to a window; a phone hands the link to the system; mail goes to the system's handler even in a browser", async () => {
  assert.equal((await openExternalWith("https://x.test/", {}, { shellOpen: async () => { throw new Error("no"); }, windowOpen: () => ({}) })).via, "window");
  assert.deepEqual(await openExternalWith("https://x.test/", {}, { linkingOpen: async () => {} }), { opened: true, via: "system", window: null });
  assert.equal((await openExternalWith("https://x.test/", {}, { linkingOpen: async () => { throw new Error("no"); } })).opened, false);
  const sys = []; 
  assert.equal((await openExternalWith("mailto:a@b.co", {}, { windowOpen: () => { sys.push("w"); return {}; }, linkingOpen: async () => { sys.push("l"); } })).via, "system");
  assert.deepEqual(sys, ["l"]);
  assert.equal((await openExternalWith("javascript:1", {}, { shellOpen: async () => { throw new Error("must not"); } })).opened, false);
  assert.equal((await openExternalWith("https://x.test/", {}, {})).opened, false, "nothing to open it with");
});
