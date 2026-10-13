// Assistants and AI accounts from the real box: agents.list and agents.usage, agents.stop and agents.resume for pause, providers.list for the accounts.
// No autonomy dial and no budget editor here: the box has no tool for either yet, so there is no control that would not work.
import { ConnectClaude } from "./ConnectClaude";
import { AccountsCard } from "./AccountsCard";
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Avatar, Banner, Card, Chip, Divider, Meter, Text, markRef, showToast, ErrorState, LoadingState } from "@vyre/ui";
import { Page } from "../places/Frame";
import { budgetLine, money, providerRows, usedShare, type Agent, type Provider, type Usage } from "./agents-model";
import { agentsUsage, providers } from "./real";
import { showingJoined } from "../../src/real/team-join";
import { PlaceTag } from "../../src/real/PlaceTag";

const say = (e: unknown, f = "That did not work.") => (e instanceof Error ? e.message : f);

export function RealAi() {
  const [ps, setPs] = useState<Provider[] | null>(null);
  const [us, setUs] = useState<Usage[]>([]);
  const [err, setErr] = useState("");
  const [member, setMember] = useState(false);
  useEffect(() => { void showingJoined().then(setMember).catch(() => setMember(false)); }, []);
  const load = useCallback(() => { setErr(""); providers().then(setPs).catch((e) => setErr(say(e, "AI accounts did not answer."))); agentsUsage().then(setUs).catch(() => setUs([])); }, []);
  useEffect(load, [load]);
  const rows = ps ? providerRows(ps) : [];
  const budgeted = us.filter((u) => u.agent && u.budget_usd != null);
  return (
    <Page title="AI accounts" back="/u/settings">
      <PlaceTag of="home" />
      <Banner>Nobody's work runs on someone else's account. Your chats use your accounts and count against your budget.</Banner>
      {member ? null : <ConnectClaude onConnected={load} />}
      <AccountsCard />
      {err ? <Card flush><ErrorState title="AI accounts did not load" reason={err} retry={load} /></Card> : null}
      {ps === null && !err ? <LoadingState rows={3} /> : null}
      {ps ? (
        <Card flush>
          {rows.map((r, i) => (
            <View key={r.id}>{i ? <Divider /> : null}
              <View className="flex-row items-center gap-s3 p-s3">
                <Avatar of={markRef("agent", r.name)} size={40} />
                <View className="min-w-0 flex-1 gap-s1"><View className="flex-row flex-wrap items-center gap-s2"><Text strong>{r.name}</Text>{r.on ? <Chip tone="ok">Connected</Chip> : <Chip>Not connected</Chip>}</View><Text size="caption" tone="label">{r.line}</Text></View>
              </View>
            </View>
          ))}
        </Card>
      ) : null}
      {us.length ? (
        <Card className="gap-s2">
          <Text strong>{`${money(us.reduce((n, u) => n + (u.spent_usd || 0), 0))} spent by agents`}</Text>
          {budgeted.map((u) => (
            <View key={u.agent} className="gap-s1"><Text size="secondary">{`${u.agent}: ${budgetLine(u)}`}</Text><Meter value={usedShare(u)} label={`${u.agent} budget used`} /></View>
          ))}
          <Text size="caption" tone="label">Set a budget per agent with vyre agents update. Connect an account with vyre providers.</Text>
        </Card>
      ) : null}
    </Page>
  );
}
