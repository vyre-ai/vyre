// kernel/core/seal.js: how the kernel seals what it must be able to recognise later as its own (K-3): the grants store's events, a stored job chain and a session token.
// The secret behind it must never be in a process an assistant on the same machine can read, so the real implementation holds none: it asks the sealing process, which holds
// the key and answers `kernel.mac(purpose, data)` and `kernel.verify(purpose, data, mac)` (kernel/seal/process.js). Only the grants store and the chain builder are given
// this handle; nothing else in the kernel can seal or check anything. Each call is one round trip over the sealing process's pipe; calls are pipelined, so a batch of N
// checks costs N small messages, not N waits.
// A development or test kernel with no sealing process passes `key` instead: the same interface over a local HMAC, which answers synchronously (`sync: true`) so the
// code that needs no sealing process stays as simple as it was. A caller that might meet either simply `await`s.
import { hmac, sameMac } from "./canonical.js";

const PURPOSE = /^[a-z0-9_.-]{1,40}$/;

/**
 * @param {{ sealer?: { kernel: { mac(i: { purpose: string, data: string }): Promise<string>, verify(i: { purpose: string, data: string, mac: string }): Promise<boolean> } },
 *   key?: Uint8Array | string }} cfg
 * @returns {{ sync: boolean, mac(purpose: string, data: string): string | Promise<string>, verify(purpose: string, data: string, mac: string): boolean | Promise<boolean>,
 *   verifyMany(items: { purpose: string, data: string, mac: string }[]): Promise<boolean[]> }}
 */
export function createKernelSeal(cfg) {
  const ok = (/** @type {string} */ p) => { if (!PURPOSE.test(p)) throw new Error("bad purpose"); return p; };
  if (cfg.sealer && cfg.sealer.kernel) {
    const k = cfg.sealer.kernel;
    return Object.freeze({
      sync: false,
      mac: (purpose, data) => k.mac({ purpose: ok(purpose), data }),
      verify: (purpose, data, mac) => k.verify({ purpose: ok(purpose), data, mac }).then(Boolean, () => false),
      verifyMany: items => Promise.all(items.map(i => k.verify({ purpose: ok(i.purpose), data: i.data, mac: i.mac }).then(Boolean, () => false))),
    });
  }
  if (!cfg.key) throw new Error("the kernel needs the sealing process, or a development key");
  const key = cfg.key;
  const macOf = (/** @type {string} */ purpose, /** @type {string} */ data) => hmac(key, `${ok(purpose)}\n${data}`);
  return Object.freeze({
    sync: true,
    mac: macOf,
    verify: (purpose, data, mac) => typeof mac === "string" && sameMac(macOf(purpose, data), mac),
    verifyMany: async items => items.map(i => typeof i.mac === "string" && sameMac(macOf(i.purpose, i.data), i.mac)),
  });
}
