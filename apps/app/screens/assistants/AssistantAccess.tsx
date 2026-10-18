// "What my assistant may do" in Settings (G23): one switch for each area, the tools turned off one by one, and one place to turn a tool off. Only the person changes it; the assistant is refused what is off.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Banner, Button, Card, Divider, Field, Row, Switch, Text, showToast } from "@vyre/ui";
import { Group, Page } from "../places/Frame";
import { tool } from "../../src/real/box";
import { areaLine, refusal, stateFrom, summary, switchCall, toolCall, type AccessState } from "./access-model.js";

/** The page, drawn from a state (the gallery draws it from a sample). */
export function AccessView({ s, busy, problem, typed, setTyped, onSwitch, onTurnOffTool, onTurnOnTool, more, onOpen }: {
  s: AccessState; busy: boolean; problem: string; typed: string; setTyped: (v: string) => void;
  onSwitch: (id: string, on: boolean) => void; onTurnOffTool: () => void; onTurnOnTool: (name: string) => void;
  /** The other pages that decide what agents may do, led to from here so this is the one place to look. */ more?: { title: string; sub: string; href: string }[]; onOpen?: (href: string) => void;
}) {
  return (
    <Page title="What agents may do" sub={summary(s)} back="/u/settings">
      <Group title="Areas">
        <Card flush>
          {s.screens.map((a, i) => (
            <View key={a.id}>{i ? <Divider /> : null}
              <Row title={a.label} sub={areaLine(a.off)} end={<Switch label={a.label} on={!a.off} disabled={busy} onChange={(on: boolean) => onSwitch(a.id, on)} />} />
            </View>
          ))}
        </Card>
      </Group>
      <Group title="Tools turned off" note="A name like records.list stops one tool; records.* stops all of them.">
        {s.tools.length ? (
          <Card flush>
            {s.tools.map((t, i) => <View key={t.name}>{i ? <Divider /> : null}<Row title={t.name} end={<Button kind="ghost" label="Turn on" disabled={busy} onPress={() => onTurnOnTool(t.name)} />} /></View>)}
          </Card>
        ) : <Text tone="label">No single tool is turned off.</Text>}
        <Card className="gap-s2">
          <Field label="Turn off a tool" value={typed} onChangeText={(v) => setTyped(v ?? "")} placeholder="records.list or records.*" />
          <View className="flex-row"><Button kind="secondary" label="Turn off" disabled={busy || !typed.trim()} onPress={onTurnOffTool} /></View>
        </Card>
      </Group>
      {more && more.length ? (
        <Group title="More options" note="What agents are asked, shown and spend.">
          <Card flush>
            {more.map((m, i) => <View key={m.href}>{i ? <Divider /> : null}<Row title={m.title} sub={m.sub} chevron onPress={() => onOpen?.(m.href)} /></View>)}
          </Card>
        </Group>
      ) : null}
      {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
      <Banner><Text>This only ever lets your agent do less. It cannot change these settings, and when it is refused something it says what you turned off.</Text></Banner>
    </Page>
  );
}

const MORE = [
  { title: "Standing permissions", sub: "Decide what may go ahead without asking you", href: "/u/settings/permissions" },
  { title: "What my agents can see", sub: "Choose, Space by Space, what your agents may read", href: "/u/settings/seeing" },
  { title: "Rules", sub: "Set what an agent never does, drafts only, or asks about first", href: "/u/settings/rules" },
  { title: "Spending limits", sub: "Cap what each AI provider can spend in a day", href: "/u/settings/spend" },
  { title: "Outside agents", sub: "Let agents running elsewhere reach what you choose", href: "/u/settings/outside" },
];

export function AssistantAccessScreen() {
  const router = useRouter();
  const [s, setS] = useState<AccessState | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [typed, setTyped] = useState("");
  const load = useCallback(() => { tool<any>("assistant.access.get", {}).then((d) => setS(stateFrom(d))).catch(() => setS(null)); }, []);
  useEffect(load, [load]);
  const run = async (call: { tool: string; input: Record<string, unknown> }, done?: string) => {
    setBusy(true); setProblem("");
    try { setS(stateFrom(await tool<any>(call.tool, call.input))); if (done) showToast(done); }
    catch (e) { setProblem(refusal((e as { code?: string }).code, e instanceof Error ? e.message : "")); }
    finally { setBusy(false); }
  };
  if (!s) return <Page title="What agents may do" back="/u/settings"><Text tone="label">This server does not keep these settings yet.</Text></Page>;
  return (
    <AccessView more={MORE} onOpen={(href) => router.push(href as never)} s={s} busy={busy} problem={problem} typed={typed} setTyped={setTyped}
      onSwitch={(id, on) => void run(switchCall(id, on))}
      onTurnOffTool={() => { const c = toolCall(typed) as { problem?: string; tool?: string; input?: Record<string, unknown> }; if (c.problem || !c.tool) { setProblem(c.problem ?? ""); return; } setTyped(""); void run({ tool: c.tool, input: c.input ?? {} }, "Turned off for your agent."); }}
      onTurnOnTool={(name) => void run({ tool: "assistant.access.restore", input: { tools: [name] } })} />
  );
}
