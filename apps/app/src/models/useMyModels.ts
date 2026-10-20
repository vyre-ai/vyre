// The one hook every model picker reads: the person's own AI accounts and the models each can run, with their details, from the one model service (sessions.accounts.list, then
// sessions.accounts.models for each). It draws from its last copy at once and refreshes in the background, so a picker never waits on an empty list; a failed look keeps the last copy and says so.
import { useCallback, useEffect, useState } from "react";
import { allowsMock } from "@vyre/ui";
import { tool, said } from "../real/box";
import { accountsOf, groupsOf, type ModelGroup } from "./model-choice.js";
import { sampleGroups } from "./mock-models.js";

let last: ModelGroup[] | null = null;
let looking: Promise<ModelGroup[]> | null = null;
const listeners = new Set<(g: ModelGroup[]) => void>();

/** Read the person's accounts and each one's models now (one look at a time), and tell every picker on screen. */
export function refreshMyModels(): Promise<ModelGroup[]> {
  if (allowsMock()) { last = sampleGroups(); for (const f of listeners) f(last); return Promise.resolve(last); }
  if (!looking) {
    looking = (async () => {
      const accounts = accountsOf(await tool("sessions.accounts.list", {}));
      const answers = await Promise.all(accounts.slice(0, 12).map((a) => tool("sessions.accounts.models", { account: a.id }).catch(() => null)));
      const groups = groupsOf(accounts.slice(0, 12), answers);
      last = groups;
      for (const f of listeners) f(groups);
      return groups;
    })().finally(() => { looking = null; });
  }
  return looking;
}

/** The person's groups (null before the first look ever answered), the words of a failed look, and a way to look again. */
export function useMyModels(): { groups: ModelGroup[] | null; error: string; reload: () => void } {
  const [groups, setGroups] = useState<ModelGroup[] | null>(last);
  const [error, setError] = useState("");
  const reload = useCallback(() => { setError(""); refreshMyModels().catch((e) => setError(said(e))); }, []);
  useEffect(() => {
    listeners.add(setGroups);
    reload();
    return () => { listeners.delete(setGroups); };
  }, [reload]);
  return { groups, error, reload };
}
