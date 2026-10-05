// The shell's data, shared: the space switcher, the person's line, and the screens that name the showing space read one copy. In a mock build it is the sample world; otherwise
// it starts with only All spaces and is filled from the box by UiShell.
import { useSpaces } from "./state";
import { create } from "zustand";
import { allowsMock } from "@vyre/ui";
import { loadShell } from "./data";
import { ALL, type ShellData } from "./real-model";

type S = { data: ShellData; loaded: boolean; error: string; set: (d: ShellData) => void; fail: (m: string) => void };

export const useShell = create<S>((set) => ({
  data: allowsMock() ? loadShell() : { me: { name: "You", sub: "", vyreName: "" }, spaces: [ALL] },
  loaded: allowsMock(),
  error: "",
  set: (data) => set({ data, loaded: true, error: "" }),
  fail: (error) => set({ error }),
}));

/** The home time zone of the space showing (an IANA name), or null: under All spaces, in Personal, or when the space has none. Times that belong to the space also show in it. */
export function useSpaceZone(): string | null {
  const space = useSpaces((s) => s.space);
  const spaces = useShell((s) => s.data.spaces);
  return spaces.find((x) => x.id === space)?.zone ?? null;
}
