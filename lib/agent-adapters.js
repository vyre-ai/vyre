// @ts-check
// The process names an agent session can have. Claude is built in. Every process-backed provider
// the registry registered adds its id and the basename of the command it runs. A provider with
// capabilities.process false is an HTTP chat endpoint and has no process. Vault lending and the
// identity checks read this one set, so a Claude session, a Grok session, a Codex session and a
// newly registered adapter are the same kind of caller.
// [reviewed: trust]

/** Adapters that exist before any module registers a provider. */
const BUILTIN = ["claude"];

/**
 * Process basenames that are agent hosts even when the registry has not been asked.
 * A registered provider adds its own command on top of these.
 */
const KNOWN_HOSTS = ["claude", "codex", "codex-acp", "gemini", "grok", "opencode", "cursor-agent", "aider", "goose"];

/**
 * The driver object, whether `get` returned it or the registry map's `{ driver }` row.
 * @param {any} raw
 */
function driverOf(raw) {
  if (raw && raw.driver && typeof raw.driver === "object" && typeof raw.driver.run === "function") return raw.driver;
  return raw;
}

/**
 * Process names of built-in Claude and every process-backed provider.
 * `providers` is the registry map (`get` returns `{ driver }`) or the context view (`list` / `get` return the driver).
 * @param {any} [providers]
 * @returns {Set<string>}
 */
export function adapterCommands(providers) {
  const names = new Set(BUILTIN);
  if (!providers || typeof providers.get !== "function") return names;
  const ids = typeof providers.list === "function"
    ? providers.list()
    : typeof providers.keys === "function" ? [...providers.keys()] : [];
  for (const id of ids) {
    const driver = driverOf(providers.get(id));
    if (driver && driver.capabilities && driver.capabilities.process === false) continue;
    if (id) names.add(String(id));
    const cmd = driver && (driver.command || driver.bin);
    if (cmd) {
      const base = String(cmd).split(/[/\\]/).pop();
      if (base) names.add(base);
    }
  }
  return names;
}

/**
 * Every name an identity check treats as an agent session: the registered process names, plus the hosts known with no registry.
 * @param {any} [providers]
 * @returns {Set<string>}
 */
export function agentNames(providers) {
  const names = adapterCommands(providers);
  for (const n of KNOWN_HOSTS) names.add(n);
  return names;
}
