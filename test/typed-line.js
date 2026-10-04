// @ts-check
// Test stand-in, SHIM(transcript): harness.enrich believes `interactive` only when the session's own transcript, read through recall.transcript, says the person typed exactly this prompt
// (HD-4b). A test world with no Recall module and no Claude Code writing a transcript says it for the person: the prompt a test sends through harness.enrich IS the line "typed", unless the
// test sends it as something a person did not type (`typedLine: false`). Not for production code.
/** @param {any} reg a Registry */
export function personTypes(reg) {
  const real = reg.call.bind(reg);
  let last = "";
  reg.call = async (/** @type {string} */ tool, /** @type {any} */ input, /** @type {any} */ caller, /** @type {any} */ meta) => {
    if (tool === "recall.transcript") return { data: { blocks: [{ kind: "turn" }, { kind: "user", text: last }] } };
    if (tool === "harness.enrich" && input && typeof input.prompt === "string") last = input.prompt;
    return real(tool, input, caller, meta);
  };
}
