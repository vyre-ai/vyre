// kernel/model/door.js: the one inference door (contract 8.4; invariants 5 and 6). Every model call in the product goes
// through `call`. The door refuses a caller that is not a declared model sink, refuses a provider the Space's residency
// does not allow, refuses a prompt that contains a value the session resolved (the seal ledger), replaces what the
// detectors find with references, and logs what happened without the content.
import { isChain } from "../core/chain.js";
import { createGate } from "../core/gate.js";
import { mintUuid } from "../core/ids.js";
import { KernelError } from "../core/errors.js";
import { sanitize } from "../seal/detect.js";
import { sessionOf } from "../seal/index.js";

/** The action the door registers with the authorizer. */
export const MODEL_ACTIONS = Object.freeze([
  Object.freeze({ action: "model.call", resource_type: "space", risk: "read", label: "ask a model", gloss: "Send text to an AI model." }),
]);

/**
 * @param {{ space: string, providers: Record<string, { call(req: any): Promise<any> }>, sinks: Set<string>, seal: any, authorizer: any, log: any,
 *   residency?: { providers?: string[] }, budget?: (chain: any, input: any) => void | Promise<void>, max_prompt_chars?: number, clock?: () => number }} cfg
 *   seal: the sealing client (check, stash). sinks: the first-party services declared as model sinks (a registry the kernel keeps).
 */
export function createModelDoor(cfg) {
  const clock = cfg.clock || Date.now;
  const { gate } = createGate({ authorizer: cfg.authorizer, log: cfg.log });
  const cap = cfg.max_prompt_chars ?? 400_000;
  const refuse = (/** @type {any} */ chain, /** @type {string} */ code, /** @type {any} */ data, /** @type {string} */ message) => {
    try { cfg.log.append(chain, { type: "model.refused", sv: 1, subject: `vyre://${cfg.space}/model/door`, data: { code, ...data } }); } catch { /* the refusal stands */ }
    return new KernelError(code, message);
  };

  return Object.freeze({
    async call(/** @type {any} */ input) {
      const chain = input && input.chain;
      if (!isChain(chain)) throw new KernelError("bad_input", "a call needs a kernel-built chain");
      await gate(chain, "model.call", `vyre://${cfg.space}/model/door`);
      // A model sink is a service declared as one. A service that is not cannot reach the door at all.
      for (const h of chain.hops) if (h.actor.kind === "service" && !cfg.sinks.has(h.actor.id)) throw refuse(chain, "not_a_sink", { service: h.actor.id }, `${h.actor.id} is not a declared model sink`);
      const provider = cfg.providers[input.provider];
      if (!provider || (cfg.residency && cfg.residency.providers && !cfg.residency.providers.includes(input.provider))) throw refuse(chain, "residency", { provider: String(input.provider) }, "this Space's policy does not allow that provider");
      if (cfg.budget) await cfg.budget(chain, input);
      const messages = Array.isArray(input.messages) ? input.messages : [];
      if (messages.reduce((n, m) => n + String(m.content).length, 0) > cap) throw refuse(chain, "bad_input", { why: "prompt too large" }, "the prompt is too large to check");
      const session = sessionOf(chain);
      // The ledger first, over the text as written: a value the session resolved may not go to a model in any form it can be matched in.
      const joined = messages.map((/** @type {any} */ m) => String(m.content)).join("\n");
      const led = await cfg.seal.check({ session, text: joined });
      if (led.hit) throw refuse(chain, "ledger_hit", { class: led.hit.class, session }, "that text contains a sealed value this session already used");
      // Then the detectors, at this boundary: matches become references, and only the sanitised text goes on.
      let detections = 0;
      const originals = [];
      const clean = messages.map((/** @type {any} */ m) => { const s = sanitize(String(m.content)); detections += s.detections; originals.push(...s.originals); return { role: m.role, content: s.text }; });
      if (originals.length) await cfg.seal.stash({ session, originals });
      let res;
      try { res = await provider.call({ model: input.model, messages: clean, ...(input.tools ? { tools: input.tools } : {}), ...(input.max_output_tokens ? { max_output_tokens: input.max_output_tokens } : {}) }); }
      catch (e) { throw new KernelError("unavailable", "the model could not answer", String(e && /** @type {any} */ (e).message)); }
      cfg.log.append(chain, { type: "model.called", sv: 1, subject: `vyre://${cfg.space}/model/door`, data: { purpose: input.purpose, provider: input.provider, model: input.model, detections, usage: res.usage || null, session } }, {});
      return { id: mintUuid(clock()), provider: input.provider, model: input.model, content: res.content, ...(res.tool_calls ? { tool_calls: res.tool_calls } : {}), ...(res.usage ? { usage: res.usage } : {}) };
    },
  });
}
