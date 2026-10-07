// What the web app shows while a kernel act waits for the person's phone: one open ask at a time, its words, and a way to stop waiting.
import { create } from "zustand";

type S = { open: boolean; line: string; signal: { stopped: boolean }; show: (line?: string) => void; hide: () => void; cancel: () => void };

export const useApproval = create<S>((set, get) => ({
  open: false,
  line: "",
  signal: { stopped: false },
  show: (line = "") => set({ open: true, line, signal: { stopped: false } }),
  hide: () => set({ open: false }),
  cancel: () => { get().signal.stopped = true; set({ open: false }); },
}));
