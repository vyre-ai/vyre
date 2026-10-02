// @ts-check
// device-history: what the setup step "Your history" shows about the person's own computers (#26). The box asks every paired Mac for its
// import.offer (counts, sizes and dates by source and project folder, never what was said) and this turns the answers into what the step
// draws: per device, per agent, the projects with counts and dates, and one honest sentence.

/**
 * @param {any[]} answers link.macs.call's answers: [{ mac, name, ok, data?: { sources }, error? }]
 * @returns {{ devices: any[], sessions: number, summary: string, found: boolean }}
 */
export function deviceHistory(answers) {
  const devices = (Array.isArray(answers) ? answers : []).map(a => {
    const sources = a && a.ok && a.data && Array.isArray(a.data.sources) ? a.data.sources : [];
    const agents = sources.filter((/** @type {any} */ s) => s && Array.isArray(s.folders) && s.folders.length).map((/** @type {any} */ s) => ({
      agent: String(s.agent || s.kind || "claude-code"), sessions: Number(s.sessions) || 0, bytes: Number(s.bytes) || 0, from: s.from ?? null, to: s.to ?? null,
      folders: s.folders.map((/** @type {any} */ f) => ({ cwd: f.cwd ?? null, name: f.name || null, sessions: Number(f.sessions) || 0, bytes: Number(f.bytes) || 0, from: f.from ?? null, to: f.to ?? null,
        // Ticked by default, except what Vyre never suggests (its own folders, temporary ones), with the reason.
        ticked: f.suggested !== false, ...(f.why ? { why: String(f.why) } : {}) })),
    }));
    const sessions = agents.reduce((n, g) => n + g.sessions, 0);
    const projects = agents.reduce((n, g) => n + g.folders.length, 0);
    return { mac: String(a && a.mac || ""), name: String(a && a.name || "your Mac"), online: Boolean(a && a.ok) || !(a && a.error && a.error.code === "mac_offline"),
      ok: Boolean(a && a.ok), ...(a && !a.ok && a.error ? { why: String(a.error.message || a.error.code || "no answer") } : {}), sessions, projects, agents };
  });
  const sessions = devices.reduce((n, d) => n + d.sessions, 0);
  const found = sessions > 0;
  const plural = (/** @type {number} */ n, /** @type {string} */ w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  let summary;
  if (!devices.length) summary = "No computer is paired yet. Pair your Mac in the next step and import from there.";
  else if (found) summary = `Found ${plural(sessions, "session")} on ${devices.filter(d => d.sessions).map(d => `${d.name} (${plural(d.projects, "project")})`).join(", ")}`;
  else if (devices.some(d => !d.ok)) summary = `${devices.filter(d => !d.ok).map(d => d.name).join(", ")} did not answer, so its history is not listed yet. Open Vyre on it and try again.`;
  else summary = `Nothing found on ${devices.map(d => d.name).join(", ")}: no Claude Code, Codex or Grok history in their usual folders.`;
  return { devices, sessions, summary, found };
}
