// @ts-check
// The lines on Your profile that are pure: the role chip for the Space showing, the @username, and the one line under the name.

const WORD = { owner: "Owner", admin: "Admin", manager: "Manager", member: "Member", guest: "Guest", temp: "Guest" };

/** @param {string} bit @returns {"Owner" | "Admin" | "Manager" | "Member" | "Guest"} */
function roleWord(bit) {
  const first = String(bit || "").trim().toLowerCase().split(/\s+/)[0] || "";
  return /** @type {"Owner" | "Admin" | "Manager" | "Member" | "Guest"} */ (WORD[/** @type {keyof typeof WORD} */ (first)] || "Member");
}

/** @param {string} s */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The role in this Space. A line that names the Space ("Admin of Juniper Studio") uses that role. A line that is already a role word uses it.
 * A line that names some other Space, or none of these, is Member.
 * @param {string} line @param {string} [spaceName] @returns {"Owner" | "Admin" | "Manager" | "Member" | "Guest"}
 */
export function profileRole(line, spaceName) {
  const text = String(line || "").trim();
  const name = String(spaceName || "").trim();
  if (name) {
    const re = new RegExp(`\\bof\\s+${escapeRe(name)}$`, "i");
    const hit = text.split(",").map((s) => s.trim()).find((s) => re.test(s));
    if (hit) return roleWord(hit);
    if (/\bof\s+\S/i.test(text)) return "Member";
  }
  return roleWord(text);
}

/** The @username, without the domain. Empty when there is no username yet (a space in the line means it is not a username). @param {string} _name @param {string} vyreName @returns {string} */
export function profileHandle(_name, vyreName) {
  const sub = String(vyreName || "").trim().replace(/\.vyre\.run$/i, "");
  if (!sub || /\s/.test(sub)) return "";
  return `@${sub}`;
}

/** @param {string} [spaceName] @returns {string} */
export function profileLine(spaceName) {
  const name = String(spaceName || "").trim() || "this Space";
  return `How you show up in ${name}. Each Space has its own profile.`;
}
