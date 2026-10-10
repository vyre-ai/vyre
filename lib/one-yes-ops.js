// The tools each moment of the one yes covers, and the ones a yes may be reused for. Pure data with no imports, so a surface (the app, the Deck) reads the owner's lists instead of keeping its own copy
// (FOUNDATION A5). lib/one-yes.js re-exports them and is still the one place the yes is decided.

/**
 * The tools each moment covers: an explicit allowlist, never a prefix. A card, and an approval at the registry's floor, exist only for these; any other tool (removing a device, resetting a server, deleting or
 * exporting from the vault, inviting someone) is refused at ask and at the floor, however its name begins. The outward moment is any tool marked `outward` in its module.json; the registry's `isOutward` is the one source and is passed in (none given: nothing is outward).
 */
export const MOMENT_OPS = Object.freeze({
  pair: Object.freeze(["presence.enroll", "link.pair.approve", "wink.phone.pair.answer", "wink.server.pair.answer", "wink.pair.server",
    // starting a pairing or turning the relay on is the same weight as answering one: a proof signed over the call itself (software strength on a development build only)
    "wink.phone.open", "relay.pair.start", "relay.enable",
    // typing back the code a new device shows is the owner's yes to adding it
    "wink.code.ack",
    // showing a code for a new computer or server (a browser or a server typed pairing starts here)
    "wink.code.open",
    // enrolment changes of the keys that give a yes, and the devices and routes that reach this server
    "presence.code", "presence.capsule.pin", "relay.devices.trust", "relay.web.pin", "relay.pair.ticket", "relay.pair.window.open", "relay.join",
    "wink.approve", "wink.device.key", "wink.server.retarget", "link.companion.pair", "vault.device.approve",
    // what widens the reach of an agent, a module or an outsider (a person's yes, never an agent's): project access, an agent computer's network and egress, listening for webhooks, installing code
    "projects.access.grant", "computers.egress.set", "computers.tailnet.set", "hooks.enable", "hooks.open", "learn.skill-install", "appmods.install", "pluginagent.grant", "files.drive.share",
    // who is an owner or an agent of a Space, a computer lent to it, a recovery approved, a Space taken back, a network joined (these also carry the kernel's own signed act)
    "runner.folders.allow", "spaces.members.set-role", "spaces.members.extend", "spaces.members.add-agent", "spaces.devices.lend", "spaces.identity.recover.approve", "spaces.retire-here", "network.wink.join",
    // a standing allowance that lets an agent pay or send without asking, and turning a Mac into a server or pairing a device from setup
    "gate.said.add", "onboard.machine", "onboard.join"]),
  // filling a sealed field or revealing one is the vault moment (ruling 7cc004d)
  vault: Object.freeze(["vault.reveal", "vault.copy", "vault.totp", "vault.inject", "vault.resolve", "vault.render", "records.seal-put", "records.reveal",
    // the other tools that return or move a value: they were checked a second time by the vault's own interim prove.js, which is gone; the registry's floor is the one place
    "vault.git", "vault.fill.native", "vault.session.open", "vault.device.code", "vault.device.unlock", "vault.backup", "vault.kit",
    // the key to the person's own identity memory, released to their own assistant's session (core/memory/identity)
    "memory.identity.unlock",
    // grant-making and the destruction of shared secrets
    "vault.grant", "vault.agent.grant", "vault.approve", "vault.pass.create", "vault.pass.accept", "vault.connections.grant", "vault.members.invite", "vault.members.role", "vault.members.remove", "vault.vaults.rotate",
    "vault.offboard", "vault.restore", "vault.delete", "vault.emergency.add", "vault.ssh.approve",
    // writes secrets in bulk: one yes over the whole call (its digest), see yesFieldsOf
    "vault.import",
    // the Vault MCP lets a pass's agent see one item once: the person's yes, never the agent's
    "vault.mcp.reveal.allow"]),
});
/** A reveal, a copy or a code asks for the five-minute reuse. */
export const REUSE_OPS = Object.freeze(["vault.reveal", "vault.copy", "vault.totp"]);
export const REUSE_MS = 5 * 60_000;
