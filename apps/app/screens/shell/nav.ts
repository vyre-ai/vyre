// The places of /u, in the prototype's order: the default sidebar. The list itself is lib/sidebar/model.js (PLACES), shared with the box's sidebar tools, so what a person arranges and what a
// fresh install shows come from one place. Routes may not all exist yet: the other builders add theirs under app/u/.
import type { NavDef, NavItem } from "@vyre/ui";
import { builtinEntries, layout } from "../../../../lib/sidebar/model.js";
import { RC } from "./rc";

/** The build's flags that decide which built-in places exist (Sites is only in some builds). */
export const PLACE_FLAGS = { sites: Boolean(RC.sites) };

/** A drawn layout as the shell's nav definition. @param {ReturnType<typeof layout>} l */
export function navDef(l: ReturnType<typeof layout>): NavDef {
  return { items: l.items as NavItem[], more: l.more as NavItem[], bottom: l.bottom as NavItem[], groups: l.groups.map((g) => ({ name: g.name, items: g.items as NavItem[] })) };
}

export const NAV: NavDef = navDef(layout(builtinEntries(), { flags: PLACE_FLAGS }));
