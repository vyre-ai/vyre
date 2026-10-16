// @ts-check
// [reviewed: trust] A person in their own app is not held. An assistant's change to people, devices or vault
// access waits on one Needs-you card (approvals.hold), the same queue an outward send uses. An assistant never
// receives a vault value, including after Approve. Lending (vault.request, vault.space.use) injects the value
// and the result is scrubbed. A module calling another module is not held.
import { holdFields } from "../../lib/hold-fields.js";
import { COVERED } from "../../lib/covered.js";
import { momentOf, yes } from "../../lib/one-yes.js";
import { isSurface } from "../../lib/surface-tools.js";
import { scrubAll } from "../../lib/scrub.js";
import { PERSON_ONLY as reachPersonOnly } from "./agent-reach.js";

const AGENT_OR_THREAD = /(?:^|[\s:])(?:agent|thread):/;
const LENDING = new Set(["vault.request", "vault.space.use"]);
/** Tools whose result is a vault value. An assistant is refused before the body runs. */
const HANDS_VALUE = new Set([
  "vault.reveal", "vault.copy", "vault.totp", "vault.codes", "vault.resolve", "vault.render", "vault.inject",
  "vault.fill.native", "vault.account.export-secret-key", "vault.account.import-secret-key", "vault.state",
]);
/** Adding a device. The schema must name name, type and fingerprint so the card can show them. */
const DEVICE_ADD = new Set([
  "onboard.computer.add", "onboard.phone.add", "onboard.windows",
  "spaces.devices.enrol", "spaces.devices.restore", "wink.phone.open", "wink.pair.server", "devices.signin",
]);
const SECRET_KEY = /^(password|passwd|passphrase|secret|secretkey|secret_key|recovery|recoverykey|recoverysecret|recoverycode|privatekey|private_key|token|apikey|api_key|credential|accesstoken|access_token|refreshtoken|refresh_token|masterpassword|master_password)$/i;

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

/** In-the-air lending. The value is injected and does not come back as the result. @param {string} name */
export function lending(name) {
  return LENDING.has(String(name || ""));
}

/**
 * A vault value: anything under vault. except lending and a change to who can use a vault.
 * An assistant is never given one.
 * @param {string} name
 */
export function vaultValue(name) {
  const n = String(name || "");
  if (lending(n)) return false;
  if (!n.startsWith("vault.")) return false;
  if (/^vault\.vaults\./.test(n)) return false;
  if (/^vault\.grant/.test(n)) return false;
  if (/^vault\.agent\.grant/.test(n)) return false;
  if (/^vault\.members\./.test(n)) return false;
  if (/^vault\.connections\.grant/.test(n)) return false;
  return true;
}

/** @param {string} name */
export function handsVaultValue(name) {
  return HANDS_VALUE.has(String(name || "")) || (isSurface(name) && vaultValue(name));
}

/**
 * An assistant adding a device must name it. Missing facts are refused, not held.
 * The person who asked is the caller, shown on the card, never a field the assistant picks.
 * @param {string} tool @param {any} input
 * @returns {null | { error: { code: string, message: string } }}
 */
export function deviceAddMissing(tool, input) {
  if (!DEVICE_ADD.has(String(tool || ""))) return null;
  const i = input && typeof input === "object" ? input : {};
  const name = typeof i.name === "string" ? i.name.trim() : "";
  const type = typeof i.type === "string" ? i.type.trim() : "";
  const fingerprint = typeof i.fingerprint === "string" ? i.fingerprint.trim() : "";
  if (name && name.length <= 80 && type && type.length <= 40 && fingerprint.length >= 8 && fingerprint.length <= 128) return null;
  return { error: { code: "bad_input", message: "Adding a device needs its name, its type, and its key fingerprint." } };
}

/**
 * May this MCP or harness caller see a surface tool even when the tool's callers list is only the person's?
 * Seeing the name is not receiving a vault value: holdNeedsYou refuses that call.
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
 * What listTools tells the MCP server. A surface write can wait for a tap. A vault value is not marked that way.
 * @param {string} name @param {{ effect?: string, needsYou?: boolean }} d
 */
export function listingMarks(name, d) {
  const surface = isSurface(name);
  const needsYou = !vaultValue(name) && (Boolean(d && d.needsYou) || (surface && Boolean(d && d.effect === "write")));
  return { ...(surface ? { surface: true } : {}), ...(needsYou ? { needsYou: true } : {}) };
}

/**
 * Take secret fields out of a result an assistant will see. A person's own caller is unchanged.
 * Lending keeps the vendor body and still drops a secret-named field on the envelope.
 * [reviewed: trust]
 * @param {string} caller @param {string} tool @param {any} result
 */
export function scrubVaultResult(caller, tool, result) {
  if (!modelCaller(caller) || result == null || typeof result !== "object") return result;
  const lend = lending(tool);
  const stripValue = !lend && String(tool || "").startsWith("vault.");
  /** @type {string[]} */
  const pulled = [];
  /** @param {any} v @returns {any} */
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== "object") return v;
    /** @type {Record<string, any>} */
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (SECRET_KEY.test(k) || (stripValue && k === "value")) {
        if (typeof val === "string" && val.length >= 4) pulled.push(val);
        continue;
      }
      out[k] = lend ? val : walk(val);
    }
    return out;
  };
  if (lend) {
    /** @type {Record<string, any>} */
    const out = {};
    for (const [k, val] of Object.entries(result)) {
      if (SECRET_KEY.test(k)) {
        if (typeof val === "string" && val.length >= 4) pulled.push(val);
        continue;
      }
      if (val && typeof val === "object" && !Array.isArray(val)) {
        /** @type {Record<string, any>} */
        const inner = {};
        for (const [ik, iv] of Object.entries(val)) {
          if (SECRET_KEY.test(ik)) {
            if (typeof iv === "string" && iv.length >= 4) pulled.push(iv);
            continue;
          }
          inner[ik] = iv;
        }
        out[k] = inner;
      } else out[k] = val;
    }
    return pulled.length ? scrubAll(out, pulled) : out;
  }
  const cleaned = walk(result);
  return pulled.length ? scrubAll(cleaned, pulled) : cleaned;
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
  if (!def || def.internal || def.hook) return null;
  if (modelCaller(caller)) {
    const missing = deviceAddMissing(tool, o.input);
    if (missing) return missing;
    if (!lending(tool) && handsVaultValue(tool)) return { error: { code: "denied", message: "An assistant does not receive a vault value." } };
  }
  if (def.outward === true) return null;
  if (!modelCaller(caller)) return null;
  const write = def.effect === "write" || def.needsYou === true;
  // A person-only read stays refused. Holding it used to return the value after a tap.
  if (isSurface(tool) && reachPersonOnly.has(tool) && !write) return { error: { code: "denied", message: "That stays with you." } };
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
          const still = deviceAddMissing(tool, c.input);
          if (still) return still;
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
