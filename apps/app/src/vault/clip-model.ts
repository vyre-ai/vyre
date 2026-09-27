// Copy on the device tapped, as data: when a copied secret is cleared, and what the note says.
// A copy never goes to the Mac (vault.copy is not called from the app). The value is written
// to this device's clipboard, then after CLEAR_AFTER_S cleared if it is still ours:
//   - "compare": the clipboard can be read without a prompt (a browser that granted
//     clipboard-read): clear only if it still holds the same value.
//   - "if-last": native, where reading may show the system's paste banner: never read; clear
//     only if nothing else was copied by the app since (tracked here, in memory).
//   - "none": a browser that can't read silently: never clear, so the note says only "Copied".
// Imports nothing, so its tests run from the repo root as well as from the app.

export const CLEAR_AFTER_S = 30;

export type Plan = "compare" | "if-last" | "none";

/** How this device clears: by its platform and whether it reads the clipboard silently. */
export function planFor(os: string, readsSilently: boolean): Plan {
  if (os === "web") return readsSilently ? "compare" : "none";
  return "if-last";
}

/** The note after a copy: the countdown only where clearing will really happen. */
export function copiedNote(plan: Plan): string {
  return plan === "none" ? "Copied" : `Copied · clears in ${CLEAR_AFTER_S} s`;
}

/** Whether to clear when the time is up. */
export function shouldClear(plan: Plan, o: { mine: boolean; current?: string | null; value?: string }): boolean {
  if (!o.mine) return false;
  if (plan === "if-last") return true;
  if (plan === "compare") return typeof o.value === "string" && o.current === o.value;
  return false;
}

/** This device's clipboard (clipboard.native.ts, clipboard.web.ts). */
export type Board = {
  os: string;
  /** Write the value once it arrives; false when it never came (null) or the write failed. */
  write(pending: Promise<string | null>): Promise<boolean>;
  readsSilently(): Promise<boolean>;
  /** Only called on a "compare" plan. */
  read(): Promise<string | null>;
  clear(): Promise<void>;
};

export type Timers = { set(f: () => void, ms: number): unknown; clear(id: unknown): void };

/**
 * The one copy in flight on this device. The value is held only as long as the plan needs it:
 * dropped at once unless the clipboard must be compared, and dropped when the time is up.
 */
export function makeClip(board: Board, timers: Timers) {
  let seq = 0;
  let last = 0;
  let timer: unknown = null;
  return {
    /** Copy what the pending value resolves to; null when nothing was copied. */
    async copy(pending: Promise<string | null>): Promise<{ said: string } | null> {
      const token = ++seq;
      last = token;
      if (timer !== null) {
        timers.clear(timer);
        timer = null;
      }
      if (!(await board.write(pending))) return null;
      const plan = planFor(board.os, await board.readsSilently().catch(() => false));
      if (token !== last) return { said: copiedNote(plan) };
      let value: string | undefined = plan === "compare" ? ((await pending) ?? undefined) : undefined;
      if (plan !== "none") {
        timer = timers.set(() => {
          timer = null;
          const held = value;
          value = undefined;
          const mine = token === last;
          if (plan === "if-last") {
            if (shouldClear(plan, { mine })) void board.clear().catch(() => {});
            return;
          }
          if (!mine) return;
          void board
            .read()
            .then((current) => (shouldClear(plan, { mine: token === last, current, value: held }) ? board.clear() : undefined))
            .catch(() => {});
        }, CLEAR_AFTER_S * 1000);
      }
      return { said: copiedNote(plan) };
    },
  };
}
