// @ts-check
// browser-profiles: seal shared-browser context exports on the space server and restore them on start.

import {
  agentProfilePath,
  keyFromVault,
  memberProfilePath,
  readSealedProfile,
  writeSealedProfile,
} from "../../lib/browser-profile-store.js";
import { AGENT_BROWSER_PROFILE_KEY, MEMBER_BROWSER_PROFILE_KEY } from "../../lib/browser-profile.js";

/**
 * @param {{ pool: import("./pool.js").Pool, dataRoot: string,
 *   agentKey: () => Promise<string>,
 *   memberKey?: (personId: string) => Promise<string>,
 *   log?: (m: string) => void }} deps
 */
export class BrowserProfiles {
  constructor(deps) {
    this.pool = deps.pool;
    this.dataRoot = deps.dataRoot;
    this.agentKey = deps.agentKey;
    this.memberKey = deps.memberKey || null;
    this.log = deps.log || (() => {});
  }

  /** @param {string} computerId */
  members(computerId) {
    return this.pool.members(computerId);
  }

  /**
   * @param {string} computerId @param {string} agentId
   */
  async exportContext(computerId, agentId) {
    const h = this.pool.endpoint(computerId).helper;
    const res = await this.pool._helperFetch(new URL("/agents/profile/export", h.url), {
      method: "POST",
      headers: { authorization: `Bearer ${h.token}`, "content-type": "application/json" },
      body: JSON.stringify({ id: agentId }),
    });
    let body; try { body = await res.json(); } catch { body = null; }
    if (!res.ok) throw new Error(`profile export refused: ${(body && body.error && body.error.message) || res.status}`);
    return body && body.state ? body.state : { v: 1, cookies: [] };
  }

  /**
   * @param {string} computerId @param {string} agentId @param {any} state
   */
  async importContext(computerId, agentId, state) {
    const h = this.pool.endpoint(computerId).helper;
    const res = await this.pool._helperFetch(new URL("/agents/profile/import", h.url), {
      method: "POST",
      headers: { authorization: `Bearer ${h.token}`, "content-type": "application/json" },
      body: JSON.stringify({ id: agentId, state }),
    });
    let body; try { body = await res.json(); } catch { body = null; }
    if (!res.ok) throw new Error(`profile import refused: ${(body && body.error && body.error.message) || res.status}`);
    return Boolean(body && body.imported);
  }

  /** @param {string} computerId @param {string} agentId */
  async persistAgent(computerId, agentId) {
    const state = await this.exportContext(computerId, agentId);
    const plain = Buffer.from(JSON.stringify(state), "utf8");
    const key = keyFromVault(await this.agentKey());
    await writeSealedProfile(key, agentProfilePath(this.dataRoot, computerId, agentId), plain);
    this.log(`sealed browser profile for ${agentId} on ${computerId}`);
  }

  /** @param {string} computerId @param {string} agentId */
  async restoreAgent(computerId, agentId) {
    const key = keyFromVault(await this.agentKey());
    const plain = await readSealedProfile(key, agentProfilePath(this.dataRoot, computerId, agentId));
    if (!plain) return false;
    const state = JSON.parse(plain.toString("utf8"));
    await this.importContext(computerId, agentId, state);
    this.log(`restored browser profile for ${agentId} on ${computerId}`);
    return true;
  }

  /** @param {string} computerId @param {string} personId @param {any} state */
  async persistMember(computerId, personId, state) {
    if (!this.memberKey) return;
    const plain = Buffer.from(JSON.stringify(state), "utf8");
    const key = keyFromVault(await this.memberKey(personId));
    await writeSealedProfile(key, memberProfilePath(this.dataRoot, computerId, personId), plain);
    this.log(`sealed member browser profile for ${personId} on ${computerId}`);
  }

  /** @param {string} computerId @param {string} personId @param {string} storageAgentId id used in cdpmux for this member context */
  async restoreMember(computerId, personId, storageAgentId) {
    if (!this.memberKey) return false;
    const key = keyFromVault(await this.memberKey(personId));
    const plain = await readSealedProfile(key, memberProfilePath(this.dataRoot, computerId, personId));
    if (!plain) return false;
    const state = JSON.parse(plain.toString("utf8"));
    await this.importContext(computerId, storageAgentId, state);
    this.log(`restored member browser profile for ${personId} on ${computerId}`);
    return true;
  }

  /** @param {string} computerId */
  async persistAll(computerId) {
    for (const m of this.members(computerId)) {
      try { await this.persistAgent(computerId, m.agent_id); } catch (e) { this.log(`could not seal ${m.agent_id}: ${/** @type {Error} */ (e).message}`); }
    }
  }

  /** @param {string} computerId */
  async restoreAll(computerId) {
    for (const m of this.members(computerId)) {
      try { await this.restoreAgent(computerId, m.agent_id); } catch (e) { this.log(`could not restore ${m.agent_id}: ${/** @type {Error} */ (e).message}`); }
    }
  }
}

export { AGENT_BROWSER_PROFILE_KEY, MEMBER_BROWSER_PROFILE_KEY };
