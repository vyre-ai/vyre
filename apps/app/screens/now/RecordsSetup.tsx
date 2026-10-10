import { useEffect, useState } from "react";
import { View } from "react-native";
import { Card, Text } from "@vyre/ui";
import { callT } from "../../src/real/call-tool";
import { recordsSetup } from "./records-setup.js";

/** On Now while a space's records are being set up: asks every few seconds, and goes away when they are ready. */
export function RecordsSetup() {
  const [d, setD] = useState<unknown>(null);
  useEffect(() => {
    let live = true, timer: ReturnType<typeof setTimeout> | undefined;
    const look = async () => {
      const r = await callT("spaces.records.status").catch(() => null);
      if (!live) return;
      const next = r && !r.error ? r.data : null;
      setD(next);
      if (recordsSetup(next)) timer = setTimeout(look, 4000);
    };
    void look();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, []);
  const c = recordsSetup(d);
  if (!c) return null;
  return (
    <Card className="gap-s2">
      <Text strong>{c.title}</Text>
      <Text tone="muted">{c.line}</Text>
      {c.detail ? <View><Text size="caption" tone="label">{c.detail}</Text></View> : null}
    </Card>
  );
}
