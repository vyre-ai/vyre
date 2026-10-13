import { useEffect } from "react";
import { MOCK } from "../../src/real/box";
import { useMembers } from "../spaces/state";
import { mayMakeTemplates } from "./use";

/** The session's role in the space showing (the one Settings, People reads), and so whether to show the buttons that make or copy a template. The sample build is an admin. */
export function useMayMakeTemplates(): boolean {
  const { spaces, space, load } = useMembers();
  useEffect(() => { if (!MOCK && !spaces.length) void load(); }, [spaces.length, load]);
  if (MOCK) return true;
  const cur = spaces.find((x) => x.id === space) ?? (spaces.length === 1 ? spaces[0] : undefined);
  return mayMakeTemplates(cur?.role);
}
