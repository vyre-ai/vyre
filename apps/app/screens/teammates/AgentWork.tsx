import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Banner, Card, Divider, LoadingState, Select, Text } from "@vyre/ui";
import { callT as call } from "../../src/real/call-tool";
import { LIMITS, TITLE, accountLine, accountOptions, limitLine, limitOptions, reportLine, reportValue, REPORTS, refusal, settingOf, usable, type Setting } from "./agent-work-model";
import type { Teammate } from "./model";

/** The project's "Agent work" section: the AI account agents work on, a different one for one teammate, the daily limit, and how often the lead reports. `project` is the Project record's id. */
export function AgentWork({ project, rows }: { project: string; rows: Teammate[] }) {
  const [slug, setSlug] = useState("");
  const [set, setSet] = useState<Setting | null>(null);
  const [mine, setMine] = useState<Record<string, string>>({});
  const [accounts, setAccounts] = useState<ReturnType<typeof usable>>([]);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const read = useCallback(async () => {
    const ref = await call<{ slug?: string }>("work.project.ref", { project });
    if (ref.error || !ref.data?.slug) { setProblem("This project could not be read, so its agent work settings are not shown. Open the project again."); return; }
    const s = ref.data.slug;
    setSlug(s);
    const [one, list] = await Promise.all([call("agents.work.setting", { project: s }), call("sessions.accounts.list", {})]);
    if (one.error) { setProblem(refusal(one.error.code, one.error.message)); return; }
    setSet(settingOf(one.data));
    setAccounts(usable(list.data));
    const picks: Record<string, string> = {};
    await Promise.all(rows.map(async (t) => { const r = await call("agents.work.setting", { project: s, agent: t.agent }); const x = settingOf(r.data); if (x.agentPick && x.account) picks[t.agent] = x.account; }));
    setMine(picks);
  }, [project, rows.map((t) => t.agent).join(",")]);
  useEffect(() => { void read(); }, [read]);
  const save = async (input: Record<string, unknown>) => {
    setBusy(true); setProblem("");
    const r = await call("agents.work.set", { project: slug, ...input });
    setBusy(false);
    if (r.error) setProblem(refusal(r.error.code, r.error.message)); else void read();
  };
  if (!set) return problem ? <Card><Banner tone="warn"><Text>{problem}</Text></Banner></Card> : <LoadingState rows={2} />;
  const options = accountOptions(accounts);
  return (
    <Card className="gap-s3" title={TITLE}>
      <Text size="caption" tone="label">What agents on this project do on their own, and what it spends.</Text>
      <Select label="AI account for agent work" value={set.account || ""} options={options} disabled={busy} onChange={(v: string) => void save({ account: v || null })} />
      <Text size="caption" tone="label">{accountLine(set, accounts)}</Text>
      {rows.length ? (
        <View className="gap-s2">
          <Divider />
          <Text strong>One teammate on its own account</Text>
          {rows.map((t) => (
            <Select key={t.agent} label={t.role} value={mine[t.agent] || ""} options={[["", "The project's account"], ...options.slice(1)]} disabled={busy} onChange={(v: string) => void save({ agent: t.agent, account: v || null })} />
          ))}
        </View>
      ) : null}
      <Divider />
      <Select label="Daily limit" value={String(set.dailyLimit ?? 100)} options={limitOptions(set.dailyLimit).filter(([v]) => LIMITS.includes(Number(v) as never) || Number(v) === set.dailyLimit)} disabled={busy} onChange={(v: string) => void save({ daily_limit: Number(v) })} />
      <Text size="caption" tone="label">{limitLine}</Text>
      <Select label="Report from the project lead" value={reportValue(set.reportHours)} options={REPORTS} disabled={busy} onChange={(v: string) => void save({ report_hours: Number(v) })} />
      <Text size="caption" tone="label">{reportLine(set.reportHours)}</Text>
      {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
    </Card>
  );
}
