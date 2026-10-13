// threads.list for an agent's Work section, answered from memory in the sample build (EXPO_PUBLIC_VYRE_MOCK=1) only. The shape is the box's own (core/switchboard record()).
const now = Date.now();
const t = (id: string, agent: string, o: Record<string, unknown>) => ({ id, agent, name: agent, project: "juniper", model: "sonnet", asks: 0, status: "idle", ...o });
const ALL = [
  t("th_intake_chat", "intake", { purpose: "agent", name: "Draft the reply to Dana Wu", last: now - 8 * 60_000, status: "waiting", asks: 1 }),
  t("th_intake_job1", "intake", { purpose: "job", last: now - 45 * 60_000, status: "working" }),
  t("th_intake_job2", "intake", { purpose: "job", last: now - 5 * 3_600_000, status: "idle" }),
  t("th_intake_chat2", "intake", { purpose: "agent", name: "Conflict check for the Harlow matter", last: now - 26 * 3_600_000, status: "idle" }),
  t("th_intake_job3", "intake", { purpose: "job", last: now - 3 * 86_400_000, status: "stopped", stopped_reason: "exit 1" }),
  t("th_refunds_job", "refunds", { purpose: "job", last: now - 2 * 3_600_000 }),
];
export const mockAgentWorkTools: Record<string, (i: any) => unknown> = {
  "threads.list": (i) => i?.agent ? ALL.filter((r) => r.agent === i.agent) : [],
};
