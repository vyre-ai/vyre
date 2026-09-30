// @ts-check
// setting: the one string a person's "change this setting" ask is matched by (P17).
//
// settings.request asks vault.said.match with exactly this string as the only destination, and the
// recorder that turns the person's words into a `setting` intent (lib/said, the assistant) writes
// the same string, so the two can never drift. It names the key, the canonical value and the
// level, so "use Sonnet by default in this project" covers that value, at that level, in that
// project, and nothing else: not the opposite value, not the account level, not another project.
//
//   <key>=<canonical JSON value>@<level>[/<project|device|session id>]     a change
//   <key>=reset@<level>[/<id>]                                              clearing it
//
// The canonical value is JSON with object keys sorted, so the same value always reads the same.

/** @param {any} v */
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/**
 * @param {{ key: string, value?: any, reset?: boolean, level: string, target?: string | null }} c
 * @returns {string}
 */
export function settingTo(c) {
  const v = c.reset === true || c.value === undefined ? "reset" : canon(c.value);
  return `${c.key}=${v}@${c.level}${c.target ? `/${c.target}` : ""}`;
}
