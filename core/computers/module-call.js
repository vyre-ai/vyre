// @ts-check
// A computers-module call that must not inherit the person or agent who asked. The shared screen key is this module's
// own vault item: the first ask creates it. A put made inside that ask would carry the ask's origin, and the vault
// refuses a module acting for an agent. This scope is taken at load, before any call, so the put is the module's own.

import { AsyncResource } from "node:async_hooks";

const root = new AsyncResource("vyre.computers.module");

/** Run `fn` with no running call, so a later ctx.call captures no origin. @template T @param {() => T} fn @returns {T} */
export function asModule(fn) {
  return root.runInAsyncScope(fn);
}
