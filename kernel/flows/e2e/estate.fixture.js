// The Estate planning Kit from the records team, compiled by their language compiler, and what the e2e needs around it: the catalog Flows
// compile against, the Flow that a payment starts, and a Stripe-shaped payment as the connector normalises it.
import fs from "node:fs";
import { compile } from "../../../records/language/compile.js";
import { normalize } from "../../../records/connectors/stripe/stripe.js";
import { ROLE_IDS } from "../../contracts/index.js";

export const SPACE = "spc_harlow000001";
const KIT_TS = new URL("../../../records/kits/estate-planning/kit.ts", import.meta.url);

/** The Kit's stored form, compiled from records' own kit.ts. */
export function estateKit() {
  const src = fs.readFileSync(KIT_TS, "utf8");
  return compile(src);
}

/** The catalog Flows compile against, from the Kit's own definitions. @param {any} kit */
export function catalogOf(kit) {
  return {
    space: SPACE,
    types: Object.fromEntries(kit.types.map(t => [t.name, t])),
    actions: { "email.send": { risk: "outward.send", label: "Send an email" }, "records.read": { risk: "read" }, "records.create": { risk: "write" }, "records.update": { risk: "write" } },
    roles: [...ROLE_IDS, "attorney"],
    teammates: kit.roles.filter(r => r.kind === "teammate").map(r => r.name),
    templates: kit.templates.map(t => t.name),
  };
}

/** The Kit's own payment Flow, as records' compiler stores it: find or create the contact, find or create the matter, which begins at Intake. */
export const onPaymentFlow = () => estateKit().flows.find(f => f.name === "on_payment");

/** A paid Stripe checkout, run through the connector's own normaliser: the event data the Space sees as payment.received. */
export function paymentEvent() {
  const ev = { id: "evt_1", type: "checkout.session.completed", livemode: false, created: 1791000000, data: { object: { id: "cs_test_1", object: "checkout.session", payment_status: "paid", payment_intent: "pi_test_1", amount_total: 350000, currency: "usd", customer: "cus_test_1", customer_details: { email: "Sam@Example.test", name: "Sam Rivera" }, metadata: { plan: "Trust" } } } };
  return normalize(ev);
}
