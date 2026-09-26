// @ts-check
// driver: what the pool needs from whatever runs the containers.
//
// Two drivers implement it: docker.js (the Engine API through the restricted proxy, on the box)
// and fake.js (in memory, for tests and for pointing hands modules at a local Chrome). The pool
// never knows which one it has, so everything it does is tested against the fake and the docker
// driver only has to prove it sends the right requests.

/** Ports inside every computer. None is published on the host; vyred reaches them over the internal network. */
export const PORTS = Object.freeze({ vnc: 5900, cdp: 9223, helper: 7000 });

/** The screen every computer starts with. Glass and the image both read it from SCREEN. */
export const SIZE = Object.freeze({ w: 1440, h: 900 });

/**
 * @typedef {object} CreateSpec
 * @property {string} agent
 * @property {string} image
 * @property {Record<string, string>} env      VNC_PASSWORD, COMPUTERD_TOKEN, SCREEN; never logged
 * @property {Record<string, string>} labels   `<prefix>.computer=<agent>` and `<prefix>.managed=true`
 * @property {string} [network]
 * @property {string} volume                   the agent's home volume, mounted at /home/agent
 * @property {number} [cpus]
 * @property {number} [memoryMb]
 * @property {{ w: number, h: number }} [size]
 */

/**
 * @typedef {"running"|"paused"|"exited"|"missing"} ContainerState
 * @typedef {{ state: ContainerState, host: string|null, ports?: { vnc: number, cdp: number, helper: number } }} Inspection
 */

/**
 * @typedef {object} Driver
 * @property {string} name
 * @property {(spec: CreateSpec) => Promise<{ id: string }>} create
 * @property {(id: string) => Promise<void>} start
 * @property {(id: string) => Promise<void>} pause
 * @property {(id: string) => Promise<void>} unpause
 * @property {(id: string) => Promise<void>} stop
 * @property {(id: string) => Promise<void>} remove
 * @property {(id: string) => Promise<Inspection>} inspect
 * @property {() => Promise<Array<{ id: string, agent: string, state: ContainerState }>>} list
 */
