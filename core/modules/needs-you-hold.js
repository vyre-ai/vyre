// @ts-check
// A model that drives onboarding, a device or an invite does not change anything until the person taps once.
// The card is the same approvals queue an outward send already uses (approvals.hold). A module calling
// another module is not held: onboard and the relay still set a machine to device themselves.
import { holdFields } from "../../lib/hold-fields.js";
import { COVERED } from "../../lib/covered.js";
import { momentOf, yes } from "../../lib/one-yes.js";
import { isSurface } from "../../lib/surface-tools.js";

const AGENT_OR_THREAD = /(?:^|[\s:])(?:agent|thread):/;

/** @param {string} caller */
const kindOf = (caller) => String(caller || "").replace(/[\s:](agent|thread):.*$/s, "");

/**
 * An MCP or harness caller, including a bare "mcp" and a session thread. A module is never one.
 * A person on the terminal ("cli") is not one; an agent riding that label is.
 * @param {string} caller
 */
export function modelCaller(caller) {
  const c = String(caller || "");
  if (c.startsWith("module:")) return false;
  const kind = kindOf(c);
  return kind === "mcp" || kind === "harness" || AGENT_OR_THREAD.test(c);
}

/**
 * May this MCP or harness caller see a surface tool even when the tool's callers list is only the person's?
 * @param {string} caller @param {string} tool
 */
export function surfaceAllows(caller, tool) {
  if (!isSurface(tool)) return false;
  const c = String(caller || "");
  if (c.startsWith("module:")) return false;
  const kind = kindOf(c);
  return kind === "mcp" || kind === "harness";
}

/**
 * What listTools tells the MCP server, so a person-only name still appears when the call will wait for a tap.
 * @param {string} name @param {{ effect?: string, needsYou?: boolean }} d
 */
export function listingMarks(name, d) {
  const surface = isSurface(name);
  const needsYou = Boolean(d && d.needsYou) || (surface && d && d.effect === "write");
  return { ...(surface ? { surface: true } : {}), ...(needsYou ? { needsYou: true } : {}) };
}

/**
 * Hold a surface write from a model, or spend the card and let the call continue.
 * Answers null when this call is not one of those. An outward tool keeps the registry's own hold.
 * @param {{ tools: { get(name: string): any } }} registry
 * @param {{ tool: string, def: any, caller: string, meta: any, input: any, approval: string | null }} o
 * @returns {Promise<null | { error: any } | { input: any, meta: any }>}
 */
export async function holdNeedsYou(registry, o) {
  const { tool, def, caller } = o;
  if (!def || def.internal || def.hook || def.outward === true) return null;
  if (!modelCaller(caller)) return null;
  const write = def.effect === "write" || def.needsYou === true;
  if (!((isSurface(tool) && write) || def.needsYou === true)) return null;
  const meta = o.meta || {};
  const asker = `${caller}${meta.origin ? `>${meta.origin}` : ""}`;
  const named = momentOf(tool, () => false);
  const moment = named === "pair" || named === "vault" || named === "outward" ? named : "pair";
  let input = o.input;
  let fields = holdFields(input);
  if (o.approval) {
    const edited = registry.tools.get("approvals.card-input");
    if (edited) {
      try {
        const c = await edited.run({ id: o.approval, tool, from: asker }, { caller: "module:registry" });
        if (c && c.input && typeof c.input === "object") {
          const { checkInput } = await import("./index.js");
          const bad = checkInput(def.input, c.input);
          if (bad.length) return { error: { code: "bad_input", message: `the edited call is not valid: ${bad.join("; ")}` } };
          input = c.input;
          fields = holdFields(input);
        }
      } catch { /* the card is the card as it was held */ }
    }
    const r = await yes(moment, { op: tool, fields, device: asker }, { card: o.approval });
    if (!r.ok) return { error: { code: "approval_refused", message: `that approval does not cover this call (${r.reason}); ask again` } };
    return { input, meta: { ...meta, [COVERED]: { card: o.approval, tool, input_sha256: fields.input_sha256, asker } } };
  }
  const hold = registry.tools.get("approvals.hold");
  if (!hold) return { error: { code: "held_unavailable", message: `${tool} changes a device or an invite, and this server has no approvals queue to hold it in` } };
  let card;
  try { card = await hold.run({ tool, fields, from: asker, input, moment }, { caller: "module:registry" }); }
  catch (e) { return { error: { code: "held_unavailable", message: `${tool} could not be held for your yes: ${String((e && /** @type {any} */ (e).message) || e).slice(0, 160)}` } }; }
  const id = card && card.id;
  return { error: { code: "held_for_approval", approval: id, line: card && card.line, moment: (card && card.moment) || moment, ...(card && card.group ? { group: card.group } : {}), message: `${tool} waits for your one tap (approval ${id}). Nothing changed. After you approve, call it again with the same input and approval: ${id}` } };
}
