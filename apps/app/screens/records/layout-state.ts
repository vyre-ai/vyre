import { useCallback, useEffect, useState } from "react";
import { showToast } from "@vyre/ui";
import { callT } from "../../src/real/call-tool";
import { hasMine, ownLayout } from "../../ui/views/layout.js";

export type LayoutScope = "mine" | "space";

/**
 * How a type is shown to this person (records.layout.get): their own choices laid over the Space's. `save` changes one key in the scope being edited ("mine" is theirs alone; "space" is everyone's and an
 * owner's or admin's act); `reset` drops their own layer so the Space's shows again.
 */
export function useTypeLayout(type: string) {
  const [state, setState] = useState<{ layout: any; source: any }>({ layout: {}, source: {} });
  const [scope, setScope] = useState<LayoutScope>("mine");
  const load = useCallback(() => { void callT<{ layout: any; source: any }>("records.layout.get", { type }).then((r) => { if (r.data) setState({ layout: r.data.layout ?? {}, source: r.data.source ?? {} }); }); }, [type]);
  useEffect(() => { setState({ layout: {}, source: {} }); load(); }, [load]);
  const save = useCallback(async (key: string, value: unknown): Promise<boolean> => {
    const r = await callT("records.layout.set", { type, scope, layout: ownLayout(state.layout, state.source, scope, key, value) });
    if (r.error) { showToast(r.error.message || "That did not save."); return false; }
    load();
    return true;
  }, [type, scope, state, load]);
  const reset = useCallback(async () => {
    const r = await callT("records.layout.set", { type, scope: "mine", layout: {} });
    if (r.error) { showToast(r.error.message || "That did not reset."); return; }
    showToast("Back to the Space layout.");
    load();
  }, [type, load]);
  return { layout: state.layout, source: state.source, scope, setScope, save, reset, mine: hasMine(state.source) };
}
