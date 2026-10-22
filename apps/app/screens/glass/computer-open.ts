// Which agent's computer is open over the window. The Computer tab and /u/glass both set it; ComputerHost draws it once, over the shell.
import { create } from "zustand";

type Open = { agent: string; route: boolean };

export const useComputerOpen = create<{ open: Open | null }>(() => ({ open: null }));

/** Open an agent's computer over the window. route: opened from /u/glass, so closing leaves that route. */
export function openComputer(agent: string, route = false) {
  const name = String(agent || "");
  if (!name) return;
  useComputerOpen.setState({ open: { agent: name, route } });
}

/** Close it. With an agent, only that one, so a route unmounting does not close a different computer. */
export function closeComputer(agent?: string) {
  const cur = useComputerOpen.getState().open;
  if (!cur) return;
  if (agent && cur.agent !== agent) return;
  useComputerOpen.setState({ open: null });
}
