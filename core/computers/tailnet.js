// @ts-check
// tailnet: each running computer as its own ephemeral, tagged tailnet node (ADR 0014 part 9).
//
// Off by default (config computers.tailnet.enabled). Off means nothing here runs: no vault
// fetch, no call to the computer, no timer. On, a computer that starts (or thaws) is asked to
// join: vyred reads the reusable, ephemeral, pre-approved key tagged tag:vyre-agent from the
// vault item ITEM and hands it to the computer's tailnet side in one POST body. The key is never
// in the container's env, labels or arguments, never in a log line, an event or a tool result.
//
// The computer answers with its node's stable id and name, which the pool records so the names
// listener can map a whois of that node to the agent (computers.node.agent). The node is
// ephemeral, so a container that dies takes its node with it; a clean stop also logs it out.
//
// Before the key is sent, the computer is asked GET /tailnet, with no key. An image without a
// tailnet side answers 404 (or says it cannot run one), and then the key is never sent at all.

/** The vault item holding the auth key. The user makes the key and stores it (the report's steps). */
export const ITEM = "tailscale-agent-authkey";

export const DEFAULT_TAG = "tag:vyre-agent";

// Tailscale's own tag grammar: "tag:" and a name that starts with a letter.
const TAG = /^tag:[A-Za-z][A-Za-z0-9-]{0,62}$/;

/** How long each call to the computer's tailnet side may take. `tailscale up` waits on the control plane. */
const UP_MS = 45_000;
const CALL_MS = 5_000;

/** A just-started computer's tailnet side comes up a little after the container: a short, bounded wait. */
const RETRY_MS = [500, 1_000, 2_000, 4_000, 8_000];

/**
 * config computers.tailnet, checked. Anything but enabled: true is off.
 * @param {any} raw
 * @returns {{ enabled: boolean, tag: string }}
 */
export function setting(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const tag = r.tag === undefined ? DEFAULT_TAG : String(r.tag);
  if (!TAG.test(tag)) throw new Error(`computers.tailnet.tag ${JSON.stringify(tag).slice(0, 80)} is not a tag (tag:name)`);
  return { enabled: r.enabled === true, tag };
}

/** The node's hostname for one agent: the only name it ever asks for. */
export const hostname = agent => `vyre-agent-${agent}`;

/**
 * One call to the computer's tailnet side, with computerd's bearer token. The error never
 * carries the body (which may hold the key) or the token.
 * @param {{ url: string, token: string }} h
 * @param {"GET"|"POST"} method @param {string} route @param {any} [body]
 * @param {{ ms?: number, signal?: AbortSignal }} [o]
 */
export async function ask(h, method, route, body, o = {}) {
  const signals = [AbortSignal.timeout(o.ms || CALL_MS), ...(o.signal ? [o.signal] : [])];
  const res = await fetch(new URL(route, h.url), {
    method,
    headers: { authorization: `Bearer ${h.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.any(signals),
  });
  let out = null;
  try { out = await res.json(); } catch { out = null; }
  return { status: res.status, body: out };
}

/**
 * Join one computer's node, or say why not. Throws only for a caller bug; every other failure
 * is a { joined: false, why } the pool logs.
 * @param {{ helper: () => { url: string, token: string }, key: () => Promise<string>, agent: string, tag: string,
 *   signal?: AbortSignal, wait?: (ms: number) => Promise<void> }} o
 * @returns {Promise<{ joined: true, stableId: string, node: string } | { joined: false, why: string }>}
 */
export async function join(o) {
  const wait = o.wait || (ms => pause(ms, o.signal));
  // First, with no key: is there a tailnet side, and is it already up (a thawed computer)?
  let st = null, last = "";
  for (let i = 0; ; i++) {
    if (o.signal && o.signal.aborted) return { joined: false, why: "the computer stopped" };
    try { st = await ask(o.helper(), "GET", "/tailnet", undefined, { signal: o.signal }); break; }
    catch (e) { last = /** @type {Error} */ (e).message; }
    if (i >= RETRY_MS.length) return { joined: false, why: `computerd did not answer (${last})` };
    await wait(RETRY_MS[i]);
  }
  if (st.status === 404) return { joined: false, why: "this computer's image has no tailnet side; the key was not sent" };
  if (st.status !== 200 || !st.body) return { joined: false, why: `the tailnet side answered ${st.status}${errorOf(st.body)}; the key was not sent` };
  if (st.body.ready !== true) return { joined: false, why: `the tailnet side cannot run here${st.body.why ? `: ${String(st.body.why).slice(0, 200)}` : ""}; the key was not sent` };
  if (st.body.running === true && isId(st.body.stableId)) return { joined: true, stableId: String(st.body.stableId), node: String(st.body.node || "") };

  let authKey;
  try { authKey = await o.key(); }
  catch (e) { return { joined: false, why: `no auth key: ${/** @type {Error} */ (e).message}` }; }
  if (!authKey) return { joined: false, why: `the vault item ${ITEM} is empty` };
  let up;
  try { up = await ask(o.helper(), "POST", "/tailnet/up", { authKey: String(authKey), hostname: hostname(o.agent), tag: o.tag }, { ms: UP_MS, signal: o.signal }); }
  catch (e) { return { joined: false, why: `tailscale up did not finish: ${/** @type {Error} */ (e).message}` }; }
  finally { authKey = ""; }
  if (up.status !== 200 || !up.body || !isId(up.body.stableId)) return { joined: false, why: `tailscale up failed (${up.status}${errorOf(up.body)})` };
  return { joined: true, stableId: String(up.body.stableId), node: String(up.body.node || "") };
}

/** Log the node out: a clean stop. Best effort; the node is ephemeral either way. */
export async function leave(h) {
  const r = await ask(h, "POST", "/tailnet/down", {});
  if (r.status !== 200) throw new Error(`tailscale down answered ${r.status}${errorOf(r.body)}`);
}

/** A wait that a stop cuts short, and that never keeps vyred alive on its own. */
const pause = (ms, signal) => new Promise(resolve => {
  const t = setTimeout(resolve, ms);
  t.unref();
  if (signal) signal.addEventListener("abort", () => { clearTimeout(t); resolve(undefined); }, { once: true });
});

const isId = v => typeof v === "string" && /^[A-Za-z0-9]{1,64}$/.test(v);
const errorOf = b => (b && b.error && b.error.message ? `: ${String(b.error.message).slice(0, 200)}` : "");
