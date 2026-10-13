// Share a Flow: "Can use" (run it, see it) or "Can edit". The levels are shown in the sample build only: the engine has no per-Flow sharing yet (grants are role and member level, and a Flow runs on
// its approver's access), so a real build says so and offers no control it cannot keep.
import { useState } from "react";
import { View } from "react-native";
import { Banner, Button, Row, Select, Sheet, Text, allowsMock } from "@vyre/ui";
import type { FlowOptions } from "@vyre/ui";
import { useFlowsState } from "./store";

const LEVELS: [string, string][] = [["", "No access"], ["use", "Can use"], ["edit", "Can edit"]];

export function ShareFlow({ id, options }: { id: string; options: FlowOptions | null }) {
  const [open, setOpen] = useState(false);
  const { shares, setShare } = useFlowsState();
  const mine = shares[id] ?? {};
  const who = [...(options?.roles ?? []).map((r) => ({ key: `role:${r.name}`, label: `A team or role: ${r.label}` })), ...(options?.people ?? []).map((p) => ({ key: `person:${p.name}`, label: p.label }))];
  return (
    <>
      <View className="self-start"><Button kind="secondary" size="sm" icon="share" label="Share" onPress={() => setOpen(true)} /></View>
      <Sheet open={open} onClose={() => setOpen(false)} title="Share this Flow">
        <View className="gap-s3">
          <Text tone="muted">Can use: run it and see it. Can edit: change its steps. A step only ever touches what the person who added it can reach.</Text>
          {allowsMock() ? who.map((w) => (
            <Row key={w.key} dense title={w.label} end={<View style={{ width: 150 }}><Select value={mine[w.key] ?? ""} options={LEVELS} onChange={(l) => setShare(id, w.key, l)} /></View>} />
          )) : <Banner tone="warn" icon="info"><Text>Sharing a single Flow is not available on this box yet. Today a Flow runs with the access of the person who approved it, and anyone with the Start Flows role can run it.</Text></Banner>}
          <View className="self-start"><Button kind="primary" label="Done" onPress={() => setOpen(false)} /></View>
        </View>
      </Sheet>
    </>
  );
}
