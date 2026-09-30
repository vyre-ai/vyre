// @ts-check
// driver: what the pool needs from whatever runs the containers.
//
// Two drivers implement it: docker.js (the Engine API through the restricted proxy, on the box)
// and fake.js (in memory, for tests and for pointing hands modules at a local Chrome). The pool
// never knows which one it has, so everything it does is tested against the fake and the docker
// driver only has to prove it sends the right requests.

/**
 * Ports inside every computer. None is published on the host; vyred reaches them over the
 * internal network. Chrome's own debugging port (9222) is not here and never published anywhere:
 * it stays loopback-only inside the container, reached only by computerd, which proxies it out
 * authenticated on `helper` (see computerd's `/cdp/...` routes and modules/hands-chrome/cdp.js).
 */
export const PORTS = Object.freeze({ vnc: 5900, helper: 7000 });

/** The screen every computer starts with. Glass and the image both read it from SCREEN. */
export const SIZE = Object.freeze({ w: 1440, h: 900 });

/**
 * @typedef {object} CreateSpec
 * @property {string} agent
 * @property {string} image
 * @property {Record<string, string>} env      SCREEN and the egress PAC; never a secret (those go by seed)
 * @property {Record<string, string>} labels   `<prefix>.computer=<agent>` and `<prefix>.managed=true`
 * @property {string} [network]
 * @property {string} volume                   the agent's home volume, mounted at /home/agent
 * @property {string} [browserVolume]          computerd's and Chrome's own volume, mounted at /var/lib/vyre
 * @property {number} [cpus]
 * @property {number} [memoryMb]
 * @property {{ w: number, h: number }} [size]
 */

/**
 * @typedef {"running"|"paused"|"exited"|"missing"} ContainerState
 * @typedef {{ state: ContainerState, host: string|null, ports?: { vnc: number, helper: number, tailnet?: number }, exitCode?: number }} Inspection
 * ports.tailnet: where the computer's tailnet side answers, apart from computerd; no driver names
 * one until the image runs that side as another user (core/computers/tailnet.js).
 */

/**
 * @typedef {object} Driver
 * @property {string} name
 * @property {(spec: CreateSpec) => Promise<{ id: string }>} create
 * @property {(id: string, secrets: { computerd_token: string, vnc_password: string }) => Promise<void>} seed
 *   put the computer's secrets in its volume as /var/lib/vyre/.boot (policy.js bootTar), before start
 * @property {(id: string, agents: Array<{ name: string, token: string }>) => Promise<void>} seedAgentTokens
 *   a shared (browser-kind) computer's per-agent identity, as /var/lib/vyre/.agent-tokens (policy.js
 *   agentTokensTar) -- computerd reads it once at start; changing it on a running computer does
 *   not by itself make computerd notice (see the revocation note in docs/work/glass.md)
 * @property {(id: string) => Promise<void>} start
 * @property {(id: string) => Promise<void>} pause
 * @property {(id: string) => Promise<void>} unpause
 * @property {(id: string) => Promise<void>} stop
 * @property {(id: string) => Promise<void>} remove
 * @property {(id: string) => Promise<Inspection>} inspect
 * @property {() => Promise<Array<{ id: string, agent: string, state: ContainerState }>>} list
 */
