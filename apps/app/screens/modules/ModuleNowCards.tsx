import { useEffect, useState } from "react";
import { callT } from "../../src/real/call-tool";
import { Card, Text } from "@vyre/ui";
import { loadNowCards } from "./model.js";

type NowCard = { module: string; tool: string; title: string; detail: string; meta: string };

/** The Now cards modules show: each is a tool a module named as `now:<tool>`, and the module supplies the words only. One that fails is simply not here. */
export function ModuleNowCards() {
  const [cards, setCards] = useState<NowCard[]>([]);
  useEffect(() => { let live = true; loadNowCards(callT).then((c: NowCard[]) => { if (live) setCards(c); }).catch(() => {}); return () => { live = false; }; }, []);
  if (!cards.length) return null;
  return (
    <>
      {cards.map((c) => (
        <Card key={c.tool} className="gap-s1">
          <Text strong>{c.title}</Text>
          {c.detail ? <Text tone="muted">{c.detail}</Text> : null}
          {c.meta ? <Text size="caption" tone="label">{c.meta}</Text> : null}
        </Card>
      ))}
    </>
  );
}
