// @ts-check
// presence, the module: the keys a person proves presence with (docs/adr/0004-presence.md).
//
// The verifier itself lives in index.js and vyred builds it before any module starts, so the
// registry can ask it about every call. This module is the user's handle on it: list the enrolled
// Capsule keys, device keys and passkeys, enroll or remove one, and mint a one-time code for enrolling a
// passkey from the Deck. Enrolling, removing and minting need presence themselves; they are on
// the floor's list, and they say so here too.

import { Presence } from "./index.js";
import { PersonSessions } from "./person.js";

const str = { type: "string" };
const obj = (properties, required = []) => ({ type: "object", properties, required });

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    // Rows only: challenges and nonces live in vyred's own verifier, not in this one.
    const presence = new Presence({ db: ctx.store.db, log: m => ctx.log(m) });

    ctx.tool("presence.keys", {
      description: "The Capsule keys, device keys and passkeys enrolled for proving presence: id, kind, name, when enrolled and last used. Never the keys themselves.",
      input: obj({}),
      // On a Mac with vyre-core, the list is core's (a read vyred may proxy, ADR 0040 section 3).
      run: async () => (presence.coreLink ? presence.coreLink.keys() : presence.keys()),
    });

    ctx.tool("presence.enroll", {
      description: "Enroll a Capsule key (Ed25519), a phone's device key (P-256, alg -7) or a passkey, by its public key as base64url SPKI DER. Needs presence.",
      presence: { summary: async input => `Enroll a ${input.kind === "passkey" ? "passkey" : input.kind === "device" ? "device key" : "Capsule key"} named "${String(input.name || input.kind)}"` },
      input: obj({ kind: { type: "string", enum: ["capsule", "passkey", "device"] }, name: str, public_key: str, alg: { type: "integer" }, rp_id: str, credential_id: str,
        device: str },
        ["kind", "public_key"]),
      run: async (input, meta = {}) => {
        // A passkey a browser made at relay pairing (ADR 0032 part 2b): only the relay module enrolls
        // one, for the device it just paired, under an allowed app's name (app.vyre.run). It proves
        // only for that device, from that origin.
        if (input.device !== undefined) {
          if (meta.caller !== "module:relay") throw Object.assign(new Error("only the relay enrolls a device's passkey"), { code: "denied" });
          if (input.kind !== "passkey" || !/^[a-z2-7]{16}$/.test(String(input.device))) throw Object.assign(new Error("a device's key here is a passkey for a relay device id"), { code: "bad_input" });
          const origins = ((ctx.config.network || {}).origins || ["https://app.vyre.run"]).map(String);
          const origin = origins.find(o => { try { return new URL(o).hostname === String(input.rp_id || "").toLowerCase(); } catch { return false; } });
          if (!origin) throw Object.assign(new Error(`a device's passkey must be for an allowed app (${origins.join(", ")})`), { code: "denied" });
          const k = presence.enroll({ ...input, origin });
          ctx.events.emit("presence.enrolled", { id: k.id, kind: k.kind, name: k.name });
          return k;
        }
        // On the box a passkey must belong to the Deck's own address, not a name in the request.
        if (ctx.config.role === "box" && input.kind === "passkey") {
          let host = null;
          try { host = new URL(String((ctx.config.network || {}).address || "")).hostname; } catch {}
          if (!host) throw new Error("the box has no address yet, so no passkey can be enrolled");
          if (String(input.rp_id || "").toLowerCase() !== host.toLowerCase()) throw new Error(`a passkey here must be for ${host}`);
        }
        const k = presence.enroll(input);
        ctx.events.emit("presence.enrolled", { id: k.id, kind: k.kind, name: k.name });
        return k;
      },
    });

    ctx.tool("presence.remove", {
      description: "Remove an enrolled Capsule key, device key or passkey by id. Needs presence.",
      presence: { summary: async input => `Remove the presence key ${String(input.id)}` },
      input: obj({ id: str }, ["id"]),
      run: async ({ id }) => {
        if (!presence.remove(id)) throw new Error(`no key ${id}`);
        ctx.events.emit("presence.removed", { id });
        return { removed: id };
      },
    });

    ctx.tool("presence.code", {
      description: "A one-time code, valid 10 minutes, that enrolls one passkey from the Deck. Needs presence.",
      presence: { summary: async () => "Make a one-time code to enroll a passkey" },
      input: obj({}),
      run: async () => presence.mintCode(),
    });

    ctx.tool("presence.session.open", {
      description: "After one strong proof (Touch ID, the Capsule, a device key or a passkey), a secret that proves presence for revealing, copying, TOTP codes and sends at the Gate for 30 minutes, on this device only.",
      presence: { summary: async () => "Keep revealing and copying vault items for up to 30 minutes on this device" },
      input: obj({}),
      run: async (_, meta) => {
        if (!meta.presence) throw new Error("a session opens from a person's proof, not from a module");
        return presence.openSession({ method: meta.presence.method, keyId: meta.presence.keyId, peer: meta.peer });
      },
    });

    // The person session (person.js): a browser signed in as the person, not only their device.
    const people = new PersonSessions({ db: ctx.store.db });
    const nodeOf = meta => (meta.peer && (meta.peer.stableId || meta.peer.node)) || null;

    ctx.tool("presence.person.start", {
      description: "Sign this browser or app in as the person for 30 days (90 at most), on this device only, with a passkey or the device's own key. The Deck gets a cookie; with cc (a PKCE S256 challenge) the answer is a one-time code the app trades at /v1/person/token; a device paired over the relay sends its request-signing key (key, an ES256 public JWK) and gets the token itself.",
      presence: { summary: async input => {
        if (!input.cc) return "Sign this browser in for 30 days";
        let at = "an app";
        try { const u = new URL(String(input.return || "")); at = u.hostname === "127.0.0.1" ? "the vyre command line and Capsule on this Mac" : u.host; } catch {}
        return `Sign ${at} in on this device for 30 days`;
      } },
      callers: ["deck", "capsule"],
      input: obj({ cc: str, return: str, label: str, key: { type: "object" } }),
      run: async (input, meta) => {
        if (!meta.presence) throw new Error("a person session opens from a person's proof");
        const node = nodeOf(meta);
        const label = input.label || (meta.peer && meta.peer.node) || null;
        if (input.cc) {
          // The code goes back only to an app this box allows (network.origins), never to a page
          // that names itself: that page would hold the verifier and trade the code for the person.
          let back;
          try { back = new URL(String(input.return || "")); } catch { throw Object.assign(new Error("return must be the app's address"), { code: "bad_input" }); }
          const allowed = ((ctx.config.network || {}).origins || ["https://app.vyre.run"]).map(String);
          // A paired Mac's vyred (`vyre link signin`) listens on its own loopback, as a native
          // app does (RFC 8252). Its code is traded by vyred itself, never by a browser page.
          const loop = back.protocol === "http:" && back.hostname === "127.0.0.1" && /^\/cb\/[\w-]{16,}$/.test(back.pathname);
          // The native app (vyre://person/signin): its code is traded by the app itself, which
          // must also sign that trade with the key it registers (person.js exchange).
          const native = back.protocol === "vyre:" && back.host === "person";
          if (!loop && !native && (back.protocol !== "https:" || !allowed.includes(back.origin))) throw Object.assign(new Error(`${back.protocol === "vyre:" ? back.href : back.origin} is not an app this box signs in to`), { code: "denied" });
          const c = people.code({ node, cc: input.cc, origin: loop ? "loopback" : native ? "app:vyre" : back.origin, label });
          back.searchParams.set("code", c.code);
          return { kind: "code", code: c.code, expires: c.expires, redirect: back.href };
        }
        // A device paired over the relay (ADR 0026) has no browser to hold a cookie and no path to
        // the box's sign-in page. It proves the person with the key enrolled for it at pairing (a
        // phone's Secure Enclave or Keystore key, method device), and gets a token bound to the
        // request-signing key it sends, pinned to its device id.
        if (meta.peer && meta.peer.kind === "device") {
          if (meta.presence.method === "passkey") {
            // A relayed browser: its passkey is bound to this device id (presence checked it too).
            const b = /** @type {any} */ (ctx.store.db.prepare("SELECT device FROM presence_key_devices WHERE key = ?").get(String(meta.presence.keyId || "")));
            if (!b || b.device !== node) throw Object.assign(new Error("that passkey is not this device's"), { code: "denied" });
          } else if (meta.presence.method === "device") {
            const r = await ctx.call("relay.device.presence", { id: node }).catch(() => null);
            const mine = r && r.data && r.data.key;
            if (!mine || mine !== meta.presence.keyId) throw Object.assign(new Error("that key is not the one enrolled for this device"), { code: "denied" });
          } else throw Object.assign(new Error("a paired device signs in with its own device key or passkey"), { code: "denied" });
          const k = input.key;
          if (!k || k.kty !== "EC" || k.crv !== "P-256" || typeof k.x !== "string" || typeof k.y !== "string" || k.d) throw Object.assign(new Error("key must be the public JWK of an ES256 key"), { code: "bad_input" });
          const s = people.start({ node, kind: "bearer", label, key: { kty: "EC", crv: "P-256", x: k.x, y: k.y } });
          ctx.events.emit("presence.signed-in", { id: s.id, node: label });
          return { kind: "bearer", id: s.id, token: s.token, expires: s.expires };
        }
        const s = people.start({ node, kind: "cookie", label });
        ctx.events.emit("presence.signed-in", { id: s.id, node: label });
        return { kind: "cookie", id: s.id, token: s.token, expires: s.expires };
      },
    });

    ctx.tool("presence.person.status", {
      description: "Whether this request is signed in as the person (a person session), and until when.",
      input: obj({}),
      run: async (_, meta) => ({ signed: Boolean(meta.person), ...(meta.person ? { id: meta.person.id, kind: meta.person.kind } : {}) }),
    });

    ctx.tool("presence.person.sessions", {
      description: "The browsers and apps signed in as the person: id, how (cookie or app), device, made, last used, when it lapses. Never a secret.",
      callers: ["cli", "local", "deck", "capsule"],
      input: obj({}),
      run: async () => ({ sessions: people.list() }),
    });

    ctx.tool("presence.person.revoke", {
      description: "Sign one browser or app out now, by session id.",
      callers: ["cli", "local", "deck", "capsule"],
      input: obj({ id: str }, ["id"]),
      run: async ({ id }) => {
        if (!people.revoke(id)) throw Object.assign(new Error(`no session ${id}`), { code: "not_found" });
        ctx.events.emit("presence.signed-out", { id });
        return { revoked: id };
      },
    });

    ctx.tool("presence.covered", {
      internal: true,
      description: "Whether the device a call came from (its tailnet peer; none for this machine) has a live presence session, since when and until when (ms). The Gate and the Switchboard put it on held items and asks.",
      input: obj({ peer: { type: "object" } }),
      run: async ({ peer }) => presence.coverage(peer || null),
    });

    ctx.tool("presence.session.close", {
      description: "End a presence session now.",
      input: obj({ session: str }, ["session"]),
      run: async ({ session }) => ({ closed: presence.closeSession(session) }),
    });

    return { async stop() {} };
  },
};
