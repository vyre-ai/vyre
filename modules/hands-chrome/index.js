// @ts-check
// hands-chrome: Chrome control over one long-lived CDP connection per computer (docs/work/computers.md).
//
// Every tool resolves which agent's computer it means the same way core/computers does (an
// agent's own hands call as `mcp:agent:<name>`; anyone else must say `agent`), asks
// `computers.endpoint` for where that computer's Chrome answers, and keeps one Cdp connection to
// it in the pool below rather than opening a new one per call (cdp.js; the 137x finding in
// the prototype's bin/macd.cjs).
//
// A consequential control (consequence.js) is refused before it is ever clicked: `computers.may-act`
// is asked first (are these hands even allowed to act right now, i.e. not paused, not taken
// over), then the control itself is classified, and only an observable one is pressed. Nothing
// here retries a consequential action that looks like it missed.
//
// Every action, successful or not, emits `chrome.acted {agent, action, summary, ok, why?}` so
// Glass's action log has something to show. No event, tool result or log line ever carries the
// CDP endpoint's helper token or a page's full text: `summary` is a short, human sentence.

import { CdpPool } from "./cdp.js";
import { EXPRESSION, toSnapshot } from "./snapshot.js";
import * as act from "./act.js";
import * as consequence from "./consequence.js";
import * as selector from "./selector.js";

const AGENT = /^[a-z][a-z0-9-]{0,40}$/;
const str = { type: "string" };
const obj = (properties, required = []) => ({ type: "object", properties, required });

const SELECTOR = obj({
  role: str, identifier: str, name: str, container: str,
}, []);

/** Which agent's computer a call means, the same rule as core/computers/index.js. */
async function resolveAgent(input, caller, call) {
  const m = /^mcp:agent:(.+)$/.exec(String(caller || ""));
  let agent;
  if (m) {
    const self = m[1];
    if (!input.agent || input.agent === self) agent = self;
    else {
      const r = await call("agents.list", {});
      const a = !r.error && (r.data || []).find(x => x && x.name === self);
      if (a && a.kind === "assistant") agent = input.agent;
      else throw new Error(`${self} can only use its own computer, not ${input.agent}'s`);
    }
  } else {
    if (!input.agent) throw new Error("say which agent's computer: agent is required");
    agent = input.agent;
  }
  if (!AGENT.test(String(agent))) throw new Error(`"${agent}" is not an agent name`);
  return String(agent);
}

