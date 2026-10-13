// openEngineer: the one door every "Describe it" calls. It queues what the person asked (where from, which thing, their words, what they want) and opens the one
// @Engineer chat, which sends it with a context card the moment it opens (EngineerEntry). Nothing here is a screen of its own.
import { queueHandoff, type Handoff } from "./model.js";

export type { Handoff };

/** `router` is expo-router's. Call it from a button: openEngineer(router, { source: "playbook", ref: template, words }). No `ref` means the person wants a new one. */
export function openEngineer(router: { push: (to: never) => void }, h: Handoff) {
  queueHandoff(h);
  router.push("/u/engineer" as never);
}
