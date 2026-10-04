// @ts-check
// push: Web Push to the Deck and the Capsule on a phone or a laptop, for the moments the user
// is needed: a session asking permission, something held at the Gate, a watched thread, a
// planner ring. docs/adr/0011-web-push.md.
//
// A push is for "needs you" only, and never while you are at a screen: a surface calls
// push.seen when it is shown, when it is hidden, and on the first input after a minute of none.
// An ask, a draft or a watch that arrives within HOLD_MS of that waits until HOLD_MS after it,
// and is dropped if it is answered or resolved meanwhile. Planner rings always push at once.
//
// What a notification carries is the least that can be useful: a kind, a fixed title, and the
// Deck path to open. Never draft content, a tool's input, a value or a name the user typed: a
// push crosses Google's, Mozilla's or Apple's servers, and the lock screen shows it to anyone
// holding the phone. The Deck fetches the details after the tap, over the user's own connection.
// One exception, the user's to make: push.settings planner_label (off by default) puts a planner
// item's own words on the lock screen as the notification's body.
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
const KINDS = ["ask", "draft", "watch", "lesson", "planner", "goal", "proactive", "notice"];
const PEOPLE = ["cli", "local", "deck", "capsule", "tailnet", "device", "space", "agent"];
/** Kinds on until switched off. A lesson is not "needs you", so it is off until switched on. */
const DEFAULT_KINDS = { ask: true, draft: true, watch: true, lesson: false, planner: true, goal: true, proactive: true, notice: true };
/** The kinds nobody asked for in the moment: they share one daily budget (assistant.chattiness, default 3).
 * Not ask (a session is blocked on the person) and not planner (a reminder the person set). */
const CAPPED = new Set(["draft", "watch", "lesson", "goal", "proactive"]);
const CHATTINESS_DEFAULT = 3;
/** The kinds that wait while a screen is in use. */
const HELD = new Set(["ask", "draft", "watch"]);
const HOLD_MS = 180_000;
const PENDING_MAX = 200;
/** What ends a held moment before it is sent: the event, and the tag the note used. */
const RESOLVES = {
  "ask.answered": e => `ask-${e.payload.ask}`,
  "gate.released": e => `draft-${e.payload.id}`,
  "gate.rejected": e => `draft-${e.payload.id}`,
  "gate.revised": e => `draft-${e.payload.id}`,
  "gate.failed": e => `draft-${e.payload.id}`,
};
/** A receipt from push.test is good this long, and only the newest few are kept. */
const RECEIPT_MS = 10 * 60_000;
const RECEIPTS_MAX = 50;
/** push.seen from an installed app tells the box once per surface in this long. */
const SEEN_EVENT_MS = 10 * 60_000;

/** An error with a code the registry passes through to the caller. */
function fail(code, message) {
  const e = /** @type {Error & { code?: string }} */ (new Error(message));
  e.code = code;
  return e;
}

/** For tests only: the clock and the hold. */
export const testHooks = { now: () => Date.now(), holdMs: HOLD_MS };

/**
 * What each event becomes. Titles are fixed words; the only variable part is an id in the path.
 * `loud` rings through quiet hours: an alarm or a timer the user set themselves (ADR 0025).
 * @type {Record<string, (e: any, s: any) => { kind: string, title: string, path: string, tag: string, body?: string, actions?: string[], loud?: boolean } | null>}
 */
