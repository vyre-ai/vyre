import { useEffect, useState } from "react";
import { View } from "react-native";
import { Button, Card, Text } from "@vyre/ui";
import { shellKind } from "../../src/shell/shell";
import { mountView } from "../../src/shell/mount-model.js";

type MountShell = { state(): Promise<{ supported?: boolean; on?: boolean; paired?: boolean }>; set(on: boolean): Promise<unknown> };
const mountOf = (): MountShell | null => (typeof window === "undefined" ? null : ((window as unknown as { __vyreShell?: { mount?: MountShell } }).__vyreShell?.mount ?? null));

/**
 * Settings, "Show Vyre in Finder" (Mac) or "Show Vyre in File Explorer" (Windows): the person's files appear there the way iCloud Drive or OneDrive do. Only where this build carries the file
 * extension; nothing shows in a browser or a phone.
 */
export function FilesInFinder() {
  const kind = shellKind();
  const [state, setState] = useState<{ supported?: boolean; on?: boolean; paired?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  useEffect(() => { mountOf()?.state().then(setState).catch(() => setState(null)); }, []);
  const v = mountView(kind, state);
  if (!v.show) return null;
  const flip = async () => {
    const m = mountOf();
    if (!m || busy) return;
    setBusy(true); setProblem("");
    try { await m.set(!v.on); setState(await m.state()); }
    catch (e) { setProblem((e as Error).message || "That did not work."); }
    finally { setBusy(false); }
  };
  return (
    <Card>
      <View className="gap-s2 p-s2">
        <Text strong>{v.title}</Text>
        <Text tone="muted">{v.sub}</Text>
        {problem ? <Text tone="muted">{problem}</Text> : null}
        <View className="flex-row"><Button kind="secondary" label={v.button} onPress={flip} disabled={!v.enabled || busy} /></View>
      </View>
    </Card>
  );
}
