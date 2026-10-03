// The conformance suite against a real Twenty. Skipped unless VYRE_TWENTY_LIVE_URL is set. It runs
// inside a container on the Space's internal network (see run-on-testbox.sh), because Twenty has no
// published port. A real Twenty needs the webhook target to be a hostname it is allowed to call
// (OUTBOUND_HTTP_ALLOWED_INTERNAL_HOSTS), so the listener's hostname is VYRE_TWENTY_LIVE_HOOK_HOST.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { conformance, SUITE_TYPES } from "../../conformance-suite.js";
import { TwentyStore } from "../driver.js";
import { TwentyClient } from "../client.js";

const URL_ = process.env.VYRE_TWENTY_LIVE_URL;
const KEY_FILE = process.env.VYRE_TWENTY_LIVE_KEY_FILE;
const HOOK_HOST = process.env.VYRE_TWENTY_LIVE_HOOK_HOST ?? "gateway";
const HOOK_PORT = Number(process.env.VYRE_TWENTY_LIVE_HOOK_PORT ?? 4100);

if (!URL_ || !KEY_FILE) {
  test("live Twenty conformance (skipped: set VYRE_TWENTY_LIVE_URL and VYRE_TWENTY_LIVE_KEY_FILE)", { skip: true }, () => {});
} else {
  const key = () => fs.readFileSync(KEY_FILE, "utf8").trim();
  const client = new TwentyClient({ url: URL_, key });
  const servers = [];
  const stores = [];

  async function resetWidget() {
    const cur = await client.gql("metadata", "query Objs { objects(paging: { first: 200 }) { edges { node { id nameSingular } } } }");
    const w = cur.objects.edges.map((e) => e.node).find((n) => n.nameSingular === "widget");
    if (!w) return;
    await client.gql("metadata", "mutation Off($i: UpdateOneObjectInput!) { updateOneObject(input: $i) { id } }", { i: { id: w.id, update: { isActive: false } } });
    await client.gql("metadata", "mutation Del($i: DeleteOneObjectInput!) { deleteOneObject(input: $i) { id } }", { i: { id: w.id } });
  }

  async function boot(types) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tw-live-"));
    const secret = crypto.randomBytes(16).toString("hex");
    const store = new TwentyStore({ client, space: "live", dir, webhookSecret: secret, graceMs: 250 });
    await store.define({ types });
    stores.push(store);
    return store;
  }
  /** a listener Twenty's worker can call */
  async function listen(store) {
    const srv = http.createServer(async (req, res) => {
      const chunks = []; for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString();
      const r = await store.handleWebhook(req.headers, raw);
      if (process.env.VYRE_FEED_DEBUG) { let b = {}; try { b = JSON.parse(raw); } catch {} console.error("hook", r.status, r.recorded, b.eventName, b.record?.id, b.record?.updatedAt, JSON.stringify(b.updatedFields), req.headers["x-twenty-webhook-timestamp"]); }
      res.writeHead(r.status); res.end("{}");
    });
    await new Promise((r) => srv.listen(HOOK_PORT, "0.0.0.0", () => r(null)));
    servers.push(srv);
  }

  const harness = {
    waitMs: 20_000,
    async make() {
      await resetWidget();
      const store = await boot(SUITE_TYPES);
      await listen(store);
      await store.registerWebhook(`http://${HOOK_HOST}:${HOOK_PORT}/hook`);
      const p = store.plan("widget");
      const tw = (patch) => Object.fromEntries(Object.entries(patch).map(([k, v]) => [p.byVyre.get(k).twenty, v && typeof v === "object" && "amount" in v ? { amountMicros: v.amount * 1e6, currencyCode: v.currency } : v]));
      return {
        store,
        behind: async (type, id, patch) => { await client.gql("graphql", "mutation Behind($id: UUID!, $d: WidgetUpdateInput!) { updateWidget(id: $id, data: $d) { id } }", { id, d: tw(patch) }); },
        touch: async (type, id) => { await client.gql("graphql", "mutation Touch($id: UUID!, $d: WidgetUpdateInput!) { updateWidget(id: $id, data: $d) { id } }", { id, d: { position: 7 } }); },
        cleanup: async () => { for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(null))); },
      };
    },
    // a second, empty store needs its own object name; the suite's import test targets "widget",
    // so the live harness imports into the same Twenty after clearing the rows it exported.
    async empty(types) {
      const store = stores[0];
      const rows = [];
      for await (const x of store.export()) rows.push(x);
      // move aside: destroy every widget row, then the test imports its subset back
      for (const { record } of rows) await client.gql("graphql", "mutation D($id: UUID!) { destroyWidget(id: $id) { id } }", { id: record.id });
      return { store, cleanup: async () => {} };
    },
  };
  conformance("twenty store (live Twenty v2.44.0)", { test, before, after }, { assert }, harness);
}
