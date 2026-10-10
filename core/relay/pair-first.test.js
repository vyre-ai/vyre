// @ts-check
// relay.pair.first makes the QR code for the very first device, during onboarding. No yes can exist before that device does, so it asks for none (ruled 10 Oct, red first: with vyre-core holding the keys on a Mac it needed
// one and onboarding could not pair). Three things guard it instead, and each is pinned here through the real daemon: only the onboarding listener's own caller, never once any person exists, and never a caller a
// socket client merely names (the listener behind the one-time setup token is the only way to be "onboard").
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { request } from "../daemon/client.js";
import { momentOf } from "../../lib/one-yes.js";
import { tempHome } from "../../test/helpers.js";
import { createRelay } from "../../relay/node/server.js";

test("relay.pair.first: no yes is asked of the process that has no way to give one, and a socket client cannot be the onboarding page", async t => {
  const relay = createRelay();
  const url = await relay.listen();
  t.after(() => relay.close());
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", name: "fresh", transcripts: [], relay: { enabled: false, url }, modules: { disable: ["names", "onboard"] } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  assert.equal(momentOf("relay.pair.first", () => false), null, "not one of the three moments");
  // the onboarding page's caller (a listener behind the setup token): answered, with no prompt
  const ok = await d.registry.call("relay.pair.first", {}, "onboard");
  assert.ok(ok.data && ok.data.url, JSON.stringify(ok));
  // anyone who only names it over the socket is anonymous, and a person's own surface is not the page
  const forged = await request("POST", "/v1/tools/relay.pair.first", {}, { root, caller: "onboard" });
  assert.ok(forged.error && forged.error.code === "denied", JSON.stringify(forged));
  assert.equal((await d.registry.call("relay.pair.first", {}, "cli")).error?.code, "denied");
  assert.equal((await d.registry.call("relay.pair.first", {}, "mcp:agent:kit")).error?.code, "denied");
});
