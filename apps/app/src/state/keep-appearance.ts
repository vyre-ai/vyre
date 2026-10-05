import { useAppearance } from "@vyre/ui";
import { readScheme } from "../../screens/settings/appearance";
import { themeFrom } from "../../screens/settings/appearance-model";
import { useSpaces } from "../../screens/shell/state";
import { changedLooks } from "./appearance-keep.js";
import { allowsMock } from "@vyre/ui";
import { KEY, pack, unpack } from "./appearance-keep.js";
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
    if (Object.keys(kept.person).length) useAppearance.getState().setPerson(kept.person);
    for (const [id, look] of Object.entries(kept.looks)) useSpaces.getState().setLook(id, look as never);
    if (!allowsMock()) readScheme().then((r) => useAppearance.getState().setPerson({ theme: themeFrom(r.value) })).catch(() => {});
    let t: ReturnType<typeof setTimeout> | null = null;
    const keep = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => { void kvSet(KEY, pack({ person: useAppearance.getState().person, looks: changedLooks(useSpaces.getState().looks) })); }, 300);
    };
    useAppearance.subscribe(keep);
    useSpaces.subscribe(keep);
  })();
}
