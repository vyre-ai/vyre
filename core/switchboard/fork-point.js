// @ts-check
// Where a thread forks: the transcript holds the agent's reply, and the fork keeps everything up to and including its last line. The Switchboard says where a run's transcript is (find), so this file
// holds no provider's file naming.
import fs from "node:fs";

/**
 * The run that holds the agent's message `want` (the id the chat's frames carry, which is the provider's message id, or a transcript line's own uuid) and the uuid of that message's LAST line: the cut.
 * Newest run first (a rolled-over chat has several). Throws, in plain words, when the chat has no run or no run holds the message.
 * @param {any[]} runs the chat's runs, newest first @param {(run: any) => { file: string } | null} find the run's transcript, or null @param {string} want
 * @returns {{ run: string, uuid: string }}
 */
export function forkCut(runs, find, want) {
  if (!runs.length) throw Object.assign(new Error("this thread has no conversation yet, so there is nothing to fork from: send a message in it first, then fork one of the replies"), { code: "not_found" });
  for (const r of runs) {
    const t = find(r);
    if (!t) continue;
    let hit = null;
    for (const l of fs.readFileSync(t.file, "utf8").split("\n")) {
      if (!l.includes(want)) continue;
      try { const j = JSON.parse(l); if (j.type === "assistant" && j.uuid && (j.uuid === want || (j.message && j.message.id === want))) hit = j; } catch { /* a line that is not json */ }
    }
    if (hit) return { run: r.thread, uuid: String(hit.uuid) };
  }
  throw Object.assign(new Error("that is not one of the agent's replies in this thread: pick a reply from this thread and fork from that"), { code: "not_found" });
}
