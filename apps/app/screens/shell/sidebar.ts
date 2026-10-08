// The sidebar the shell draws: the built-in places, laid out with the Space's default and this person's own arrangement on top (lib/sidebar/model.js has the rules, the box's sidebar tools keep
// the lists). Without a box (the sample world) or on a box that has no sidebar tools yet, the built-in places stand: today's NAV.
import { useMemo } from "react";
import { create } from "zustand";
import { ICON_NAMES } from "../../ui/components/Icon";
import { builtinEntries, layout, merge } from "../../../../lib/sidebar/model.js";
import { MOCK, tool } from "../../src/real/box";
import { navDef, PLACE_FLAGS } from "./nav";
import type { NavDef } from "@vyre/ui";

export type Entry = { kind: "place"; id: string; group?: string; hidden?: boolean } | { kind: "module"; module: string; screen: string; group?: string; hidden?: boolean } | { kind: "view"; id: string; label: string; href: string; icon?: string; group?: string; hidden?: boolean };
export type ModuleScreens = { module: string; label?: string; screens: { id: string; label: string; path?: string; icon?: string }[] };

type S = {
  loaded: boolean;
  space: string;
  /** The Space's default (null: none stored, the built-in places stand). */
  base: Entry[] | null;
  mine: Entry[];
  modules: ModuleScreens[];
  load: (space: string) => Promise<void>;
};

/** The id the box keeps a Space's default under: a real Space's id, else "*" (the sample world, "all"). */
export const spaceKey = (space: string) => (/^spc_[a-z2-7]{12}$/.test(space) ? space : "*");

export const useSidebar = create<S>((set) => ({
  loaded: false, space: "*", base: null, mine: [], modules: [],
  async load(space) {
    if (MOCK) { set({ loaded: true }); return; }
    const key = spaceKey(space);
    try {
      const r = await tool<{ default: Entry[] | null; mine: Entry[]; modules: ModuleScreens[] }>("sidebar.get", { space: key });
      set({ loaded: true, space: key, base: r.default, mine: Array.isArray(r.mine) ? r.mine : [], modules: Array.isArray(r.modules) ? r.modules : [] });
    } catch { set({ loaded: true, space: key, base: null, mine: [], modules: [] }); }   // no sidebar tools on this box: the built-in places
  },
}));

/** The entries now in effect: the person's list over the default (or the built-in places). */
export const effective = (base: Entry[] | null, mine: Entry[]): Entry[] => merge(base ?? builtinEntries(), mine) as Entry[];

/** An icon the app can draw: a module or a view may name one it does not have. */
const safeIcon = (name: string) => ((ICON_NAMES as readonly string[]).includes(name) ? name : "box");

/** The catalog layout draws from: this build's places and the installed module screens. */
export const catalogOf = (modules: ModuleScreens[]) => ({ flags: PLACE_FLAGS, modules });

/** The nav definition the shell draws for a Space. */
export function useNavDef(space: string): NavDef {
  const { base, mine, modules } = useSidebar();
  return useMemo(() => {
    const nav = navDef(layout(effective(base, mine) as never, catalogOf(modules)));
    const fix = (items: NavDef["items"]) => items.map((it) => ({ ...it, icon: safeIcon(it.icon) as never }));
    return { items: fix(nav.items), more: fix(nav.more), bottom: fix(nav.bottom), groups: (nav.groups ?? []).map((g) => ({ name: g.name, items: fix(g.items) })) };
  }, [base, mine, modules, space]);
}

/** Make one change for me or for the team: the whole list, replaced. @param scope "me" or "team" */
export async function saveList(scope: "me" | "team", space: string, entries: Entry[]) {
  await tool("sidebar.edit", { op: "set", scope, space: spaceKey(space), entries });
}
