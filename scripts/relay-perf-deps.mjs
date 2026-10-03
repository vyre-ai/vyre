// The relay pieces core/stream/relay-perf.mjs needs, gathered in one place outside the scanned
// module trees: the measurement script is a dev harness, not a module, so it is the one thing in
// core/stream that is allowed to know the relay (the module itself never imports it).
export { keyPair } from "../core/relay/noise.js";
export { newRouteKey, routeId } from "../core/relay/wire.js";
export { relayLink } from "../core/relay/link.js";
export { bridge } from "../core/relay/bridge.js";
