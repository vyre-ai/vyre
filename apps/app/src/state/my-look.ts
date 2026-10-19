// Your own look: how you are drawn, picked with the same picker as an agent's (Settings > Account, Change your look). It is kept on this device (the app's local store), not on the box: the settings
// hub's account level is the whole Space's, not a person's, and the box keeps no profile for a person yet, so other people still see you drawn from your name. "" means no look picked.
import { create } from "zustand";
import { kvGet, kvSet } from "./kv";

const KEY = "vyre.me.look";
const LOOK = /^s[0-7]~c(?:1[0-5]|[0-9])(?:~[emtbh]\d)*$/;

export const useMyLook = create<{ look: string; set: (look: string) => void }>((set) => ({
  look: "",
  set: (look) => { const v = LOOK.test(look) ? look : ""; set({ look: v }); void kvSet(KEY, v); },
}));

let started = false;
/** Bring this device's kept look back after a restart. */
export function startKeepingMyLook(): void {
  if (started) return;
  started = true;
  void kvGet(KEY).then((v) => { if (typeof v === "string" && LOOK.test(v)) useMyLook.setState({ look: v }); }).catch(() => {});
}
