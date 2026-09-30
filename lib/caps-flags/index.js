// @ts-check
// lib/caps-flags: the one list of provider capability flags (PLAN.md C14b, plans/sessions.md 3.4).
// sessions fills `caps` on providers.list and threads.get; every surface reads it. Both sides
// import this file, so a flag can't be spelled two ways: sessions' conformance test checks a
// provider declares every flag here, and the Deck only reads flags named here. Pure JavaScript with
// no imports: Node loads it, and vyred serves it to the Deck at /lib/caps-flags/index.js.
//
// A missing flag means false (or its "none" value): a surface shows less, never a control that
// fails. `rewind` stays false for a provider until it is proven on that provider.

/** Each flag and its kind: "bool", "list" (of ids), "rewind" ({conversation, code}) or a fixed set of values. */
export const FLAGS = Object.freeze({
  steer: "bool", queue: "bool", interrupt: "bool", resume: "bool", fork: "bool",
  rewind: "rewind", modes: "list", plan: "bool", questions: "bool", permissions: "bool",
  thinking: "bool", effort: "bool", images: "bool", commands: "bool", tasks: "bool",
  subagents: "bool", model_switch: "bool",
  usage: Object.freeze(["none", "coarse", "detailed"]),
  remember: Object.freeze([null, "CLAUDE.md", "AGENTS.md", "GEMINI.md"]),
});

/** The shared tool kinds on thread.tool (C14b). Plans and asks are their own events, not kinds. */
export const TOOL_KINDS = Object.freeze(["read", "edit", "write", "run", "search", "fetch", "mcp", "task", "other"]);

/** The "off" value of each flag. */
function off(/** @type {any} */ kind) {
  if (kind === "bool") return false;
  if (kind === "list") return [];
  if (kind === "rewind") return { conversation: false, code: false };
  return kind[0];
}

/**
 * Every flag present, typed, and nothing else: unknown keys drop, a wrong type is off. What a
 * surface reads, whatever a provider sent.
 * @param {any} raw @returns {Record<string, any>}
 */
export function normalizeCaps(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  /** @type {Record<string, any>} */ const out = {};
  for (const [name, kind] of Object.entries(FLAGS)) {
    const v = r[name];
    if (kind === "bool") out[name] = v === true;
    else if (kind === "list") out[name] = Array.isArray(v) ? v.filter(x => typeof x === "string" && x) : [];
    else if (kind === "rewind") out[name] = { conversation: v?.conversation === true, code: v?.code === true };
    else out[name] = kind.includes(v) ? v : off(kind);
  }
  return out;
}

/**
 * What is wrong with a provider's declared caps: each flag missing or mistyped, and each unknown
 * key. [] when it is exact. sessions' conformance test fails on a non-empty answer, so a provider
 * can't leave a flag out and silently grey a control.
 * @param {any} raw @returns {string[]}
 */
export function checkCaps(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return ["caps must be an object"];
  const problems = [];
  for (const [name, kind] of Object.entries(FLAGS)) {
    if (!(name in raw)) { problems.push(`${name} is missing`); continue; }
    const v = raw[name];
    const ok = kind === "bool" ? typeof v === "boolean"
      : kind === "list" ? Array.isArray(v) && v.every(x => typeof x === "string")
      : kind === "rewind" ? !!v && typeof v === "object" && typeof v.conversation === "boolean" && typeof v.code === "boolean"
      : kind.includes(v);
    if (!ok) problems.push(`${name} has the wrong type or value`);
  }
  for (const k of Object.keys(raw)) if (!(k in FLAGS)) problems.push(`${k} is not a capability flag`);
  return problems;
}
