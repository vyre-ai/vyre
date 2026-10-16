// @ts-check
// The onboarding, device and invite tools an MCP caller may reach. This list is declared.
// Nothing scans source to build it. The coverage test keeps its own copy and checks this one.
// A vault value is not on it. Lending (vault.request, vault.space.use) is the vault's own path.
//
// pluginagent.grant, .decline, .on, .pending and .revoke are person-only (reach person, presence):
// they must not be surface tools or a model session is held_for_approval instead of denied.
// pluginagent.status stays: a read of whether a grant is waiting.

/** @type {readonly string[]} */
export const MCP_ALLOW = Object.freeze([
  "flows.kit.library",
  "flows.kit.library.get",
  "flows.kit.propose",
  "onboard.computer.add",
  "onboard.github.finish",
  "onboard.github.start",
  "onboard.join.read",
  "onboard.machine",
  "onboard.member.link",
  "onboard.person.create",
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
  "wink.code.ack",
  "wink.pair.server",
  "wink.pair.status",
  "wink.pair.targets",
  "wink.phone.open",
  "wink.phone.pair.answer",
  "wink.phone.pairing",
]);
