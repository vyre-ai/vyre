import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { Card, LoadingState, Text } from "@vyre/ui";
import { callT } from "../../src/real/call-tool";
import { recordsSetup } from "./records-setup.js";

/**
 * On Now while a space's records are being set up: asks every few seconds, and goes away when they are ready. Records shows the same card in place of an error while they set up for the first time:
 * `onReady` runs once they are ready, and `otherwise` is what shows when they are not being set up (the screen's own error).
 */
export function RecordsSetup({ onReady, otherwise }: { onReady?: () => void; otherwise?: React.ReactNode } = {}) {
  const [d, setD] = useState<unknown>(undefined);
  const ready = useRef(onReady);
  ready.current = onReady;
  useEffect(() => {
    let live = true, waited = false, timer: ReturnType<typeof setTimeout> | undefined;
    const look = async () => {
      const r = await callT("spaces.records.status").catch(() => null);
      if (!live) return;
      const next = r && !r.error ? r.data : null;
      setD(next);
      if (recordsSetup(next)) { waited = true; timer = setTimeout(look, 4000); }
      else if (waited) ready.current?.();
    };
    void look();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, []);
  const c = recordsSetup(d ?? null);
  if (!c) return d === undefined && otherwise ? <LoadingState rows={3} /> : <>{otherwise ?? null}</>;
  return (
    <Card className="gap-s2">
      <Text strong>{c.title}</Text>
      <Text tone="muted">{c.line}</Text>
      {c.detail ? <View><Text size="caption" tone="label">{c.detail}</Text></View> : null}
    </Card>
  );
}
