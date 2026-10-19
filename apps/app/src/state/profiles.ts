// The profiles of a Space's people, read from that Space (records.list of member-profile, profiles-model.js), and the person's own save. A Space a person joined is reached through its own door
// (src/real/box tool: records.me, records.list, records.create and records.update are member door rows), so the profile lives in the team's Space, not on the person's own home.
// The faces the app draws by name read `looks` (ui/marks/useMark.ts), so a profile's look shows in People and in chats once the Space's profiles are loaded.
import { create } from "zustand";
import { usePersonLooks } from "@vyre/ui";
import { MOCK, tool } from "../real/box";
import { looksByName, profileWrite, profilesOf, type Profile } from "./profiles-model.js";

type Entry = { me: string | null; byPerson: Record<string, Profile>; at: number; error: string };

type S = {
  bySpace: Record<string, Entry>;
  /** Faces by lower-case name across the loaded Spaces: what a face drawn from a name alone uses. */
  looks: Record<string, string>;
  load: (space: string, force?: boolean) => Promise<Entry | null>;
  /** Save the person's own profile in a Space: name, about and look. Throws the box's words. */
  save: (space: string, next: { name?: string; about?: string; look?: string }) => Promise<void>;
};

const FRESH_MS = 30_000;
const real = (space: string) => /^spc_[a-z2-7]{12}$/.test(space);
const said = (e: unknown) => (e instanceof Error ? e.message : "That did not work.");
/** Faces by lower-case name and by person id, across the loaded Spaces. */
const allLooks = (by: Record<string, Entry>) => Object.assign({}, ...Object.values(by).flatMap((e) => [looksByName(e.byPerson), Object.fromEntries(Object.values(e.byPerson).filter((p) => p.look).map((p) => [p.person, p.look]))])) as Record<string, string>;

export const useProfiles = create<S>((set, get) => ({
  bySpace: {},
  looks: {},
  load: async (space, force = false) => {
    if (MOCK || !real(space)) return null;
    const had = get().bySpace[space];
    if (had && !force && Date.now() - had.at < FRESH_MS) return had;
    // Who you are here is asked on its own, so a Space whose profiles cannot be read yet still knows you (and the page can say why a save fails).
    const meP = tool<{ person?: string }>("records.me", { space }).then((r) => (typeof r?.person === "string" ? r.person : null)).catch(() => null);
    let entry: Entry;
    try {
      const list = await tool<unknown>("records.list", { type: "member-profile", space, limit: 200 });
      entry = { me: (await meP) ?? had?.me ?? null, byPerson: profilesOf(list), at: Date.now(), error: "" };
    } catch (e) {
      // A Space whose server has not defined the member-profile type yet (an older server) reads as no profiles, with the reason kept for the page.
      entry = { me: (await meP) ?? had?.me ?? null, byPerson: had?.byPerson ?? {}, at: Date.now(), error: said(e) };
    }
    const bySpace = { ...get().bySpace, [space]: entry };
    const looks = allLooks(bySpace);
    set({ bySpace, looks });
    usePersonLooks.getState().set(looks);
    return entry;
  },
  save: async (space, next) => {
    const cur = (await get().load(space, true)) ?? get().bySpace[space];
    if (cur?.error) throw new Error(`Your profile could not be read in this Space, so nothing was saved: ${cur.error}`);
    if (!cur || !cur.me) throw new Error("Vyre could not tell who you are in this Space. Try again in a moment.");
    const me = cur.me;
    const w = profileWrite(cur.byPerson[me], me, next, space);
    if (w) await tool(w.tool, w.input as Record<string, unknown>);
    await get().load(space, true);
  },
}));

