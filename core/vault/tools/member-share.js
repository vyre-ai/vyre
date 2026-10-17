// @ts-check
// The member's share of a login with an agent (core/vault/member-share.js): share, unshare, list. Not for the owner and not for a model: each one takes the member from the kernel's chain and refuses an
// assistant acting for them. None returns a value; the member sees the names of their own logins, the agent, the site and the expiry.

import { PERSON_SURFACES as THE_SURFACES } from "../../../lib/person-surfaces.js";
import { presence } from "./presence.js";

const PERSON_SURFACES = [...THE_SURFACES, "device", "web"];
const obj = (properties, required = []) => ({ type: "object", properties, required });
const str = { type: "string" };

export const SHARE_TOOLS = ["vault.me.share.agent", "vault.me.unshare.agent", "vault.me.shares"];

/** @param {{ access: import("../access.js").Access, tool: (name: string, callers: string[]|null, description: string, input: any, run: Function, needs?: any) => void }} o */
export function register({ access, tool }) {
  tool("vault.me.share.agent", PERSON_SURFACES, "Let one of your agents sign in with one of your logins, on one site, until an expiry: { item, agent, origin, expires? } (up to a year, default a week). Your agent can use this login while you're away. The agent never sees it.",
    obj({ item: str, agent: str, origin: str, expires: { type: "number" } }, ["item", "agent", "origin"]), (/** @type {any} */ i, /** @type {any} */ meta) => access.members.share(i || {}, meta),
    presence("Share a login with an agent", ({ agent, origin }) => `Let ${String(agent).slice(0, 40)} sign in to ${String(origin).slice(0, 80)} with a login of yours while you're away`));
  tool("vault.me.unshare.agent", PERSON_SURFACES, "Stop an agent signing in with one of your logins: { item, agent?, origin? }. The server's copy is deleted at once.",
    obj({ item: str, agent: str, origin: str }, ["item"]), (/** @type {any} */ i, /** @type {any} */ meta) => access.members.unshare(i || {}, meta));
  tool("vault.me.shares", PERSON_SURFACES, "The logins you have shared with agents: the login's name, the agent, the site and when it ends. Never a value.",
    obj({}), (/** @type {any} */ _i, /** @type {any} */ meta) => access.members.list(meta));
}
