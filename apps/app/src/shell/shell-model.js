// @ts-check
// What a menu command from the Mac shell means: a route of the app, "back" or "forward". Anything else is ignored, so a shell newer than the app
// cannot send the page somewhere it does not know.

/** @param {unknown} name @returns {{ kind: "route", route: string } | { kind: "back" } | { kind: "forward" } | { kind: "none" }} */
export function shellCommand(name) {
  const n = typeof name === "string" ? name : "";
  if (n === "back") return { kind: "back" };
  if (n === "forward") return { kind: "forward" };
  if (/^\/u\/[a-z0-9/_-]*$/i.test(n)) return { kind: "route", route: n };
  return { kind: "none" };
}
