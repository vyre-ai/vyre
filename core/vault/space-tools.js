// @ts-check
// Space vault tools. The personal vault's lending path is unchanged. These tools seal a space key that the server wrap can open while nobody is unlocked.

import path from "node:path";
import { isPerson } from "../../lib/caller.js";
import { modelSuppliedSecret, SECRET_REFUSED } from "../../lib/master-secret.js";
import * as SV from "../../kernel/identity/space-vault.js";

const obj = (properties, required = []) => ({ type: "object", properties, required });
const str = { type: "string" };
const refuse = (message, code) => Object.assign(new Error(message), { code });

/** @param {any} ctx */
export function registerSpaceTools(ctx) {
  const dirOf = (/** @type {any} */ input) => path.join(ctx.paths.root, "identity", "space-vaults", String(input.space || ""));
  const spaceOk = (/** @type {any} */ input) => {
    if (!/^spc_[a-z2-7]{8,}$/.test(String(input.space || "")) && !/^spc_test_[a-z0-9_-]{1,40}$/.test(String(input.space || ""))) throw refuse("Name the space by its id.", "bad_input");
  };

  ctx.tool("vault.space.create", {
    description: "Make a space vault key, wrapped for the server so agents work while you are away.",
    input: obj({ space: str }, ["space"]),
    presence: { summary: (/** @type {any} */ i) => `Make a space vault for ${i && i.space}` },
    run: async (input) => { spaceOk(input); return SV.create(dirOf(input)); },
  });
  ctx.tool("vault.space.status", {
    description: "Whether a space vault exists and which generation it is on. No key is returned.",
    input: obj({ space: str }, ["space"]),
    run: async (input) => { spaceOk(input); return SV.status(dirOf(input)); },
  });
  ctx.tool("vault.space.attention", {
    description: "Space vault rotations that failed when a member left, and that Vyre will retry. Titles only, no key.",
    input: obj({}),
    effect: "read",
    callers: ["local", "deck", "capsule", "module"],
    run: async () => SV.attention(path.join(ctx.paths.root, "identity", "space-vaults")),
  });
  ctx.tool("vault.space.grant", {
    description: "Wrap the space vault key to a member so their access carries to the space.",
    input: obj({ space: str, person: str, pub: str }, ["space", "person", "pub"]),
    presence: { summary: (/** @type {any} */ i) => `Let ${i && i.person} open the space vault of ${i && i.space}` },
    run: async (input) => { spaceOk(input); return SV.grant(dirOf(input), input.person, input.pub); },
  });
  ctx.tool("vault.space.put", {
    description: "Store a space vault item. The value is sealed and never returned.",
    input: obj({ space: str, id: str, name: str, value: str }, ["space", "id", "name", "value"]),
    presence: { summary: (/** @type {any} */ i) => `Store "${i && i.name}" in the space vault of ${i && i.space}` },
    run: async (input, meta) => {
      spaceOk(input);
      const caller = String((meta && meta.caller) || "");
      if (!isPerson(caller) && !caller.startsWith("module:")) throw refuse("Enter the value on your device. An agent cannot supply it.", "secret_refused");
      if (modelSuppliedSecret(caller, input)) throw refuse(SECRET_REFUSED, "secret_refused");
      return SV.put(dirOf(input), { id: input.id, name: input.name, value: input.value });
    },
  });
  ctx.tool("vault.space.list", {
    description: "List space vault item names. Values stay sealed.",
    input: obj({ space: str }, ["space"]),
    run: async (input) => { spaceOk(input); return SV.list(dirOf(input)); },
  });
  ctx.tool("vault.space.rotate", {
    description: "Rotate the space vault key and drop one member. Remaining members still open items.",
    input: obj({ space: str, person: str }, ["space"]),
    presence: { summary: (/** @type {any} */ i) => `Rotate the space vault of ${i && i.space}` },
    run: async (input) => { spaceOk(input); return SV.rotate(dirOf(input), { remove: input.person ? [input.person] : [] }); },
  });
  ctx.tool("vault.space.use", {
    description: "Use a space vault item on an outbound request. The caller gets the response, never the value.",
    input: obj({
      space: str, id: str, url: str, method: str,
      headers: { type: "object" }, body: str,
    }, ["space", "id", "url"]),
    callers: ["cli", "local", "deck", "capsule", "module", "mcp", "harness"],
    run: async (input) => {
      spaceOk(input);
      return SV.use(dirOf(input), {
        id: input.id,
        request: { url: input.url, method: input.method, headers: input.headers, body: input.body },
        transport: async (req) => {
          const r = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
          return { status: r.status, body: await r.text() };
        },
      });
    },
  });
}
