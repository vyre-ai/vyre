import { useState } from "react";
import { View } from "react-native";
import { Banner, Button, Card, Text } from "@vyre/ui";
import { said, tool } from "../../src/real/box";

/**
 * Shown when a module with screens has been installed: "add to the sidebar, for me or for the team". Each screen becomes a sidebar entry; the team's is the Space's default and
 * only an admin's own screen can set it. `onDone` hears the choice (including "Not now"). Whatever installs modules mounts this on its result (SPEC-0.3.0 part 9).
 */
export function SidebarOffer({ module, label, screens, onDone }: { module: string; label: string; screens: { id: string; label: string }[]; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!screens.length) return null;
  const add = async (scope: "me" | "team") => {
    setBusy(true); setError("");
    try {
      for (const s of screens) await tool("sidebar.edit", { op: "add", scope, entry: { kind: "module", module, screen: s.id } });
      onDone();
    } catch (e) { setError(said(e)); } finally { setBusy(false); }
  };
  return (
    <Card className="gap-s3">
      <Text strong>{`Add ${label} to the sidebar?`}</Text>
      <Text tone="muted">{screens.length === 1 ? `It adds ${screens[0].label}.` : `It adds ${screens.map((s) => s.label).join(", ")}.`}</Text>
      {error ? <Banner tone="warn">{error}</Banner> : null}
      <View className="flex-row flex-wrap gap-s2">
        <Button label="For me" disabled={busy} onPress={() => void add("me")} />
        <Button kind="secondary" label="For the team" disabled={busy} onPress={() => void add("team")} />
        <Button kind="ghost" label="Not now" disabled={busy} onPress={onDone} />
      </View>
    </Card>
  );
}
