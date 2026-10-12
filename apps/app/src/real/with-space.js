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
const MEMBER_CHAT = Object.freeze({ "work.chat.persistent": "chat.persistent", "work.chat.pin": "chat.pin", "work.chat.list": "chat.list", "work.chat.get": "chat.get", "work.chat.create": "chat.create",
  "stream.send": "chat.send", "stream.catchup": "chat.catchup", "stream.typing": "chat.typing", "stream.react": "chat.react", "stream.pin": "chat.pin-message", "stream.reply-mode": "chat.reply-mode", "stream.mark-read": "chat.mark-read",
  // A member's own AI sign-in (kernel/remote CALLS.accounts): the Settings screen's calls reach the team's server the same way.
  "sessions.accounts.list": "accounts.list", "sessions.accounts.signin": "accounts.signin", "sessions.accounts.remove": "accounts.remove", "sessions.accounts.bind": "accounts.default" });

/** The rows of the member door's one table (core/work/member-tools.js MEMBER_TOOLS), generated from it (scripts/gen-surface-lists.mjs): a row is reached under the SAME name as the registry tool the app calls, with the Store's own input keys, except the few names below. Not a row, so refused in words (flows) or left on her own home (records.define, tasks.decide and the planner need her presence or an admin): everything else. */
import { MEMBER_ROWS } from "./member-routes.generated.js";
/** The app tools whose door call is spelled differently (a call name has no dot after its group). */
const ALIASES = { "work.template.list": "work.templates", "work.project.create": "work.project-create", "flows.test.save": "flows.test-save", "flows.test.remove": "flows.test-remove", "flows.test.list": "flows.test-list", "flows.test.run": "flows.test-run" };
const MEMBER_DOOR = Object.freeze({ ...MEMBER_CHAT, ...Object.fromEntries(MEMBER_ROWS.map((t) => [t, t])), ...ALIASES });

/** The team-door call for a tool, or null when this tool is not one a member reaches that way. The one map of the app's member routes: a row for a group (flows, work) is added here when its member tool exists on the door (core/work/member-tools.js MEMBER_TOOLS). @param {string} tool @returns {string | null} */
export function memberChatWire(tool) { return Object.hasOwn(MEMBER_DOOR, tool) ? /** @type {any} */ (MEMBER_DOOR)[tool] : null; }
export const memberWire = memberChatWire;

/** The tools that do a Space's own work. While a team the person JOINED is showing, none of them may go to her own home as if it were the team: the ones with a member door call go through it (memberWire), the rest are refused in words. Her own things (planner, settings, accounts, her sidebar, her devices) are not in this list. Records, tasks, assistants and lessons are NOT here yet either: screens such as the chat composer read them today and only a door row for them (rc2-people) can replace those reads, so they wait for their rows instead of being refused. */
const TEAM_WORK = Object.freeze(["work.project.", "work.start-project", "work.template.", "flows.", "team."]);

/** Does this tool do a team's own work (so it never goes to her own home while the team shows)? @param {string} tool */
export const isTeamWork = (tool) => TEAM_WORK.some((p) => tool.startsWith(p));

/** What a member is told when a tool of the team's has no door call for her yet. */
export const NOT_FOR_MEMBERS_YET = "Doing this in the team is the owner's for now. Ask the owner, or do it in your own Space.";

/** The team Space a chat call is for: the one the screen named, else the one showing; null when it names no real Space. @param {Record<string, unknown> | undefined} input @param {string | undefined} showing */
export function chatSpace(input, showing) {
  const named = input && typeof input.space === "string" ? input.space : "";
  const s = named || showing || "";
  return /^spc_[a-z2-7]{12}$/.test(s) ? s : null;
}
