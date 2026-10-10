// @ts-check
// docs: the docs, found and read from inside Vyre (0.3.1, R031-00h). Two tools:
//
//   docs.find { query, limit?, set? }       the best pages for an intent in plain words, each with what it is for (`when`), its audience and what it costs to read
//   docs.read { page, heading?, max_tokens? }   a page, or one section of it, within a token budget; a long page comes back as its outline and the first sections that fit
//
// Two sets come from one tree (lib/docs-corpus.js): the human docs (what vyre.run publishes) and the agent docs (docs/agents, audience agents only). A person's own surface gets the human docs. A caller that is not
// a person (a session, an agent, the harness, a module) gets both, because an agent working through Vyre may need either. The agent docs are not secret (the code is open source); they are simply not offered to people.
// Ranking is lib/docs-rank.js, pure and deterministic. Nothing here writes, sends or reaches the network.

import { PKG_ROOT } from "../../kernel/devbuild.js";
import { isPerson } from "../../lib/caller.js";
import { loadCorpus, section } from "../../lib/docs-corpus.js";
import { buildIndex, search } from "../../lib/docs-rank.js";
import { tokens } from "../../lib/tokens.js";
import fs from "node:fs";
import path from "node:path";

/** Test seam: a corpus root per home. @type {Map<string, { root: string }>} */
export const seams = new Map();

const DEFAULT_READ = 3000, MAX_READ = 20000;
/** Pages that record why or how something was decided, not how to do it: found when asked for by name, but not first for an intent. */
const HISTORY = /^(adr|design|releases|proposals)\//;
const err = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });

/** @param {string} root */
function open(root) {
  const nav = path.join(root, "docs", "nav.json");
  let stamp = "";
  /** @type {null | { all: any[], index: ReturnType<typeof buildIndex>, humanIndex: ReturnType<typeof buildIndex> }} */ let cache = null;
  return () => {
    let s = "";
    try { s = String(fs.statSync(nav).mtimeMs); } catch { s = "none"; }
    if (!cache || s !== stamp) {
      const c = loadCorpus(root), all = [...c.human, ...c.agent];
      cache = { all, index: buildIndex(all), humanIndex: buildIndex(c.human) };
      stamp = s;
    }
    return cache;
  };
}

/** The page a name points at: its docs-relative path with or without .md, or a unique file name. @param {any[]} pages @param {string} name */
export function resolve(pages, name) {
  const n = String(name || "").trim().replace(/^\/+/, "").replace(/#.*$/, "");
  const want = n.endsWith(".md") ? n : `${n}.md`;
  const exact = pages.find((p) => p.path === want || p.path === `${n}/index.md`);
  if (exact) return exact;
  const base = pages.filter((p) => path.posix.basename(p.path) === path.posix.basename(want));
  return base.length === 1 ? base[0] : null;
}

/** The outline of a page, and as many of its sections as fit a budget, in order. @param {any} page @param {number} max */
function fit(page, max) {
  const out = [], used = { n: 0 };
  const top = page.headings.filter((/** @type {any} */ h) => h.level <= 2);
  const intro = page.headings.length ? page.body.slice(0, page.headings[0].start) : page.body;
  out.push(intro.trim()); used.n += tokens(intro);
  const left = [];
  for (const h of top) {
    const text = section(page, h.anchor) || "";
    if (used.n + tokens(text) <= max) { out.push(text); used.n += tokens(text); } else left.push(h.text);
  }
  return { text: out.filter(Boolean).join("\n\n"), left };
}

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    const seam = seams.get(ctx.paths && ctx.paths.root);
    const corpus = open(seam ? seam.root : PKG_ROOT);
    /** Both sets for a caller that is not a person, the human set for a person. @param {any} meta */
    const audienceOf = (meta) => (isPerson(meta) ? "human" : "both");

    ctx.tool("docs.find", {
      effect: "read",
      description: "Find docs pages for an intent: { query, limit? } -> best-first { page, title, when, tokens, set }. Read one with docs.read.",
      input: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 300, description: "what you want to do, in plain words" }, limit: { type: "integer", minimum: 1, maximum: 8, description: "default 5" }, set: { type: "string", enum: ["human", "agent", "both"] } }, required: ["query"] },
      run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
        const c = corpus();
        const aud = audienceOf(meta);
        let set = input.set || aud;
        if (aud === "human") set = "human";   // a person is never offered the agent set, whatever they ask for
        const index = set === "human" ? c.humanIndex : c.index;
        let hits = search(index, String(input.query), { limit: Math.max(8, input.limit || 5) * 2, prefer: aud === "both" ? "agent" : "human", lift: aud === "both" ? 1.6 : 1.12, demote: HISTORY });
        if (set === "agent") hits = hits.filter((h) => h.page.set === "agent");
        hits = hits.slice(0, input.limit || 5);
        return { pages: hits.map((h) => ({ page: h.page.path, title: h.page.title, when: h.page.when || h.page.summary, tokens: h.page.tokens, set: h.page.set })) };
      },
    });

    ctx.tool("docs.read", {
      effect: "read",
      description: "Read a docs page, or one section: { page (path from docs.find), heading? }. A long page returns an outline and the first sections.",
      input: { type: "object", properties: { page: { type: "string", minLength: 1, maxLength: 200 }, heading: { type: "string", maxLength: 200, description: "return only this section" }, max_tokens: { type: "integer", minimum: 200, maximum: MAX_READ, description: "default 3000; a longer page returns an outline and the first sections that fit, `more` listing the rest to ask for by heading" } }, required: ["page"] },
      run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
        const c = corpus();
        const pool = audienceOf(meta) === "human" ? c.all.filter((p) => p.set === "human") : c.all;
        const page = resolve(pool, input.page);
        if (!page) {
          const near = search(buildIndex(pool), String(input.page).replace(/[/._-]+/g, " "), { limit: 3 }).map((h) => h.page.path);
          throw err("not_found", `No docs page "${input.page}".${near.length ? ` Closest: ${near.join(", ")}.` : ""} docs.find finds a page from what you want to do.`);
        }
        const max = input.max_tokens || DEFAULT_READ;
        if (input.heading) {
          const text = section(page, input.heading);
          if (text === null) throw err("not_found", `${page.path} has no section "${input.heading}". Its sections: ${page.headings.filter((/** @type {any} */ h) => h.level <= 3).map((/** @type {any} */ h) => h.anchor).join(", ")}.`);
          return { page: page.path, title: page.title, heading: input.heading, tokens: tokens(text), text };
        }
        if (page.tokens <= max) return { page: page.path, title: page.title, tokens: page.tokens, text: page.body.trimEnd() };
        const f = fit(page, max);
        return { page: page.path, title: page.title, tokens: tokens(f.text), of: page.tokens, text: f.text, more: f.left };
      },
    });
    return { async stop() {} };
  },
};
