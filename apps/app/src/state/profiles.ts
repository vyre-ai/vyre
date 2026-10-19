// The profiles of a Space's people, read from that Space (records.list of member-profile, profiles-model.js), and the person's own save. A Space a person joined is reached through its own door
// (src/real/box tool: records.me, records.list, records.create and records.update are member door rows), so the profile lives in the team's Space, not on the person's own home.
// The faces the app draws by name read `looks` (ui/marks/useMark.ts), so a profile's look shows in People and in chats once the Space's profiles are loaded. A profile's photo is its own
// member-photo record, named by id from the profile: the faces read it once, by address, through the same door (records.get), and keep it (ui/marks/usePersonLooks.ts photoCache).
import { create } from "zustand";
import { photoCache, usePersonLooks } from "@vyre/ui";
import { MOCK, tool } from "../real/box";
import { dataUri } from "../../ui/marks/photo-model.js";
import { looksByName, photoCreate, photoUrn, photosOf, profileWrite, profilesOf, type Profile } from "./profiles-model.js";
import type { Picture } from "./profile-photo";

type Entry = { me: string | null; byPerson: Record<string, Profile>; at: number; error: string };

type S = {
  bySpace: Record<string, Entry>;
  /** Faces by lower-case name across the loaded Spaces: what a face drawn from a name alone uses. */
  looks: Record<string, string>;
  load: (space: string, force?: boolean) => Promise<Entry | null>;
  /** Save the person's own profile in a Space: name, about and look. Throws the box's words. */
  save: (space: string, next: { name?: string; about?: string; look?: string }) => Promise<void>;
  /** Keep a new profile photo in a Space (a new member-photo record, then the profile names it), or take it away (null). The picture before is wiped. Throws the box's words. */
  setPhoto: (space: string, pic: Picture | null, name?: string) => Promise<void>;
};

const FRESH_MS = 30_000;
const real = (space: string) => /^spc_[a-z2-7]{12}$/.test(space);
const said = (e: unknown) => (e instanceof Error ? e.message : "That did not work.");
/** Photos by person id and by name across the loaded Spaces, as the photo records' addresses. */
const allPhotos = (by: Record<string, Entry>) => Object.assign({}, ...Object.entries(by).map(([space, e]) => photosOf(e.byPerson, space))) as Record<string, string>;
/** A photo by its address: the record read in the Space it names, through that Space's door when it is a team the person joined (records.get takes no Space of its own). */
async function readPhoto(urn: string): Promise<string> {
  const space = /^vyre:\/\/(spc_[a-z2-7]{12})\//.exec(urn)?.[1] ?? "";
  const joined = space ? await (await import("../real/team-join")).joinedHere(space).catch(() => false) : false;
  return dataUri(await tool<unknown>("records.get", joined ? { urn, space } : { urn }));
}
usePersonLooks.getState().setReader(readPhoto);

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
    usePersonLooks.getState().setPhotos(allPhotos(bySpace));
    return entry;
  },
  save: async (space, next) => {
    const cur = await mine(space);
    const w = profileWrite(cur.byPerson[cur.me], cur.me, next, space);
    if (w) await tool(w.tool, w.input as Record<string, unknown>);
    await get().load(space, true);
  },
  setPhoto: async (space, pic, name) => {
    const cur = await mine(space);
    const before = cur.byPerson[cur.me]?.photo ?? "";
    let id = "";
    if (pic) {
      const made = await tool<{ id?: string; record?: { id?: string } }>("records.create", photoCreate(cur.me, space, pic) as unknown as Record<string, unknown>);
      id = String(made?.id ?? made?.record?.id ?? "");
      if (!id) throw new Error("The photo was not kept. Try again.");
      // the person's own face changes at once, before anyone reads it back
      photoCache.put(photoUrn(space, id), `data:${pic.mime};base64,${pic.base64}`);
    }
    const w = profileWrite(cur.byPerson[cur.me], cur.me, { ...(name ? { name } : {}), photo: id }, space);
    if (w) await tool(w.tool, w.input as Record<string, unknown>);
    await get().load(space, true);
    // the picture before is wiped, so the Space no longer holds it; best effort, the profile no longer names it either way
    if (before && before !== id) {
      const urn = photoUrn(space, before);
      void tool<{ record?: { version?: number } | null }>("records.get", { urn }).then((r) => (r?.record ? tool("records.update", { urn, patch: { image: "", bytes: 0 }, base_version: Number(r.record.version) || 0 }) : null)).catch(() => {});
    }
  },
}));

/** The person's own entry in a Space, read fresh, or the reason a save cannot go ahead. */
async function mine(space: string): Promise<Entry & { me: string }> {
  const s = useProfiles.getState();
  const cur = (await s.load(space, true)) ?? s.bySpace[space];
  if (cur?.error) throw new Error(`Your profile could not be read in this Space, so nothing was saved: ${cur.error}`);
  if (!cur || !cur.me) throw new Error("Vyre could not tell who you are in this Space. Try again in a moment.");
  return cur as Entry & { me: string };
}


