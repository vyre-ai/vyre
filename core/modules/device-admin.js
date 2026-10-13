// @ts-check
// The acts only a FULL device does. A device that came in on the person's identity chain (core/relay/chain-admit.js) can be LIMITED: a newcomer under 24 hours, a relay-held key, a GitHub-added device nobody has
// confirmed. A limited device uses, sends, approves and holds presence, but it may not pair or confirm other devices, mark or remove them, hand ownership over, set another device's presence key, or change the
// identity's own list. One list and one gate, here, instead of a check in each tool.
//
//   DEVICE_ADMIN  refused to a limited chain device.
//   DEVICE_OK     has the shape of device administration but a limited device may do it, with the reason beside the name.
// ADMIN_SHAPE is what the drift test looks for: any tool a device can reach whose name has this shape must be on exactly one of the two lists.

import { deviceIdOf } from "../../lib/caller.js";

export const DEVICE_ADMIN = Object.freeze(new Set([
  // pairing windows and tickets: they make a new device
  "relay.pair.first", "relay.pair.start", "relay.pair.ticket", "relay.pair.window.open", "relay.pair.window.close", "relay.pair.window.confirm", "relay.pair.window.reject", "relay.pair.window.renew", "relay.pair.window.ping",
  // the devices themselves
  "relay.devices.mark", "relay.devices.remove", "relay.devices.rename", "relay.devices.trust", "relay.devices.ask-trust", "relay.devices.drop", "relay.devices.drop-server", "relay.devices.admit-server", "relay.devices.clear-leftover",
  "relay.enable", "relay.disable", "relay.join", "relay.web.pin", "relay.web.release",
  // Wink: pairing a phone, a computer or a server, confirming it, handing the server over
  "wink.access", "wink.approve", "wink.cancel", "wink.code.ack", "wink.code.open", "wink.code.redeem", "wink.device.key", "wink.pair.server",
  "wink.phone.enrolled", "wink.phone.open", "wink.phone.pair.answer", "wink.phone.pairing", "wink.phone.scan",
  "wink.server.adopt", "wink.server.code", "wink.server.confirm", "wink.server.handover", "wink.server.owner", "wink.server.pair.answer", "wink.server.pairing", "wink.server.release", "wink.server.reset.begin",
  "wink.server.reset.confirm", "wink.server.retarget", "wink.server.setup-offer",
  // presence keys of other devices, and the codes that make them
  "presence.enroll", "presence.remove", "presence.keys", "presence.code", "presence.person.renew-allow", "presence.person.revoke", "presence.person.locked",
  // ownership, the identity's own list, a device's place in the Spaces
  "spaces.owner.adopt", "spaces.identity.enrol", "spaces.identity.recover.approve", "spaces.identity.recover.begin", "spaces.identity.recover.code", "spaces.identity.recover.finish",
  "spaces.devices.enrol", "spaces.devices.remove", "spaces.devices.restore", "spaces.devices.set", "spaces.devices.lend",
]));

export const DEVICE_OK = Object.freeze(new Set([
  // reads of devices and pairings
  "relay.devices.list", "relay.devices.path", "relay.devices.all", "relay.setup.status", "spaces.devices.list", "spaces.devices.spaces", "spaces.devices.lend.status",
  "wink.card", "wink.code.status", "wink.pair.status", "wink.pair.targets", "wink.phone.wait", "wink.server.probe", "wink.server.status",
  // this device's own session: sign in, a fresh challenge, renew its own secret (never another device's)
  "presence.person.start", "presence.person.start-paired", "presence.person.pair-challenge", "presence.person.rotate",
]));

/** The shape of device administration, for the drift test. */
export const ADMIN_SHAPE = /^(relay\.(pair|devices|enable|disable|join|web|setup)|wink\.(access|approve|cancel|card|code|device|pair|phone|server)|presence\.(enroll|remove|keys|code|person\.(renew|revoke|rotate|locked|start|pair))|spaces\.(owner|devices|identity\.(enrol|recover)))/;

const NEXT = "Do this from your first device, or wait until this one has been on your list for 24 hours. A device that was added by signing in elsewhere is also kept from this until you confirm it from one you already use.";

/**
 * The gate at the registry's entry. The registry says whether the caller is a device (`isDevice`, from its own label check at the call site), so no module reads the label's shape here. For a device the id is read with
 * lib/caller.js deviceIdOf; a device label with NO valid id is refused for a device-admin tool (fail closed), never skipped. `isLimited(deviceId)` says whether that device is a chain device that is limited NOW (read from
 * the chain, not remembered); any failure to tell fails closed for the admin tools only.
 * @param {{ isLimited: (deviceId: string) => Promise<boolean> }} o
 * @returns {(tool: string, caller: string, isDevice: boolean) => Promise<{ error: { code: string, message: string } } | null>}
 */
export function createLimitedGate(o) {
  return async (tool, caller, isDevice) => {
    if (!DEVICE_ADMIN.has(tool) || isDevice !== true) return null;
    const deny = { error: { code: "denied", message: `${tool} is for a device you have set up in person. ${NEXT}` } };
    const id = deviceIdOf(String(caller));
    if (!id) return deny;
    let limited = true;
    try { limited = await o.isLimited(id); } catch { limited = true; }
    return limited ? deny : null;
  };
}
