// @ts-check
// Fixtures for the flow-runs contract (team/contracts/flow-runs.md). A consumer imports these to build against the shape while the producer's tools change underneath.
export const RECORD_URN = "vyre://spc_aaaaaaaaaaaa/matter/11111111-1111-4111-8111-111111111111";

/** A row of flows.runs for a run a stage move started. */
export const RUN_ROW = Object.freeze({ id: "run_fixture0000000000000a", flow: "fl_fixture", version: 1, state: "done", started_at: 1_790_000_000_000, finished_at: 1_790_000_000_500, tainted: false, record: RECORD_URN, label: "Welcome the client", error: null });

/** An entry of work.timeline for that run. */
export const TIMELINE_ENTRY = Object.freeze({ type: "flow-run", kind: "flow", title: "Welcome the client", line: "Welcome the client: done" });
