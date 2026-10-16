// @ts-check
// Entry points that relay a person's composer line, chips, or slash into person-scoped kernel tools.
// Built from shared routes and the live tool registry, not a hand-maintained allowlist of surfaces.

import { routeComposerLine } from "./thread-composer-route.js";
import { COMMANDS } from "../apps/app/src/chat/core/commands.js";
import { ingressRelayTargets, personScopedRelayTool } from "./person-relay.js";

const sampleLine = (/** @type {string} */ name) => {
  if (name === "find" || name === "search") return "/find sample";
  if (name === "later" || name === "remind") return '/later "at 9am" sample';
  if (name === "remember") return "/remember sample";
  if (name === "model") return "/model x";
  if (name === "effort") return "/effort low";
  if (name === "rewind") return "/rewind";
  if (name === "move") return "/move";
  return `/${name}`;
};

/** Kernel tools `threads.slash` can reach for each composer command name (from routeComposerLine). */
export function composerSlashRelayTargets() {
  const tools = new Set();
  for (const c of COMMANDS) {
    tools.add(routeComposerLine(sampleLine(c.name)).tool);
    for (const a of c.aliases || []) tools.add(routeComposerLine(sampleLine(a)).tool);
  }
  tools.add(routeComposerLine("!git status").tool);
  return [...tools].sort();
}

/** Person-scoped targets of composer slash routing only. */
export function composerPersonRelayTargets() {
  return composerSlashRelayTargets().filter(personScopedRelayTool);
}

/**
 * Every relay entry point: the surface tool plus nested person-scoped targets (derived).
 * @param {{ tools?: { has(name: string): boolean } }} [registry]
 */
export function listPersonRelayEntryPoints(registry) {
  const ingress = ingressRelayTargets();
  /** @type {{ id: string, tool: string, nested: string[] }[]} */
  const out = [];
  const add = (/** @type {string} */ id, /** @type {string} */ tool, /** @type {string[]} */ nested) => {
    if (registry && !registry.tools.has(tool)) return;
    out.push({ id, tool, nested: [...new Set(nested)].sort() });
  };
  add("composer.slash", "threads.slash", composerPersonRelayTargets());
  add("composer.send", "threads.send", ingress);
  add("composer.edit-queued", "threads.edit", ingress);
  add("stream.group-slash", "threads.slash", composerPersonRelayTargets());
  add("mcp.threads_slash", "threads.slash", composerPersonRelayTargets());
  if (registry) {
    for (const name of ["stream.send", "stream.send-group"]) {
      if (registry.tools.has(name)) add(`stream.${name}`, name, ingress);
    }
  }
  return out;
}

/** View/capsule tools that relay first-party module calls as the asking person (lib/views/engine.js). */
export function viewsPersonRelayTools() {
  return ["capsule.commands", "capsule.view", "capsule.act", "views.list", "views.get", "views.act"];
}

/**
 * Person-bound relays outside composer send/slash (agents, mentions, views, connectors).
 * @param {{ tools?: { has(name: string): boolean } }} [registry]
 */
export function listAuxiliaryPersonRelayEntryPoints(registry) {
  /** @type {{ id: string, tool: string, nested: string[] }[]} */
  const out = [];
  const add = (/** @type {string} */ id, /** @type {string} */ tool, /** @type {string[]} */ nested) => {
    if (registry && !registry.tools.has(tool)) return;
    out.push({ id, tool, nested: [...new Set(nested)].sort() });
  };
  add("agents.ask", "agents.ask", ["threads.send", "threads.release"]);
  add("mentions.search", "mentions.search", []);
  add("mentions.resolve", "mentions.resolve", ["vault.mention.resolve"]);
  for (const tool of viewsPersonRelayTools()) add(`views.${tool.replace(".", "-")}`, tool, ["mcp.servers", "mcp.tools", "mcp.call"]);
  add("connectors.declare", "connectors.declare", ["vault.put"]);
  add("connectors.scope", "connectors.scope", []);
  add("appmods.install", "appmods.install", ["connectors.connection.create"]);
  add("appmods.remove", "appmods.remove", ["connectors.connection.delete"]);
  return out;
}

/** Primary composer/stream/MCP entry points plus auxiliary person relays. */
export function listAllPersonRelayEntryPoints(registry) {
  return [...listPersonRelayEntryPoints(registry), ...listAuxiliaryPersonRelayEntryPoints(registry)];
}
