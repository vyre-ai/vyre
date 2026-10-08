// The box's update status for Now and About: read once when the screen mounts and again after a check or an update. Real boxes only; the sample world has no updates.
import { useCallback, useEffect } from "react";
import { create } from "zustand";
import { allowsMock } from "@vyre/ui";
import { updateApply, updateCheck, updateStatus } from "../../screens/settings/real";
import type { UpdateStatus } from "../../screens/settings/real-model";

type S = {
  status: UpdateStatus | null;
  busy: boolean;
  set: (s: UpdateStatus | null) => void;
  setBusy: (b: boolean) => void;
};
const useStore = create<S>((set) => ({ status: null, busy: false, set: (status) => set({ status }), setBusy: (busy) => set({ busy }) }));

/** The status, and the three things a screen does with it. `apply` answers what update.apply answered. */
export function useUpdate() {
  const { status, busy, set, setBusy } = useStore();
  const load = useCallback(async () => { try { set(await updateStatus()); } catch { /* an old box with no update tool: no card */ } }, [set]);
  useEffect(() => { if (!allowsMock()) void load(); }, [load]);
  const check = useCallback(async () => { setBusy(true); try { set(await updateCheck()); } finally { setBusy(false); } }, [set, setBusy]);
  const apply = useCallback(async () => {
    setBusy(true);
    try { const r = await updateApply(); await load(); return r; } finally { setBusy(false); }
  }, [load, setBusy]);
  return { status, busy, load, check, apply };
}
