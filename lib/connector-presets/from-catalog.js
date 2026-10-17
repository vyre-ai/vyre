// @ts-check
// lib/connector-presets/from-catalog: presets made from the reviewed catalog snapshot (lib/connector-presets/catalog.snapshot.json), so a person can tap Connect on a catalog row. The snapshot reaches a box only
// through a pull request a person read, the same as presets.json, so it is as trusted as that file: a config file never adds to it. A made preset is the narrowest one the data supports: the vendor published the
// server on its own domain (the snapshot says `verified`), the sign-in is dynamic registration, and the authorization server is pinned to the server's own origin, so a vendor document cannot send the
// code anywhere else. A vendor whose sign-in lives on another origin fails the connect with the reason, not silently. These presets are not listed in `connectors.catalog` (that is the curated list).

import fs from "node:fs";
import { makeCatalog } from "./index.js";
import { connectable, presetIdFor, urlKey } from "../mcp-catalog.js";

const FILE = new URL("./catalog.snapshot.json", import.meta.url);

/** The snapshot as the build carries it, or the file a test names in `config.mcp.catalog`; none is an empty one. @param {any} [config] @returns {{ entries: any[], generated: string | null }} */
export function loadSnapshot(config) {
  const named = config && config.mcp && typeof config.mcp.catalog === "string" && process.env.NODE_TEST_CONTEXT ? config.mcp.catalog : null;
  try {
    const s = JSON.parse(fs.readFileSync(named || FILE, "utf8"));
    return { entries: Array.isArray(s && s.entries) ? s.entries : [], generated: s && typeof s.generated === "string" ? s.generated : null };
  } catch { return { entries: [], generated: null }; }
}

/** One connectable snapshot entry as a preset, or null. @param {any} e */
export function presetFromEntry(e) {
  if (!connectable(e)) return null;
  const origin = new URL(e.url).origin;
  return {
    id: presetIdFor(e), label: String(e.name || e.id).slice(0, 60), group: "work", url: e.url, transport: e.transport,
    who: `Anyone with an account at ${String(e.vendor || "the vendor").slice(0, 60)}.`, evidence: "docs",
    oauth: { client: "dcr", as: [origin] },
    catalog: { id: String(e.id), vendor: String(e.vendor || ""), source: "snapshot" },
  };
}

/**
 * A catalog over the snapshot's connectable entries, kept apart from the curated one. An entry whose address a curated preset already serves is left to that preset, and an id that a curated id
 * extends (by name or prefix) is dropped, so a snapshot can never take over a shipped vendor's host binding.
 * @param {{ entries: any[], generated?: string | null }} snap @param {{ presets(): any[] }} curated
 */
export function snapshotCatalog(snap, curated) {
  const taken = new Set(curated.presets().filter(p => p.url).map(p => urlKey(p.url)));
  const shipped = curated.presets().map(p => p.id);
  const seen = new Set();
  const presets = [];
  for (const e of snap.entries) {
    const p = presetFromEntry(e);
    if (!p || taken.has(urlKey(p.url)) || seen.has(p.id)) continue;
    if (shipped.some(id => p.id === id || p.id.startsWith(`${id}-`) || id.startsWith(`${p.id}-`))) continue;
    seen.add(p.id);
    presets.push(p);
  }
  return makeCatalog({ checked: String(snap.generated || ""), presets });
}
