// @ts-check
// Written entry-point report for person-scoped relays (generated from routes + registry, not hand lists).

import { listAllPersonRelayEntryPoints, composerPersonRelayTargets, composerSlashRelayTargets } from "./person-relay-entrypoints.js";
import { ingressRelayTargets, PERSON_SCOPED_RELAY_TOOLS } from "./person-relay.js";

/** RELAY_ALLOWED keys copied for the report (source: core/modules/index.js). */
export const RELAY_ALLOWED_SUMMARY = Object.freeze({
  spaces: ["work.chat.upgrade-plan", "work.chat.upgrade-move", "memory.upgrade.plan", "memory.upgrade.move"],
  memory: ["spaces.storage."],
  work: ["spaces.storage.", "vault.uses.for"],
  publish: ["previews.folder"],
  previews: ["publish.quick"],
  providers: ["sessions.providers.snapshot"],
  vault: ["flows.connections"],
  term: ["threads.get"],
  mcp: ["vault.me.store."],
  appmods: ["flows.kit.propose"],
  import: ["projects.add-threads", "projects.remove-threads", "sync.consent", "link.call"],
});

/**
 * Markdown report for integrators.
 * @param {{ tools?: { has(name: string): boolean } }} [registry]
 */
export function personRelayReportMarkdown(registry) {
  const eps = listAllPersonRelayEntryPoints(registry);
  const lines = [
    "# Person relay entry points",
    "",
    "Standing rule: every path that runs a tool **as the verified person** on a turn uses `personCallOpts` / `relayPersonTool` in `lib/person-relay.js`. Tests are derived from this list and composer routes (`lib/person-relay-entrypoints.js`), not hand-maintained surface lists.",
    "",
    "## Composer slash targets (`routeComposerLine`)",
    "",
    ...composerSlashRelayTargets().map((t) => `- \`${t}\``),
    "",
    "## Person-scoped slash nested tools",
    "",
    ...composerPersonRelayTargets().map((t) => `- \`${t}\``),
    "",
    "## Ingress tag relay (`threads.send` / `threads.edit` → `resolveTags`)",
    "",
    ...ingressRelayTargets().map((t) => `- \`${t}\``),
    "",
    "## `PERSON_SCOPED_RELAY_TOOLS` (proven session on `{ as }`)",
    "",
    ...[...PERSON_SCOPED_RELAY_TOOLS].sort().map((t) => `- \`${t}\``),
    "",
    "## Entry points (surface tool → nested person-scoped tools)",
    "",
    "| id | tool | nested |",
    "|----|------|--------|",
    ...eps.map((e) => `| ${e.id} | \`${e.tool}\` | ${e.nested.map((n) => `\`${n}\``).join(", ") || "—"} |`),
    "",
    "## Module `RELAY_ALLOWED` (`{ relay: true }` person hops)",
    "",
    ...Object.entries(RELAY_ALLOWED_SUMMARY).flatMap(([mod, tools]) => [
      `### \`${mod}\``,
      ...tools.map((t) => `- \`${t}\``),
      "",
    ]),
    "## Not in this table",
    "",
    "- Switchboard peer / Mac link (`link.macs.call` with `as: \"person\"`) — box person, not composer relay.",
    "- Queued composer edits — same ingress as `threads.send` once dequeued.",
    "- `CALL_AS` merge in `core/modules/index.js` — any `{ as: <person surface> }` carries `currentCall()` token/kernelFacts.",
    "",
  ];
  return lines.join("\n");
}
