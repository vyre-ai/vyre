import { useMemo } from "react";
import { View } from "react-native";
import { Chip } from "../components/Chip";
import { Text } from "../components/Text";
import { ValueField } from "./ValueField";
import { addressPicks, insertList } from "./template.js";
import type { Draft, Options } from "./logic.js";

/** An address box (To, From, Reply-To): a typed address or tokens, with the email fields of the Flow's context offered first. `many` joins picks with a comma. */
export function AddressField({ label, value, onChange, draft, stepId, options, placeholder, many = false, note }: {
  label: string; value: string; onChange: (v: string) => void; draft: Draft; stepId: string; options: Options; placeholder?: string; many?: boolean; note?: string;
}) {
  const picks = useMemo(() => addressPicks(insertList(draft, stepId, options)).slice(0, 6), [draft, stepId, options]);
  return (
    <View className="gap-s1">
      {picks.length ? (
        <View className="gap-s1">
          <Text size="caption" tone="label">{`Suggested for ${label}`}</Text>
          <View className="flex-row flex-wrap gap-s2">
            {picks.map((p) => <Chip key={p.token} icon="mention" selected={value.includes(p.token)} onPress={() => onChange(many && value.trim() ? `${value.trim().replace(/[,;]$/, "")}, ${p.token}` : p.token)}>{p.label}</Chip>)}
          </View>
        </View>
      ) : null}
      <ValueField label={label} value={value} onChange={onChange} placeholder={placeholder} draft={draft} stepId={stepId} options={options} />
      {note ? <Text size="caption" tone="label">{note}</Text> : null}
    </View>
  );
}
