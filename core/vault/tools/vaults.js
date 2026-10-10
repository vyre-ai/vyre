// @ts-check
// Tools for shared vaults (ADR 0006, decision 5; shared.js does the work).
//
// Listing is open to everyone, Claude included: names, roles and fingerprints, never a value.
// Changing who may read a vault, or its key, needs a person who is present. Joining needs a
// person too: it trusts the inviter's card.

import { presence, quoted } from "./presence.js";
import { decodeInvite } from "../shared.js";
import { decodeJoin } from "../devices.js";

const PEOPLE = ["cli", "local"];
/** The person's own devices write to shared vaults too (invite, role, remove and rotate each take the one yes); a model never does. */
const WRITERS = [...PEOPLE, "device"];
const str = { type: "string" };
const obj = (properties, required = []) => ({ type: "object", properties, required });

/**
 * @param {{ vault: import("../vault.js").Vault,
 *   tool: (name: string, callers: string[]|null, description: string, input: any, run: Function, needs?: any) => void }} o
 */
export function register({ vault, tool }) {
  const shared = vault.shared;

  tool("vault.vaults.create", WRITERS, "Make a shared vault. This Vyre is its owner and its home.",
    obj({ name: str }, ["name"]), (input, { caller }) => shared.create(input, caller));

  tool("vault.vaults.list", ["cli", "local", "deck", "capsule", "tailnet", "device", "module"], "Shared vaults: members, roles, fingerprints and item names. Never a value.",
    obj({}), () => shared.list());

  tool("vault.vaults.sync", [...WRITERS, "mcp"], "Pull what changed in shared vaults from their homes.",
    obj({ vault: str }), (input, { caller }) => shared.sync(input, caller));

  tool("vault.members.invite", WRITERS, "Invite a person whose card you pinned and verified into a shared vault. Returns an invite for them to accept.",
    obj({ vault: str, person: str, role: { type: "string", enum: ["admin", "member", "read-only"] } }, ["vault", "person"]),
    (input, { caller }) => shared.invite(input, caller),
    presence("Invite someone into a shared vault", ({ vault: v, person, role }) => `Let ${String(person).slice(0, 64)} read ${quoted(v)}${role === "read-only" ? "" : " and write to it"} as ${role || "member"}`));

  tool("vault.members.accept", WRITERS, "Join a shared vault from an invite.",
    obj({ invite: str }, ["invite"]), (input, { caller }) => shared.accept(input, caller),
    presence("Join a shared vault", ({ invite }) => { const i = decodeInvite(invite); return `Join ${quoted(i.name)}, trusting ${i.card.name}'s card`; }));

  tool("vault.members.role", WRITERS, "Change a member's role: admin, member or read-only.",
    obj({ vault: str, person: str, role: { type: "string", enum: ["admin", "member", "read-only"] } }, ["vault", "person", "role"]),
    (input, { caller }) => shared.role(input, caller),
    presence("Change a member's role", ({ vault: v, person, role }) => `Make ${String(person).slice(0, 64)} ${role} in ${quoted(v)}`));

  tool("vault.members.remove", WRITERS, "Remove a member: a new key they never see, and every item they could read flagged for rotation.",
    obj({ vault: str, person: str }, ["vault", "person"]), (input, { caller }) => shared.remove(input, caller),
    presence("Remove someone from a shared vault", ({ vault: v, person }) => `Remove ${String(person).slice(0, 64)} from ${quoted(v)} and change its key`));

  tool("vault.vaults.rotate", WRITERS, "Give a shared vault a new key. Members keep access; item keys are re-wrapped.",
    obj({ vault: str }, ["vault"]), (input, { caller }) => shared.rotate(input, caller),
    presence("Change a shared vault's key", ({ vault: v }) => `Change the key of ${quoted(v)}`));

  // This person's other devices (devices.js). `vault.devices` is the autofill extensions.
  tool("vault.device.join", PEOPLE, "On a new device: make a join code (role full or storage), or finish joining with the approval another device gave.",
    obj({ role: { type: "string", enum: ["full", "storage"] }, approval: str }), (input, { caller }) => vault.devices.join(input, caller));

  tool("vault.device.approve", PEOPLE, "Let a new device into your vault. It receives the account keyset sealed to its own key; a storage device gets no personal key.",
    obj({ code: str }, ["code"]), (input, { caller }) => vault.devices.approve(input, caller),
    presence("Let a new device into your vault", ({ code }) => {
      const j = decodeJoin(code);
      return j.role === "storage"
        ? `Let ${j.name} (fingerprint ${j.fingerprint}) hold your vault as storage and run your agents' keys`
        : `Let ${j.name} (fingerprint ${j.fingerprint}) open your whole vault, personal items included, with your password`;
    }));

  tool("vault.device.list", ["cli", "local", "deck", "capsule", "tailnet", "device", "module"], "Your devices in this vault's group: names, roles, fingerprints.",
    obj({}), () => vault.devices.list());

  tool("vault.device.sync", [...PEOPLE, "mcp"], "Push and pull items between your devices now.",
    obj({}), (input, { caller }) => vault.devices.sync(input, caller));

  tool("vault.move", PEOPLE, "Move an item into a shared vault. Everyone in it can then use it.",
    obj({ name: str, to: str }, ["name", "to"]), (input, { caller }) => shared.move(input, caller),
    presence("Move an item into a shared vault", ({ name, to }) => {
      const v = shared.row(to);
      return `Move ${quoted(name)} into ${quoted(to)}, readable by ${v ? shared.out(v).members.length : "its"} members`;
    }));
}
