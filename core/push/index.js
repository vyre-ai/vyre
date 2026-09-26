// @ts-check
// push — Web Push to the Deck and the Capsule on a phone or a laptop, for the moments the user
// is needed: a session asking permission, something held at the Gate, a watched thread, a
// proposed lesson. docs/adr/0011-web-push.md.
//
// What a notification carries is the least that can be useful: a kind, a fixed title, and the
// Deck path to open. Never draft content, a tool's input, a value or a name the user typed: a
// push crosses Google's, Mozilla's or Apple's servers, and the lock screen shows it to anyone
// holding the phone. The Deck fetches the details after the tap, over the user's own connection.
//
// The VAPID private key is made once, on first use, and put in the Vault (item `push-vapid`,
// granted to this module); only its public half lives in this module's table.

import crypto from "node:crypto";
import { vapidKeys, send } from "./webpush.js";

export const MIGRATIONS = [
  `CREATE TABLE push_devices (id TEXT PRIMARY KEY, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
     label TEXT, by TEXT, at INTEGER NOT NULL, expires INTEGER, last_ok INTEGER, fails INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE push_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
];

/** The push services browsers use. Anything else is refused: vyred must not POST to any URL a client names. */
const SERVICES = ["fcm.googleapis.com", "updates.push.services.mozilla.com", "push.apple.com", "notify.windows.com"];
const KEY_ITEM = "push-vapid";
const KINDS = ["ask", "draft", "watch", "lesson", "planner"];
const PEOPLE = ["cli", "local", "deck", "capsule"];

/**
 * What each event becomes. Titles are fixed words; the only variable part is an id in the path.
 * `loud` rings through quiet hours: an alarm or a timer the user set themselves (ADR 0025).
 * @type {Record<string, (e: any) => { kind: string, title: string, path: string, tag: string, actions?: string[], loud?: boolean } | null>}
 */
const NOTES = {
  "ask.raised": e => ({ kind: "ask", title: "A session is waiting for your answer", path: `/needs/${enc(e.payload.ask)}`, tag: `ask-${e.payload.ask}` }),
  "gate.held": e => ({ kind: "draft", title: "Something is waiting for your approval", path: `/needs/${enc(e.payload.id)}`, tag: `draft-${e.payload.id}` }),
  "thread.watched": e => ({ kind: "watch",
    title: e.payload.reason === "asked" ? "A thread you are watching is asking" : e.payload.reason === "stopped" ? "A thread you are watching stopped" : "A thread you are watching finished",
    path: `/threads/${enc(e.thread)}`, tag: `watch-${e.payload.watch}` }),
  "lesson.proposed": e => ({ kind: "lesson", title: "Vyre has a lesson for you to review", path: "/settings?section=lessons", tag: `lesson-${e.payload.lesson}` }),
  // Never the label the user typed: a fixed word per item kind, and the firing id as the tag, so
  // a second ring replaces the first on the device.
  "planner.fired": e => ({ kind: "planner", title: PLANNER_TITLES[e.payload.kind] || "Reminder", path: `/planner/${enc(e.payload.firing)}`,
    tag: `planner-${e.payload.firing}`, actions: ["done", "snooze"], loud: e.payload.kind === "alarm" || e.payload.kind === "timer" }),
};
const PLANNER_TITLES = /** @type {Record<string, string>} */ ({ alarm: "Alarm", timer: "Timer finished", reminder: "Reminder", event: "Starting soon", todo: "Todo due" });
const enc = v => encodeURIComponent(String(v ?? ""));

/**
 * Is it quiet now? Quiet hours are "HH:MM" to "HH:MM" in a time zone (the box's own by default),
 * and may run past midnight.
 * @param {{ start: string, end: string, timezone?: string } | null | undefined} q @param {number} [now]
 */
export function isQuiet(q, now = Date.now()) {
  if (!q || !q.start || !q.end) return false;
  const mins = s => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s)); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };
  const parts = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...(q.timezone ? { timeZone: q.timezone } : {}) }).formatToParts(new Date(now));
  const at = Number(parts.find(p => p.type === "hour")?.value) * 60 + Number(parts.find(p => p.type === "minute")?.value);
  const a = mins(q.start), b = mins(q.end);
  if ([a, b, at].some(Number.isNaN) || a === b) return false;
  return a < b ? at >= a && at < b : at >= a || at < b;
}

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const db = ctx.store.db;
    const opts = (ctx.config && ctx.config.push) || {};
    const subject = String(opts.subject || "https://vyre.sh");
    const hosts = [...SERVICES, ...(Array.isArray(opts.hosts) ? opts.hosts.map(String) : [])];
    const state = {
      get: k => { const r = /** @type {any} */ (db.prepare("SELECT value FROM push_state WHERE key = ?").get(k)); return r ? JSON.parse(String(r.value)) : undefined; },
      set: (k, v) => db.prepare("INSERT INTO push_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, JSON.stringify(v)),
    };
    const settings = () => ({ quiet: state.get("quiet") ?? null, kinds: { ...Object.fromEntries(KINDS.map(k => [k, true])), ...(state.get("kinds") || {}) } });

    /** The keypair: made once, the private half in the Vault. Held in memory once fetched. */
    let privateKey = null;
    const key = async () => {
      let pub = state.get("vapid_public");
      if (!pub) {
        const k = vapidKeys();
        const put = await ctx.call("vault.put", { name: KEY_ITEM, kind: "secret", description: "Web Push (VAPID) signing key, made by the push module",
          fields: { value: k.private, public: k.public }, grants: ["push"] });
        if (put.error) throw new Error(`push has no key yet: the vault did not take it (${put.error.message})`);
        state.set("vapid_public", k.public);
        privateKey = k.private;
        pub = k.public;
      }
      if (!privateKey) privateKey = String(await ctx.vault.fetch(KEY_ITEM));
      return { publicKey: String(pub), privateKey };
    };
    // Made on first use (push.key or a subscribe), not at start: a vyred nobody subscribes to
    // never touches the Vault for this.

    /** A subscription from a browser, checked before vyred ever sends to it. */
    const check = s => {
      if (!s || typeof s !== "object" || typeof s.endpoint !== "string" || !s.keys) throw new Error("give the browser's PushSubscription (endpoint and keys)");
      let u;
      try { u = new URL(s.endpoint); } catch { throw new Error("the endpoint is not a URL"); }
      const known = hosts.some(h => u.hostname === h || u.hostname.endsWith("." + h));
      if (!known) throw new Error(`${u.hostname} is not a push service vyred sends to`);
      if (u.protocol !== "https:" && !(opts.allow_http && u.protocol === "http:")) throw new Error("a push endpoint must be https");
      const p = Buffer.from(String(s.keys.p256dh || ""), "base64url"), a = Buffer.from(String(s.keys.auth || ""), "base64url");
      if (p.length !== 65 || p[0] !== 4 || a.length !== 16) throw new Error("the subscription's keys are not a P-256 key and a 16-byte secret");
      return { endpoint: s.endpoint, p256dh: String(s.keys.p256dh), auth: String(s.keys.auth), expires: typeof s.expirationTime === "number" ? s.expirationTime : null };
    };

    /** Send one message to every device (or one), dropping those the service says are gone. */
    const deliver = async (message, only = null) => {
      const k = await key();
      const devices = /** @type {any[]} */ (db.prepare(`SELECT * FROM push_devices ${only ? "WHERE id = ?" : ""}`).all(...(only ? [only] : [])));
      const out = { sent: 0, failed: 0, dropped: 0 };
      await Promise.all(devices.map(async d => {
        if (d.expires && d.expires < Date.now()) { db.prepare("DELETE FROM push_devices WHERE id = ?").run(d.id); out.dropped++; return; }
        const r = await send({ endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth } }, message,
          { privateKey: k.privateKey, publicKey: k.publicKey, subject, urgency: ["ask", "draft", "planner"].includes(message.kind) ? "high" : "normal" });
        if (r.gone) { db.prepare("DELETE FROM push_devices WHERE id = ?").run(d.id); out.dropped++; return; }
        if (r.ok) { db.prepare("UPDATE push_devices SET last_ok = ?, fails = 0 WHERE id = ?").run(Date.now(), d.id); out.sent++; }
        else { db.prepare("UPDATE push_devices SET fails = fails + 1 WHERE id = ?").run(d.id); out.failed++; ctx.log(`push to device ${d.id} failed (${r.status || "network"})`); }
      }));
      return out;
    };

    const offs = Object.entries(NOTES).map(([type, make]) => ctx.events.on(type, async e => {
      try {
        const made = make(e);
        if (!made) return;
        const { loud, ...n } = made;
        const s = settings();
        if (!s.kinds[n.kind] || (!loud && isQuiet(s.quiet))) return;
        if (!db.prepare("SELECT 1 FROM push_devices LIMIT 1").get()) return;
        await deliver({ ...n, at: Date.now() });
      } catch (err) { ctx.log(`push: ${/** @type {Error} */ (err).message}`); }
    }));

    const tool = (name, description, input, run) => ctx.tool(name, { description, input, run, callers: PEOPLE });
    const str = { type: "string" };

    tool("push.key", "The public key a browser subscribes with (applicationServerKey, base64url).",
      { type: "object", properties: {} },
      async () => ({ public_key: (await key()).publicKey }));

    tool("push.subscribe", "Keep this browser's PushSubscription, so the moments you are needed reach this device. Returns the device id.",
      { type: "object", required: ["subscription"], properties: { subscription: { type: "object" }, label: str } },
      async (i, { caller }) => {
        const s = check(i.subscription);
        const id = crypto.createHash("sha256").update(s.endpoint).digest("base64url").slice(0, 12);
        db.prepare(`INSERT INTO push_devices (id, endpoint, p256dh, auth, label, by, at, expires) VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, label = COALESCE(excluded.label, push_devices.label),
          expires = excluded.expires, fails = 0`).run(id, s.endpoint, s.p256dh, s.auth, i.label ? String(i.label).slice(0, 80) : null, String(caller), Date.now(), s.expires);
        return { device: id };
      });

    tool("push.unsubscribe", "Forget a device: by its id, or by the subscription's endpoint.",
      { type: "object", properties: { device: str, endpoint: str } },
      async i => {
        if (!i.device && !i.endpoint) throw new Error("give device or endpoint");
        const r = i.device ? db.prepare("DELETE FROM push_devices WHERE id = ?").run(i.device) : db.prepare("DELETE FROM push_devices WHERE endpoint = ?").run(i.endpoint);
        return { removed: Number(r.changes) > 0 };
      });

    tool("push.devices", "The devices that get notifications: id, label, push service, when added, last delivered. Never the endpoint or keys.",
      { type: "object", properties: {} },
      async () => /** @type {any[]} */ (db.prepare("SELECT * FROM push_devices ORDER BY at").all()).map(d => ({
        device: d.id, label: d.label, service: new URL(d.endpoint).hostname, at: d.at, last_ok: d.last_ok, fails: d.fails })));

    tool("push.settings", "Quiet hours ({start: \"22:00\", end: \"07:00\", timezone?}, or null for none) and which kinds notify (ask, draft, watch, lesson, planner). With no input, the current settings.",
      { type: "object", properties: { quiet: { anyOf: [{ type: "object" }, { type: "null" }] }, kinds: { type: "object" } } },
      async i => {
        if (i.quiet !== undefined) {
          const q = i.quiet;
          if (q !== null && !(/^\d{1,2}:\d{2}$/.test(String(q.start)) && /^\d{1,2}:\d{2}$/.test(String(q.end)))) throw new Error("quiet hours are {start: \"HH:MM\", end: \"HH:MM\"}");
          if (q && q.timezone) { try { new Intl.DateTimeFormat("en", { timeZone: String(q.timezone) }); } catch { throw new Error(`${q.timezone} is not a time zone`); } }
          state.set("quiet", q ? { start: String(q.start), end: String(q.end), ...(q.timezone ? { timezone: String(q.timezone) } : {}) } : null);
        }
        if (i.kinds) {
          const bad = Object.keys(i.kinds).filter(k => !KINDS.includes(k));
          if (bad.length) throw new Error(`no such kind: ${bad.join(", ")} (kinds: ${KINDS.join(", ")})`);
          state.set("kinds", { ...(state.get("kinds") || {}), ...Object.fromEntries(Object.entries(i.kinds).map(([k, v]) => [k, Boolean(v)])) });
        }
        return { ...settings(), quiet_now: isQuiet(settings().quiet) };
      });

    tool("push.test", "Send a test notification to every device, or one. Ignores quiet hours.",
      { type: "object", properties: { device: str } },
      async i => deliver({ kind: "test", title: "Vyre can reach this device", path: "/settings", tag: "test", at: Date.now() }, i.device || null));

    return { async stop() { for (const off of offs) { try { off(); } catch {} } } };
  },
};
