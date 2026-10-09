// @ts-check
// lib/docs-corpus: the docs as the docs tool serves them (core/docs) and as the checks measure them (scripts/gen-agent-docs.mjs): two sets read from the same docs/ tree.
//
//   human   the pages of docs/nav.json `sections`: what vyre.run publishes
//   agent   the pages of docs/nav.json `agents`: docs/agents/*.md, audience agents only, never published, never offered to a person
//
// A page is { path, set, title, summary, when, audience, budget, tokens, headings, body }. Pure and synchronous (it reads files), no feature state: any part may import it.
import fs from "node:fs";
import path from "node:path";
import { tokens } from "./tokens.js";

/** The front matter of a page: a small subset of YAML (`key: value`, quotes optional, a trailing `# comment`, inline `[a, b]`). @param {string} text @returns {{ data: Record<string, string | string[]>, body: string }} */
export function frontMatter(text) {
  const t = String(text).replace(/\r\n?/g, "\n");
  if (!t.startsWith("---\n")) return { data: {}, body: t };
  const end = t.indexOf("\n---", 4);
  if (end < 0) return { data: {}, body: t };
  /** @type {Record<string, string | string[]>} */ const data = {};
  for (const line of t.slice(4, end).split("\n")) {
    const m = /^([A-Za-z][\w-]*):\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2].replace(/\s+#.*$/, "");
    if (/^\[.*\]$/.test(v)) { data[m[1]] = v.slice(1, -1).split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean); continue; }
    v = v.replace(/^["']|["']$/g, "");
    data[m[1]] = v;
  }
  const rest = t.slice(end + 4);
  return { data, body: rest.replace(/^\n+/, "") };
}

const list = (v) => (Array.isArray(v) ? v : String(v || "").split(",").map((x) => x.trim()).filter(Boolean));

/** The headings of a body, outside code fences, each with where its section starts and ends in the body. @param {string} body */
export function headings(body) {
  /** @type {{ level: number, text: string, anchor: string, start: number, end: number }[]} */ const out = [];
  let fence = false, at = 0;
  for (const line of body.split("\n")) {
    if (/^ {0,3}(`{3,}|~{3,})/.test(line)) fence = !fence;
    const m = !fence && /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (m) {
      const text = m[2].replace(/[`*_]/g, "").trim();
      if (out.length) out[out.length - 1].end = at;
      out.push({ level: m[1].length, text, anchor: text.toLowerCase().replace(/[^a-z0-9 -]/g, "").trim().replace(/\s+/g, "-"), start: at, end: body.length });
    }
    at += line.length + 1;
  }
  return out;
}

/** @param {string} root the folder holding docs/ @param {string} rel docs-relative path @param {"human" | "agent"} set */
function readPage(root, rel, set) {
  const file = path.join(root, "docs", rel);
  if (!fs.existsSync(file)) return null;
  const { data, body } = frontMatter(fs.readFileSync(file, "utf8"));
  if (data.redirect) return null;
  const h1 = /^#\s+(.+)$/m.exec(body);
  const budget = Number(data.tokens);
  return {
    path: rel, set,
    title: String(data.title || (h1 && h1[1]) || path.basename(rel, ".md")),
    summary: String(data.summary || ""), when: String(data.when || ""),
    audience: list(data.audience), budget: Number.isInteger(budget) && budget > 0 ? budget : null,
    tokens: tokens(body), headings: headings(body), body,
  };
}

/**
 * Every page of both sets. A page that is listed but missing is left out here (the docs check reports it).
 * @param {string} root @returns {{ human: ReturnType<typeof readPage>[], agent: ReturnType<typeof readPage>[] }}
 */
export function loadCorpus(root) {
  let nav = { sections: [], agents: [] };
  try { nav = JSON.parse(fs.readFileSync(path.join(root, "docs", "nav.json"), "utf8")); } catch { /* an empty corpus */ }
  const human = [], agent = [], seen = new Set();
  for (const s of nav.sections || []) for (const p of s.pages || []) {
    if (seen.has(p)) continue; seen.add(p);
    const page = readPage(root, p, "human");
    if (page) human.push(page);
  }
  for (const p of nav.agents || []) {
    if (seen.has(p)) continue; seen.add(p);
    const page = readPage(root, p, "agent");
    if (page) agent.push(page);
  }
  return { human: human.filter(Boolean), agent: agent.filter(Boolean) };
}

/** The text of one section of a page (its heading and everything under it to the next heading of the same or a higher level), or null. @param {{ body: string, headings: ReturnType<typeof headings> }} page @param {string} want an anchor or the heading's words */
export function section(page, want) {
  const w = String(want).toLowerCase().replace(/^#/, "").trim();
  const i = page.headings.findIndex((h) => h.anchor === w || h.text.toLowerCase() === w);
  if (i < 0) return null;
  const h = page.headings[i];
  let end = page.body.length;
  for (let j = i + 1; j < page.headings.length; j++) if (page.headings[j].level <= h.level) { end = page.headings[j].start; break; }
  return page.body.slice(h.start, end).trimEnd();
}
