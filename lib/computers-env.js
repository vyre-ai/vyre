// @ts-check
// computers-env: the box's agent-computer settings, read the same way by vyred and by the docker-api proxy (core/dockerproxy/main.js).
//
// box/compose.yml hands both services the same VYRE_COMPUTERS_* values from one YAML anchor each, so the image, network and label prefix vyred
// asks a create for are exactly the ones the proxy's create policy pins. The proxy's own defaults live here too, so neither side can drift.
//
// On a box (VYRE_SUPERVISOR=docker) the proxy is always there: box/vyre names the `computers` profile on every compose run. So a box whose
// config.json names no computer driver uses it, with each agent its own Linux user on the Space's one computer. A setting in config.json wins,
// and `computers.enabled: false` (or `computers.driver: "none"`) turns computers off.

/** Where vyred reaches the docker-api service on a box: its internal network, port 2375 (box/compose.yml). */
export const BOX_PROXY_URL = "http://docker-api:2375";

/** What the proxy allows when the environment names nothing: the compose file's own defaults. */
export const PROXY_DEFAULTS = Object.freeze({ network: "vyre-computers", image: "vyre/computer:0.1", labelPrefix: "run.vyre.computers" });

/**
 * The create policy the box's environment names, with the proxy's defaults for anything unset.
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ network: string, image: string, labelPrefix: string, capAdd: string[] }}
 */
export function computersFromEnv(env = process.env) {
  return {
    network: env.VYRE_COMPUTERS_NETWORK || PROXY_DEFAULTS.network,
    image: env.VYRE_COMPUTERS_IMAGE || PROXY_DEFAULTS.image,
    labelPrefix: env.VYRE_COMPUTERS_LABEL_PREFIX || PROXY_DEFAULTS.labelPrefix,
    capAdd: String(env.VYRE_COMPUTERS_CAP_ADD || "").split(",").map(s => s.trim()).filter(Boolean),
  };
}

/** Did the person turn computers off in config.json? @param {any} cfg the computers section */
export function computersOff(cfg) {
  return Boolean(cfg) && (cfg.enabled === false || cfg.docker === false || cfg.driver === "none");
}

/** Is this vyred the one inside a box's container? @param {Record<string, string | undefined>} [env] */
export function onBox(env = process.env) { return env.VYRE_SUPERVISOR === "docker"; }

/**
 * The computers settings in effect: config.json's own, over what a box implies.
 *   - turned off in config: no driver at all;
 *   - a box with no driver named: the docker-api proxy, and each agent its own Linux user (agentUsers) unless config says otherwise;
 *   - a box using the proxy: image, network, label prefix and extra capabilities from the environment the proxy reads, where config names none.
 * Anything config.json sets is kept as it is. Pure: the same input always gives the same answer.
 * @param {any} cfg the computers section of config.json (may be missing)
 * @param {Record<string, string | undefined>} [env]
 * @returns {Record<string, any>}
 */
export function effectiveComputers(cfg, env = process.env) {
  /** @type {Record<string, any>} */
  const c = cfg && typeof cfg === "object" ? { ...cfg } : {};
  if (computersOff(c)) { delete c.docker; delete c.driver; return c; }
  if (!onBox(env)) return c;
  if (!c.docker && !c.driver) {
    c.docker = BOX_PROXY_URL;
    if (c.agentUsers === undefined) c.agentUsers = true;
  }
  if (c.docker) {
    const p = computersFromEnv(env);
    if (c.image === undefined) c.image = p.image;
    if (c.network === undefined) c.network = p.network;
    if (c.labelPrefix === undefined) c.labelPrefix = p.labelPrefix;
    if (c.capAdd === undefined && p.capAdd.length) c.capAdd = p.capAdd;
  }
  return c;
}
