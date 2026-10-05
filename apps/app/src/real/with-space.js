// @ts-check
// Every call that acts inside a space names it (trunk: calls with no `space` act in the home's own space, and `acted_in` says which). The app names the space that is showing, and only on the tools whose
// schema takes a `space` (docs/reference/tools.md): a tool that does not take one would refuse the extra key. With All spaces showing nothing is added; the screens that read across spaces name each one themselves.

/** records, tasks, rules and files tools that take `space` (docs/reference/tools.md, trunk 3482f1bed). */
export const SPACE_TOOLS = new Set([
  "files.drive.restore", "files.drive.space.list", "files.drive.space.read", "files.drive.upload", "files.drive.versions",
  "records.actors", "records.create", "records.define", "records.dev-seed", "records.events", "records.kits.get", "records.kits.library", "records.list", "records.me", "records.types",
  "records.workspace.create", "records.workspace.delete",
  "runner.places",
  "rules.accept", "rules.define", "rules.disable", "rules.dismiss", "rules.enable", "rules.get", "rules.list", "rules.propose", "rules.remove", "rules.test",
  "tasks.decide", "tasks.get", "tasks.list", "tasks.move", "tasks.request", "tasks.submit",
]);

/** The input with the showing space named, when this tool takes one and the screen did not name another. @param {string} tool @param {Record<string, unknown> | undefined} input @param {string | undefined} showing */
export function withSpace(tool, input, showing) {
  const i = input ?? {};
  if (!SPACE_TOOLS.has(tool) || (typeof i.space === "string" && i.space) || !showing || !/^spc_[a-z2-7]{12}$/.test(showing)) return i;
  return { ...i, space: showing };
}