/** @type {{ start(ctx: any): Promise<any> }} */
export default {
  async start(ctx) {
    const pool = new CdpPool({
      onEvent: (agent, m) => { if (m.method === "Inspector.detached" || m.method === "Target.targetCrashed") ctx.log(`${agent}'s Chrome: ${m.method}`); },
    });

    // A shield (a person signing in, ADR 0005 decision 3) drops the connection, so nothing
    // already attached can see the page; may-act refuses a new one until the shield is down.
    const unshielded = ctx.events.on("computer.shielded", e => {
      const agent = e && e.payload && e.payload.agent;
      if (agent) pool.drop(String(agent)).catch(err => ctx.log(`dropping ${agent}'s Chrome: ${err.message}`));
    });

    const act_ = (agent, action, ok, why, extra = {}) => {
      ctx.events.emit("chrome.acted", { agent, action, ok, ...(why ? { why } : {}), ...extra });
    };

    /** Connect (or reuse) the agent's CDP session and its page. */
    const session = async agent => {
      const r = await ctx.call("computers.endpoint", { agent });
      if (r.error) throw new Error(r.error.message);
      const cdp = await pool.get(agent, r.data.cdp);
      const sessionId = await cdp.page();
      return { cdp, sessionId };
    };

    const evaluate = async (cdp, sessionId, expression) => {
      const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (r.exceptionDetails) throw new Error(`page script failed: ${r.exceptionDetails.text || "unknown error"}`);
      return r.result && r.result.value;
    };

    const perceive = async (cdp, sessionId) => toSnapshot(await evaluate(cdp, sessionId, EXPRESSION));

    /** May the agent's hands act at all right now (not paused, not taken over)? Throws if not. */
    const mayAct = async (agent, tool) => {
      const r = await ctx.call("computers.may-act", { agent, tool });
      if (r.error) throw new Error(r.error.message);
      if (!r.data.ok) throw new Error(r.data.why);
    };

    const tool = (name, description, input, run) => ctx.tool(name, { description, input, run });

    tool("chrome.snapshot", "Every actionable control on the agent's current page: role, name, whether it is enabled, and where it sits. No page text beyond a length.",
      obj({ agent: str }), async (i, { caller }) => {
        const agent = await resolveAgent(i, caller, ctx.call);
        await mayAct(agent, "chrome.snapshot");
        const { cdp, sessionId } = await session(agent);
        const snap = await perceive(cdp, sessionId);
        act_(agent, "snapshot", true, undefined, { summary: `${snap.controls.length} controls on ${snap.title || snap.url}` });
        return { title: snap.title, url: snap.url, controls: snap.controls, named: snap.named, nameless: snap.nameless };
      });

    tool("chrome.open", "Navigate the agent's Chrome to a URL.", obj({ agent: str, url: str }, ["url"]),
      async (i, { caller }) => {
        const agent = await resolveAgent(i, caller, ctx.call);
        await mayAct(agent, "chrome.open");
        const url = String(i.url);
        if (!/^https?:\/\//.test(url)) throw new Error(`"${url}" is not an http(s) URL`);
        const { cdp, sessionId } = await session(agent);
        try {
          const loaded = cdp.waitFor(m => m.method === "Page.loadEventFired" && m.sessionId === sessionId);
          await cdp.send("Page.navigate", { url }, sessionId);
          await loaded;
        } catch (e) {
          act_(agent, "open", false, /** @type {Error} */ (e).message, { summary: url });
          throw e;
        }
        const snap = await perceive(cdp, sessionId);
        act_(agent, "open", true, undefined, { summary: url });
        return { ok: true, title: snap.title, url: snap.url };
      });

    tool("chrome.click", "Click a control, chosen by role/name/identifier against a fresh look at the page. Refuses a control that looks consequential (send, pay, delete, submit, ...): take over in Glass for those.",
      obj({ agent: str, selector: SELECTOR }, ["selector"]), async (i, { caller }) => {
        const agent = await resolveAgent(i, caller, ctx.call);
        await mayAct(agent, "chrome.click");
        const { cdp, sessionId } = await session(agent);
        const r = await act.once({
          request: i.selector,
          perceive: () => perceive(cdp, sessionId),
          decide: act.decideBySelector,
          click: async ctl => {
            const check = await ctx.call("computers.may-act", { agent, tool: "chrome.click" });
            if (check.error || !check.data.ok) return { ok: false, why: (check.data && check.data.why) || (check.error && check.error.message) || "cannot act right now" };
            const c = ctl.frame ? { x: Math.round(ctl.frame.x + ctl.frame.w / 2), y: Math.round(ctl.frame.y + ctl.frame.h / 2) } : null;
            if (!c) throw new Error(`${ctl.name || ctl.role} has no on-screen position to click`);
            await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: c.x, y: c.y, button: "left", clickCount: 1 }, sessionId);
            await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: c.x, y: c.y, button: "left", clickCount: 1 }, sessionId);
          },
        });
        act_(agent, "click", r.ok, r.ok ? undefined : r.why, { summary: r.control ? (r.control.name || r.control.role) : JSON.stringify(i.selector) });
        return r;
      });

    tool("chrome.type", "Type text into a text field, chosen by role/name/identifier against a fresh look at the page.",
      obj({ agent: str, selector: SELECTOR, text: str }, ["selector", "text"]), async (i, { caller }) => {
        const agent = await resolveAgent(i, caller, ctx.call);
        await mayAct(agent, "chrome.type");
        const { cdp, sessionId } = await session(agent);
        const snap = await perceive(cdp, sessionId);
        const bound = selector.resolve(i.selector, snap.controls);
        if (!bound.control) {
          act_(agent, "type", false, `nothing matches ${JSON.stringify(i.selector)}`, { summary: JSON.stringify(i.selector) });
          return { ok: false, why: bound.why === "tied" ? "more than one control matches" : `nothing matches ${JSON.stringify(i.selector)}` };
        }
        const ctl = bound.control;
        if (ctl.enabled === false) {
          act_(agent, "type", false, `${ctl.name || ctl.role} is disabled`, { summary: ctl.name || ctl.role });
          return { ok: false, why: `${ctl.name || ctl.role} is disabled right now` };
        }
        const check = await ctx.call("computers.may-act", { agent, tool: "chrome.type" });
        if (check.error || !check.data.ok) {
          const why = (check.data && check.data.why) || (check.error && check.error.message) || "cannot act right now";
          act_(agent, "type", false, why, { summary: ctl.name || ctl.role });
          return { ok: false, why };
        }
        const cx = ctl.frame ? Math.round(ctl.frame.x + ctl.frame.w / 2) : 0;
        const cy = ctl.frame ? Math.round(ctl.frame.y + ctl.frame.h / 2) : 0;
        await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: cx, y: cy, button: "left", clickCount: 1 }, sessionId);
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cx, y: cy, button: "left", clickCount: 1 }, sessionId);
        await cdp.send("Input.insertText", { text: String(i.text) }, sessionId);
        act_(agent, "type", true, undefined, { summary: ctl.name || ctl.role });
        return { ok: true, control: ctl };
      });

    tool("chrome.screenshot", "A PNG of the agent's current page, base64-encoded.", obj({ agent: str }),
      async (i, { caller }) => {
        const agent = await resolveAgent(i, caller, ctx.call);
        await mayAct(agent, "chrome.screenshot");
        const { cdp, sessionId } = await session(agent);
        const r = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
        act_(agent, "screenshot", true, undefined, { summary: "captured" });
        return { image: r.data, mime: "image/png" };
      });

    return {
      pool,
      async stop() { unshielded(); await pool.closeAll(); },
    };
  },
};
