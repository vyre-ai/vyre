// @ts-check
// The person's public address. The directory still claims the label; this is the route the server workstream serves.

const NAME = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
/** Infrastructure hosts that are not people. `<name>.vyre.run` for one of these is not a person redirect. */
export const INFRA_HOSTS = Object.freeze(new Set(["names", "app", "api", "www", "relay", "acme", "mail", "docs", "status"]));

/** @param {unknown} raw */
export function normalizeUsername(raw) {
  return String(raw ?? "").trim().toLowerCase().replace(/\.vyre\.run$/, "");
}

/** @param {unknown} raw @returns {string} */
export function checkUsername(raw) {
  const name = normalizeUsername(raw);
  if (!NAME.test(name) || INFRA_HOSTS.has(name)) {
    throw Object.assign(new Error("Choose a username of letters, digits and hyphens, three to 32 characters."), { code: "bad_input" });
  }
  return name;
}

/** @param {string} name */
export function personUrl(name) {
  return `https://vyre.run/u/${checkUsername(name)}`;
}

/**
 * A 301 from the old `<name>.vyre.run` host to the person route. Infrastructure hosts stay where they are.
 * @param {unknown} host @returns {{ status: 301, location: string }|null}
 */
export function legacyRedirect(host) {
  const h = String(host ?? "").toLowerCase().split(":")[0];
  const m = /^([a-z0-9-]+)\.vyre\.run$/.exec(h);
  if (!m || INFRA_HOSTS.has(m[1]) || !NAME.test(m[1])) return null;
  return { status: 301, location: `https://vyre.run/u/${m[1]}` };
}

/**
 * What a public lookup may say. Private unless the person opted in: then the name, id and address, never a key.
 * @param {{ name: string, id?: string|null, discoverable?: boolean, github?: { login?: string|null }|null }} p
 */
export function publicCard(p) {
  const name = normalizeUsername(p.name);
  if (!p.discoverable) return { name, private: true };
  return { name, id: p.id || null, url: `https://vyre.run/u/${name}`, private: false, github: p.github && p.github.login ? p.github.login : null };
}
