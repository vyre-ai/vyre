// @ts-check
// A turn hit its provider's limit. The routing list wins when it names a next entry. Otherwise the
// asker's next signed-in account takes the turn, and the chat says so in one line (switched.js).

/**
 * @param {any} sb the Switchboard
 * @param {string} id thread
 * @param {any} st the live run
 * @returns {Promise<boolean>} true when the turn moved
 */
export async function routeFallback(sb, id, st) {
  // One at a time: a second limit line for the same turn arrives before the first has set `switching`.
  if (st.routing) return false;
  st.routing = true;
  let switched = false;
  try {
    const rec = sb.must(id);
    st.tried = st.tried || new Set();
    const provider = rec.provider || "claude";
    const account = rec.account || null;
    const tried = [...st.tried];
    const scope = { provider, ...(account ? { account } : {}), ...(rec.agent ? { agent: rec.agent } : {}), ...(rec.project ? { project: rec.project } : {}), tried };
    const listed = await sb.deps.call("sessions.routes.next", scope).catch(() => ({}));
    let hit = listed.data && listed.data.entry;
    let fromNext = false;
    if (!hit) {
      const asker = sb.turnAsker.get(id) || null;
      const n = await sb.deps.call("sessions.accounts.nextSigned", { provider, ...(account ? { account } : {}), ...(asker ? { person: asker } : {}), tried }).catch(() => ({}));
      hit = n.data && n.data.entry;
      fromNext = Boolean(hit);
    }
    if (!hit) return false;
    const last = st.lastPrompt || null;
    const triedNow = new Set([...st.tried, `${provider}:${account || ""}`]);
    const asker = fromNext ? (sb.turnAsker.get(id) || null) : null;
    st.switching = true;
    try {
      await sb.switchProvider(id, { provider: hit.provider, account: hit.account || null, model: hit.model || null, reason: "limit", text: last, ...(asker ? { person: asker } : {}) });
      switched = true;
    } finally { const now = sb.live.get(id); if (now) now.tried = triedNow; }
    return true;
  } finally {
    // Only a switch that happened retires this state; any other way out lets the next limit try again.
    if (!switched) { st.routing = false; if (sb.live.get(id) === st) st.switching = false; }
  }
}
