// AI accounts from the real box: one list of every provider and the person's accounts under each (sessions.accounts.list, the one source), and what the agents spent (agents.usage).
// No autonomy dial and no budget editor here: the box has no tool for either yet, so there is no control that would not work.
import { AiAccountsList } from "./AccountsCard";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { Banner, Card, Meter, Text } from "@vyre/ui";
import { Page } from "../places/Frame";
import { budgetLine, money, usedShare, type Usage } from "./agents-model";
import { agentsUsage } from "./real";
import { PlaceTag } from "../../src/real/PlaceTag";

export function RealAi() {
  const [us, setUs] = useState<Usage[]>([]);
  useEffect(() => { agentsUsage().then(setUs).catch(() => setUs([])); }, []);
  const budgeted = us.filter((u) => u.agent && u.budget_usd != null);
  return (
    <Page title="AI accounts" back="/u/settings">
      <PlaceTag of="home" />
      <Banner>Nobody's work runs on someone else's account. Your chats use your accounts and count against your budget.</Banner>
      <AiAccountsList />
      {us.length ? (
        <Card className="gap-s2">
          <Text strong>{`${money(us.reduce((n, u) => n + (u.spent_usd || 0), 0))} spent by agents`}</Text>
          {budgeted.map((u) => (
            <View key={u.agent} className="gap-s1"><Text size="secondary">{`${u.agent}: ${budgetLine(u)}`}</Text><Meter value={usedShare(u)} label={`${u.agent} budget used`} /></View>
          ))}
          <Text size="caption" tone="label">A budget for each agent is set on that agent's page.</Text>
        </Card>
      ) : null}
    </Page>
  );
}
