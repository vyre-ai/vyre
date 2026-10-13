// @ts-check
// A tool that first-party modules call (so its reach cannot be `person`, which refuses modules) but that an agent, a model, a guest or an MCP caller must never run: the body refuses them,
// and the person's surfaces and the modules pass. The golden records reach, not the body, so each such tool is named in the allow file with this as its reason (scripts/gen-allow.mjs).

/**
 * @param {any} meta the call's meta @param {string} what what the tool does, for the refusal
 * @returns {void}
 */
export function refuseNonPerson(meta, what) {
  const who = String((meta && meta.caller) || "");
  if (who.startsWith("module:")) return;
  if ((meta && meta.agent) || /:agent:|^mcp|^harness|guest/.test(who)) {
    throw Object.assign(new Error(`only a person ${what}; an agent asks the person to do it`), { code: "denied" });
  }
}
