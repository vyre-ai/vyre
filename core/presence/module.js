// @ts-check
// presence, the module: the keys a person proves presence with (docs/adr/0004-presence.md).
//
// The verifier itself lives in index.js and vyred builds it before any module starts, so the
// registry can ask it about every call. This module is the user's handle on it: list the enrolled
// Capsule keys and passkeys, enroll or remove one, and mint a one-time code for enrolling a
// passkey from the Deck. Enrolling, removing and minting need presence themselves; they are on
// the floor's list, and they say so here too.

import { Presence } from "./index.js";

const str = { type: "string" };
const obj = (properties, required = []) => ({ type: "object", properties, required });

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    // Rows only: challenges and nonces live in vyred's own verifier, not in this one.
    const presence = new Presence({ db: ctx.store.db, log: m => ctx.log(m) });

    ctx.tool("presence.keys", {
      description: "The Capsule keys and passkeys enrolled for proving presence: id, kind, name, when enrolled and last used. Never the keys themselves.",
      input: obj({}),
      run: async () => presence.keys(),
    });

    ctx.tool("presence.enroll", {
      description: "Enroll a Capsule key (Ed25519) or a passkey, by its public key as base64url SPKI DER. Needs presence.",
      presence: { summary: async input => `Enroll a ${input.kind === "passkey" ? "passkey" : "Capsule key"} named "${String(input.name || input.kind)}"` },
      input: obj({ kind: { type: "string", enum: ["capsule", "passkey"] }, name: str, public_key: str, alg: { type: "integer" }, rp_id: str, credential_id: str },
        ["kind", "public_key"]),
      run: async input => {
        const k = presence.enroll(input);
        ctx.events.emit("presence.enrolled", { id: k.id, kind: k.kind, name: k.name });
        return k;
      },
    });

    ctx.tool("presence.remove", {
      description: "Remove an enrolled Capsule key or passkey by id. Needs presence.",
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
      description: "After one strong proof (Touch ID, the Capsule or a passkey), a secret that proves presence for revealing, copying and TOTP codes for 5 minutes idle, 30 at most, on this device only.",
      presence: { summary: async () => "Keep revealing and copying vault items for up to 30 minutes on this device" },
      input: obj({}),
      run: async (_, meta) => {
        if (!meta.presence) throw new Error("a session opens from a person's proof, not from a module");
        return presence.openSession({ method: meta.presence.method, keyId: meta.presence.keyId, peer: meta.peer });
      },
    });

    ctx.tool("presence.session.close", {
      description: "End a presence session now.",
      input: obj({ session: str }, ["session"]),
      run: async ({ session }) => ({ closed: presence.closeSession(session) }),
    });

    return { async stop() {} };
  },
};
