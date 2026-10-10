// @ts-check
// hands-desktop: the module layer over act.js, snapshot.js and client.js — an agent's AT-SPI
// hands, wired to a real computer through core/computers (team/archive/work-journals/computers.md, ADR 0003).
//
// Everything that decides whether a click is safe to try lives in act.js and consequence.js
// already; this file only finds the agent's computer (computers.endpoint), speaks computerd
// through client.js, and gates every attempted action against the keyboard (computers.may-act)
// so a take-over stops the hands exactly where the checkout's Docker container is not touched.
//
// Reads (tree, apps, screenshot) ask may-act with `read: true`: a take-over leaves them working
// (ADR 0003: one keyboard, not one pair of eyes), but a shield, a person signing in, refuses
// them too (ADR 0005, decision 3).
//
// No computerd token is ever returned from a tool, logged, or put in the desktop.acted event:
// client.js already scrubs it from every error string it raises, and nothing here holds it
// past the one client it was built for.

import { callerKind, agentClaim } from "../../core/modules/index.js";
import { createClient } from "./client.js";
import * as snapshot from "./snapshot.js";
import * as act from "./act.js";

/** Callers that are the person at one of their own surfaces, who may say which thread a step is for. */
const PERSON_SURFACES = new Set(["cli", "local", "deck", "capsule"]);
const str = { type: "string" };
const obj = (properties, required = []) => ({ type: "object", properties, required });
const AGENT = /^[a-z][a-z0-9-]{0,40}$/;
/** The person's own surfaces and modules, plus an agent's own hands (a model session): resolveAgent refuses a model that names no agent of its own. */
const CALLERS = ["cli", "local", "deck", "capsule", "mobile", "tailnet", "device", "module", "mcp", "harness"];

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
     *
     * This used to match only the exact shape "mcp:agent:<name>"; a caller vouched under another
     * transport ("cli agent:<name>", the shape a person's own CLI gets when an agent runs inside
     * it) fell through to the trusted-caller branch below and could name any agent's computer as
     * if it were the CLI itself (e2e review, 2026-09-28). `agentClaim` (core/modules, shared with
     * computers.js's ownSurface and sight) finds the claim under any transport, so the same
     * self-or-assistant rule now applies whichever way the agent's identity reached this call.
     */
    const resolveAgent = async (input, caller) => {
      const self = agentClaim(caller);
      let agent;
      if (self) {
        if (!input.agent || input.agent === self) agent = self;
        else if ((await kindOf(self)) === "assistant") agent = input.agent;
        else throw new Error(`${self} can only use its own computer, not ${input.agent}'s`);
      } else {
        // A model session that names no agent (a bare "mcp", "mcp:thread:<id>", the harness) has no computer of its own.
        if (/^(mcp|harness)\b/.test(String(caller || ""))) throw Object.assign(new Error("a model session may only act on its own agent's computer; it names no agent"), { code: "denied" });
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

    /** May the agent's hands look right now? Refused only while shielded. Throws if not. */
    const mayRead = async (agent, tool) => {
      const r = await ctx.call("computers.may-act", { agent, tool, read: true });
      if (!r.error && r.data && r.data.ok === false) throw new Error(r.data.why);
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

    /** tree, apps and screenshot only look; act drives the desktop. */
    const tool = (name, description, input, run) => ctx.tool(name, { description, input, run, callers: CALLERS, effect: name === "hands-desktop.act" ? "write" : "read" });

    tool("hands-desktop.tree", "The accessibility tree of an app in the agent's computer, shaped into the controls the hands can act on.",
      obj({ agent: str, thread: str, app: str }, ["agent"]),
      async (i, { caller }) => {
        const agent = await resolveAgent(i, caller);
        await mayRead(agent, "hands-desktop.tree");
        const client = await clientFor(agent, i.thread);
        return snapshot.toSnapshot(i.app || "", await client.tree(i.app || undefined));
      });

    tool("hands-desktop.apps", "Apps running in the agent's computer, from AT-SPI.",
      obj({ agent: str, thread: str }, ["agent"]),
      async (i, { caller }) => {
        const agent = await resolveAgent(i, caller);
        await mayRead(agent, "hands-desktop.apps");
        return { apps: await (await clientFor(agent, i.thread)).apps() };
      });

    tool("hands-desktop.screenshot", "The agent's whole display, base64-encoded: a PNG, or with format jpeg a small JPEG scaled to maxWidth.",
      obj({ agent: str, thread: str, format: { type: "string", enum: ["png", "jpeg"], description: "png by default; jpeg gives a small still for a phone" }, maxWidth: { type: "integer", minimum: 160, maximum: 1920, description: "jpeg width, default 640" } }, ["agent"]),
      async (i, { caller }) => {
        const agent = await resolveAgent(i, caller);
        await mayRead(agent, "hands-desktop.screenshot");
        const jpeg = i.format === "jpeg";
        const bytes = await (await clientFor(agent, i.thread)).screenshot(jpeg ? { format: "jpeg", width: i.maxWidth } : {});
        return { image: bytes.toString("base64"), mime: jpeg ? "image/jpeg" : "image/png" };
      });

    tool("hands-desktop.act",
      "Find a named control, press, focus or type into it, and verify the window changed. Consequential controls (send, pay, delete) are refused: use Glass.",
      obj({
        agent: str, thread: str, app: str, name: str, role: str,
        action: { type: "string", enum: ["press", "focus", "set-text"], description: "press by default; set-text types value" },
        value: { ...str, description: "text to type with set-text" },
      }, ["agent", "name"]),
      async (i, meta) => {
        const { caller } = meta;
        const agent = await resolveAgent(i, caller);
        await mayRead(agent, "hands-desktop.act");
        const client = await clientFor(agent, i.thread);
        const actionName = i.action || "press";
        const result = await act.once({
          app: i.app || "",
          request: { name: i.name, role: i.role },
          perceive: perceiveWith(client, i.app),
          decide: decideFor({ name: i.name, role: i.role }),
          click: clickWith(client, agent)(actionName, i.value),
        });
        // The thread is the one vyred traced the call to. A person's own surface may name one; any
        // other caller naming a thread would put its steps in someone else's chat (e2e review).
        // The call links the step to the chat row that asked for it (ADR 0036), as a link only.
        const kind = callerKind(caller);
        // callerKind drops an agent label ("cli agent:kit" is "cli"): an agent vouched on a person's
        // surface is still an agent, and names no thread.
        const person = PERSON_SURFACES.has(kind) && !/(?:^|[\s:])agent:/.test(String(caller));
        const thread = meta.thread ? String(meta.thread) : i.thread && person ? String(i.thread) : null;
        const line = (/** @type {unknown} */ x) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
        ctx.events.emit("desktop.acted",
          { agent, action: actionName, summary: line(i.name), ok: result.ok, ...(i.app ? { app: line(i.app) } : {}),
            ...(thread ? { thread } : {}), ...(meta.call ? { call: String(meta.call) } : {}),
            ...(result.ok ? {} : { why: line(result.why) }) },
          thread ? { thread } : {});
        return result;
      });

    return { async stop() {} };
  },
};
