// @ts-check
// The edge's question to the directory, against the Worker's own code over HTTP: a box that published through the tunnel is found by the host it declared, and nobody else is. The first version of
// this question read the answer as { route } while the directory sends { data: { route } }, so a real edge served no one; every other test of the tunnel used a lookup of its own shape.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { directoryResolve } from "./resolve.js";
import { createDirectoryServer } from "./directory.js";
import { directory } from "../../core/names/directory.js";
import { newRouteKey, routeId, signRoute } from "../../core/relay/wire.js";

const SECRET = "s".repeat(40), ADMIN = "a".repeat(40);

test("the edge finds the route of a host a box declared through the tunnel, and only that", async t => {
  const k = newRouteKey(), route = routeId(k.pub);
  const dir = await createDirectoryServer({ port: 0, zone: "vyre.run", relaySecret: SECRET, tunnelIpv4: "93.184.216.99", adminSecret: ADMIN });
  t.after(() => dir.close());
  const store = dir.rt.object("v1", "DIRECTORY").ctx.storage.map;
  store.set("n/harlow", { name: "harlow", route, state: "claimed", claimedAt: Date.now(), everPointed: false, pointedAt: null, ips: {}, notices: [], log: [] });
  store.set(`r/${route}`, "harlow");
  const signer = { identity: async () => ({ route, pub: k.pub }), sign: async (/** @type {Buffer} */ m) => signRoute(k.priv, m) };
  await directory({ base: dir.url, signer }).publish("harlow", { apps: true, via: "tunnel" });

  const resolve = directoryResolve({ base: dir.url, secret: SECRET });
  assert.deepEqual(await resolve("documents.harlow.vyre.run"), { route }, "the declared app host is served by the box that declared it");
  for (const h of ["harlow.vyre.run", "a.b.harlow.vyre.run", "documents.nobody.vyre.run", "documents.harlow.example.com", ""]) assert.equal(await resolve(h), null, `${h || "(empty)"} is nobody's`);
  // the relay's secret is the only way to ask: a wrong one is a plain no, and so is a directory that is down or slow
  assert.equal(await directoryResolve({ base: dir.url, secret: "x".repeat(40) })("documents.harlow.vyre.run"), null);
  assert.equal(await directoryResolve({ base: "http://127.0.0.1:1", secret: SECRET })("documents.harlow.vyre.run"), null);
  assert.equal(await directoryResolve({ base: dir.url, secret: SECRET, fetch: (_u, o) => new Promise((_ok, no) => { /** @type {any} */ (o).signal.addEventListener("abort", () => no(new Error("timed out"))); }), timeoutMs: 50 })("documents.harlow.vyre.run"), null);
  // the support switch takes the host away at the next question
  const sus = await fetch(`${dir.url}/v1/names/admin/suspend`, { method: "POST", headers: { "content-type": "application/json", "x-vyre-admin": ADMIN }, body: JSON.stringify({ name: "harlow", on: true }) });
  assert.equal(sus.status, 200);
  assert.equal(await resolve("documents.harlow.vyre.run"), null, "suspended: not served");
});
