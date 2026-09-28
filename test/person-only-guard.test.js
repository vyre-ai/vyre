// @ts-check
// A recurring class of bug (e2e review, 28 Sep, latest instance files.receive): a tool whose
// callers list names only the person's own surfaces (cli, local, deck, capsule -- never module,
// mcp, tailnet or a guest) reads as person-only, but core/daemon's floor block (core/daemon/peer.js,
// the `personal` check in core/daemon/index.js) only refuses a `claude`/thread process for a tool
// core/presence's PERSON_ONLY names, or one that needs presence itself. A tool with person-only
// callers and neither of those is left checking only `callerAllowed`'s caller-kind string, which a
// model's own shell can claim ("cli") exactly as a real terminal would -- so it slips a model
// straight past what its own callers list meant to keep out.
//
// This loads every module's real tool definitions the way docs:ref does (scripts/lib/docs/reference.js's
// harvest, a sandboxed child process, throwaway home, nothing it starts can reach outside) and fails
// on any tool whose callers are person-only surfaces alone unless it is in PERSON_ONLY, in
// HUMAN_ONLY (which always needs presence, a stronger guarantee), or sets presence: true itself.
//
// Full auto-derivation of PERSON_ONLY from the manifests (the lead's "better still") is a bigger
// change -- PERSON_ONLY is presence's own hand-reviewed floor list, and generating it outright would
// take the review out of adding to it. This guard keeps the two in sync without going that far.

import { test } from "node:test";
import assert from "node:assert/strict";
import { harvest } from "../scripts/lib/docs/reference.js";
import { PERSON_ONLY, HUMAN_ONLY } from "../core/presence/index.js";

/** The person's own surfaces: a real terminal, the Deck, Capsule. Never module, mcp, tailnet, hook
 * or a guest -- those already keep a model or another box's peer out on their own. */
const PERSON_SURFACES = new Set(["cli", "local", "deck", "capsule"]);

test("presence: a tool whose callers are person-only surfaces alone is in PERSON_ONLY (or HUMAN_ONLY, or asks presence itself)", () => {
  const data = harvest();
  const bad = [];
  for (const role of /** @type {const} */ (["box", "local"])) {
    for (const [moduleName, m] of Object.entries(data[role])) {
      for (const t of /** @type {any} */ (m).tools || []) {
        if (t.internal || t.hook) continue; // internal carriers and hooks are not a caller's own choice
        if (!Array.isArray(t.callers) || t.callers.length === 0) continue; // no callers list: open to any caller kind, not person-only
        const personOnly = t.callers.every((/** @type {string} */ c) => PERSON_SURFACES.has(c));
        if (!personOnly) continue;
        if (PERSON_ONLY.has(t.name) || HUMAN_ONLY.has(t.name) || t.presence) continue;
        bad.push(`${t.name} (${moduleName}/${role}): callers ${JSON.stringify(t.callers)}, not in PERSON_ONLY or HUMAN_ONLY, and no presence`);
      }
    }
  }
  assert.deepEqual(bad, []);
});
