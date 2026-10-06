// The relay Worker's entry for `wrangler dev` in tests: only the handler and the two Durable Object classes. The module's other exports
// (constants and helpers the tests import) are not valid exports for a local workerd, which refuses the whole Worker over them.
export { default, CodeSlot, PairTicket, RouteRelay } from "./index.js";
