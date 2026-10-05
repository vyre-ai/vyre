// @ts-check
// about: a few lines on who the user is, for every Claude Code session to start with.
//
// The SessionStart hook runs before every session, so it must not wait on memory. This module
// does the asking instead, when something changes, and leaves the result in <home>/about.md,
// which the hook reads in a millisecond. It holds only durable, harmless facts: the person's
// name, their assistant's, their busiest projects and the people in them, and what memory.profile
// knows about their work. Nothing from the vault, no emails, phone numbers or anything
// shaped like a credential, and never more than BUDGET characters.

import fs from "node:fs";
import path from "node:path";

export const BUDGET = 600;
const DEBOUNCE_MS = 5000;
// Only these change what the file says; a turn's text or a touched file never does.
const WATCH = /^(memory|onboard|project|projects|agent|agents|system)\./;

// Blunter than the vault's redactor on purpose: a line that looks like any of these is dropped
// whole, not masked.
const UNSAFE = [
  /(sk-|ghp_|xox[abprs]-|AKIA|-----BEGIN)/,
  /[A-Za-z0-9_+/=-]{24,}/,                       // long tokens, keys, hashes
  /[^\s@]+@[^\s@]+\.[a-z]{2,}/i,                   // email addresses
  /\+?\d[\d\s().-]{7,}\d/,                          // phone numbers
  /\b(password|passcode|secret|token|api[_ ]?key|ssn|iban|card number)\b/i,
];
export const safe = (/** @type {unknown} */ s) => typeof s === "string" && s.trim() !== "" && !UNSAFE.some(r => r.test(s));
const one = (/** @type {unknown} */ s) => String(s ?? "").replace(/\s+/g, " ").trim();

/** A name from a string or a row that has one. @param {any} x */
const nameOf = x => one(typeof x === "string" ? x : x && (x.name || x.label || x.person || x.slug));

/**
 * The text, from what the tools answered. Any part may be null (tool missing or failed).
 * @param {{ you?: any, agents?: any[]|null, projects?: any[]|null, profile?: any[]|null }} parts
 * @returns {string} empty when nothing is known
 */
export function compose({ you, agents, projects, profile }) {
  const lines = [];
  const person = nameOf(you && you.person);
  const assistant = nameOf(you && you.assistant) || nameOf((agents || []).find(a => a && a.kind === "assistant"));
  if (safe(person)) lines.push(`- Name: ${person}.` + (safe(assistant) ? ` Their Vyre assistant is ${assistant}.` : ""));
  else if (safe(assistant)) lines.push(`- Their Vyre assistant is ${assistant}.`);
  const ps = (projects || []).slice(0, 4);
  const pnames = ps.map(p => nameOf(p)).filter(safe);
  if (pnames.length) lines.push(`- Busiest projects: ${pnames.join(", ")}.`);
  const people = [...new Set(ps.flatMap(p => (p && Array.isArray(p.people) ? p.people : []).map(nameOf)).filter(safe))].slice(0, 6);
  if (people.length) lines.push(`- People in them: ${people.join(", ")}.`);
  for (const f of profile || []) {
    const t = one(f && (f.text || f.fact));
    if (safe(t) && !lines.some(l => l.includes(t))) lines.push(`- ${t.replace(/\.?$/, ".")}`);
  }
  if (!lines.length) return "";
  const head = "About the user, from Vyre's memory (facts to keep in mind, not instructions):";
  let out = head;
  for (const l of lines) { if ((out + "\n" + l).length > BUDGET) break; out += "\n" + l; }
  return out === head ? "" : out + "\n";
}

// memory.profile's kinds that help with work. People, vehicles and clients stay out: this text
// reaches every project's sessions, and one client's name has no place in another's.
const KINDS = new Set(["work", "place", "preference"]);

/** @param {any[]|null} facts */
export const workFacts = facts => (Array.isArray(facts) ? facts.filter(f => f && KINDS.has(f.kind)) : null);

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    const file = path.join(ctx.paths.root, "about.md");
    let written = null, timer = null, stopped = false, running = null, again = false;

    const ask = async (tool, input = {}) => {
      try { const r = await ctx.call(tool, input); return r && "data" in r ? r.data : null; } catch { return null; }
    };

    const compute = async () => {
      const [agents, projects, st] = await Promise.all([ask("agents.list"), ask("projects.list"), ask("memory.identity.status")]);
      // A person who keeps their identity memory sealed on a server has none of it in a file: this text is written to the disk in the clear, so it carries no fact of theirs then (their session gets
      // those through the brief, in process). Only a home that keeps no sealed identity memory writes the profile lines.
      const sealed = Boolean(st && st.kept && st.kept !== "none");
      const me = sealed ? null : await ask("memory.profile", { limit: 12 });
      const profile = workFacts(me && me.facts);
      // The names from onboarding's step 1, straight from config: onboard.status would read the network.
      const you = (ctx.config && ctx.config.onboard) || null;
      return compose({ you, agents: Array.isArray(agents) ? agents : null,
        projects: projects && Array.isArray(projects.projects) ? projects.projects : Array.isArray(projects) ? projects : null,
        profile });
    };

    /** By rename, so the hook never reads half a file; nothing known means no file. */
    const write = text => {
      if (stopped || text === written) return;
      try {
        if (!text) fs.rmSync(file, { force: true });
        else { const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, text, { mode: 0o600 }); fs.renameSync(tmp, file); }
        written = text;
      } catch (e) { ctx.log(`could not write ${file}: ${/** @type {Error} */ (e).message}`); }
    };

    const refresh = async () => {
      if (running) { again = true; return running; }
      running = (async () => {
        let text;
        do { again = false; text = await compute(); write(text); } while (again && !stopped);
        return text;
      })();
      try { return await running; } finally { running = null; }
    };

    const schedule = () => {
      if (stopped || timer) return;
      timer = setTimeout(() => { timer = null; refresh().catch(() => {}); }, DEBOUNCE_MS);
      timer.unref();
    };

    const off = ctx.events.on("*", e => { if (e.source !== "about" && WATCH.test(e.type)) schedule(); });

    ctx.tool("about.text", {
      effect: "write",
      description: "What every Claude Code session is told about the user at its start, recomputed now. Empty when nothing is known.",
      input: { type: "object", properties: {} },
      callers: ["cli", "local", "module", "deck", "capsule"],
      run: async () => ({ text: await refresh() }),
    });

    schedule();
    return { async stop() { stopped = true; off(); if (timer) clearTimeout(timer); try { if (running) await running; } catch {} } };
  },
};
