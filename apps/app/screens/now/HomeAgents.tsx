import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { Avatar, Text, useUiTheme } from "@vyre/ui";
import { callT } from "../../src/real/call-tool";
import { agentCards, askChips } from "./home-model.js";

type Card = ReturnType<typeof agentCards>[number];

/** One face and a name. A tap writes @name into the ask field. The pressable is 44 high on a phone. */
function AgentChip({ a, onMention }: { a: Card; onMention: (name: string) => void }) {
  const { phone } = useUiTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Ask ${a.title}`} onPress={() => onMention(a.name)} style={{ minHeight: phone ? 44 : 32, justifyContent: "center" }}>
      <View className="flex-row items-center gap-s2 rounded-chip bg-hover px-s2 py-s1">
        <Avatar of={{ kind: a.kind === "assistant" ? "assistant" : "agent", id: a.name, name: a.name }} size={24} />
        <Text size="caption" tone="muted" numberOfLines={1}>{a.title}</Text>
      </View>
    </Pressable>
  );
}

/** Agents under the ask field. The assistant is first, then agents the person made. The Engineer is never shown. `onNames` still hears every name, so @engineer typed by hand still routes. */
export function HomeAgents({ onMention, onNames, cards, live }: { onMention: (name: string) => void; onNames?: (names: string[], assistant: string) => void; cards?: ReturnType<typeof agentCards>; live?: boolean }) {
  const [fetched, setFetched] = useState<ReturnType<typeof agentCards>>([]);
  useEffect(() => {
    if (cards || !live) return;
    let on = true;
    void callT<any>("agents.list", {}).then((r) => {
      if (!on || r.error) return;
      const d = r.data;
      const c = agentCards(Array.isArray(d) ? d : d?.agents);
      setFetched(c);
      onNames?.(c.map((a) => a.name), c.find((a) => a.kind === "assistant")?.name ?? "");
    });
    return () => { on = false; };
  }, [cards, live]);
  useEffect(() => {
    if (!cards) return;
    onNames?.(cards.map((a) => a.name), cards.find((a) => a.kind === "assistant")?.name ?? "");
  }, [cards]);
  const shown = askChips(cards ?? fetched);
  if (!shown.length) return null;
  return (
    <View className="flex-row flex-wrap gap-s2">
      {shown.map((a) => <AgentChip key={a.name} a={a} onMention={onMention} />)}
    </View>
  );
}
