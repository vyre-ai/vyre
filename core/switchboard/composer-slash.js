// @ts-check
// Composer slash commands as one kernel tool (threads.slash), shared routing in lib/thread-composer-route.js.

import { routeComposerLine } from "../../lib/thread-composer-route.js";

/**
 * Register threads.slash and move a few small thread tools here so switchboard/index.js stays under its cap.
 * @param {(name: string, desc: string, schema: any, run: any, callers?: string[]) => void} tool
 * @param {{ sb: any, ctx: any, guard: (caller: string, what: string) => void, queuesFor: (caller: string) => boolean, personTurn: (caller: string) => boolean, surfaceOf: (i: any, caller: string) => string, str: any }} o
 */
export function registerComposerSlashTools(tool, o) {
  const { sb, ctx, guard, queuesFor, personTurn, surfaceOf, str } = o;

  tool("threads.commands", "The slash commands a running thread offers, for a composer's / menu. Send one as a message, e.g. \"/compact\".",
    { type: "object", required: ["thread"], properties: { thread: str } },
    async (i, { caller }) => { guard(caller, "read sessions"); return sb.commands(i.thread); });

  tool("threads.shell", "Claude Code's ! mode: run a shell line in the thread's folder, as you, under the security floor. Its output shows here and goes to Claude with your next message. Only a person can.",
    { type: "object", required: ["thread", "command"], properties: { thread: str, command: str } },
    async (i, { caller, thread }) => {
      if (thread && thread === i.thread) throw Object.assign(new Error("a session does not run the person's shell lines"), { code: "denied" });
      return sb.shell(i.thread, i.command);
    }, ["cli", "local", "deck", "capsule"]);

  tool("threads.remember", "/remember (Claude Code's # mode; # is a tag now): add a line to CLAUDE.md: the project's (project, the default), your own (user) or this folder's private one (local, CLAUDE.local.md). Vyre's own memory is separate.",
    { type: "object", required: ["thread", "text"], properties: { thread: str, text: str, scope: { type: "string", enum: ["project", "user", "local"] } } },
    async (i, { caller, thread }) => {
      if (thread && thread === i.thread) throw Object.assign(new Error("a session does not edit its own instructions: the person edits them, or another session does"), { code: "denied" });
      return sb.remember(i.thread, i.text, i.scope || "project");
    }, ["cli", "local", "deck", "capsule"]);

  tool("threads.slash", "Run a composer's / or ! line through the kernel: remember, model, effort, later, find, shell, or the session's own slash (compact, clear, and the rest).",
    { type: "object", required: ["line"], properties: {
      thread: str, chat: str, line: str, surface: str, raw: { type: "boolean" },
      mode: { type: "string", enum: ["steer", "queue"] },
      mentions: { type: "array", maxItems: 8, items: { type: "object", required: ["kind", "id"], properties: { kind: str, id: str, name: str } } },
      pasted: { type: "array", maxItems: 20, items: str },
    } },
    async (i, meta) => {
      const { caller } = meta;
      guard(caller, "send to sessions");
      let thread = typeof i.thread === "string" ? i.thread : "";
      if (!thread && typeof i.chat === "string") {
        const named = /** @type {any} */ (await ctx.call("threads.chat-thread", { thread: i.chat }).catch(() => null));
        thread = named && named.data && named.data.thread ? String(named.data.thread) : "";
      }
      if (!thread) throw Object.assign(new Error("name the chat or the session"), { code: "bad_input" });
      const route = routeComposerLine(String(i.line || ""), Boolean(i.raw));
      const surface = surfaceOf(i, caller);
      const extra = { thread, surface, ...(i.mode ? { mode: i.mode } : {}), ...(Array.isArray(i.mentions) ? { mentions: i.mentions } : {}), ...(Array.isArray(i.pasted) ? { pasted: i.pasted.filter((/** @type {unknown} */ x) => typeof x === "string").slice(0, 20) } : {}) };
      if (route.tool === "threads.send") {
        if (!queuesFor(caller) && route.sendAsMessage) throw Object.assign(new Error("only a person's surface sends slash commands into a session"), { code: "denied" });
        return ctx.call("threads.send", { ...extra, text: String(route.input.text ?? i.line) });
      }
      if (route.tool === "threads.shell" || route.tool === "threads.remember") {
        if (!personTurn(caller)) throw Object.assign(new Error("only a person's surface runs this command"), { code: "denied" });
        return ctx.call(route.tool, { ...extra, ...route.input });
      }
      if (route.tool === "threads.get" && !route.input.model) {
        guard(caller, "read sessions");
        const g = await ctx.call("threads.get", { thread, limit: 50 });
        return g && g.data ? { thread, model: g.data.thread && g.data.thread.model } : { thread, model: null };
      }
      if (route.tool === "planner.add" || route.tool === "recall.search") {
        if (!personTurn(caller)) throw Object.assign(new Error("only a person's surface runs this command"), { code: "denied" });
        return ctx.call(route.tool, route.input, { as: caller });
      }
      if (route.tool === "threads.commands") return ctx.call("threads.commands", { thread });
      return ctx.call(route.tool, { ...extra, ...route.input });
    });
}
