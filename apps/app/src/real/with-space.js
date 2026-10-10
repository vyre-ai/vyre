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
