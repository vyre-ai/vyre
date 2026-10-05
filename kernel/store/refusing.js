// @ts-check
// kernel/store/refusing.js: the record store of a Space whose Twenty cannot run here. Every record call answers one plain refusal; nothing is stored anywhere. The kernel's own
// parts (log, grants, tasks, sessions) do not use a record store and keep working, so the daemon starts and says why records are off instead of hiding the line by not starting.
import { KernelError } from "../core/errors.js";

const METHODS = ["define", "types", "scrub", "describe", "get", "query", "aggregate", "create", "update", "remove", "restore", "search", "changes", "health", "version", "export"];

/** @param {string} reason why Twenty cannot run (the preflight's reasons, joined) */
export function createRefusingStore(reason) {
  const message = `This machine cannot run the record store (Twenty): ${reason}. Put your space on your server.`;
  const refuse = () => { throw new KernelError("unavailable", message); };
  /** @type {Record<string, any>} */
  const store = { refusing: true, message, features: () => ({}) };
  for (const m of METHODS) store[m] = async () => refuse();
  store.export = () => ({ [Symbol.asyncIterator]() { return { next: async () => refuse() }; } });
  return store;
}
