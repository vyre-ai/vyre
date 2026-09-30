// @ts-check
// A stand-in for vyre-core's key store, in process, with the same async shape as the real client
// (lib/vyre-core-keys.js createCoreKeys): the private bytes live only in this closure, and every
// operation is a promise, as a call to a root daemon would be. `calls` counts what was asked.
import crypto from "node:crypto";
import { keyPair, dh } from "../core/relay/noise.js";
import { newRouteKey, signRoute } from "../core/relay/wire.js";

/** @param {{ made?: boolean }} [o] `made: false` starts with no keys, made on ensure(). */
export function fakeCoreKeys(o = {}) {
  /** @type {{ box: ReturnType<typeof keyPair>, route: ReturnType<typeof newRouteKey> } | null} */
  let k = o.made === false ? null : { box: keyPair(), route: newRouteKey() };
  const calls = { ensure: 0, boxDh: 0, routeSign: 0 };
  const held = () => { if (!k) throw new Error("no keys"); return k; };
  const later = async v => { await new Promise(r => setImmediate(r)); return v; };
  return {
    calls,
    exists: async () => later(Boolean(k)),
    ensure: async () => { calls.ensure++; k = k || { box: keyPair(), route: newRouteKey() }; return later(true); },
    boxPub: async () => later(Buffer.from(held().box.pub)),
    boxDh: async remote => { calls.boxDh++; return later(dh(held().box.priv, remote)); },
    routePub: async () => later(Buffer.from(held().route.pub)),
    routeSign: async msg => { calls.routeSign++; return later(signRoute(held().route.priv, msg)); },
  };
}
