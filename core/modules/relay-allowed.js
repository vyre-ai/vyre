// @ts-check
// The relay allow list: which tools a first-party module may ask for as the person whose call is running. Kept in its own file so
// core/modules/index.js stays under its line budget. Changing it is a security change: sec53 reads every edit.

import { FIRST_RUN_RELAY } from "./relay-context.js";

export const RELAY_ALLOWED = Object.freeze({
  spaces: ["work.chat.upgrade-plan", "work.chat.upgrade-move", "memory.upgrade.plan", "memory.upgrade.move", "wink.install.issue"],
  memory: ["spaces.storage."],
  work: ["spaces.storage.", "vault.uses.for", "spaces.members.list"], // vault.uses.for: the timeline asks, as the person looking; spaces.members.list: the names of those a person adds to a chat, asked as that person
  publish: ["previews.folder"], previews: ["publish.quick"], // a files preview card publishes its own folder, as the person who pressed it (publish asks previews.folder); the share sheet's "anyone with the link" is the same press (previews.share, a person's own act, hands the person to publish.quick, which holds it for one yes)
  providers: ["sessions.providers.snapshot"], vault: ["flows.connections"], // providers: the accounts a person may choose are theirs; vault: which Flows use a Connection, as the person looking at the credential (R031-70)
  // a terminal opened on a session resolves the thread as the person at it (threads.get answers for the chats that person is in)
  term: ["threads.get"],
  // a team member's own MCP servers (mcp.mine.*) live in the member's own vault store: the mcp module asks it as the member, and the vault tool resolves the person from the relayed claim
  mcp: ["vault.me.store.", "vault.me.who"],
  // appmods proposes the Kit an app ships (its record type and its Flow) as the installing person; the owner's yes in Now is what defines anything
  appmods: ["flows.kit.propose"],
  // a connection a person makes: the connectors module asks vault.me.who for the person it connects for (core/connectors/who.js), as that person's call
  connectors: ["vault.me.who", "vault.me.connect.put"],   // a member's sign-in keeps her connection in her own vault, asked as her (core/connectors/index.js saveMine)
  // the person's sessions are filed into their projects as the person who chose them (the import tools run for the person or for their vouched AI key); undone as the same person when the upload cannot start
  import: ["projects.add-threads", "projects.remove-threads", "sync.consent", "link.call"],
  // the computers module asks agents.level what the person behind the call may do with an agent (use or edit), as that person: agents.level judges the relayed person and refuses a caller that is not one
  computers: ["agents.level"],
  mail: ["gate.request"], // standing permissions: the agent's session token reaches the Gate on the filed send
  ...FIRST_RUN_RELAY,
});
