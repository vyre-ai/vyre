import { useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Avatar, Pulse, Text } from "@vyre/ui";
import { callT } from "../../src/real/call-tool";
import { agentCards } from "./home-model.js";

/** The agents on Home: a face each, a ring that pulses while it is working and turns violet when it waits on you. A tap opens that agent. */
export function HomeAgents({ onCount, onNames }: { onCount?: (working: number) => void; onNames?: (names: string[], assistant: string) => void }) {
  const router = useRouter();
  const [cards, setCards] = useState<ReturnType<typeof agentCards>>([]);
  useEffect(() => {
    let live = true;
    void callT<any>("agents.list", {}).then((r) => { if (!live || r.error) return; const d = r.data; const c = agentCards(Array.isArray(d) ? d : d?.agents); setCards(c); onCount?.(c.filter((a) => a.live).length); onNames?.(c.map((a) => a.name), c.find((a) => a.kind === "assistant")?.name ?? ""); });
    return () => { live = false; };
  }, []);
  if (!cards.length) return null;
  return (
    <View className="flex-row flex-wrap gap-s4 pb-s3">
      {cards.map((a) => (
        <View key={a.name} className="items-center gap-s1">
          <Pulse active={a.live}><View className={a.needsYou ? "rounded-full border-2 border-primary p-s1" : a.live ? "rounded-full border-2 border-edge-strong p-s1" : "rounded-full border-2 border-transparent p-s1"}><Avatar of={{ kind: a.kind === "assistant" ? "assistant" : "agent", id: a.name, name: a.name }} size={40} onPress={() => router.push(`/u/assistants/${encodeURIComponent(a.name)}` as never)} label={`${a.name}, ${a.doing}`} /></View></Pulse>
          <Text size="caption" tone={a.live ? "default" : "muted"}>{a.title}</Text>
        </View>
      ))}
    </View>
  );
}
