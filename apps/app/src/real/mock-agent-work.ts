// threads.list for an agent's Work section, answered from memory in the sample build (EXPO_PUBLIC_VYRE_MOCK=1) only. The shape is the box's own (core/switchboard record()).
const now = Date.now();
const t = (id: string, agent: string, o: Record<string, unknown>) => ({ id, agent, name: agent, project: "juniper", model: "sonnet", asks: 0, status: "idle", ...o });
const ALL = [
  t("th_intake_chat", "intake", { purpose: "agent", name: "Draft the reply to Dana Wu", last: now - 8 * 60_000, status: "waiting", asks: 1 }),
  t("th_intake_job1", "intake", { purpose: "job", last: now - 45 * 60_000, status: "working" }),
  t("th_intake_job2", "intake", { purpose: "job", last: now - 5 * 3_600_000, status: "idle" }),
  t("th_intake_chat2", "intake", { purpose: "agent", name: "Conflict check for the Harlow matter", last: now - 26 * 3_600_000, status: "idle" }),
  t("th_intake_job3", "intake", { purpose: "job", last: now - 3 * 86_400_000, status: "stopped", stopped_reason: "exited 1" }),
  t("th_refunds_job", "refunds", { purpose: "job", last: now - 2 * 3_600_000 }),
];
// A sample Flow chat: "Refund request" woken three times for the refunds agent, one run waiting on you.
const fo = (flow: string, run: string, no: string, rec: string, o = {}) => ({ flow, run, run_no: no, step: "2", step_name: "refunds agent", flow_name: "Refund request", record_name: rec, approver: "Dana", ...o });
const FLOW = [
  t("th_refund_41", "refunds", { purpose: "job", name: "Flow: Handle refund - Refund request", started: now - 26 * 3_600_000, last: now - 26 * 3_600_000, origin: fo("flow_refund", "run_41", "41", "Refund for Sam Ortiz") }),
  t("th_refund_42", "refunds", { purpose: "job", name: "Flow: Handle refund - Refund request", started: now - 5 * 3_600_000, last: now - 5 * 3_600_000, status: "stopped", stopped_reason: "exited 1", origin: fo("flow_refund", "run_42", "42", "Refund for Lee Park") }),
  t("th_refund_43", "refunds", { purpose: "job", name: "Flow: Handle refund - Refund request", started: now - 20 * 60_000, last: now - 20 * 60_000, status: "waiting", asks: 1, origin: fo("flow_refund", "run_43", "43", "Refund for Jane Doe") }),
];
export const mockAgentWorkTools: Record<string, (i: any) => unknown> = {
  "threads.list": (i) => i?.agent ? [...ALL, ...FLOW].filter((r) => r.agent === i.agent) : FLOW,
};
