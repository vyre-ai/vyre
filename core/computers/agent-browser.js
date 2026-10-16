// @ts-check
// agent-browser: the one vyred implementation for reaching an agent's Chrome on the box.
//
// Every caller (hands-chrome via computers.endpoint, Glass screencast, helper/shield/fill, checkout)
// goes through here so shared-browser membership, desktop checkout, and token shape stay aligned.

import { NO_DRIVER } from "./pool.js";
import { helper as thawHelper } from "./helper.js";
import { cdpUrlOf, glassStreamPath, sharedBrowserOn } from "../../lib/browser-access.js";
import { Cdp } from "../../lib/cdp.js";

/**
 * @param {{ pool: import("./pool.js").Pool, shared: import("./shared-browser.js").SharedBrowser,
 *   cfg: () => any }} deps
 */
export class AgentBrowser {
  constructor(deps) {
    this.pool = deps.pool;
    this.shared = deps.shared;
    this.cfg = deps.cfg;
  }

  mode() {
    return sharedBrowserOn(this.cfg()) ? "browser" : "desktop";
  }

  /** @param {string} agent @param {{ thread?: string|null, why?: string }} [o] */
  async endpoint(agent, o = {}) {
    if (!this.pool.driver) throw new Error(NO_DRIVER);
    if (this.mode() === "browser") {
      await this.shared.hold(agent, { thread: o.thread || null, why: o.why });
      return { ...await this.shared.endpoint(agent), mode: "browser" };
    }
    await this.pool.checkout(agent, { thread: o.thread, why: o.why || "hands" });
    return { helper: this.pool.endpoint(agent).helper, mode: "desktop" };
  }

  /** Thaw/touch without claiming a desktop screen (Glass files, shield). @param {string} agent */
  async touch(agent) {
    if (!this.pool.driver) throw new Error(NO_DRIVER);
    if (this.mode() === "browser") return this.shared.touch(agent);
    return this.pool.serial(agent, async () => {
      await this.pool.allowed(agent);
      await this.pool.ensure(agent);
      if (!this.pool.touch(agent)) this.pool.idle.set(agent, this.pool.now());
    });
  }

  /** @param {string} agent */
  async helper(agent) {
    if (this.mode() === "browser") {
      await this.shared.touch(agent);
      return (await this.shared.endpoint(agent)).helper;
    }
    return thawHelper(this.pool, agent);
  }

  /** @param {string} agent @param {{ thread?: string|null, why?: string }} [o] */
  async checkout(agent, o = {}) {
    if (this.mode() === "browser") {
      await this.shared.hold(agent, o);
      return { agent, screen: null, thread: o.thread || null };
    }
    return this.pool.checkout(agent, o);
  }

  computerRow(agent) {
    return this.mode() === "browser" ? this.shared.computer() : agent;
  }

  /** @param {string} agent */
  view(agent) {
    return this.mode() === "browser" ? this.shared.view(agent) : this.pool.view(agent);
  }

  glassPath() {
    return glassStreamPath(this.mode());
  }

  /**
   * Open CDP through the same helper token computers.endpoint would return.
   * @param {string} agent @param {{ thread?: string|null, why?: string, page?: boolean }} [o]
   */
  async openCdp(agent, o = {}) {
    const ep = await this.endpoint(agent, { thread: o.thread, why: o.why || "cdp" });
    const cdp = new Cdp({ cdpUrl: cdpUrlOf(ep.helper), token: ep.helper.token });
    await cdp.connect();
    const sessionId = o.page === false ? null : await cdp.page();
    return { cdp, sessionId, helper: ep.helper, mode: ep.mode };
  }

  /** Hold a Glass viewer slot. @param {string} agent @param {number} delta */
  async viewer(agent, delta) {
    if (this.mode() === "browser") {
      if (delta > 0) await this.shared.hold(agent, { why: "watch" });
      return this.shared.viewer(agent, delta);
    }
    return this.pool.viewer(agent, delta);
  }
}

export { cdpUrlOf };
