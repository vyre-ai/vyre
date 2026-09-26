// @ts-check
// brief — what a thread should know the moment it starts inside a project.
//
// When a thread opens in a project it should already know what the project is, who is involved,
// what the other threads have been doing and what the project's memory holds, without anyone
// pasting it in. The Harness's SessionStart hook prints this text; `vyre resume` and `vyre start`
// pass it to Claude Code with --append-system-prompt.
//
// Two rules, both learned the hard way:
//   - From this project only. The caller hands in this project's threads and facts and nothing
//     else, so one client's work cannot leak into another's first turn.
//   - Short. A brief that grows with the project turns every thread's first turn into a context
//     bill, so it carries headlines and pointers, and the thread asks for more.

import os from "node:os";

/** Characters, about 600 tokens, paid once per thread. */
export const LIMIT = 2400;
const THREADS = 6;
const FACTS = 10;

const tilde = p => { const h = os.homedir(); const s = String(p || ""); return s === h || s.startsWith(h + "/") ? "~" + s.slice(h.length) : s; };

/** "12 min ago", "3 h ago", "5 days ago". */
export function ago(t, now = Date.now()) {
  if (!t) return "";
  const s = Math.max(0, (now - t) / 1000);
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + " min ago";
  if (s < 86400) return Math.round(s / 3600) + " h ago";
  return Math.round(s / 86400) + " days ago";
}

/** A thread's label on one short line. An unnamed thread is labelled by its first message, which can be a paragraph. */
export function label(t, max = 80) {
  const s = String((t && (t.name || t.title)) || "(untitled)").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** One memory fact as a line, whatever shape the memory module returns it in. */
function factLine(f) {
  if (typeof f === "string") return f;
  if (!f || typeof f !== "object") return null;
  const text = f.text || f.fact || f.summary || f.label;
  if (!text) return null;
  return String(text).replace(/\s+/g, " ").trim() + (typeof f.confidence === "number" ? ` (${Math.round(f.confidence * 100)}%)` : "");
}

/**
 * The brief as plain text. Pure: it reads no database and no clock except `now`.
 * @param {{ project: import("./markers.js").Project, threads?: any[], facts?: any[], now?: number }} x
 */
export function compose({ project, threads = [], facts = [], now = Date.now() }) {
  const lines = [];
  lines.push(`You are working in the Vyre project "${project.name}"${project.org ? ` (${project.org})` : ""}, home ${tilde(project.home)}.`);
  lines.push("This brief is background from Vyre, built from this project's own threads. What the user says now, and the files in front of you, take priority over it.");
  const people = project.people.map(p => (p.email && p.email !== p.name ? `${p.name} <${p.email}>` : p.name));
  if (people.length) lines.push(`People: ${people.join(", ")}.`);
  if (project.workspaces.length > 1) lines.push(`Folders: ${project.workspaces.map(tilde).join(", ")}.`);
  if (project.watchers.length) lines.push(`Watchers: ${project.watchers.join(", ")}.`);
  if (threads.length) {
    lines.push("Other threads in this project, most recent first:");
    for (const t of threads.slice(0, THREADS)) lines.push(`- ${label(t)}${t.last ? ", " + ago(t.last, now) : ""}`);
    if (threads.length > THREADS) lines.push(`- and ${threads.length - THREADS} more`);
  }
  const fl = facts.map(factLine).filter(Boolean).slice(0, FACTS);
  if (fl.length) {
    lines.push("From this project's memory (facts found in its threads, not verified):");
    for (const f of fl) lines.push(`- ${String(f).length > 160 ? String(f).slice(0, 159) + "…" : f}`);
  }
  let text = lines.join("\n");
  // Over the cap, cut at a line break so Claude never sees half a name or address.
  if (text.length > LIMIT) {
    const cut = text.lastIndexOf("\n", LIMIT - 2);
    text = (cut > 0 ? text.slice(0, cut) : text.slice(0, LIMIT - 2)) + "\n…";
  }
  return text;
}
