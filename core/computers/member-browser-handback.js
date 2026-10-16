// @ts-check
// member-browser-handback: seal a member's shared-browser session on private take-over handback.

/**
 * @param {{ agentBrowser: import("./agent-browser.js").AgentBrowser, shared: import("./shared-browser.js").SharedBrowser,
 *   browserProfiles: import("./browser-profiles.js").BrowserProfiles, log?: (m: string) => void }} deps
 * @param {string} agent
 * @param {{ personId: string, browserSnap: any }} t
 */
export async function sealMemberBrowserOnHandback(deps, agent, t) {
  if (!t.personId || !t.browserSnap || deps.agentBrowser.mode() !== "browser") return;
  const { computerId, agentId } = await deps.shared.ensureMember(agent);
  const state = await deps.browserProfiles.exportContext(computerId, agentId);
  await deps.browserProfiles.persistMember(computerId, t.personId, state);
  await deps.browserProfiles.importContext(computerId, agentId, t.browserSnap);
  (deps.log || (() => {}))(`member browser profile sealed for ${t.personId} on handback from ${agent}`);
}

/**
 * Before a private take-over on the shared browser: restore the member's saved cookies and remember the agent context.
 * @param {{ agentBrowser: import("./agent-browser.js").AgentBrowser, shared: import("./shared-browser.js").SharedBrowser,
 *   browserProfiles: import("./browser-profiles.js").BrowserProfiles, log?: (m: string) => void }} deps
 * @param {string} agent @param {string} personId
 * @returns {Promise<any|null>} snapshot of the agent context before the member session, or null
 */
export async function beginPrivateMemberBrowser(deps, agent, personId) {
  if (deps.agentBrowser.mode() !== "browser" || !personId) return null;
  const { computerId, agentId } = await deps.shared.ensureMember(agent);
  const browserSnap = await deps.browserProfiles.exportContext(computerId, agentId);
  try {
    await deps.browserProfiles.restoreMember(computerId, personId, agentId);
  } catch (e) {
    (deps.log || (() => {}))(`could not restore member browser profile for ${personId}: ${/** @type {Error} */ (e).message}`);
  }
  return browserSnap;
}
