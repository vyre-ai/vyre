// @ts-check
import { TOOLS_WITH_SPACE } from "./space-tools.generated.js";
// Every call that acts inside a space names it (trunk: calls with no `space` act in the home's own space, and `acted_in` says which). The app names the space that is showing, and only on the tools whose
// schema takes a `space` (docs/reference/tools.md): a tool that does not take one would refuse the extra key. With All spaces showing nothing is added; the screens that read across spaces name each one themselves.

/** The families of tools that default to the showing space. Whether a tool takes a `space` is the tool's own schema, read from the generated tool reference; which families the app names it in is the app's choice. */
const FAMILIES = ["files.drive.", "records.", "rules.", "tasks.", "runner.places"];

/** Tools of those families that take `space` (generated: scripts/gen-surface-lists.mjs). */
export const SPACE_TOOLS = new Set(TOOLS_WITH_SPACE.filter((t) => FAMILIES.some((f) => t.startsWith(f))));

/** The input with the showing space named, when this tool takes one and the screen did not name another. @param {string} tool @param {Record<string, unknown> | undefined} input @param {string | undefined} showing */
export function withSpace(tool, input, showing) {
  const i = input ?? {};
  if (!SPACE_TOOLS.has(tool) || (typeof i.space === "string" && i.space) || !showing || !/^spc_[a-z2-7]{12}$/.test(showing)) return i;
  return { ...i, space: showing };
}

/** A team member's own chat tools and the Space's chat service call each one reaches (kernel/remote/wire.js CALLS.chat): a member has no session on the team's server, so these go through the Space's own door. */
const MEMBER_CHAT = Object.freeze({ "work.chat.persistent": "chat.persistent", "work.chat.pin": "chat.pin", "work.chat.list": "chat.list", "work.chat.get": "chat.get", "work.chat.create": "chat.create" });

/** The team-door call for a chat tool, or null when this tool is not one a member reaches that way. @param {string} tool @returns {string | null} */
export function memberChatWire(tool) { return Object.hasOwn(MEMBER_CHAT, tool) ? /** @type {any} */ (MEMBER_CHAT)[tool] : null; }

/** The team Space a chat call is for: the one the screen named, else the one showing; null when it names no real Space. @param {Record<string, unknown> | undefined} input @param {string | undefined} showing */
export function chatSpace(input, showing) {
  const named = input && typeof input.space === "string" ? input.space : "";
  const s = named || showing || "";
  return /^spc_[a-z2-7]{12}$/.test(s) ? s : null;
}
