// Sample world only (a mock build): the proof that a notice is made with the app closed (apps/app/scripts/notices-android.sh). The proof route arms a scripted server answer here, closes its screen, and the
// foreground service's headless task runs the real loop (notices.ts) against it: an empty look, then one approval waiting. The script then reads the phone's notifications. Nothing arms this in a packaged build.
import { allowsMock } from "@vyre/ui";

let script: null | (<T = unknown>(tool: string, input?: unknown) => Promise<{ data?: T; error?: unknown }>) = null;

/** The scripted answers, or null when none is armed (always null outside a mock build). */
export function scriptedCall(): typeof script { return allowsMock() ? script : null; }

/** After `afterMs` the scripted server has one approval waiting; before that it has nothing. Returns false in a packaged build. */
export function armNoticesProof(afterMs: number): boolean {
  if (!allowsMock()) return false;
  const t0 = Date.now();
  script = (async (tool: string) => {
    if (tool === "approvals.pending") return { data: Date.now() - t0 < afterMs ? { approvals: [] } : { approvals: [{ id: "proof-1", line: "Proof: a call waits for your yes" }] } } as never;
    return { data: [] } as never;
  }) as never;
  return true;
}
