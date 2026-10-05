// @ts-check
// Stripe, as a declaration (records/connectors/format.js). The ops are the ones a firm's flows use: look a customer up, make one (read back to check it), list recent payments (what
// a poll watches), refund (money moves: outward, held). The inbound side is Stripe's webhook, verified and mapped by ./stripe.js, which takes its event list from here.
import { defineConnector } from "../format.js";

const PAYMENT_EVENTS = ["checkout.session.completed", "payment_intent.succeeded", "invoice.paid", "charge.succeeded"];

export default defineConnector({
  id: "stripe", label: "Stripe", version: 1,
  base_url: "https://api.stripe.com",
  auth: { type: "bearer" },
  rate: { per_minute: 6000, retry_after: true },
  idempotency: { header: "Idempotency-Key" },
  ops: {
    "customers.get": { method: "GET", path: "/v1/customers/{id}", kind: "read", label: "Look up a customer",
      input: { params: { id: { type: "string", required: true } } }, output: { id: { type: "string", required: true }, email: { type: "string" }, name: { type: "string" } } },
    "customers.list": { method: "GET", path: "/v1/customers", kind: "read", label: "Find customers",
      input: { query: { email: { type: "email" }, limit: { type: "number" }, starting_after: { type: "string" } } }, output: { data: { type: "array", required: true } } },
    "customers.create": { method: "POST", path: "/v1/customers", kind: "change", label: "Create a customer",
      input: { encoding: "form", body: { email: { type: "email" }, name: { type: "string", max: 256 }, phone: { type: "string" }, description: { type: "string" }, metadata: { type: "object" } } },
      output: { id: { type: "string", required: true } },
      readback: { op: "customers.get", args: { id: "response.json.id" }, compare: { email: "request.body.email", name: "request.body.name" } } },
    "payment_intents.get": { method: "GET", path: "/v1/payment_intents/{id}", kind: "read", label: "Look up a payment",
      input: { params: { id: { type: "string", required: true } } }, output: { id: { type: "string", required: true }, status: { type: "string" } } },
    "payment_intents.list": { method: "GET", path: "/v1/payment_intents", kind: "read", label: "List payments",
      input: { query: { limit: { type: "number" }, "created[gte]": { type: "number" }, starting_after: { type: "string" } } }, output: { data: { type: "array", required: true } } },
    "refunds.create": { method: "POST", path: "/v1/refunds", kind: "spend", label: "Refund a payment",
      input: { encoding: "form", body: { payment_intent: { type: "string", required: true }, amount: { type: "number" }, reason: { type: "string", enum: ["duplicate", "fraudulent", "requested_by_customer"] } } },
      output: { id: { type: "string", required: true }, status: { type: "string" } } },
  },
  poll: {
    "payments.recent": {
      op: "payment_intents.list", items: "data", id: "id", every_minutes: 15, label: "New payments",
      args: { query: { "created[gte]": "{since_s}", limit: "100" } },
      map: { comm_kind: { const: "payment" }, at: "created|iso", title: { template: "{description} {status}" }, status: "status", amount: "amount", currency: "currency|lower", customer: "customer" },
    },
  },
  inbound: { webhook: { events: PAYMENT_EVENTS, emits: "payment.received" } },
});