export const NOTES = {
  "ask.raised": e => ({ kind: "ask", title: "A session is waiting for your answer", path: `/needs/${enc(e.payload.ask)}`, tag: `ask-${e.payload.ask}` }),
  "gate.held": e => ({ kind: "draft", title: "Something is waiting for your approval", path: `/needs/${enc(e.payload.id)}`, tag: `draft-${e.payload.id}` }),
  "thread.watched": e => ({ kind: "watch",
    title: e.payload.reason === "asked" ? "A thread you are watching is asking" : e.payload.reason === "stopped" ? "A thread you are watching stopped" : "A thread you are watching finished",
    path: `/threads/${enc(e.thread)}`, tag: `watch-${e.payload.watch}` }),
  "lesson.proposed": e => ({ kind: "lesson", title: "Vyre has a lesson for you to review", path: "/settings?section=lessons", tag: `lesson-${e.payload.lesson}` }),
  // A fixed word per item kind, and the ring's key as the tag (planner-<item>-<due>), so a second
  // ring replaces the first, and a device that rang it from its own schedule shows it once (ADR
  // 0029, R6). item and due (seconds) ride along. The label the user typed only when they turned
  // planner_label on.
  "planner.fired": (e, s) => ({ kind: "planner", title: PLANNER_TITLES[e.payload.kind] || "Reminder", path: `/planner/${enc(e.payload.firing)}`,
    tag: plannerTag(e.payload), item: String(e.payload.item ?? ""), due: Math.floor(Number(e.payload.due) / 1000),
    actions: ["done", "snooze"], loud: e.payload.kind === "alarm" || e.payload.kind === "timer",
    ...(s.planner_label && e.payload.title ? { body: String(e.payload.title).slice(0, 120) } : {}) }),
  // core/goals: a milestone landing, or the last one landing (the goal itself done). One push
  // per event, no escalation (unlike planner's rings) - a milestone does not need answering.
  "goal.milestone": e => ({ kind: "goal", title: "A milestone is done", path: `/goals/${enc(e.payload.goal)}`,
    tag: `goal-milestone-${e.payload.goal}-${e.payload.index}`, body: String(e.payload.text || "").slice(0, 120) }),
  // Any proactive source (the assistant, watchers, duties) files one push through this event.
  // The title is a fixed sentence the source wrote, never model text; over the daily budget it is dropped.
  "push.proactive": e => ({ kind: "proactive", title: String(e.payload.title || "Something needs a look").slice(0, 120),
    path: String(e.payload.path || "/needs").slice(0, 200), tag: String(e.payload.tag || `proactive-${Date.now()}`).slice(0, 100) }),
  // An agent loosened a guard because the person asked (core/settings, settings.loosened): a notice, not an ask. It is
  // not counted in the daily budget and rings through quiet hours; the title is one fixed sentence around the setting's
  // own label (never model text), and the path opens that change, whose Undo needs no proof.
  "settings.loosened": e => ({ kind: "notice", title: `${String(e.payload.label || "A setting").slice(0, 80)} changed, as you asked. Undo`,
    path: `/settings?change=${enc(e.payload.change)}`, tag: `settings-loosened-${e.payload.change}`, loud: true }),
  // core/spaces: the person's identity list changed (a new device, a recovery by the code or by contacts, a removal). Every device that sees
  // it (each asks the directory for the list, spaces.identity.sync) rings its own push devices at once, through quiet hours and outside the
  // daily budget, with a one-tap Remove. The words are fixed; the path carries only an entry id, which is a hash of a public key.
  "identity.entry-added": e => ({ kind: "notice", title: "A new sign-in was added to your identity. Remove it if it was not you",
    path: `/settings?section=identity&remove=${enc(e.payload.eid || (e.payload.entry && e.payload.entry.eid))}`, tag: `identity-entry-${e.payload.seq}-${e.payload.eid || (e.payload.entry && e.payload.entry.eid) || ""}`, actions: ["remove"], loud: true }),
  "identity.recovered": e => ({ kind: "notice", title: "Your identity was recovered on a new device. Remove it if it was not you",
    path: "/settings?section=identity", tag: `identity-recovered-${e.payload.seq}`, actions: ["remove"], loud: true }),
  "identity.device-removed": e => ({ kind: "notice", title: "A device was removed from your identity", path: "/settings?section=identity", tag: `identity-removed-${e.payload.eid}`, loud: true }),
  "goal.done": e => ({ kind: "goal", title: "A goal is done", path: `/goals/${enc(e.payload.goal)}`, tag: `goal-done-${e.payload.goal}` }),
};
const PLANNER_TITLES = /** @type {Record<string, string>} */ ({ alarm: "Alarm", timer: "Timer finished", reminder: "Reminder", event: "Starting soon", todo: "Todo due" });
const enc = v => encodeURIComponent(String(v ?? ""));
/** The planner's ring key, or the firing id from a planner that predates keys. */
const plannerTag = p => String(p.key || `planner-${p.firing}`);

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
    const settings = () => ({ quiet: state.get("quiet") ?? null, kinds: { ...DEFAULT_KINDS, ...(state.get("kinds") || {}), notice: true },
      planner_label: Boolean(state.get("planner_label")) });

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

    /** Planner firings pushed since start, so an ack elsewhere can close them; the newest 500. */
    const rung = new Set();
    /** When a person last used a screen (push.seen), in memory only: a restart forgets it. */
    let lastUse = 0;
    /** Held moments by tag, oldest first, and the one timer that sends them. */
    const pending = new Map();
    /** @type {NodeJS.Timeout | null} */
    let timer = null;
    const arm = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (!pending.size) return;
      timer = setTimeout(flush, Math.max(0, lastUse + testHooks.holdMs - testHooks.now()));
      timer.unref();
    };
    /** The budget: how many capped pushes today, in the person's day (the quiet-hours zone, else the box's). */
    const dayKey = () => new Intl.DateTimeFormat("en-CA", { ...(settings().quiet?.timezone ? { timeZone: settings().quiet.timezone } : {}) }).format(new Date(testHooks.now()));
    const cap = async () => {
      const r = await ctx.call("settings.get", { key: "assistant.chattiness" }).catch(() => null);
      const v = r && !r.error && r.data ? Number(r.data.value) : NaN;
      return Number.isInteger(v) && v >= 0 ? v : CHATTINESS_DEFAULT;
    };
    /** Sends now what may go: kinds, quiet hours, the daily budget and a device, checked when it is sent. */
    const post = async (n, loud = false) => {
      const s = settings();
      if (!s.kinds[n.kind] || (!loud && isQuiet(s.quiet, testHooks.now()))) return;
      if (!db.prepare("SELECT 1 FROM push_devices LIMIT 1").get()) return;
      if (CAPPED.has(n.kind) && !loud) {
        // Read the limit first: the count is then read and written with no await between, so
        // pushes arriving together cannot each see room that the others took.
        const limit = await cap();
        const day = dayKey(), used = state.get("sent")?.day === day ? state.get("sent").n : 0;
        if (used >= limit) {
          // Over budget: no push. The item is already in waiting and the glance; say so once.
          ctx.events.emit("push.capped", { kind: n.kind, tag: n.tag, day });
          return;
        }
        state.set("sent", { day, n: used + 1 });
      }
      await deliver({ ...n, at: Date.now() });
    };
    async function flush() {
      timer = null;
      if (testHooks.now() - lastUse < testHooks.holdMs) return arm();
      const due = [...pending.values()];
      pending.clear();
      for (const n of due) { try { await post(n); } catch (err) { ctx.log(`push: ${/** @type {Error} */ (err).message}`); } }
    }
    const offs = Object.entries(NOTES).map(([type, make]) => ctx.events.on(type, async e => {
      try {
        const s = settings();
        const made = make(e, s);
        if (!made) return;
        const { loud, ...n } = made;
        if (!s.kinds[n.kind] || (!loud && isQuiet(s.quiet, testHooks.now()))) return;
        if (!db.prepare("SELECT 1 FROM push_devices LIMIT 1").get()) return;
        if (HELD.has(n.kind) && testHooks.now() - lastUse < testHooks.holdMs) {
          pending.delete(n.tag);
          pending.set(n.tag, n);
          while (pending.size > PENDING_MAX) pending.delete(pending.keys().next().value);
          if (!timer) arm();
          return;
        }
        if (type === "planner.fired") { rung.add(String(e.payload.firing)); if (rung.size > 500) rung.delete(rung.values().next().value); }
        await post(n, loud);
      } catch (err) { ctx.log(`push: ${/** @type {Error} */ (err).message}`); }
    }));
    // Answered or resolved on a screen before it went out: it never goes out.
    for (const [type, tagOf] of Object.entries(RESOLVES)) {
      offs.push(ctx.events.on(type, e => {
        if (!pending.delete(tagOf(e))) return;
        if (!pending.size && timer) { clearTimeout(timer); timer = null; }
      }));
    }
    // Done or Snooze on one device (or the Deck, the Capsule, a deletion) closes the notification on
    // the others: a push with only a kind and the tag, and nothing to show.
    offs.push(ctx.events.on("planner.acked", async e => {
      try {
        // A ring the box never rang (answered on a device that rang it on its own) is on the
        // other devices' schedules too, so it is cleared the same way.
        const f = String(e.payload.firing || "");
        if (!(rung.delete(f) || e.payload.unrung) || !settings().kinds.planner) return;
        await deliver({ kind: "planner-ack", tag: plannerTag(e.payload), at: Date.now() });
      } catch (err) { ctx.log(`push: ${/** @type {Error} */ (err).message}`); }
    }));

    /** push.test receipts not yet posted back: nonce -> { device, at }, in memory, the newest RECEIPTS_MAX. */
    const receipts = new Map();
    /** When each surface last emitted push.seen. */
    const seenEvents = new Map();

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
        // The push service's name only: never the endpoint or the keys.
        const row = /** @type {any} */ (db.prepare("SELECT label FROM push_devices WHERE id = ?").get(id));
        ctx.events.emit("push.subscribed", { device: id, label: row ? row.label : null, service: new URL(s.endpoint).hostname });
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

    tool("push.settings", "Quiet hours ({start: \"22:00\", end: \"07:00\", timezone?}, or null for none), which kinds notify (ask, draft, watch, lesson, planner; lesson is off by default), and planner_label: show a planner item's own words on the lock screen (off by default). With no input, the current settings.",
      { type: "object", properties: { quiet: { anyOf: [{ type: "object" }, { type: "null" }] }, kinds: { type: "object" }, planner_label: { type: "boolean" } } },
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
          // A notice says a guard was loosened as asked: nobody, the person included, switches it off here.
          if ("notice" in i.kinds) throw new Error("notice cannot be turned off: it says a guard was loosened as you asked");
          state.set("kinds", { ...(state.get("kinds") || {}), ...Object.fromEntries(Object.entries(i.kinds).map(([k, v]) => [k, Boolean(v)])) });
        }
        if (i.planner_label !== undefined) state.set("planner_label", Boolean(i.planner_label));
        return { ...settings(), quiet_now: isQuiet(settings().quiet) };
      });

    tool("push.seen", "A person is using this screen: call it when the screen is shown, when it is hidden, and on the first input after a minute of none. Asks, drafts and watches wait until 3 minutes after the last call; planner rings do not. standalone: the app runs installed (emits push.seen at most once per surface in 10 minutes). device: this screen's push device id (push.subscribe's answer), carried in the event.",
      { type: "object", properties: { surface: { type: "string", maxLength: 80 }, visible: { type: "boolean" }, standalone: { type: "boolean" }, device: { type: "string", maxLength: 40 } } },
      async i => {
        if (i.surface !== undefined && String(i.surface).length > 80) throw new Error("surface is at most 80 characters");
        if (i.device !== undefined && (typeof i.device !== "string" || i.device.length > 40)) throw new Error("device is a string of at most 40 characters");
        lastUse = testHooks.now();
        if (i.standalone === true) {
          const surface = i.surface === undefined ? "" : String(i.surface);
          const last = seenEvents.get(surface);
          if (last === undefined || lastUse - last >= SEEN_EVENT_MS) {
            seenEvents.delete(surface);
            seenEvents.set(surface, lastUse);
            while (seenEvents.size > RECEIPTS_MAX) seenEvents.delete(seenEvents.keys().next().value);
            ctx.events.emit("push.seen", { surface: surface || null, standalone: true, ...(i.device ? { device: i.device } : {}) });
          }
        }
        return { ok: true };
      });

    tool("push.test", "Send a test notification to every device, or one. Ignores quiet hours. receipt: true puts a one-time receipt in it, which the device posts back (push.receipt) once it is shown.",
      { type: "object", properties: { device: str, receipt: { type: "boolean" } } },
      async i => {
        const message = { kind: "test", title: "Vyre can reach this device", path: "/settings", tag: "test", at: Date.now() };
        if (i.receipt !== true) return deliver(message, i.device || null);
        const now = testHooks.now();
        for (const [k, v] of receipts) if (now - v.at >= RECEIPT_MS) receipts.delete(k);
        const nonce = crypto.randomBytes(9).toString("base64url");
        receipts.set(nonce, { device: i.device ? String(i.device) : null, at: now });
        while (receipts.size > RECEIPTS_MAX) receipts.delete(receipts.keys().next().value);
        return { ...(await deliver({ ...message, receipt: nonce }, i.device || null)), receipt: nonce };
      });

    tool("push.receipt", "A device showed a test notification: post back its receipt. Known once, for 10 minutes; anything else is unknown_receipt.",
      { type: "object", required: ["receipt"], properties: { receipt: { type: "string", maxLength: 64 } } },
      async i => {
        const nonce = String(i.receipt ?? "");
        const r = receipts.get(nonce);
        // One answer for "never made", "used" and "expired": the tool tells nothing else.
        if (!r || testHooks.now() - r.at >= RECEIPT_MS) { receipts.delete(nonce); throw fail("unknown_receipt", "no such receipt"); }
        receipts.delete(nonce);
        ctx.events.emit("push.delivered", { receipt: nonce, device: r.device });
        return { ok: true };
      });

    return {
      async stop() {
        for (const off of offs) { try { off(); } catch {} }
        if (timer) { clearTimeout(timer); timer = null; }
        pending.clear();
        receipts.clear();
        seenEvents.clear();
      },
      /** For tests: what is held, and whether a timer runs. */
      held: () => ({ pending: [...pending.keys()], timer: Boolean(timer) }),
    };
  },
};
