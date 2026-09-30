// @ts-check
// statusline: the short line under every Claude Code session: `vyre · 2 need you · box ok · juno idle`.
//
// Claude Code runs the statusLine command often, so that command (harness/statusline/statusline.sh)
// must not ask vyred anything. This module does the asking instead: it recomputes the line when
// something happens and leaves it in <home>/statusline, where the script reads it with no network
// and no node. Line 1 of the file is vyred's pid, so a stale file from a dead vyred shows nothing.
// Every tool used here may be missing; each missing one only drops its part of the line.

import fs from "node:fs";
import path from "node:path";

const DEBOUNCE_MS = 1000;
// A steady stream of events (a turn's text arriving) must not hold the line back forever.
const MAX_WAIT_MS = 5000;
// Reachability of the box can change with no event at all; SPEC principle 8 allows nothing faster.
const TICK_MS = 60_000;
const IGNORE = new Set(["file.touched"]);

/** The assistant's status, in as few words as the line has room for. */
const SHORT = { "waiting on your answer": "waits on you" };

/**
 * The line from what the tools answered. Any part may be null (tool missing or failed).
 * `waiting` is waiting.count's answer, the one count push, the Capsule and the Deck show (asks,
 * held drafts, ringing reminders, pairing requests); a vyred without the waiting module falls
 * back to held drafts plus asks.
 * @param {{ waiting?: { count?: number }|null, held?: any[]|null, asks?: any[]|null, link?: any, agents?: any[]|null }} parts
 */
export function compose({ waiting, held, asks, link, agents }) {
  const bits = ["vyre"];
  const need = waiting && Number.isInteger(waiting.count) ? Number(waiting.count)
    : (Array.isArray(held) ? held.length : 0) + (Array.isArray(asks) ? asks.length : 0);
  if (need) bits.push(`${need} need${need === 1 ? "s" : ""} you`);
  if (link && link.role === "local" && link.linked) bits.push(link.reachable ? "box ok" : "box away");
  const a = Array.isArray(agents) ? agents.find(x => x && x.kind === "assistant") : null;
  if (a && a.name) bits.push([a.name, SHORT[a.doing] || a.doing || a.status].filter(Boolean).join(" "));
  return bits.join(" · ");
}

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    const file = path.join(ctx.paths.root, "statusline");
    let written = null, timer = null, first = 0, running = null, again = false, stopped = false;

    /** Another module's answer, or null when it is missing, failing or not running here. */
    const ask = async (tool, input = {}) => {
      try { const r = await ctx.call(tool, input); return r && "data" in r ? r.data : null; } catch { return null; }
    };

    const compute = async () => {
      const [waiting, link, agents] = await Promise.all([ask("waiting.count"),
        ctx.config.role === "local" ? ask("link.status") : null, ask("agents.list")]);
      // Only a vyred without waiting counts the two lists itself.
      const [held, asks] = waiting ? [null, null] : await Promise.all([ask("gate.held"), ask("threads.asks")]);
      return compose({ waiting, held, asks, link, agents });
    };

    /** Write the file only when the text changed, by rename, so the script never reads half a line. */
    const write = line => {
      const text = `${process.pid}\n${line}\n`;
      if (stopped || text === written) return;
      const tmp = `${file}.${process.pid}.tmp`;
      try { fs.writeFileSync(tmp, text, { mode: 0o600 }); fs.renameSync(tmp, file); written = text; }
      catch (e) { try { fs.rmSync(tmp, { force: true }); } catch {} ctx.log(`could not write ${file}: ${/** @type {Error} */ (e).message}`); }
    };

    /** One recompute at a time; an event during one asks for another right after. */
    const refresh = async () => {
      if (running) { again = true; return running; }
      running = (async () => {
        let line;
        do { again = false; line = await compute(); write(line); } while (again && !stopped);
        return line;
      })();
      try { return await running; } finally { running = null; }
    };

    const schedule = () => {
      if (stopped) return;
      const now = Date.now();
      if (!timer) first = now;
      else if (now - first >= MAX_WAIT_MS) return;
      else clearTimeout(timer);
      timer = setTimeout(() => { timer = null; refresh().catch(() => {}); }, DEBOUNCE_MS);
      timer.unref();
    };

    const off = ctx.events.on("*", e => { if (e.source !== "statusline" && !IGNORE.has(e.type)) schedule(); });
    const tick = setInterval(schedule, TICK_MS);
    tick.unref();

    ctx.tool("statusline.line", {
      description: "The Vyre status line as it is right now, recomputed: what needs the user, the box, the assistant.",
      input: { type: "object", properties: {} },
      // For the terminal and the surfaces; Claude already sees all of this where it matters.
      callers: ["cli", "local", "module", "deck", "capsule"],
      run: async () => ({ line: await refresh() }),
    });

    // Other modules may still be starting; the first line waits the same second any event would.
    schedule();

    return {
      async stop() {
        stopped = true;
        off(); clearInterval(tick); if (timer) clearTimeout(timer);
        try { if (running) await running; } catch {}
        try { fs.rmSync(file, { force: true }); } catch {}
      },
    };
  },
};
