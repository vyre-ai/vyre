// @ts-check
// wink: pairing as grants (spec: team/0.3/SPEC-wink-network.md section 6; DESIGN-wink.md section 4). Every way into a space is a Wink: a code
// or a scan on one device, a card on the other, and then exactly one grant (kernel/contracts/grant.d.ts) and a handful of events. There is no
// hidden way in. This module owns the flows on a box:
//
//   Add a computer or phone   wink.code.open   a typed code (two-sided: the PAKE of relay/client/code.js, then the person types back the code
//                                              the new device shows, wink.code.ack); the ring (QR) path is the existing pairing window and
//                                              this module writes its grant and events too (device.paired, device.removed).
//   Invite a person           wink.invite      a Wink ticket with the offer sealed into it; the invited person's redemption becomes a membership
//                                              grant here (a sensitive role waits for the admin's approval).
//   Share a computer          wink.share       lend one of my computers to my own space: a node.host grant with limits.
//   See and remove            wink.access / wink.remove   every grant as a card with its last use; one removal does all of it.
//
// What this module does not do: the network. Joining a network (the control plane, the Wink core) is core/wink/control and core/wink/node,
// which this module will hand a one-time key to after the confirm; until they are wired, the relay path carries everything, which is correct.
// Everything user-facing is worded by cards.js (team/0.3/wink-copy.md). The code on screen is a secret: it is returned by the tool that
// opened it and never put on the event bus.

import crypto from "node:crypto";
import { createWinkCode } from "./code.js";
import { createGrants, MIGRATIONS as GRANT_MIGRATIONS, spaceIdOf, timeId, base32 } from "./grants.js";
import { card, removal, removed } from "./cards.js";
import { createPairing, MIGRATIONS as DEVICE_MIGRATIONS, FLOW_KIND, ownDirectory } from "./pairing.js";
import { createStorageDevices, registerStorageTools, MIGRATIONS as STORAGE_MIGRATIONS } from "./storage/index.js";
import { storageGrants } from "./storage/grants.js";
import { seedFromKey } from "../../relay/client/join.js";

const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });
const OFFER_TTL = 5 * 60_000;
const INVITE_TTL_DAYS = 7;
const ROLES = new Set(["member", "contributor", "guest", "admin"]);
const SENSITIVE_ROLES = new Set(["admin"]);
const sha = (/** @type {string} */ s) => crypto.createHash("sha256").update(s).digest();
const obj = (/** @type {any} */ props = {}, /** @type {string[]} */ required = []) => ({ type: "object", properties: props, ...(required.length ? { required } : {}) });
const str = { type: "string" };

/** The owner's own surfaces only: never an agent, a guest, a hook or an anonymous caller. @param {any} meta @param {string} what */
function owner(meta, what) {
  const c = String((meta && meta.caller) || "");
  if (!c || (meta && meta.agent) || /^(anonymous|hook)$/.test(c) || c.startsWith("tailnet-guest:") || c.startsWith("agent:") || c.startsWith("tailnet:agent:") || c.startsWith("space:") || c.startsWith("org:"))
    throw fail("denied", `${what} is the owner's`);
}

