// @ts-check
// work.chat.summary's agent rows (the pinned Assistant and every other agent), as a map by the agent's name: how many threads, the latest, the live one and whether it needs the person.
// Pure; useConvos reads the box and gives the answer here.

/** @param {unknown} data work.chat.summary's answer @returns {Map<string, { count: number, latest?: string, at?: number, live?: string, needs?: boolean }>} */
export function summaryByAgent(data) {
  const out = new Map();
  const d = /** @type {any} */ (data && typeof data === "object" ? data : {});
  for (const row of [...(Array.isArray(d.pinned) ? d.pinned : []), ...(Array.isArray(d.agents) ? d.agents : [])]) {
    if (!row || typeof row !== "object" || row.kind !== "agent") continue;
    const name = String(row.agent ?? row.name ?? "");
    if (!name) continue;
    out.set(name, {
      count: Number(row.threads) || 0,
      ...(row.latest && row.latest.title ? { latest: String(row.latest.title), at: Number(row.latest.last_active) || 0 } : {}),
      ...(row.live && row.live.title ? { live: String(row.live.title), needs: row.live.needs_you === true || row.needs_you === true } : {}),
    });
  }
  return out;
}
