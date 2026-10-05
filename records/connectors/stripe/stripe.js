// @ts-check
// The Stripe connector (test mode). A payment in Stripe becomes a `payment.received` event in the
// Space, and the Kit's own flow finds or creates the contact and the matter. Inbound webhook only: it
// never calls Stripe and never holds a Stripe secret key, only the webhook signing secret.
//
//   verify  the Stripe-Signature header (HMAC-SHA256 over "<t>.<body>", 5 minute tolerance, any v1)
//   refuse  live-mode events unless the connector was told to accept them (this build is test mode)
//   map     checkout.session.completed, payment_intent.succeeded, invoice.paid, charge.succeeded
//   emit    payment.received into the Space's event log (once per payment), where the Flow runner hears it
//   run     the Kit's Flow for payment.received (find or create the contact, then the matter) runs on the kernel's runner

import crypto from "node:crypto";
import declaration from "./declaration.js";

const TOLERANCE_SEC = 300;
// What Stripe pushes, and what it becomes, is the declaration's (./declaration.js): this file is the small mapping code the declaration points at.
export const HANDLED = declaration.inbound?.webhook.events ?? [];
const EMITS = declaration.inbound?.webhook.emits ?? "payment.received";

/**
 * @param {string} rawBody @param {string | undefined} header @param {string} secret
 * @param {{ now?: () => number, toleranceSec?: number }} [o]
 * @returns {{ ok: true } | { ok: false, reason: "missing" | "malformed" | "stale" | "mismatch" }}
 */
export function verifySignature(rawBody, header, secret, o = {}) {
  if (!header) return { ok: false, reason: "missing" };
  const parts = header.split(",").map((p) => p.trim().split("="));
  const t = parts.find(([k]) => k === "t")?.[1];
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || !/^\d+$/.test(t) || !sigs.length) return { ok: false, reason: "malformed" };
  const nowSec = Math.floor((o.now ?? Date.now)() / 1000);
  if (Math.abs(nowSec - Number(t)) > (o.toleranceSec ?? TOLERANCE_SEC)) return { ok: false, reason: "stale" };
  const want = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  const w = Buffer.from(want);
  const ok = sigs.some((s) => { const b = Buffer.from(s); return b.length === w.length && crypto.timingSafeEqual(b, w); });
  return ok ? { ok: true } : { ok: false, reason: "mismatch" };
}

/** Build a header for tests and the testbox run. @param {string} rawBody @param {string} secret @param {number} [nowMs] */
export function signForTest(rawBody, secret, nowMs = Date.now()) {
  const t = Math.floor(nowMs / 1000);
  return `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex")}`;
}

const major = (/** @type {number} */ minor, /** @type {string} */ cur) => (["jpy", "krw", "vnd", "clp"].includes(cur) ? minor : minor / 100);

/**
 * Stripe event -> the payment the Space sees, or null for an event that is not a received payment.
 * @param {any} ev
 * @returns {{ event: string, customer: string, email: string | null, name: string | null, payment: string, amount: { amount: number, currency: string }, description: string | null, livemode: boolean, at: string, metadata: Record<string, string> } | null}
 */
export function normalize(ev) {
  const o = ev?.data?.object;
  if (!o || typeof ev.id !== "string") return null;
  /** @type {{ payment: string, minor: number, cur: string, customer: string | null, email: string | null, name: string | null, description: string | null, metadata: any } | null} */ let p = null;
  switch (ev.type) {
    case "checkout.session.completed":
      if (o.payment_status !== "paid") return null;
      p = { payment: o.payment_intent ?? o.id, minor: o.amount_total, cur: o.currency, customer: o.customer ?? null, email: o.customer_details?.email ?? o.customer_email ?? null, name: o.customer_details?.name ?? null, description: o.metadata?.plan ? `Checkout: ${o.metadata.plan}` : "Checkout", metadata: o.metadata };
      break;
    case "payment_intent.succeeded":
      p = { payment: o.id, minor: o.amount_received ?? o.amount, cur: o.currency, customer: o.customer ?? null, email: o.receipt_email ?? null, name: null, description: o.description ?? null, metadata: o.metadata };
      break;
    case "invoice.paid":
      p = { payment: o.payment_intent ?? o.id, minor: o.amount_paid, cur: o.currency, customer: o.customer ?? null, email: o.customer_email ?? null, name: o.customer_name ?? null, description: o.description ?? null, metadata: o.metadata };
      break;
    case "charge.succeeded":
      if (!o.paid) return null;
      p = { payment: o.payment_intent ?? o.id, minor: o.amount_captured ?? o.amount, cur: o.currency, customer: o.customer ?? null, email: o.billing_details?.email ?? o.receipt_email ?? null, name: o.billing_details?.name ?? null, description: o.description ?? null, metadata: o.metadata };
      break;
    default: return null;
  }
  if (typeof p.minor !== "number" || typeof p.cur !== "string" || typeof p.payment !== "string") return null;
  const cur = p.cur.toLowerCase();
  const email = p.email ? String(p.email).toLowerCase() : null;
  return { event: ev.id, display: p.name ?? email ?? p.customer ?? `payment ${p.payment}`, customer: p.customer ?? (email ? `guest:${email}` : `payment:${p.payment}`), email, name: p.name, payment: p.payment, amount: { amount: major(p.minor, cur), currency: cur.toUpperCase() }, description: p.description, livemode: !!ev.livemode, at: new Date((ev.created ?? Date.now() / 1000) * 1000).toISOString(), metadata: Object.fromEntries(Object.entries(p.metadata ?? {}).filter(([, v]) => typeof v === "string")) };
}

