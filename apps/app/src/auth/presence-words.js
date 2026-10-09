// @ts-check
// The words on the device's confirm prompt (Face ID, the fingerprint, Touch ID): what the person is about to do, never the box's tool name. "Save Gmail", "Show Gmail", "Remove Gmail".
// An item's name is quoted data from the box, cut and cleaned; a tool this file does not know gets the plain "Confirm this on your home".

/** The verb for the last word of a tool name. */
const VERBS = /** @type {Record<string, string>} */ ({
  put: "Save", update: "Save", create: "Create", add: "Add", set: "Save", write: "Save", reveal: "Show", delete: "Delete", remove: "Remove", revoke: "Take back", grant: "Share", approve: "Approve",
  send: "Send", pair: "Pair", unlock: "Unlock", rotate: "Replace", import: "Import", export: "Export",
});
const THINGS = /** @type {Record<string, string>} */ ({ vault: "", flows: "the flow", records: "the record", spaces: "the space", team: "the team", agents: "the assistant", approvals: "the request" });

/** A name the person can read: control characters out, one line, cut. @param {unknown} v */
const clean = (v) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);

/**
 * @param {string} tool the box's tool name ("vault.update") @param {unknown} [input] the call's input; its `name` or `item` is what the words are about
 * @returns {string}
 */
export function presencePrompt(tool, input) {
  const parts = String(tool || "").split(".");
  const verb = VERBS[parts[parts.length - 1]];
  const i = input && typeof input === "object" ? /** @type {any} */ (input) : {};
  const what = clean(i.name ?? i.item ?? i.title);
  if (verb && what) return `${verb} ${what}`;
  if (verb) return `${verb} ${THINGS[parts[0]] || "this"}`.trim() + " on your home";
  return "Confirm this on your home";
}
