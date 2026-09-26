// @ts-check
// network: who besides the owner the box's tailnet listener serves (ADR 0014 part 8).
//
// A person in another tailnet the owner shared this box with is a guest: `tailnet-guest:<login>`,
// limited to the tools listed here or granted by the tailnet policy, and of those only GUEST_SAFE
// (core/names/guests.js). These tools keep that list. Changing it is the owner's, with presence;
// an agent or a guest never changes it. Guests are off until network.guests.enable turns them on.
//
// Vyre never shares the box or writes the tailnet policy. The owner shares the machine in the
// Tailscale admin console; network.guests.check says what the listener would then do.

import * as config from "../config/index.js";
import * as ts from "../names/tailscale.js";
import { classify } from "../names/identity.js";
import { GUEST_SAFE, allowedTools, grantedPatterns, listed, settings } from "../names/guests.js";

const AGENT_CLAIM = /(?:^|[\s:])agent:/;
const LOGIN = /^[^\s@]{1,128}@[^\s@]{1,128}$/;
const str = { type: "string" };
const obj = (properties = {}, required = []) => ({ type: "object", properties, required });
const fail = (code, message) => Object.assign(new Error(message), { code });

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    const net = () => ctx.config.network || {};
    const save = guests => config.save({ network: { guests } }, ctx.paths.root, ctx.config);

    /** Reads: anyone who reaches the tool but a guest. */
    const notGuest = caller => {
      if (String(caller || "").startsWith("tailnet-guest:")) throw fail("denied", "a guest cannot see who else this box serves");
    };
    /** Changes: the owner's, never an agent's or a guest's. Presence proves a person is there. */
    const owner = (caller, meta, what) => {
      const c = String(caller || "");
      notGuest(c);
      if ((meta && meta.agent) || AGENT_CLAIM.test(c)) throw fail("denied", `"${c}" is an agent; ${what} is the owner's`);
      if (["anonymous", "onboard", "hook"].includes(c)) throw fail("denied", `${what} is the owner's, from the box's terminal, the Capsule or the Deck`);
    };

    const view = () => {
      const g = settings(net());
      return {
        enabled: g.enabled,
        safe: [...GUEST_SAFE].sort(),
        people: Object.entries(g.people).map(([login, e]) => {
          const tools = Array.isArray(e && e.tools) ? e.tools.filter(t => typeof t === "string") : [];
          return { login, tools, allowed: g.enabled ? allowedTools(net(), { login, caps: {} }) : [] };
        }),
      };
    };

    ctx.tool("network.guests.list", {
      description: "Guests from other tailnets this box serves: whether guests are on, each listed login with its tools, and the view-only tools a guest can ever reach.",
      input: obj(),
      run: async (_, { caller } = {}) => { notGuest(caller); return view(); },
    });

    ctx.tool("network.guests.add", {
      description: "Serve a person from another tailnet as a guest, with these tools (only view-only ones: see network.guests.list's safe). Replaces the person's tools when already listed.",
      input: obj({ login: str, tools: { type: "array", items: str } }, ["login", "tools"]),
      presence: { summary: ({ login, tools }) => `Let ${login} use ${(tools || []).join(", ") || "no tools"} on this box` },
      run: async ({ login, tools }, meta) => {
        owner(meta.caller, meta, "who this box serves");
        const l = String(login).trim();
        if (!LOGIN.test(l)) throw fail("bad_input", "login must be a Tailscale login, like sam@harlow.example");
        if (net().owner && l.toLowerCase() === String(net().owner).toLowerCase()) throw fail("bad_input", "that is the owner; the owner is served already");
        const bad = tools.filter(t => !GUEST_SAFE.has(t));
        if (bad.length) throw fail("bad_input", `a guest can only have ${[...GUEST_SAFE].sort().join(", ")}; not ${bad.join(", ")}`);
        const g = settings(net());
        const had = listed(net(), l);
        const people = { ...g.people };
        if (had) delete people[had.login];
        people[l] = { tools: [...new Set(tools)].sort() };
        save({ enabled: g.enabled, people });
        ctx.events.emit("guest.added", { login: l, tools: people[l].tools });
        return view();
      },
    });

    ctx.tool("network.guests.remove", {
      description: "Stop serving a guest listed in config. A guest the tailnet policy grants vyre.run/cap/guest is still served until that grant is removed.",
      input: obj({ login: str }, ["login"]),
      presence: { summary: ({ login }) => `Stop serving ${login} on this box` },
      run: async ({ login }, meta) => {
        owner(meta.caller, meta, "who this box serves");
        const had = listed(net(), login);
        if (!had) throw fail("bad_input", `${login} is not listed as a guest`);
        const g = settings(net());
        const people = { ...g.people };
        delete people[had.login];
        save({ enabled: g.enabled, people });
        ctx.events.emit("guest.removed", { login: had.login });
        return view();
      },
    });

    ctx.tool("network.guests.enable", {
      description: "Turn guests on or off. Off, the tailnet listener serves only the owner, whatever the list or the tailnet policy says.",
      input: obj({ on: { type: "boolean" } }, ["on"]),
      presence: { summary: ({ on }) => (on ? "Serve guests from other tailnets on this box" : "Stop serving every guest on this box") },
      run: async ({ on }, meta) => {
        owner(meta.caller, meta, "turning guests on or off");
        save({ ...settings(net()), enabled: on === true });
        ctx.log(`guests ${on ? "on" : "off"}, set by ${meta.caller}`);
        return view();
      },
    });

    ctx.tool("network.guests.check", {
      description: "Who could reach this box as a guest now: asks Tailscale who each online person's device other than the owner's is, and says whether the listener would serve them and with which tools.",
      input: obj({ login: str }),
      run: async ({ login } = {}, { caller } = {}) => {
        notGuest(caller);
        const own = net().owner || null;
        const want = login ? String(login).toLowerCase() : null;
        const out = [];
        for (const p of await ts.peers()) {
          if (!p.online || p.tagged || !p.ips.length) continue;
          if (own && p.login && p.login.toLowerCase() === own.toLowerCase()) continue;
          if (want && String(p.login || "").toLowerCase() !== want) continue;
          const who = await ts.whois(p.ips[0]);
          if (!who || !who.login || who.tagged) continue;
          const id = await classify(who, { owner: own, network: net() });
          out.push({ login: who.login, node: who.node, stableId: who.stableId || null, served: id.kind === "guest",
            listed: Boolean(listed(net(), who.login)), granted: grantedPatterns(who),
            tools: id.kind === "guest" ? allowedTools(net(), who) : [], why: id.why });
        }
        return { enabled: settings(net()).enabled, owner: own, peers: out };
      },
    });

    return { async stop() {} };
  },
};