/** @param {{ ports?: import("./pairing.js").Ports, directory?: import("./pairing.js").Directory }} [inject] @returns {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export function createWink(inject = {}) {
  return {
  async start(ctx) {
    if (ctx.config.role !== "box") return { async stop() {} };
    const now = () => Date.now();
    ctx.store.migrate([
      `CREATE TABLE wink_offers (id TEXT PRIMARY KEY, flow TEXT NOT NULL, via TEXT NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, body TEXT NOT NULL)`,
      `CREATE INDEX wink_offers_state ON wink_offers (state, expires)`,
      ...GRANT_MIGRATIONS,
      ...DEVICE_MIGRATIONS,
      ...STORAGE_MIGRATIONS,
    ]);
    const db = ctx.store.db;
    let routeId = "";
    const ensureRoute = async () => {
      if (routeId) return routeId;
      const r = /** @type {any} */ (await ctx.call("relay.route.id", {}));
      if (!r || !r.data || !r.data.route) throw fail("unavailable", "this server has no relay route yet; turn the relay on first");
      routeId = String(r.data.route);
      return routeId;
    };
    const spaceId = async () => spaceIdOf(await ensureRoute());
    let spaceCache = "";
    // The table is made at start; the space is known once the relay has a route, and every grant call asks for it first.
    const grantsStore = createGrants({ ctx, space: () => spaceCache, now });
    const grants = async () => { spaceCache = await spaceId(); return grantsStore; };
    const actor = async (/** @type {"person" | "device"} */ kind, /** @type {string} */ id) => ({ kind, id, space: await spaceId() });
    const owner0 = async () => actor("person", `per_${base32(sha(`person\n${await ensureRoute()}`), 26)}`);

    // ---- offers: what is on screen right now, never a secret ----
    /** @param {string} flow @param {string} via @param {any} body @param {number} [ttl] */
    const newOffer = (flow, via, body, ttl = OFFER_TTL) => {
      const id = timeId("wo_", now());
      db.prepare("INSERT INTO wink_offers (id, flow, via, state, created, expires, body) VALUES (?, ?, ?, 'offered', ?, ?, ?)").run(id, flow, via, now(), now() + ttl, JSON.stringify(body));
      return id;
    };
    const readOffer = (/** @type {string} */ id) => {
      const r = /** @type {any} */ (db.prepare("SELECT * FROM wink_offers WHERE id = ?").get(String(id)));
      return r ? { id: r.id, flow: r.flow, via: r.via, state: r.state, created: r.created, expires: r.expires, ...JSON.parse(r.body) } : null;
    };
    const writeOffer = (/** @type {string} */ id, /** @type {string} */ state, /** @type {any} */ patch) => {
      const cur = readOffer(id);
      if (!cur) return null;
      const { id: _i, flow: _f, via: _v, state: _s, created: _c, expires: _e, ...body } = cur;
      db.prepare("UPDATE wink_offers SET state = ?, body = ? WHERE id = ?").run(state, JSON.stringify({ ...body, ...(patch || {}) }), id);
      return readOffer(id);
    };
    const sweep = () => {
      for (const r of /** @type {any[]} */ (db.prepare("SELECT id FROM wink_offers WHERE state IN ('offered', 'found', 'joining', 'pending') AND expires <= ?").all(now()))) {
        writeOffer(r.id, "expired", {});
        ctx.events.emit("wink.expired", { offer: r.id });
      }
    };
    const publicOffer = (/** @type {any} */ o) => {
      if (!o) return null;
      const { pick: _p, ticket: _t, ...rest } = o;
      return rest;
    };

    // ---- the typed code (two-sided) ----
    /** @type {any} */
    let code = null;
    /** @type {string | null} */
    let codeOffer = null;
    /** The code on screen, only ever returned to the person who opened it. @type {{ code: string, expires: number } | null} */
    let shown = null;
    const busName = (/** @type {string} */ n) => (n.startsWith("wink.code.") ? `wink.code-${n.slice("wink.code.".length)}` : n);
    const ensureCode = async () => {
      if (code) return code;
      const route = await ensureRoute();
      code = createWinkCode({
        route, twoSided: true, level: 2,
        allocate: async () => { const r = /** @type {any} */ (await ctx.call("relay.code.alloc", {})); return r && r.data ? r.data : null; },
        release: () => { void ctx.call("relay.code.release", {}); },
        emit: (name, data) => {
          if (name === "wink.code.opened" || name === "wink.code.replaced") { shown = { code: data.code, expires: data.expires }; const { code: _c, rv: _r, ...rest } = data; ctx.events.emit(busName(name), { offer: codeOffer, ...rest }); return; }
          if (name === "wink.code.closed") { shown = null; ctx.events.emit(busName(name), { offer: codeOffer, ...data }); return; }
          if (name === "wink.code.ack" && codeOffer) { writeOffer(codeOffer, "found", { pick: data.id }); ctx.events.emit("wink.found", { offer: codeOffer }); }
          ctx.events.emit(busName(name), { offer: codeOffer, ...data });
        },
      });
      return code;
    };
    // A typing device's PAKE message arrives from the relay as an internal event; the answer goes back the same way.
    const offCode = ctx.events.on("relay.code-asked", async (/** @type {any} */ e) => {
      const m = e.payload || e;
      if (!code) return;
      let out = null;
      try { out = code.handle({ rv: String(m.rv), s: String(m.s), n: Number(m.n), m: String(m.m) }); } catch {}
      await ctx.call("relay.code.reply", { q: String(m.q), ...(out ? { m: out.m } : {}) });
    });

    /** Opens (or replaces) the showing code for one flow. @param {"W1" | "W2" | "W3"} flow */
    const openCode = async flow => {
      sweep();
      const c = await ensureCode();
      if (codeOffer) { const prev = readOffer(codeOffer); if (prev && ["offered", "found"].includes(prev.state)) writeOffer(codeOffer, "closed", {}); }
      codeOffer = newOffer(flow, "code", {});
      const made = await c.open();
      if (!made) { writeOffer(codeOffer, "closed", {}); throw fail("unavailable", "Can't connect. Check your internet connection. Nothing was lost."); }
      shown = { code: made.code, expires: made.expires };
      writeOffer(codeOffer, "offered", {});
      ctx.events.emit("wink.offered", { offer: codeOffer, flow, via: "code", expires: made.expires });
      return { offer: codeOffer, code: made.code, expires: made.expires };
    };
    /** The person typed back the code the other device shows. @param {string} offerId @param {string} typed */
    const ackOffer = async (offerId, typed) => {
      sweep();
      const o = readOffer(String(offerId));
      if (!o || o.via !== "code" || o.state !== "found" || !o.pick || !code) throw fail("not_found", "no device is waiting to be added with that offer");
      const r = await code.ack(o.pick, String(typed));
      if (!r.ok) { writeOffer(o.id, "closed", { why: "wrong_code" }); ctx.events.emit("wink.declined", { offer: o.id, why: "wrong_code" }); return { ok: false }; }
      // Both ends hold the same key: the ticket's seed is derived from it, so the relay never sees it and nothing else is carried.
      const seed = Buffer.from(seedFromKey(r.key)).toString("base64url");
      const t = /** @type {any} */ (await ctx.call("relay.ticket.mint", { seed }));
      if (!t || t.error) { writeOffer(o.id, "closed", { why: "relay" }); throw fail("unavailable", "Can't connect. Check your internet connection. Nothing was lost."); }
      writeOffer(o.id, "joining", { pick: null });
      ctx.events.emit("wink.confirmed", { offer: o.id });
      return { ok: true };
    };

    ctx.tool("wink.code.open", {
      description: "Show a Wink code for a new computer or server to type (two-sided: the new device then shows a code to type back here, wink.code.ack). Answers { offer, code, expires }. The code is a secret: it is returned here and never put on the event bus.",
      input: obj({ flow: { type: "string", enum: ["W1", "W2", "W3"] } }),
      presence: { summary: async () => "Show a code to add a new device to this server" },
      run: async (input, meta = {}) => { owner(meta, "adding a device"); return openCode(input.flow || "W2"); },
    });

    ctx.tool("wink.code.status", {
      description: "The code that is showing now, if any: { offer, code, expires, state }. The screen that opened it asks again after a replacement (a closed code is replaced with no tap).",
      input: obj(),
      run: async (_, meta = {}) => {
        owner(meta, "the Wink code");
        sweep();
        const s = code ? code.status() : null;
        return { offer: codeOffer, ...(s ? { code: s.code, expires: s.expires } : { code: null }), state: codeOffer ? (readOffer(codeOffer) || {}).state || null : null };
      },
    });

    ctx.tool("wink.code.ack", {
      description: "Type back the code the new device is showing. One try per code: the right one adds the device and uses the code up, a wrong one closes the code and a new one is showing. Answers { ok }.",
      input: obj({ offer: str, typed: str }, ["offer", "typed"]),
      presence: { summary: async () => "Add this device to your server" },
      run: async (input, meta = {}) => { owner(meta, "adding a device"); return ackOffer(input.offer, input.typed); },
    });

    ctx.tool("wink.cancel", {
      description: "Close an offer that has not been used: its code or invitation stops working. Answers { cancelled }.",
      input: obj({ offer: str }, ["offer"]),
      run: async (input, meta = {}) => {
        owner(meta, "cancelling an offer");
        const o = readOffer(String(input.offer));
        if (!o) throw fail("not_found", "no such offer");
        if (["done", "closed", "expired", "declined"].includes(o.state)) return { cancelled: false };
        if (o.via === "code" && codeOffer === o.id && code) code.cancel();
        writeOffer(o.id, "closed", { why: "cancelled" });
        ctx.events.emit("wink.declined", { offer: o.id, why: "cancelled" });
        return { cancelled: true };
      },
    });

    // ---- pairing: devices belong to the identity (pairing.js) ----
    const owner1 = async () => (await owner0()).id;
    const pairing = createPairing({
      ctx, now, identity: owner1, space: spaceId, openCode, ack: ackOffer, owner,
      directory: inject.directory || ownDirectory({ identity: owner1, space: spaceId, name: () => String(ctx.config.name || "this space") }),
      ports: inject.ports,
      relayUrl: async () => { const r = /** @type {any} */ (await ctx.call("relay.status", {})); return String((r && r.data && r.data.url) || (ctx.config.relay && ctx.config.relay.url) || ""); },
    });
    pairing.tools();
    // A device that paired (a typed code, or the ring) is registered under the identity with its kind. No grant is written in any space.
    const registerDevice = async (/** @type {any} */ p) => {
      const identity = await owner1();
      const open = /** @type {any} */ (db.prepare("SELECT id FROM wink_offers WHERE via = 'code' AND state = 'joining' ORDER BY created DESC LIMIT 1").get());
      const o = open ? readOffer(open.id) : null;
      // A typed-code join says which flow made it; a ring (QR) pairing is Add a phone (W1).
      const flow = o ? o.flow : "W1";
      const kind = /** @type {any} */ (FLOW_KIND)[flow] || "computer";
      const existing = pairing.devices.get(String(p.id));
      if (existing && !existing.removed) return existing;
      const dev = pairing.devices.add({ id: String(p.id), identity, kind, name: String(p.name || "a device"), fingerprint: String(p.fingerprint || ""), target: { kind: "identity", id: identity } });
      if (o) { writeOffer(o.id, "done", { device: dev.id, receiver: { name: p.name, fingerprint: p.fingerprint, device: p.id } }); ctx.events.emit("wink.joined", { offer: o.id, device: p.id, flow, kind }); }
      else ctx.events.emit("wink.joined", { device: p.id, flow, kind });
      return dev;
    };
    // Grants an older build wrote for devices become registry rows once, and the grants are revoked: a device is never a member of a space.
    let adopted = false;
    const adoptLegacy = async () => {
      if (adopted) return;
      adopted = true;
      const g = await grants();
      const identity = await owner1();
      for (const x of await g.list({ status: "active", source: "wink:W" })) {
        const sub = x.subject.kind === "actor" ? x.subject.actor : null;
        if (!sub || sub.kind !== "device" || !x.actions.includes("space.act")) continue;
        const who = String(x.reason || "").split(", ");
        if (!pairing.devices.get(sub.id)) pairing.devices.add({ id: sub.id, identity, kind: /** @type {any} */ (FLOW_KIND)[String(x.source).slice(5)] || "computer", name: who[0], fingerprint: who[1], target: { kind: "identity", id: identity } });
        await g.revoke(x.id, "devices belong to your identity now");
      }
    };
    const offPaired = ctx.events.on("device.paired", async (/** @type {any} */ e) => { try { await adoptLegacy(); await registerDevice(e.payload || e); } catch (err) { ctx.log(`wink: device registration failed: ${/** @type {Error} */ (err).message}`); } });
    const offRemoved = ctx.events.on("device.removed", async (/** @type {any} */ e) => {
      const p = e.payload || e;
      try {
        if (pairing.devices.get(String(p.id))) { pairing.devices.remove(String(p.id)); ctx.events.emit("wink.removed", { device: p.id }); }
      } catch (err) { ctx.log(`wink: device removal failed: ${/** @type {Error} */ (err).message}`); }
    });

    // ---- invite a person (W5) ----
    ctx.tool("wink.invite", {
      description: "Invite a person into this space: a Wink with the offer sealed into it (role and projects). Answers { offer, ticket, expiresAt }: show the ticket as a ring or a link. The invited person's own device redeems it and a card asks them to join; a sensitive role (admin) waits for your approval (wink.approve).",
      input: obj({ role: { type: "string", enum: ["member", "contributor", "guest", "admin"] }, projects: { type: "array", items: str }, days: { type: "number" }, name: str }),
      presence: { summary: async i => `Invite someone to this space as ${String((i && i.role) || "member")}` },
      run: async (input, meta = {}) => {
        owner(meta, "inviting a person");
        const role = String(input.role || "member");
        if (!ROLES.has(role)) throw fail("bad_input", "a role is member, contributor, guest or admin");
        const days = Math.min(Math.max(Number(input.days) || INVITE_TTL_DAYS, 1), 30);
        const projects = (Array.isArray(input.projects) ? input.projects : []).map(String).filter(p => /^[a-z0-9][a-z0-9-]{0,62}$/.test(p)).slice(0, 20);
        const space = await spaceId();
        const nameRes = /** @type {any} */ (await ctx.call("system.info", {}).catch(() => null));
        const spaceName = String((nameRes && nameRes.data && nameRes.data.name) || ctx.config.name || "this space").slice(0, 48);
        const offer = { v: 1, kind: "invite", space: { id: space, name: spaceName }, role, projects, inviter: { name: String(ctx.config.name || "an admin").slice(0, 48) }, exp: now() + days * 86_400_000 };
        const id = newOffer("W5", "ring", { role, projects, expires: offer.exp }, days * 86_400_000);
        offer.id = id;
        const t = /** @type {any} */ (await ctx.call("relay.ticket.mint", { offer }));
        if (!t || !t.data) { writeOffer(id, "closed", { why: "relay" }); throw fail("unavailable", "Can't connect. Check your internet connection. Nothing was lost."); }
        ctx.events.emit("wink.offered", { offer: id, flow: "W5", via: "ring", role, expires: offer.exp });
        return { offer: id, ticket: t.data.ticket, expiresAt: t.data.expiresAt };
      },
    });

    const offInvite = ctx.events.on("relay.invite-redeemed", async (/** @type {any} */ e) => {
      const p = e.payload || e;
      try {
        const o = readOffer(String((p.offer && p.offer.id) || ""));
        if (!o || o.flow !== "W5" || !["offered"].includes(o.state)) return;
        const fp = String(p.fingerprint || "");
        if (SENSITIVE_ROLES.has(o.role)) {
          // A sensitive role stays pending until an admin confirms the invitee's fingerprint words with presence.
          writeOffer(o.id, "pending", { receiver: { name: p.name, fingerprint: fp, key: p.pub } });
          ctx.events.emit("wink.found", { offer: o.id, flow: "W5" });
          return;
        }
        await admit(o.id, { name: p.name, fingerprint: fp, key: p.pub });
      } catch (err) { ctx.log(`wink: invitation failed: ${/** @type {Error} */ (err).message}`); }
    });
    /** Writes the membership: one grant, one event. @param {string} offerId @param {{ name?: string, fingerprint?: string, key: string }} who */
    const admit = async (offerId, who) => {
      const o = readOffer(offerId);
      if (!o) throw fail("not_found", "no such invitation");
      const g = await grants();
      const space = await spaceId();
      const grant = await g.create({
        subject: { kind: "actor", actor: { kind: "person", id: `per_${base32(sha(`person\n${who.key}`), 26)}`, space } },
        actions: ["member.act"], resource: { prefix: `vyre://${space}/` }, conditions: {},
        source: "wink:W5", reason: `${String(who.name || "someone")}, ${String(who.fingerprint || "")}, ${o.role}${(o.projects || []).length ? `, ${(o.projects || []).join(" ")}` : ""}`.trim(),
      }, await owner0());
      writeOffer(offerId, "done", { grant: grant.id, receiver: { name: who.name, fingerprint: who.fingerprint } });
      ctx.events.emit("wink.joined", { offer: offerId, grant: grant.id, flow: "W5", role: o.role });
      return grant;
    };
    ctx.tool("wink.approve", {
      description: "Approve a person who redeemed a sensitive invitation, after reading their fingerprint words back (the card shows them). Answers { grant }.",
      input: obj({ offer: str }, ["offer"]),
      presence: { summary: async () => "Let this person join this space with a sensitive role" },
      run: async (input, meta = {}) => {
        owner(meta, "approving a member");
        sweep();
        const o = readOffer(String(input.offer));
        if (!o || o.state !== "pending" || !o.receiver) throw fail("not_found", "nobody is waiting for approval on that invitation");
        const g = await admit(o.id, o.receiver);
        return { grant: g.id };
      },
    });
    ctx.tool("wink.decline", {
      description: "Say no to a person who redeemed a sensitive invitation. Nothing is added. Answers { declined }.",
      input: obj({ offer: str }, ["offer"]),
      run: async (input, meta = {}) => {
        owner(meta, "declining a member");
        const o = readOffer(String(input.offer));
        if (!o || o.state !== "pending") throw fail("not_found", "nobody is waiting for approval on that invitation");
        writeOffer(o.id, "declined", {});
        ctx.events.emit("wink.declined", { offer: o.id, why: "declined" });
        return { declined: true };
      },
    });

    // ---- share a computer (W4) ----
    ctx.tool("wink.share", {
      description: "Lend one of my own computers to my own space: it may run my sessions while it is awake, within the limits I set. Creates a node.host grant. Answers { grant }.",
      input: obj({ device: str, cpu: { type: "number" }, hours_day: { type: "number" }, awake: { type: "boolean" }, on_power: { type: "boolean" } }, ["device"]),
      presence: { summary: async i => `Share the computer ${String((i && i.device) || "")} with your space` },
      run: async (input, meta = {}) => {
        owner(meta, "sharing a computer");
        const dev = /** @type {any} */ (await ctx.call("relay.device.info", { id: String(input.device) }));
        const info = dev && dev.data;
        if (!info || info.removed || info.kind !== "app") throw fail("not_found", "that computer is not paired with this server");
        const g = await grants();
        const space = await spaceId();
        const cpu = Math.min(Math.max(Number(input.cpu) || 0.5, 0.05), 1);
        const hours = Math.min(Math.max(Number(input.hours_day) || 8, 0.25), 24);
        const grant = await g.create({
          subject: { kind: "actor", actor: { kind: "person", id: (await owner0()).id, space } }, actions: ["node.host"],
          resource: { prefix: `vyre://${space}/node/${String(input.device)}/` },
          conditions: { budget: { meter: "node.cpu-hours-day", limit: hours * cpu }, where: { nodes: [String(input.device)] } },
          source: "wink:W4", reason: `shared with limits: cpu ${cpu}, ${hours} hours a day, awake ${input.awake !== false}, on power ${input.on_power === true}`,
        }, await owner0());
        ctx.events.emit("wink.shared", { grant: grant.id, device: String(input.device) });
        return { grant: grant.id };
      },
    });

    // ---- access: every grant as a card, and one way to take it back ----
    const cardOf = async (/** @type {any} */ g) => {
      const who = String(g.reason || "").split(", ");
      const kind = g.source === "wink:W5" ? "invite" : g.source === "wink:W4" ? "share" : "share";
      const c = card({ kind: /** @type {any} */ (kind), receiver: { name: who[0], fingerprint: who[1] }, space: "Personal", inviter: { name: String(ctx.config.name || "") } });
      return { id: g.id, source: g.source, since: g.created_at, status: g.status, subject: g.subject, resource: g.resource.prefix, lastUsed: g.last_used || null, card: c };
    };
    ctx.tool("wink.access", {
      description: "What you have added with a Wink: your devices (a phone, a computer, a server, a storage device, each with its kind, who it belongs to and what it offers) and the grants given to people, as cards. Devices belong to you, not to a space. Answers { devices, grants }.",
      input: obj({ status: { type: "string", enum: ["active", "revoked"] } }),
      run: async (input, meta = {}) => {
        owner(meta, "the access list");
        const g = await grants();
        await adoptLegacy();
        const list = await g.list({ ...(input.status ? { status: input.status } : { status: "active" }), source: "wink:" });
        const devices = pairing.devices.list(await owner1()).map(d => ({ ...d, card: card({ kind: /** @type {any} */ (d.kind), receiver: { name: d.name, fingerprint: d.fingerprint }, space: d.owner.kind === "space" ? d.owner.id : "Personal" }) }));
        return { devices, grants: await Promise.all(list.map(cardOf)) };
      },
    });
    ctx.tool("wink.offers", {
      description: "What is waiting on a person right now: the offers that are showing or waiting for a card, without any secret. Answers { offers }.",
      input: obj(),
      run: async (_, meta = {}) => {
        owner(meta, "the offers");
        sweep();
        const rows = /** @type {any[]} */ (db.prepare("SELECT id FROM wink_offers WHERE state IN ('offered', 'found', 'pending', 'joining') ORDER BY created DESC").all());
        return { offers: rows.map(r => publicOffer(readOffer(r.id))) };
      },
    });
    ctx.tool("wink.remove", {
      description: "Take something back: a grant (a member, a share) is revoked, or a device (give `device`) is removed with its connections closed, and a line is written. Answers { removed, prompt } where prompt is the words the screen showed before asking.",
      input: obj({ grant: str, device: str }),
      presence: { summary: async () => "Remove something you added with a Wink" },
      run: async (input, meta = {}) => {
        owner(meta, "removing a grant");
        if (input.device) {
          const d = pairing.devices.get(String(input.device));
          if (!d || d.removed || d.identity !== await owner1()) throw fail("not_found", "no such device");
          pairing.devices.remove(d.id);
          // Its relay connections close at once through relay.devices.drop (a module's door to the relay's own removal); `closed` says what happened.
          let closed = false;
          if (d.kind !== "server" && d.kind !== "storage") { const rr = /** @type {any} */ (await ctx.call("relay.devices.drop", { id: d.id })); closed = !rr.error && Boolean(rr.data && rr.data.closed); }
          ctx.events.emit("wink.removed", { device: d.id });
          return { removed: d.id, closed, prompt: removal({ what: "device", name: d.name }).prompt, done: removed({ what: "device", name: d.name }) };
        }
        if (!input.grant) throw fail("bad_input", "say which grant or which device");
        const g = await grants();
        const gr = await g.get(String(input.grant));
        if (!gr || gr.status !== "active") throw fail("not_found", "no such grant");
        const subject = gr.subject.kind === "actor" ? gr.subject.actor : null;
        const label = String(gr.reason || "").split(", ")[0];
        await g.revoke(gr.id, "removed by the owner");
        // A device grant takes the device with it; its connections close at once (the relay's own removal).
        if (subject && subject.kind === "device") await ctx.call("relay.devices.drop", { id: subject.id });
        ctx.events.emit("wink.removed", { grant: gr.id, ...(subject && subject.kind === "device" ? { device: subject.id } : {}) });
        const what = gr.source === "wink:W4" ? "share" : gr.source === "wink:W5" ? "member" : "device";
        return { removed: gr.id, prompt: removal({ what: /** @type {any} */ (what), name: label, member: label, space: "this space" }).prompt, done: removed({ what, name: label, member: label, space: "this space" }) };
      },
    });

    ctx.tool("wink.card", {
      description: "The card for an offer or a grant: four lines and two buttons, in the words of team/0.3/wink-copy.md. Answers { card }.",
      input: obj({ offer: str, grant: str }),
      run: async (input, meta = {}) => {
        owner(meta, "the card");
        if (input.grant) { const g = await (await grants()).get(String(input.grant)); if (!g) throw fail("not_found", "no such grant"); return { card: (await cardOf(g)).card }; }
        const o = readOffer(String(input.offer));
        if (!o) throw fail("not_found", "no such offer");
        const kind = o.flow === "W5" ? "invite" : o.flow === "W3" ? "server" : o.flow === "W1" ? "phone" : "computer";
        return { card: card({ kind: /** @type {any} */ (kind), receiver: o.receiver || {}, space: o.flow === "W5" ? String(ctx.config.name || "this space") : "Personal", inviter: { name: String(ctx.config.name || "") }, level: 2 }) };
      },
    });

    // Storage devices (core/wink/storage): the vault holds a drive's login, and the pool engine reads offers through this seam.
    const sdata = (/** @type {any} */ r) => { if (r && r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code }); return r && r.data; };
    const storageVault = {
      put: async (/** @type {any} */ o) => { sdata(await ctx.call("vault.put", { name: o.name, kind: "env-set", description: o.description, fields: o.fields, grants: ["wink"] })); },
      fetch: async (/** @type {string} */ name, /** @type {string | undefined} */ field) => ctx.vault.fetch(name, field ? { field } : {}),
      remove: async (/** @type {string} */ name) => { sdata(await ctx.call("vault.delete", { name })); },
    };
    const storageAdmin = {
      self: async () => owner0(),
      isAdmin: async (/** @type {string} */ person, /** @type {string} */ sp) => {
        if (ctx.kernel && ctx.kernel.roles && ctx.kernel.roles.isAdmin) return Boolean(await ctx.kernel.roles.isAdmin(person, sp));
        return sp === (await spaceId());
      },
      nameOf: async (/** @type {any} */ o) => (o.kind === "person" ? "Personal" : String((ctx.config && ctx.config.name) || "this space")),
    };
    const storage = createStorageDevices({ ctx, grants: storageGrants({ ctx, space: () => spaceCache }), vault: storageVault, admin: storageAdmin, space: spaceId });
    registerStorageTools(ctx, storage, "wink.storage");
    const stopStorage = storage.startTimer();

    const timer = setInterval(sweep, 60_000);
    timer.unref();
    return {
      async stop() {
        clearInterval(timer);
        try { stopStorage(); } catch {}
        for (const off of [offCode, offPaired, offRemoved, offInvite]) { try { off(); } catch {} }
        try { code?.cancel(); } catch {}
      },
    };
  },
  };
}

export default createWink();
