import { useState } from "react";
import { View } from "react-native";
import { Avatar, Banner, Button, Card, Chip, Divider, Meter, Segmented, Sheet, Text, showToast, markRef , allowsMock} from "@vyre/ui";
import { Page } from "../places/Frame";
import { RealAi } from "./RealAgents";
import { useSettings } from "./state";
import { BUDGET_STEPS, budgetLine, money, overLine, usedPercent, usedShare } from "./logic.js";

/** AI accounts: yours, with a monthly budget each. Nobody's work runs on someone else's account. */
export function SampleAiScreen() {
  const { ai, setBudget, toggleAi } = useSettings();
  const [sheet, setSheet] = useState<string | null>(null);
  const acct = ai.find((a) => a.name === sheet);
  return (
    <Page title="AI accounts" back="/u/settings">
      <Banner>Nobody's work runs on someone else's account. In a shared space, your sessions still use your accounts and count against your budget.</Banner>
      <Card flush>
        {ai.map((a, i) => (
          <View key={a.name}>
            {i ? <Divider /> : null}
            <View className="gap-s2 p-s3">
              <View className="flex-row items-center gap-s3">
                <Avatar of={markRef("agent", a.name)} size={40} />
                <View className="min-w-0 flex-1 gap-s1">
                  <View className="flex-row flex-wrap items-center gap-s2"><Text strong>{a.name}</Text>{a.on ? <Chip tone="ok">{a.plan}</Chip> : <Chip>Not connected</Chip>}</View>
                  <Text size="caption" tone="label">{a.on ? budgetLine(a) : a.note}</Text>
                </View>
              </View>
              {a.on ? (
                <View className="gap-s1">
                  <Meter value={usedShare(a.used, a.budget)} label={`${a.name} budget used`} />
                  <Text size="caption" tone="muted">{`${usedPercent(a.used, a.budget)}% used`}{overLine(a) ? `. ${overLine(a)}` : ""}</Text>
                </View>
              ) : null}
              <View className="flex-row flex-wrap gap-s2">
                {a.on ? <><Button kind="ghost" size="sm" label={`Budget ${money(a.budget)}`} onPress={() => setSheet(a.name)} /><Button kind="ghost" size="sm" label="Disconnect" onPress={() => { toggleAi(a.name); showToast(`${a.name} is disconnected.`); }} /></>
                  : <Button size="sm" label="Connect" onPress={() => { toggleAi(a.name); showToast(`${a.name} is connected with a ${money(50)} budget.`); }} />}
              </View>
            </View>
          </View>
        ))}
      </Card>
      <Sheet open={!!acct} onClose={() => setSheet(null)} title={acct ? `${acct.name} budget` : undefined}>
        {acct ? (
          <>
            <Text tone="muted">A month's limit for sessions on this account. At the limit, assistants stop and ask you.</Text>
            <Segmented label="Monthly budget" value={String(acct.budget)} onChange={(v) => { setBudget(acct.name, Number(v)); showToast(`${acct.name} budget is ${money(Number(v))} a month.`); }} options={BUDGET_STEPS.map((n) => [String(n), money(n)] as [string, string])} />
            <View className="flex-row"><Button kind="primary" label="Done" onPress={() => setSheet(null)} /></View>
          </>
        ) : null}
      </Sheet>
    </Page>
  );
}

/** The sample page in a mock build; the box's own agents and accounts everywhere else. */
export function AiScreen() {
  return allowsMock() ? <SampleAiScreen /> : <RealAi />;
}
