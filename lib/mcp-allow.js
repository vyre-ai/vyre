// @ts-check
// The onboarding, device and invite tools an MCP caller may reach. This list is declared.
// Nothing scans source to build it. The coverage test keeps its own copy and checks this one.
// A vault value is not on it. Lending (vault.request, vault.space.use) is the vault's own path.
//
// pluginagent.grant, .decline, .on, .pending and .revoke are person-only (reach person, presence):
// they must not be surface tools or a model session is held_for_approval instead of denied.
// pluginagent.status stays: a read of whether a grant is waiting.
//
// onboard.person.create and onboard.computer.add are not on it either: they take the master password, so an agent never sees that field.
//
// The answers to a pairing question (wink.phone.pair.answer, wink.code.ack) are not on it: the words check and the typed code are the person's own, and an agent that supplies the pick
// or the code is pairing a device it controls. A card cannot name a device that is not paired yet, so these tools are person-only.

/** @type {readonly string[]} */
export const MCP_ALLOW = Object.freeze([
  "flows.kit.library",
  "flows.kit.library.get",
  "flows.kit.propose",
  "onboard.github.finish",
  "onboard.github.start",
  "onboard.join.read",
  "onboard.machine",
  "onboard.member.link",
  "onboard.person.lookup",
  "onboard.phone.add",
  "onboard.space.join",
  "onboard.space.open",
  "onboard.space.poll",
  "onboard.status",
  "onboard.windows",
  "pluginagent.status",
  "presence.person.locked",
  "presence.person.renew-allow",
  "records.kits.get",
  "records.kits.library",
  "relay.devices.list",
  "relay.devices.remove",
  "releases.info",
  "sessions.accounts.key",
  "spaces.create",
  "spaces.devices.lend",
  "spaces.devices.list",
  "spaces.devices.remove",
  "spaces.identity.status",
  "spaces.invites.accept",
  "spaces.invites.confirm",
  "spaces.invites.create",
  "spaces.invites.list",
  "spaces.invites.preview",
  "spaces.invites.revoke",
  "spaces.list",
  "spaces.members.computers",
  "spaces.resume",
  "spaces.setup.claim",
  "spaces.setup.save",
  "wink.access",
  "wink.pair.server",
  "wink.pair.status",
  "wink.pair.targets",
  "wink.phone.open",
  "wink.phone.pairing",
]);
