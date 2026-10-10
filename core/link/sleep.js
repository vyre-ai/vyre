// @ts-check
// A Mac tells vyred when it is about to sleep and when it woke (the Capsule's BoxLink.willSleep and didWake call link.sleep and link.wake when this vyred has them). vyred says so to whoever listens:
// the runner hands the sessions it runs for a Space to the Space's server before the lid shuts (R031-95 2.4), and asks to be heard from at once when the Mac is back. Nothing here stops anything itself.
const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });

/**
 * @param {any} ctx @param {{ linked: () => boolean }} d `linked`: whether this Mac is paired to a server
 */
export function registerSleepTools(ctx, d) {
  for (const [name, event, text] of /** @type {const} */ ([["link.sleep", "link.sleeping", "This Mac is about to sleep: the sessions it runs for a Space move to the Space's server first."], ["link.wake", "link.woke", "This Mac woke: it checks in with the Space's server at once."]])) {
    ctx.tool(name, {
      effect: "write",
      description: text,
      input: { type: "object", properties: {} },
      callers: ["cli", "local", "capsule"],
      run: async (_i, meta) => {
        if (!meta || !["cli", "local", "capsule"].includes(String(meta.caller))) throw refuse("the Mac's own app says this", "denied");
        ctx.events.emit(event, {});
        return { ok: true, linked: d.linked() };
      },
    });
  }
}
