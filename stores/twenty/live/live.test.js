// The kernel's conformance suite, and the Twenty-specific suite, against a real Twenty. Skipped unless
// VYRE_TWENTY_LIVE_URL is set. It runs inside a container on the Space's internal network (see
// run-on-testbox.sh) because Twenty has no published port. A real Twenty may only call a webhook host
// listed in OUTBOUND_HTTP_ALLOWED_INTERNAL_HOSTS, so the listener's hostname is VYRE_TWENTY_LIVE_HOOK_HOST.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { conformance, CONTACT } from "../../../kernel/conformance/suite.js";
import { createTwentyStore } from "../store.js";
import { TwentyClient } from "../client.js";
import { specific } from "../specific-suite.js";
import { toInput } from "../plan.js";

const URL_ = process.env.VYRE_TWENTY_LIVE_URL;
const KEY_FILE = process.env.VYRE_TWENTY_LIVE_KEY_FILE;
const HOOK_HOST = process.env.VYRE_TWENTY_LIVE_HOOK_HOST ?? "gateway";
const HOOK_PORT = Number(process.env.VYRE_TWENTY_LIVE_HOOK_PORT ?? 4100);

if (!URL_ || !KEY_FILE) {
  test("live Twenty conformance (skipped: set VYRE_TWENTY_LIVE_URL and VYRE_TWENTY_LIVE_KEY_FILE)", { skip: true }, () => {});
} else {
  const key = () => fs.readFileSync(KEY_FILE, "utf8").trim();
  const client = new TwentyClient({ url: URL_, key });
  /** @type {import("node:http").Server | null} */ let listener = null;
  /** @type {any} */ let current = null;
  // one secret for the whole run, like a real Space: Twenty caches its webhook list, so a new secret per test would race the cache
  const SECRET = crypto.randomBytes(16).toString("hex");

  // one listener for the whole run; it hands every webhook to whichever store is current
  async function ensureListener() {
    if (listener) return;
    listener = http.createServer(async (req, res) => {
      const chunks = []; for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString();
      const r = current ? await current.handleWebhook(req.headers, raw) : { status: 200 };
      if (process.env.VYRE_FEED_DEBUG) console.error("hook", r.status, r.recorded, raw.slice(0, 80));
      res.writeHead(r.status); res.end("{}");
    });
    await new Promise((r) => /** @type {any} */ (listener).listen(HOOK_PORT, "0.0.0.0", () => r(null)));
  }
  /** a fresh, empty store: every contact row destroyed, state in a new folder */
  async function fresh() {
    await ensureListener();
    const d = await client.gql("metadata", "query Objs { objects(paging: { first: 200 }) { edges { node { nameSingular } } } }");
    if (d.objects.edges.some((e) => e.node.nameSingular === "contact")) {
      await client.gql("graphql", "mutation Purge($f: ContactFilterInput) { destroyContacts(filter: $f) { id } }", { f: { or: [{ deletedAt: { is: "NULL" } }, { deletedAt: { is: "NOT_NULL" } }] } });
    }
    if (d.objects.edges.some((e) => e.node.nameSingular === "account")) {
      await client.gql("graphql", "mutation PurgeA($f: AccountFilterInput) { destroyAccounts(filter: $f) { id } }", { f: { or: [{ deletedAt: { is: "NULL" } }, { deletedAt: { is: "NOT_NULL" } }] } });
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tw-live-"));
    const store = createTwentyStore({ client, space: "live", dir, webhookSecret: SECRET, graceMs: 250 });
    await store.define({ add_types: [CONTACT] });
    await store.registerWebhook(`http://${HOOK_HOST}:${HOOK_PORT}/hook`);
    current = store;
    return store;
  }

  conformance(fresh, { test, assert }, "twenty (live Twenty v2.44.0)");
  specific("twenty (live Twenty v2.44.0)", { test }, { assert }, {
    waitMs: 120_000, // a bulk test leaves Twenty's worker with a webhook backlog, so a later webhook can arrive a minute late
    async make() {
      const store = await fresh();
      const behind = async (type, id, patch) => { const p = store.plans.get(type); await client.gql("graphql", "mutation Behind($id: UUID!, $d: ContactUpdateInput!) { updateContact(id: $id, data: $d) { id } }", { id, d: toInput(p, patch) }); };
      const touch = async (type, id) => { await client.gql("graphql", "mutation Touch($id: UUID!, $d: ContactUpdateInput!) { updateContact(id: $id, data: $d) { id } }", { id, d: { position: 7 } }); };
      return { store, behind, touch, cleanup: async () => {} };
    },
  });
  test("live: close the listener", async () => { await new Promise((r) => (listener ? listener.close(() => r(null)) : r(null))); });
}
