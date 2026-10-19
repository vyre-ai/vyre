// The assistant's first message after setup: its words, then the cards that still have something to do. A card carries words and an https link, never a tool.
import { useEffect, useState } from "react";
import { View } from "react-native";
import { Card, Row, Text } from "@vyre/ui";
import { moreTools } from "./instance";
import type { WelcomeCard as Item } from "./more-model.ts";
import { openExternal } from "../../src/shell/open-external";

export function WelcomeCard({ onOpen }: { onOpen?: (id: string) => void }) {
  const [w, setW] = useState<{ text: string; cards: Item[] } | null>(null);
  useEffect(() => { moreTools.welcome().then(setW).catch(() => setW(null)); }, []);
  if (!w || (!w.text && !w.cards.length)) return null;
  return (
    <Card>
      {w.text ? <Text>{w.text}</Text> : null}
      <View>
        {w.cards.map((c) => <Row key={c.id} dense title={c.title} sub={c.body || undefined} chevron onPress={() => (c.href ? void openExternal(c.href) : onOpen?.(c.id))} />)}
      </View>
    </Card>
  );
}
