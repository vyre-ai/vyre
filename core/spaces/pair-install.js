// @ts-check
// The Create step's name for the one install line. The mint is wink.install.issue (one function, two names).
// This file only registers the name. It does not sign, and it does not adopt.

const str = { type: "string" };

/**
 * `spaces.pair.install`: the name the Create step calls. It returns whatever wink.install.issue returns, including `command`.
 * @param {{ tool: Function, call: Function }} ctx
 */
export function registerPairInstall(ctx) {
  ctx.tool("spaces.pair.install", {
    description: "Make the one install line for Linux or an always-on Mac. The code rides in the environment. Your key stays on this device.",
    input: {
      type: "object",
      properties: {
        os: { type: "string", enum: ["linux", "mac"] },
        kind: { type: "string", enum: ["linux", "mac"] },
        name: str,
        store: str,
      },
    },
    run: async (/** @type {any} */ input) => {
      const r = await ctx.call("wink.install.issue", input || {});
      if (!r || r.error) {
        const e = r && r.error;
        throw Object.assign(new Error((e && e.message) || "The install line could not be made. Open the Vyre app and try again."), { code: (e && e.code) || "unavailable" });
      }
      return r.data;
    },
  });
}
