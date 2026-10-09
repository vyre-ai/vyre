// @ts-check
// An app module's origin is SAME-SITE with Vyre's (documents.alex.vyre.run and alex.vyre.run), and same-site is not same-origin: a page on the app's origin can make the browser send requests to Vyre with
// Vyre's SameSite cookie. This proves Vyre does not take that cookie as the person's: through the daemon's real request path, a request that carries the cookie and says it was started by another
// origin (Sec-Fetch-Site: same-site, Origin: the app's address) is refused for a read of person data and for a person's own change alike; the cookie has no Domain (the __Host- prefix makes one
// impossible), so the browser never sends it to the app's host and the app's page cannot read it; and the same cookie from Vyre's own page still works.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { start } from "../core/daemon/index.js";
import { COOKIE } from "../core/presence/person.js";
import { tempHome, present } from "./helpers.js";

const DEVICE = "abcdefghijklmnop";
const APP = { origin: "https://documents.alex.vyre.run", "sec-fetch-site": "same-site", "sec-fetch-mode": "cors" };

async function box(t) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "alex", vault: { keystore: "file" } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const ctx = d.registry.context({ name: "names", version: "0.1.0", does: { tools: [] }, watches: { emits: ["owner.seen"] } });
  // the owner's own device at its relay address, signed in as a browser would be (the cookie session the Deck gets)
  const sess = d.registry.deps.cliSessions.startStandIn("dev1");
  /** One request as the relay hands it over for the owner's device, with the cookie and whatever the browser said about who started it. */
  const send = async (tool, input, headers = {}) => {
    const raw = JSON.stringify(input);
    const req = Object.assign(Readable.from([Buffer.from(raw)]), { method: "POST", url: `/v1/tools/${tool}`, headers: { host: "relay", "content-type": "application/json", cookie: `${COOKIE}=${sess.token}`, ...headers } });
    let out = "", status = 0;
    const res = { setHeader() {}, writeHead(s) { status = s; }, end(b = "") { out += b; }, headersSent: false };
    await ctx.handler({})(req, res, `device:${DEVICE}`, { kind: "device", stableId: "dev1", node: "dev1", login: null, tags: [], caps: {} });
    return { status, ...(out ? JSON.parse(out) : {}) };
  };
  return { send, sess };
}

test("appmods: Vyre's cookie is host-only, and a request the app's origin started with it is not the person's", async t => {
  const { send } = await box(t);
  assert.ok(COOKIE.startsWith("__Host-"), "the __Host- prefix: a browser accepts the cookie only with Secure, Path=/ and NO Domain, so it is sent to Vyre's host alone and never to <app>.<host>");
  // control: Vyre's own page (same origin) with the cookie is the person
  assert.equal((await send("presence.person.status", {}, { "sec-fetch-site": "same-origin", "sec-fetch-dest": "empty" })).data.signed, true);
  // a READ of person data, started by the app's origin: not the person
  for (const dest of ["empty", "document", "iframe", "image", "script", "style"]) assert.equal((await send("presence.person.status", {}, { ...APP, "sec-fetch-dest": dest })).data.signed, false, dest);
  // a person's own CHANGE, started by the app's origin: refused as no signed-in person (the control goes through)
  for (const [tool, input] of [["agents.create", { name: "kit" }], ["gate.reject", { id: "g1" }], ["threads.answer", { ask: "0123456789abcdef01", decision: "allow" }]]) {
    const r = await send(tool, input, { ...APP, "sec-fetch-dest": "empty" });
    assert.equal(r.error && r.error.code, "person_session_required", `${tool}: ${JSON.stringify(r)}`);
  }
  const own = await send("agents.create", { name: "kit" }, { "sec-fetch-site": "same-origin", "sec-fetch-dest": "empty" });
  assert.notEqual(own.error && own.error.code, "person_session_required", `Vyre's own page with the cookie is still the person: ${JSON.stringify(own)}`);
  // another site, and a sibling box's page on the same registrable domain, are refused the same way
  assert.equal((await send("presence.person.status", {}, { "sec-fetch-site": "cross-site", "sec-fetch-dest": "empty" })).data.signed, false);
  assert.equal((await send("presence.person.status", {}, { origin: "https://bob.vyre.run", "sec-fetch-site": "same-site", "sec-fetch-dest": "document" })).data.signed, false);
});
