// Edits to this person's own sidebar list that keep a records view: save, pin, unpin, rename, delete, reorder. One place that applies a pure change (ui/views/saved-views.js) to the list in effect and saves
// it as the person's own (the same whole-list save the Sidebar settings use); the sample world keeps it in memory, because it cannot save one.
import { MOCK, said } from "../../src/real/box";
import { showToast } from "@vyre/ui";
import { effective, saveList, useSidebar, type Entry } from "../shell/sidebar";

/** Apply `change` to the list now in effect and keep the result as this person's own. Says why when it could not be saved, and returns whether it was. */
export async function editList(space: string, change: (list: Entry[]) => Entry[]): Promise<boolean> {
  const { base, mine, load } = useSidebar.getState();
  const next = change(effective(base, mine));
  if (MOCK) { useSidebar.setState({ mine: next, loaded: true }); return true; }
  try { await saveList("me", space, next); await load(space); return true; } catch (e) { showToast(said(e)); return false; }
}

/** The list in effect, for a screen that reads pins. */
export const useEffectiveList = (): Entry[] => {
  const base = useSidebar((s) => s.base), mine = useSidebar((s) => s.mine);
  return effective(base, mine);
};
