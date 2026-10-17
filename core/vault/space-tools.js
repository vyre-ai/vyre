// @ts-check
// Space vault tools. The personal vault's lending path is unchanged. These tools seal a space key that the server wrap can open while nobody is unlocked.

import path from "node:path";
import { isPerson } from "../../lib/caller.js";
import { httpFetch } from "../../lib/http.js";
import { modelSuppliedSecret, SECRET_REFUSED } from "../../lib/master-secret.js";
import * as SV from "../../kernel/identity/space-vault.js";

const obj = (properties, required = []) => ({ type: "object", properties, required });
const str = { type: "string" };
const refuse = (message, code) => Object.assign(new Error(message), { code });

/** @param {any} ctx @param {{ fetch?: typeof httpFetch }} [seam] */
export function registerSpaceTools(ctx, seam = {}) {
  const fetchOut = seam.fetch || httpFetch;
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
    run: async (input) => {
      spaceOk(input);
      // The key goes only to someone this space's own kernel says is a member. A named stranger, or a kernel that cannot answer, gets nothing.
      const k = ctx.kernel;
      if (!k || typeof k.membership !== "function") throw refuse("This server cannot check who belongs to that space, so the vault key is not shared.", "unavailable");
      /** @type {any} */ let m = null;
      try { m = await k.membership(String(input.person || ""), String(input.space)); } catch { m = null; }
      const ownsHome = typeof k.owner === "string" && k.owner === String(input.person) && k.space === String(input.space);
      if (!ownsHome && (!m || m.member !== true)) throw refuse("That person is not a member of this space, so the vault key is not shared with them.", "denied");
      return SV.grant(dirOf(input), input.person, input.pub);
    },
  });
  ctx.tool("vault.space.put", {
    description: "Store a space vault item for the hosts it may be sent to. The value is sealed and never returned.",
    input: obj({ space: str, id: str, name: str, value: str, hosts: { type: "array", items: str } }, ["space", "id", "name", "value", "hosts"]),
    presence: { summary: (/** @type {any} */ i) => `Store "${i && i.name}" in the space vault of ${i && i.space}` },
    run: async (input, meta) => {
      spaceOk(input);
      const caller = String((meta && meta.caller) || "");
      if (!isPerson(caller) && !caller.startsWith("module:")) throw refuse("Enter the value on your device. An agent cannot supply it.", "secret_refused");
      if (modelSuppliedSecret(caller, input)) throw refuse(SECRET_REFUSED, "secret_refused");
      return SV.put(dirOf(input), { id: input.id, name: input.name, value: input.value, hosts: input.hosts });
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
    description: "Use a space vault item on a host it was saved for. Another host, including a redirect, is refused. The response never includes the value.",
    input: obj({
      space: str, id: str, url: str, method: str,
      headers: { type: "object" }, body: str,
    }, ["space", "id", "url"]),
    callers: ["cli", "local", "deck", "capsule", "module", "mcp", "harness"],
    run: async (input, meta) => {
      spaceOk(input);
      let host = "";
      try { host = new URL(String(input.url)).host.toLowerCase(); } catch { host = ""; }
      const item = (SV.list(dirOf(input)).items.find((/** @type {any} */ i) => i.id === String(input.id)) || {}).name || String(input.id);
      /** @param {boolean} ok @param {number} status */
      const audit = (ok, status) => { try { ctx.events && ctx.events.emit("vault.space-used", { space: String(input.space), item: String(item), host, by: String((meta && meta.caller) || ""), ok, status }); } catch { /* the audit line never blocks the call */ } };
      let result;
      try {
        result = await SV.lend(dirOf(input), {
          id: input.id,
          request: { url: input.url, method: input.method, headers: input.headers, body: input.body },
          // The kernel's one HTTP path: https only, a public address pinned for the connection, a size cap and a timeout. A redirect is handed back to lend(), which follows it only to a saved host.
          transport: async (req) => {
            const r = await fetchOut(req.url, { method: req.method, headers: req.headers, body: req.body, redirect: "manual" });
            const location = typeof r.headers?.get === "function" ? (r.headers.get("location") || "") : "";
            return { status: r.status, headers: location ? { location } : {}, body: await r.text() };
          },
        });
      } catch (e) { audit(false, 0); throw e; }
      audit(result.ok, result.status);
      return result;
    },
  });
}
