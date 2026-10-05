// @ts-check
// drop-identity: what the Wink module lends the files module so a VyreDrop key says whose it is. Narrow on purpose: the only text it will sign is exactly `vyre-drop-key-v1\n<pub>` for a drop key's own shape, built
// here from the key (never taken from the caller), and only the files module may ask. It is not a way to get this computer's identity key to sign anything else (an identity op, a pairing proof, a hello).
const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });
export const KEY_TEXT = (/** @type {string} */ pub) => `vyre-drop-key-v1\n${pub}`;
const PUB = /^[A-Za-z0-9_-]{40,120}$/;
const files = (/** @type {any} */ meta) => { if (String((meta && meta.caller) || "") !== "module:files") throw fail("denied", "only the files module asks for this"); };

/**
 * @param {{ sign: (message: Buffer) => Promise<{ eid: string, sig: string } | null>, entry: (eid: string) => Promise<{ pub?: string } | null>, verify: (pub: string, message: Buffer, sig: string) => boolean }} o
 */
export function dropIdentity(o) {
  return {
    /** @param {any} meta @param {{ pub: string }} i */
    async sign(meta, i) {
      files(meta);
      if (!i || typeof i.pub !== "string" || !PUB.test(i.pub)) throw fail("bad_input", "a drop key");
      const r = await o.sign(Buffer.from(KEY_TEXT(i.pub), "utf8"));
      if (!r) throw fail("not_ready", "this computer has no identity yet: claim your Vyre name first");
      return r;
    },
    /** @param {any} meta @param {{ pub: string, eid: string, sig: string }} i */
    async check(meta, i) {
      files(meta);
      if (!i || typeof i.pub !== "string" || !PUB.test(i.pub) || typeof i.eid !== "string" || typeof i.sig !== "string") throw fail("bad_input", "a drop key and its signature");
      const e = await o.entry(i.eid);
      return { ok: Boolean(e && e.pub && o.verify(e.pub, Buffer.from(KEY_TEXT(i.pub), "utf8"), i.sig)) };
    },
  };
}
