// @ts-check
// Which computers Glass can open.
//
// The Computer tab calls computers.agent.status. That reads computers_agent_users: asleep, waking or live, including the owner's assistant, who is created without computer: true.
// Glass calls computers.list and looks up the target computer:<id>. That list used to be only pool rows and agents with computer: true, so a live assistant was "Glass does not know a computer".
// An agent-user row is that same computer. perAgent tells computers.watch to open the agent's own screen (computers.agent.watch), not a desktop container.

/**
 * @param {Array<Record<string, any>> | null | undefined} listed rows already in computers.list (desktops and computer: true)
 * @param {Array<{ agent?: string, state?: string }> | null | undefined} space agent-user rows; state "none" is not a computer yet
 * @returns {Array<Record<string, any>>}
 */
export function glassComputers(listed, space) {
  /** @type {Map<string, string>} */
  const bySpace = new Map();
  for (const u of space || []) {
    if (!u || !u.agent || u.state == null || u.state === "" || u.state === "none") continue;
    bySpace.set(String(u.agent), String(u.state));
  }
  /** @type {Array<Record<string, any>>} */
  const rows = [];
  const seen = new Set();
  for (const c of listed || []) {
    if (!c || !c.agent) continue;
    const agent = String(c.agent);
    seen.add(agent);
    const onSpace = bySpace.get(agent);
    if (onSpace) rows.push({ ...c, agent, state: onSpace, perAgent: true });
    else rows.push({ ...c, agent, perAgent: false });
  }
  for (const [agent, state] of bySpace) {
    if (seen.has(agent)) continue;
    rows.push({ agent, state, screen: null, thread: null, viewers: 0, takeover: null, paused: false, label: null, perAgent: true });
  }
  rows.sort((a, b) => (a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0));
  return rows;
}
