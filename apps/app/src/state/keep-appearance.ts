import { useAppearance } from "@vyre/ui";
import { readScheme } from "../../screens/settings/appearance";
import { themeFrom } from "../../screens/settings/appearance-model";
import { useSpaces } from "../../screens/shell/state";
import { changedLooks } from "./appearance-keep.js";
import { allowsMock } from "@vyre/ui";
import { KEY, pack, packPerson, personFor, personKey, unpack, unpackPerson } from "./appearance-keep.js";
import { kvGet, kvSet } from "./kv";

let started = false;

/**
 * Keep the look across a restart. On start: this device's kept settings come back (the person's density, font, reduced motion and larger text, and each space's accent, tint, density, font and corners), and the
 * theme (dark, paper, system) is read from the settings hub on the box, so the app opens the way it was left. After that every change is kept, a moment after the last one.
 */
export function startKeepingAppearance(): void {
  if (started) return;
  started = true;
  void (async () => {
    const kept = unpack(await kvGet(KEY));
    for (const [id, look] of Object.entries(kept.looks)) useSpaces.getState().setLook(id, look as never);
    // the display settings (density, font, reduced motion, larger text) are this Space's: the Space showing reads its own, and the first time a Space has none it takes a copy of what this device kept before they were per Space
    let showing = "";
    let ready = false;
    const open = async (space: string) => {
      showing = space; ready = false;
      const own = unpackPerson(await kvGet(personKey(space)));
      const { person, copied } = personFor(own, kept.person);
      if (showing !== space) return;
      useAppearance.getState().setPerson(person as never);
      if (copied) await kvSet(personKey(space), packPerson(person));
      ready = true;
    };
    void open(useSpaces.getState().space);
    if (!allowsMock()) readScheme().then((r) => useAppearance.getState().setPerson({ theme: themeFrom(r.value) })).catch(() => {});
    let t: ReturnType<typeof setTimeout> | null = null;
    const keep = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        void kvSet(KEY, pack({ person: kept.person, looks: changedLooks(useSpaces.getState().looks) }));
        if (ready && showing) void kvSet(personKey(showing), packPerson(useAppearance.getState().person));
      }, 300);
    };
    useAppearance.subscribe(keep);
    useSpaces.subscribe(keep);
    let was = useSpaces.getState().space;
    useSpaces.subscribe((s) => { if (s.space !== was) { was = s.space; void open(s.space); } });
  })();
}