/**
 * The webhook handler. Returns what to answer Stripe; Stripe retries anything that is not 2xx.
 * `host` is the Space's records host (records/host.js): `emit` writes the event, `settle` waits for the runs it started,
 * `flows.runner` says how they ended.
 * @param {{ secret: string, host: { emit: Function, settle: Function, flows: { runner: any } }, allowLive?: boolean,
 *   now?: () => number, onRejected?: (reason: string) => void }} o
 */
export function createStripeHandler(o) {
  /** @type {Map<string, Promise<any>>} one delivery at a time per customer, so two payments cannot each create the contact */
  const inflight = new Map();
  /** The runs an event started, and whether any of them did not finish. @param {string} eventId */
  async function runsOf(eventId) {
    const runs = (await o.host.flows.runner.listRuns({ limit: 1000 })).filter((/** @type {any} */ r) => r.trigger && r.trigger.key === eventId);
    return { runs, bad: runs.filter((/** @type {any} */ r) => r.state === "failed" || r.state === "paused") };
  }
  return async function handle(/** @type {Record<string, string | string[] | undefined>} */ headers, /** @type {string} */ rawBody) {
    const sigHeader = headers["stripe-signature"]; const sig = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
    const v = verifySignature(rawBody, sig, o.secret, { now: o.now });
    if (!v.ok) { o.onRejected?.(v.reason); return { status: 400, body: { error: `signature ${v.reason}` } }; }
    /** @type {any} */ let ev; try { ev = JSON.parse(rawBody); } catch { return { status: 400, body: { error: "not json" } }; }
    if (!HANDLED.includes(ev.type)) return { status: 200, body: { ignored: ev.type } };
    const pay = normalize(ev);
    if (!pay) return { status: 200, body: { ignored: `${ev.type} is not a received payment` } };
    if (pay.livemode && !o.allowLive) return { status: 200, body: { ignored: "live-mode event; this connector is in test mode" } };
    // One Checkout payment arrives as several Stripe events (the session, the payment intent, the charge). `payment.received` is
    // written exactly once per payment, keyed on the payment intent. If its run did not finish (the store was down), the next
    // delivery resumes that same run rather than starting another.
    const run = async () => {
      const key = `stripe:payment:${pay.payment}`;
      const { event, duplicate } = await o.host.emit(EMITS, pay, { source: "connector:stripe", key, subject: `vyre://${o.host.space}/payment/${pay.payment}` });
      await o.host.settle();
      let { runs, bad } = await runsOf(event.id);
      if (duplicate && bad.length) {
        // the same event, the same run: finished steps are not repeated
        for (const r of bad) await o.host.flows.runner.retry(r.id);
        await o.host.settle();
        ({ runs, bad } = await runsOf(event.id));
      }
      if (bad.length) return { status: 500, body: { error: bad[0].error?.message ?? "the flow did not finish", event: event.id } };
      const steps = runs.flatMap((/** @type {any} */ r) => Object.entries(r.steps ?? {}).map(([id, st]) => ({ id, status: /** @type {any} */ (st).status })));
      return { status: 200, body: { event: event.id, duplicate, runs: runs.map((/** @type {any} */ r) => r.id), steps } };
    };
    const prior = inflight.get(pay.customer);
    const p = (prior ?? Promise.resolve()).then(run, run).finally(() => { if (inflight.get(pay.customer) === p) inflight.delete(pay.customer); });
    inflight.set(pay.customer, p);
    try { return await p; } catch (e) { return { status: 500, body: { error: String(/** @type {Error} */ (e).message).slice(0, 200) } }; }
  };
}
