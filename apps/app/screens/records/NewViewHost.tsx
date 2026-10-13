import { create } from "zustand";
import { usePathname, useRouter } from "expo-router";
import { useRecordsWorld } from "@vyre/ui";
import { NewViewSheet } from "./NewViewSheet";
import { useSidebar } from "../shell/sidebar";
import { useSpaces } from "../shell/state";

/** Whether the New view sheet is open: the sidebar's "New view" row opens it from any records page. */
export const useNewView = create<{ open: boolean; set: (v: boolean) => void }>((set) => ({ open: false, set: (open) => set({ open }) }));

/** Mounted once in the shell: the New view sheet the Records panel opens. After a save it shows the new view. */
export function NewViewHost() {
  const { open, set } = useNewView();
  const router = useRouter();
  const path = usePathname();
  const { data: world } = useRecordsWorld();
  const space = useSpaces((s) => s.space);
  const canShare = useSidebar((s) => s.canSetDefault);
  if (!open || !world) return null;
  const here = /^\/u\/records\/([^/?]+)/.exec(path)?.[1];
  const type = here && world.types.some((t: { name: string }) => t.name === here) ? here : world.types[0]?.name ?? "";
  return <NewViewSheet open onClose={() => set(false)} types={world.types} type={type} space={space} canShare={canShare}
    onSaved={(name, t) => router.replace(`/u/records/${t}?view=${encodeURIComponent(name)}` as never)} />;
}
