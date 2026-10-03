// The Stripe connector against a real Twenty (testbox). Signed test-mode events go to the connector's
// HTTP handler, which writes through a gateway stand-in into the Space's Twenty.
//   node stores/twenty/live/stripe-live.mjs <space> <home>
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { provisionSpace, spaceDir, realRunner } from "../provision.js";
import { createTwentyStore } from "../store.js";
import { TwentyClient } from "../client.js";
import { compile } from "../../../records/language/compile.js";
import { GatewayLite } from "../../../records/testing/gateway-lite.js";
import { createStripeHandler, signForTest } from "../../../records/connectors/stripe/stripe.js";

const [space, home] = [process.argv[2], process.argv[3]];
const p = await provisionSpace({ home, space, reach: "ip", runner: realRunner() });
const kit = compile(fs.readFileSync(new URL("../../../records/kits/estate-planning/kit.ts", import.meta.url), "utf8"));
const store = createTwentyStore({ space, client: new TwentyClient({ url: p.url, key: () => fs.readFileSync(p.keyFile, "utf8").trim() }), space, dir: path.join(spaceDir(home, space), "state"), webhookSecret: fs.readFileSync(p.webhookSecretFile, "utf8").trim() });
await store.define({ add_types: kit.types });
const gateway = new GatewayLite({ store, space, types: kit.types });
const SECRET = "whsec_test_sample_secret";
const handle = createStripeHandler({ secret: SECRET, gateway, kit });
const srv = http.createServer(async (req, res) => { const c = []; for await (const x of req) c.push(x); const r = await handle(req.headers, Buffer.concat(c).toString()); res.writeHead(r.status, { "content-type": "application/json" }); res.end(JSON.stringify(r.body)); });
await new Promise((r) => srv.listen(0, "127.0.0.1", () => r(null)));
const port = srv.address().port;
const stamp = Date.now();
const mk = (type, id, obj) => ({ id, type, livemode: false, created: Math.floor(Date.now() / 1000), data: { object: obj } });
const email = `sam.${stamp}@example.test`, cus = `cus_${stamp}`, pi = `pi_${stamp}`;
const events = [
  mk("checkout.session.completed", `evt_${stamp}_1`, { id: `cs_${stamp}`, payment_status: "paid", payment_intent: pi, amount_total: 350000, currency: "usd", customer: cus, customer_details: { email, name: "Sam Rivera" }, metadata: { plan: "Trust" } }),
  mk("payment_intent.succeeded", `evt_${stamp}_2`, { id: pi, amount: 350000, amount_received: 350000, currency: "usd", customer: cus, receipt_email: email }),
  mk("charge.succeeded", `evt_${stamp}_3`, { id: `ch_${stamp}`, paid: true, amount: 350000, currency: "usd", customer: cus, payment_intent: pi, billing_details: { name: "Sam Rivera", email } }),
];
const post = (ev, header) => { const raw = JSON.stringify(ev); return fetch(`http://127.0.0.1:${port}/`, { method: "POST", headers: { "stripe-signature": header ?? signForTest(raw, SECRET) }, body: raw }).then(async (r) => ({ status: r.status, body: await r.json() })); };
const t0 = Date.now();
const results = await Promise.all([...events, ...events].map((e) => post(e)));
console.log("six concurrent deliveries ->", results.map((r) => r.status).join(","), `in ${Date.now() - t0} ms`);
const contacts = (await store.query("contact", { filter: { field: "stripe_customer", op: "eq", value: cus }, page: { limit: 10 } })).rows;
const matters = (await store.query("matter", { filter: { field: "stripe_payment", op: "eq", value: pi }, page: { limit: 10 } })).rows;
console.log("contacts for this customer:", contacts.length, "| matters for this payment:", matters.length);
console.log("matter:", JSON.stringify({ title: matters[0].data.title, stage: matters[0].data.stage, fee: matters[0].data.fee, client: matters[0].data.client.urn.endsWith(contacts[0].id) }));
console.log("events:", gateway.events.map((e) => e.kind).join(", "));
const bad = await post(events[0], "t=1,v1=" + "0".repeat(64));
console.log("bad signature ->", bad.status, JSON.stringify(bad.body));
const live = await post({ ...events[0], id: `evt_${stamp}_live`, livemode: true });
console.log("live-mode event ->", live.status, JSON.stringify(live.body));
srv.close();
