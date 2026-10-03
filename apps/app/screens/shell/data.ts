// The shell's sample data (public sample world). `loadShell()` is the one read; a real source replaces it.
import type { ShellSpace } from "@vyre/ui";

export type Me = { name: string; sub: string; vyreName: string };
export type ShellData = { me: Me; spaces: ShellSpace[] };

export function loadShell(): ShellData {
  return {
    me: { name: "Alex Rivera", sub: "alex.vyre.run", vyreName: "alex.vyre.run" },
    spaces: [
      { id: "all", name: "All spaces", sub: "One list, everything" },
      { id: "mine", name: "Mine", sub: "Personal space" },
      { id: "harlow", name: "Harlow Legal", sub: "Law firm" },
    ],
  };
}
