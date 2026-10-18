import { useEffect, useState } from "react";
import { View } from "react-native";
import { callT } from "../../src/real/call-tool";
import { Chip } from "./Chip";
import { Text } from "./Text";
import { spaceSkills, toggledSkill } from "./skills-picker-model.js";

/** Choose the Space skills a reviewer or approver checks against (skills.list, the Space's own). Shows each by name; the ids are what the slot stores, and the engine pins each skill's content when the task is made. */
export function SkillsPicker({ label, value, onChange }: { label: string; value: string[]; onChange: (ids: string[]) => void }) {
  const [data, setData] = useState<unknown>(null);
  useEffect(() => { let live = true; void callT<any>("skills.list", { level: "space", limit: 200 }).then((r) => { if (live) setData(r.error ? { skills: [] } : r.data); }); return () => { live = false; }; }, []);
  const list = spaceSkills(data, value);
  return (
    <View className="gap-s1">
      <Text size="caption" strong tone="label">{label}</Text>
      {data === null ? <Text tone="muted">Looking.</Text> : !list.length ? <Text tone="muted">This Space has no skills yet.</Text> : (
        <View className="flex-row flex-wrap gap-s2">
          {list.map((s) => <Chip key={s.id} tone={s.on ? "accent" : "plain"} onPress={() => onChange(toggledSkill(value, s.id))}>{s.gone ? `${s.name} (no longer in the Space)` : s.name}</Chip>)}
        </View>
      )}
      <Text size="caption" tone="label">Each skill's checklist is what they tick. Up to 10.</Text>
    </View>
  );
}
