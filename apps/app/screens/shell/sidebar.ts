// The sidebar the shell draws: the built-in places, laid out with the Space's default and this person's own arrangement on top (lib/sidebar/model.js has the rules, the box's sidebar tools keep
// the lists). A Space on this device's own box is read through the box's tools; a team Space this device joined is read through the team's server (the Space kernel's `sidebar` service), so a
// member's list is kept on the team's server and follows them across devices. Without a box (the sample world) or on a box that has no sidebar tools yet, the built-in places stand: today's NAV.
import { useMemo } from "react";
import { create } from "zustand";
import { ICON_NAMES } from "../../ui/components/Icon";
import { builtinEntries, layout, merge } from "../../../../lib/sidebar/model.js";
import { MOCK, tool } from "../../src/real/box";
import { joinedHere, teamCall } from "../../src/real/team-join";
import { navDef, PLACE_FLAGS } from "./nav";
import type { NavDef } from "@vyre/ui";

export type Entry = { kind: "place"; id: string; group?: string; hidden?: boolean; roles?: string[] } | { kind: "module"; module: string; screen: string; group?: string; hidden?: boolean; roles?: string[] } | { kind: "screen"; id: string; group?: string; hidden?: boolean; roles?: string[] } | { kind: "view"; id: string; label: string; href: string; icon?: string; group?: string; hidden?: boolean; roles?: string[] };
export type ModuleScreens = { module: string; label?: string; origin?: string; screens: { id: string; label: string; path?: string; icon?: string; view?: boolean }[] };

type S = {
  loaded: boolean;
  space: string;
  /** The Space's default (null: none stored, the built-in places stand). */
  base: Entry[] | null;
  mine: Entry[];
  modules: ModuleScreens[];
  /** The person's role in the showing Space, as the kernel states it (its `temp` is the guest a person sees). */
  role: string;
  /** May this person set the Space's default (its owner or admin role)? */
  canSetDefault: boolean;
  load: (space: string) => Promise<void>;
};

/** The id the box keeps a Space's default under: a real Space's id, else "*" (the sample world, "all"). */
export const spaceKey = (space: string) => (/^spc_[a-z2-7]{12}$/.test(space) ? space : "*");

/** The person's role in a Space, from the box's list of Spaces (each row says the role they hold there). "" when the box does not say. */
async function roleIn(space: string): Promise<string> {
  try {
    const rows = await tool<{ id?: string; role?: string }[]>("spaces.list");
    const row = (Array.isArray(rows) ? rows : []).find((r) => r && r.id === space);
    return row && typeof row.role === "string" ? row.role : "";
  } catch {
    return "";
  }
}

/** One sidebar call for a Space: through the team's server when this device joined it as a member, else through the box this app talks to. */
export async function sidebarCall<T = unknown>(space: string, name: "sidebar.get" | "sidebar.edit" | "sidebar.team", input: Record<string, unknown> = {}): Promise<T> {
  const key = spaceKey(space);
  const body = { ...input, space: key };
  if (key !== "*" && (await joinedHere(key))) return (await teamCall(key, name, [body])) as T;
  return tool<T>(name, body);
}

export const useSidebar = create<S>((set) => ({
  loaded: false, space: "*", base: null, mine: [], modules: [], role: "", canSetDefault: false,
  async load(space) {
    if (MOCK) { set({ loaded: true }); return; }
    try {
      const r = await sidebarCall<{ default: Entry[] | null; mine: Entry[]; modules: ModuleScreens[]; can_set_default?: boolean; role?: string }>(space, "sidebar.get");
      // The role the box states for this person in this Space; the list of Spaces says it too when the box does not.
      const role = typeof r.role === "string" && r.role ? r.role : await roleIn(space);
      set({ loaded: true, space: spaceKey(space), base: r.default, mine: Array.isArray(r.mine) ? r.mine : [], modules: Array.isArray(r.modules) ? r.modules : [], role, canSetDefault: r.can_set_default === true });
    } catch { set({ loaded: true, space: spaceKey(space), base: null, mine: [], modules: [], role: "", canSetDefault: false }); }   // no sidebar tools there: the built-in places
  },
}));

/** The entries now in effect: the person's list over the default (or the built-in places). */
export const effective = (base: Entry[] | null, mine: Entry[]): Entry[] => merge(base ?? builtinEntries(), mine) as Entry[];

/** An icon the app can draw: a module or a view may name one it does not have. */
const safeIcon = (name: string) => ((ICON_NAMES as readonly string[]).includes(name) ? name : "box");

/** The catalog layout draws from: this build's places and the installed module screens, and the role of the person looking (the kernel's, as it states it). */
export const catalogOf = (modules: ModuleScreens[], admin = false, role = "") => ({ flags: PLACE_FLAGS, modules, admin, role });

/** The nav definition the shell draws for a Space. */
export function useNavDef(space: string): NavDef {
  const { base, mine, modules, canSetDefault, role } = useSidebar();
  // The Build group is for an owner or an admin; the sample world (no box) shows it so the whole sidebar can be seen.
  const admin = MOCK || canSetDefault;
  // In the sample world the person owns the Space they are looking at.
  const viewer = MOCK ? "owner" : role;
  return useMemo(() => {
    const nav = navDef(layout(effective(base, mine) as never, catalogOf(modules, admin, viewer)));
    const fix = (items: NavDef["items"]) => items.map((it) => ({ ...it, icon: safeIcon(it.icon) as never }));
    return { items: fix(nav.items), more: fix(nav.more), bottom: fix(nav.bottom), groups: (nav.groups ?? []).map((g) => ({ name: g.name, items: fix(g.items) })) };
  }, [base, mine, modules, space, admin, viewer]);
}

/** Replace a whole list, for me or (if the role allows) for the team. */
export async function saveList(scope: "me" | "team", space: string, entries: Entry[]) {
  await sidebarCall(space, scope === "team" ? "sidebar.team" : "sidebar.edit", { op: "set", entries });
}
