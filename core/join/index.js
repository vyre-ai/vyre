// @ts-check
// join: adding a second device to this box, or pointing a moved installation back at it — the
// user's "Vyre anywhere" decision (28 Sep 2026): Tailscale never matters for Solo; it comes in
// only once a second device or a server joins. This module wires the two paths a device can join
// through (Tailscale, already built in onboard/names; the relay, already built in core/relay)
// behind one small surface, plus a reachability check once pairing is done. Everything here reads
// or asks another module to act (ctx.call): it never runs `tailscale up`, edits a tailnet policy,
// or writes the relay's state directly (ADR 0014 rule 1 extends to here).
//
// Box only for now: a Solo Mac (role "local") has neither onboard nor relay loaded today, so a
// phone joining a Solo Mac needs those to grow a "local" role too before this module can. Noted
// in docs/work/tailnet.md "Needs from others".

const obj = (properties = {}, required = []) => ({ type: "object", properties, required });
const str = { type: "string" };

export default {
  async start(ctx) {
    const call = async (tool, input = {}) => {
      const r = await ctx.call(tool, input);
      if (r.error) throw Object.assign(new Error(r.error.code === "no_such_tool" ? `${tool.split(".")[0]} is not running on this machine` : r.error.message), { code: r.error.code });
      return r.data;
    };
    const tryCall = (tool, input) => call(tool, input).catch(e => ({ __error: e.message, code: /** @type {any} */ (e).code || null }));

    ctx.tool("join.status", {
      description: "Is there a way for a second device or a server to join right now: Tailscale's own state (as onboard.tailscale reports it) and whether the relay is on and ready to pair. Read only.",
      input: obj(),
      run: async () => {
        const tailscale = await tryCall("onboard.tailscale", { action: "status" });
        const relay = await tryCall("relay.status");
        return {
          tailscale: tailscale.__error ? { available: false, why: tailscale.__error } : tailscale,
          relay: relay.__error ? { available: false, why: relay.__error } : { available: true, enabled: relay.enabled, connected: relay.connected, pairing: relay.pairing },
        };
      },
    });

    ctx.tool("join.tailscale", {
      description: "The Tailscale path in: connect starts `tailscale up` and returns the sign-in link (or says it is already on); policy answers the one-paste tailnet policy snippet for whatever is turned on today; lock reads Tailnet Lock. The same as onboard.tailscale, callable any time, not only during first-run onboarding.",
      input: obj({ action: { type: "string", enum: ["status", "connect", "policy", "lock"] } }),
      presence: { when: i => i && i.action === "connect", summary: async () => "Connect this box to your Tailscale network" },
      run: async ({ action = "status" }) => call("onboard.tailscale", { action }),
    });

    ctx.tool("join.relay", {
      description: "The relay path in, for a device that will never share this box's tailnet: a QR code that pairs one more device, good for 10 minutes.",
      input: obj(),
      presence: { summary: async () => "Pair a new device with this box, without Tailscale" },
      run: async () => call("relay.pair.start"),
    });

    ctx.tool("join.verify", {
      description: "Is the device that just paired actually reachable now: by default the calling device, or a node id from tailscale/link.peers. Read only; it does not prove a pairing succeeded, only that the link works this moment.",
      input: obj({ node: str }),
      run: async ({ node }) => call("link.health", node ? { node } : {}),
    });
  },
};
