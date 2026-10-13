import { View } from "react-native";
import { Card } from "../components/Card";
import { Chip } from "../components/Chip";
import { Field } from "../components/Field";
import { Segmented } from "../components/Segmented";
import { Text } from "../components/Text";
import { relationLines } from "./logic.js";
import type { TypeRef } from "./types";

/** A link to another type, said from both sides: which type, one or many, the name it takes on the other type, and two sentences that read it back. */
export function RelationEditor({ owner, types, to, many, inverse, onChange, error }: { owner: TypeRef; types: TypeRef[]; to: string | null; many: boolean; inverse: string; onChange: (p: { to?: string; many?: boolean; inverse?: string }) => void; error?: string }) {
  const target = types.find((t) => t.name === to);
  return (
    <View className="gap-s3">
      <View className="gap-s1">
        <Text size="caption" strong tone="label">Links to</Text>
        <View className="flex-row flex-wrap gap-s2">{types.map((t) => <Chip key={t.name} selected={t.name === to} icon={t.name === to ? "check" : undefined} onPress={() => onChange({ to: t.name })}>{t.label}</Chip>)}</View>
        {error ? <Text size="caption" tone="err">{error}</Text> : null}
      </View>
      <Segmented<"one" | "many"> label="How many" value={many ? "many" : "one"} onChange={(v) => onChange({ many: v === "many" })} options={[["one", target ? `One ${target.label}` : "One"], ["many", target ? `Many ${target.plural}` : "Many"]]} />
      {target ? (
        <>
          <Field label={`Name shown on ${target.label}`} value={inverse} onChangeText={(v) => onChange({ inverse: v })} help={`Leave empty if the ${target.label} should not list its ${owner.plural}.`} />
          <Card className="gap-s2">
            <View className="flex-row items-center gap-s2"><Chip>{owner.label}</Chip><Text tone="label">to</Text><Chip>{target.label}</Chip></View>
            {relationLines(owner, target, many, inverse).map((l) => <Text key={l}>{l}</Text>)}
          </Card>
        </>
      ) : null}
    </View>
  );
}
