import { useState } from "react";
import { View } from "react-native";
import { ASSISTANT_MARK, actedVia } from "../../src/store-core/kernel-view.js";
import { useRouter } from "expo-router";
import { Banner, Button, Card, Chip, Divider, Icon, Row, SectionLabel, SpaceTag, Text, showToast } from "@vyre/ui";
import { LaterMenu } from "../../ui/tasks/AskControls";
import { groupAsks } from "../../ui/tasks/ask-model.js";
import { snoozeNeed, useSnoozed } from "../../src/state/snooze";
import { chooseCall } from "../../src/state/needs-model";
import { needsStore, setNeeds } from "../../src/state/needs";
import { said, tool } from "../../src/real/box";
import { usePlaceText } from "../../src/real/PlaceTag";
import { visibleNeeds } from "../../src/state/answers";
import { useHidden, useNeeds } from "../../src/state/needs";
import type { Need } from "../../src/state/needs";

/** What is missing on this device (no Vyre to talk to, or no phone to approve), as one banner with the one action. */
export function GapNotice({ gap }: { gap: { title?: string; line?: string; action: string; route: string } | null }) {
  const router = useRouter();
  if (!gap) return null;
  return (
    <Banner tone="warn">
      <View className="gap-s2">
        <Text strong>{gap.title}</Text>
        <Text>{gap.line}</Text>
        <View className="flex-row"><Button size="sm" label={gap.action} onPress={() => router.push(gap.route as never)} /></View>
      </View>
    </Banner>
  );
}

/** One waiting row. A question that offers answers shows them as buttons; every row can go to its chat and can wait until later. */
function NeedRow({ n, open }: { n: Need; open: (n: Need) => void }) {
  const router = useRouter();
  const waitTag = usePlaceText("showing");
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState("");
  const choose = async (choice: string) => {
    setBusy(true); setLine("");
    try {
      const c = chooseCall(n, choice);
      await tool(c.tool, c.input);
      const cur = needsStore.get();
      setNeeds(cur.items.filter((x) => x.id !== n.id), cur.from === "cache" ? "cache" : "box");
      showToast(`Answered: ${choice}.`);
    } catch (e) { setLine(said(e)); } finally { setBusy(false); }
  };
  const later = (until: number, label: string) => { const undo = snoozeNeed(n.id, until); showToast(`${n.title}: back ${label.toLowerCase()}.`, { label: "Undo", run: undo }); };
  return (
    <View>
      <Row dense title={n.title} sub={[[n.agent, n.project].filter(Boolean).join(" \u00B7 ") || n.detail, actedVia(n) ? ASSISTANT_MARK : ""].filter(Boolean).join(" ")} end={<>{waitTag ? <SpaceTag text={waitTag} /> : null}<Chip tone="accent">{n.source === "gate" && n.kind === "send" ? "Send" : "Needs you"}</Chip></>} onPress={() => open(n)} />
      <View className="gap-s2 px-s4 pb-s3">
        {n.options && n.options.length ? <View className="flex-row flex-wrap gap-s2">{n.options.map((o, i) => <Button key={o} size="sm" kind={i === 0 ? "primary" : "secondary"} label={o} disabled={busy} onPress={() => void choose(o)} />)}</View> : null}
        {line ? <Text size="caption" tone="warn">{line}</Text> : null}
        <View className="flex-row flex-wrap items-center gap-s2">
          {n.thread ? <Button size="sm" kind="ghost" icon="chat" label="Open chat" onPress={() => router.push({ pathname: "/u/chats/[id]", params: { id: n.thread as string, ...(n.source === "ask" ? { ask: n.ref } : {}) } })} /> : null}
          <LaterMenu now={Date.now()} onLater={later} />
        </View>
      </View>
    </View>
  );
}

/** Four or more waiting on one project fold into one row that opens. */
function Group({ name, items, open }: { name: string; items: Need[]; open: (n: Need) => void }) {
  const [shown, setShown] = useState(false);
  return (
    <View>
      <Row dense title={name} sub={`${items.length} things wait on you here`} end={<Icon name={shown ? "chev-d" : "chev-r"} size={16} tone="muted" />} onPress={() => setShown(!shown)} />
      {shown ? items.map((n) => <View key={n.id}><Divider /><NeedRow n={n} open={open} /></View>) : null}
    </View>
  );
}

/** The assistants' open asks and the Gate's held items, oldest first: a row opens the ask in its session or the item's page. */
export function WaitingOnYou() {
  const router = useRouter();
  const later = useSnoozed();
  const items = visibleNeeds(useNeeds(), useHidden()).filter((n) => !later.has(n.id));
  if (!items.length) return null;
  const open = (n: Need) => {
    if (n.source === "ask" && n.thread) router.push({ pathname: "/u/chats/[id]", params: { id: n.thread, ask: n.ref } });
    else router.push({ pathname: "/need/[id]", params: { id: n.id } });
  };
  const rows = groupAsks(items, (n) => n.project);
  return (
    <View className="gap-s1">
      <SectionLabel>Waiting on you</SectionLabel>
      <Card flush>
        {rows.map((r, i) => (
          <View key={r.group ? `g:${r.key}` : r.item.id}>{i ? <Divider /> : null}
            {r.group ? <Group name={r.key} items={r.items} open={open} /> : <NeedRow n={r.item} open={open} />}
          </View>
        ))}
      </Card>
    </View>
  );
}
