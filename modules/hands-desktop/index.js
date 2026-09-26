// @ts-check
// hands-desktop: the module layer over act.js, snapshot.js and client.js — an agent's AT-SPI
// hands, wired to a real computer through core/computers (docs/work/computers.md, ADR 0003).
//
// Everything that decides whether a click is safe to try lives in act.js and consequence.js
// already; this file only finds the agent's computer (computers.endpoint), speaks computerd
// through client.js, and gates every attempted action against the keyboard (computers.may-act)
// so a take-over stops the hands exactly where the checkout's Docker container is not touched.
//
// Reads (tree, apps, screenshot) are never gated by may-act's ordinary pause/take-over refusal:
// ADR 0003 says a take-over leaves an agent's reads and screenshots working, since only one
// keyboard, not one pair of eyes, is the rule. Shield is the one exception: while a person is
// signing in, computers.may-act's `shielded` flag refuses reads too (a screenshot must never
// show a password), so every read tool checks for that specific refusal, and only that one.
//
// No computerd token is ever returned from a tool, logged, or put in the desktop.acted event:
// client.js already scrubs it from every error string it raises, and nothing here holds it
// past the one client it was built for.

import { createClient } from "./client.js";
import * as snapshot from "./snapshot.js";
import * as act from "./act.js";

const str = { type: "string" };
const obj = (properties, required = []) => ({ type: "object", properties, required });
const AGENT = /^[a-z][a-z0-9-]{0,40}$/;

/** @type {{ start(ctx: any): Promise<any> }} */
export default {
  async start(ctx) {
    /** The agents module's view of one agent's kind, or null when it cannot say. */
    const kindOf = async name => {
      const r = await ctx.call("agents.list", {});
      if (r.error) return null;
      const a = (r.data || []).find(x => x && x.name === name);
      return a ? String(a.kind) : null;
    };

    /**
     * Whose computer this call is about. An agent's own hands (caller "mcp:agent:<name>") may
     * only name themselves; only the assistant may name another. Every other caller (the CLI,
     * the Deck, the assistant itself) must say which agent it means. This mirrors
     * core/computers/index.js's resolve(): computers.endpoint is reached through ctx.call, which
     * forwards as "module:hands-desktop", so computers's own per-agent check never sees the real
     * caller and cannot enforce this on our behalf.
     */
    const resolveAgent = async (input, caller) => {
      const m = /^mcp:agent:(.+)$/.exec(String(caller || ""));
      let agent;
      if (m) {
        const self = m[1];
        if (!input.agent || input.agent === self) agent = self;
        else if ((await kindOf(self)) === "assistant") agent = input.agent;
        else throw new Error(`${self} can only use its own computer, not ${input.agent}'s`);
      } else {
        if (!input.agent) throw new Error("say which agent's computer: agent is required");
        agent = input.agent;
      }
      if (!AGENT.test(String(agent))) throw new Error(`"${agent}" is not an agent name`);
      return String(agent);
    };

    /** Where the agent's computerd answers, and a client for it. Throws with a readable reason. */
    const clientFor = async (agent, thread) => {
      const r = await ctx.call("computers.endpoint", { agent, thread });
      if (r.error) {
        if (r.error.code === "no_such_tool") throw new Error("the computers module is not running, so there is no computer to act on");
        throw new Error(`could not reach ${agent}'s computer: ${r.error.message}`);
      }
      const { helper } = r.data;
      return createClient({ url: helper.url, token: helper.token });
    };

    /** Refuse a read only when shield says so; an ordinary pause or take-over leaves reads alone. */
    const notShielded = async agent => {
      const may = await ctx.call("computers.may-act", { agent, tool: "hands-desktop.read" });
      if (!may.error && may.data && may.data.ok === false && may.data.shielded) throw new Error(may.data.why);
    };

    /** One look, shaped into a Snapshot. */
    const perceiveWith = (client, app) => async () => snapshot.toSnapshot(app || "", await client.tree(app || undefined));

    /** Pick the one control named `target.name` (and, when given, of role `target.role`). */
    const decideFor = target => async candidates => {
      const wantName = String(target.name || "").trim().toLowerCase();
      const wantRole = target.role ? String(target.role) : null;
      const matches = candidates.filter(c => (!wantRole || c.role === wantRole) && String(c.name || "").trim().toLowerCase() === wantName);
      if (!matches.length) return { why: `no control named ${JSON.stringify(target.name)}${wantRole ? ` with role ${wantRole}` : ""} is on screen` };
      if (matches.length > 1) return { why: `${matches.length} controls are named ${JSON.stringify(target.name)}; say a role to tell them apart` };
      return { control: matches[0] };
    };

    /** Press, focus, or focus-then-set-text the bound control, refusing if the keyboard moved since perceiving. */
    const clickWith = (client, agent) => (actionName, value) => async bound => {
      const may = await ctx.call("computers.may-act", { agent, tool: "hands-desktop.act" });
      if (!may.error && may.data && may.data.ok === false) return { ok: false, why: may.data.why };
      if (actionName === "set-text") {
        await client.act({ path: bound.path, action: "focus" });
        await client.act({ path: bound.path, action: "set-text", value: String(value ?? "") });
      } else {
        await client.act({ path: bound.path, action: actionName });
      }
    };

    const tool = (name, description, input, run) => ctx.tool(name, { description, input, run });

    tool("hands-desktop.tree", "The accessibility tree of an app in the agent's computer, shaped into the controls the hands can act on.",
      obj({ agent: str, thread: str, app: str }, ["agent"]),
      async (i, { caller }) => {
        const agent = await resolveAgent(i, caller);
        await notShielded(agent);
        const client = await clientFor(agent, i.thread);
        return snapshot.toSnapshot(i.app || "", await client.tree(i.app || undefined));
      });

    tool("hands-desktop.apps", "Apps running in the agent's computer, from AT-SPI.",
      obj({ agent: str, thread: str }, ["agent"]),
      async (i, { caller }) => {
        const agent = await resolveAgent(i, caller);
        await notShielded(agent);
        return { apps: await (await clientFor(agent, i.thread)).apps() };
      });

    tool("hands-desktop.screenshot", "A PNG of the agent's whole display, base64-encoded.",
      obj({ agent: str, thread: str }, ["agent"]),
      async (i, { caller }) => {
        const agent = await resolveAgent(i, caller);
        await notShielded(agent);
        const png = await (await clientFor(agent, i.thread)).screenshot();
        return { image: png.toString("base64"), mime: "image/png" };
      });

    tool("hands-desktop.act",
      "Find a named control by a fresh look, press/focus/type it, and verify the window changed. " +
      "Consequential controls (send, pay, delete, submit, sign out, ...) are refused outright: take over in Glass to do those.",
      obj({
        agent: str, thread: str, app: str, name: str, role: str,
        action: { type: "string", enum: ["press", "focus", "set-text"] },
        value: str,
      }, ["agent", "name"]),
      async (i, { caller }) => {
        const agent = await resolveAgent(i, caller);
        const client = await clientFor(agent, i.thread);
        const actionName = i.action || "press";
        const result = await act.once({
          app: i.app || "",
          request: { name: i.name, role: i.role },
          perceive: perceiveWith(client, i.app),
          decide: decideFor({ name: i.name, role: i.role }),
          click: clickWith(client, agent)(actionName, i.value),
        });
        ctx.events.emit("desktop.acted",
          { agent, action: actionName, summary: i.name, ok: result.ok, ...(result.ok ? {} : { why: result.why }) },
          i.thread ? { thread: i.thread } : {});
        return result;
      });

    return { async stop() {} };
  },
};
