// @ts-check
// kernel/gateway/chat-keys.js: the lease a chat's key is lent to this process by (team/0.3/DESIGN-chat-keys.md, "Where the key comes from at call time"). The server never holds a chat key at rest and
// never makes one: a participant's own device opens the chat's ring with its device key and wraps the keys to a one-use key this process made for the request (`bundleFor`, lib/chat-keys.js). The
// process holds them in memory only, so the Drive (kernel/storage/sealed-drive.js) can open the chat's files for the callers the gateway already allows; a rotation or a lock drops them.
//   begin(chain, chat)            a participant's own chain: { request, session_pub, epoch } (the ring the device must open is `grants.chats.read(...).ring`)
//   finish(chain, request, bundle) the same person's chain: the bundle is opened with the request's private half, checked for the chat and a current epoch, and held
//   lock(chain, chat)             a participant (or the chat's last holder going away): the keys are wiped
import crypto from "node:crypto";
import { KernelError } from "../core/errors.js";
import { isChain } from "../core/chain.js";
import { newDeviceKey } from "../../lib/keywrap.js";
import { openBundle } from "../../lib/chat-keys.js";

const TTL_MS = 5 * 60 * 1000;

/**
 * @param {{ keys: import("../../lib/chat-keys.js").ProcessKeys, grants: { chats: { read(chain: any, id: string): any, epoch(id: string): number } }, clock?: () => number }} cfg
 */
export function createChatLease(cfg) {
  const clock = cfg.clock || Date.now;
  /** @type {Map<string, { chat: string, person: string, priv: any, until: number }>} */
  const asks = new Map();
  const own = (/** @type {any} */ chain) => {
    if (!isChain(chain) || chain.viewer === true || chain.hops.length !== 1 || chain.hops[0].actor.kind !== "person") throw new KernelError("chain_not_person", "a person's own device lends a chat's key");
    return chain.hops[0].actor.id;
  };
  return Object.freeze({
    /** @param {any} chain @param {string} chat */
    begin(chain, chat) {
      const person = own(chain);
      const c = cfg.grants.chats.read(chain, chat);
      if (!c.ring) throw new KernelError("bad_input", "this chat keeps its folders in the clear: it has no key");
      for (const [k, v] of asks) if (v.until <= clock()) asks.delete(k);
      const kp = newDeviceKey(), request = crypto.randomBytes(16).toString("hex");
      asks.set(request, { chat, person, priv: kp.privateJwk, until: clock() + TTL_MS });
      return { request, session_pub: kp.publicJwk, epoch: c.ring.epoch };
    },
    /** @param {any} chain @param {string} request @param {any} bundle */
    async finish(chain, request, bundle) {
      const person = own(chain);
      const a = asks.get(String(request));
      if (!a || a.person !== person || a.until <= clock()) throw new KernelError("not_found", "no such unlock request");
      asks.delete(String(request));
      if (cfg.grants.chats.epoch(a.chat) === 0) throw new KernelError("bad_input", "this chat has no key");
      cfg.grants.chats.read(chain, a.chat);
      let k;
      try { k = await openBundle(bundle, a.chat, a.priv); } catch { throw new KernelError("bad_input", "that bundle does not open for this request"); }
      if (k.id !== a.chat || k.epoch < cfg.grants.chats.epoch(a.chat)) { k.lock(); throw new KernelError("bad_input", "that bundle is for an older key of the chat: open the current ring"); }
      cfg.keys.hold(k);
      return { chat: a.chat, epoch: k.epoch };
    },
    /** @param {any} chain @param {string} chat */
    lock(chain, chat) { own(chain); cfg.grants.chats.read(chain, chat); cfg.keys.drop(chat); return { locked: true }; },
    /** Whether this chat's key is held here and current. @param {string} chat */
    unlocked(chat) { const k = cfg.keys.get(chat); return Boolean(k && k.epoch >= cfg.grants.chats.epoch(chat)); },
  });
}
