import { View } from "react-native";
import { Card, Divider } from "../components/Card";
import { Chip } from "../components/Chip";
import { Row } from "../components/Row";
import { Segmented } from "../components/Segmented";
import { Select } from "../components/Select";
import { Switch } from "../components/Switch";
import { Text } from "../components/Text";
import { toggleRole } from "./logic.js";
import type { Seal } from "./logic.js";
import type { RoleRef } from "./types";

/** The kernel's sealed classes (kernel/seal/classes.js): what a model is told is on file, and what the value is checked to look like. */
export const SEAL_CLASSES: [string, string][] = [["free", "Anything"], ["us-ssn", "US Social Security number"], ["us-itin", "US ITIN"], ["us-ein", "US EIN"], ["bank-account", "Bank account"], ["routing-number", "Routing number"], ["card", "Card number"], ["iban", "IBAN"], ["passport", "Passport"], ["tax-id", "Tax ID"], ["medical", "Medical"]];

/** What "Seal this field" means, in the kernel's own terms (SealConfig): from AI only, or only some roles with fresh presence on every reveal; which kind of value it is; whether the last four may show. */
export function SealEditor({ seal, roles, onChange, error }: { seal: Seal; roles: RoleRef[]; onChange: (s: Seal) => void; error?: string }) {
  return (
    <View className="gap-s2">
      <Segmented<"ai" | "human"> label="Who may open it" value={seal.level} onChange={(level) => onChange({ ...seal, level, reveal_roles: level === "human" && !seal.reveal_roles.length ? ["owner"] : seal.reveal_roles })} options={[["ai", "People, never an assistant"], ["human", "Only some roles"]]} />
      {seal.level === "human" ? (
        <View className="gap-s1">
          <Text size="caption" strong tone="label">Roles that may reveal it</Text>
          <View className="flex-row flex-wrap gap-s2">{([["owner", "Owner"], ...roles] as RoleRef[]).map(([id, l]) => <Chip key={id} selected={seal.reveal_roles.includes(id)} icon={seal.reveal_roles.includes(id) ? "check" : undefined} onPress={() => onChange({ ...seal, reveal_roles: toggleRole(seal.reveal_roles, id) })}>{l}</Chip>)}</View>
          {error ? <Text size="caption" tone="err">{error}</Text> : <Text size="caption" tone="label">Each reveal needs the person present. Leave Owner on, or even the owner will not see it.</Text>}
        </View>
      ) : null}
      <Select label="What it holds" value={seal.class} options={SEAL_CLASSES} onChange={(c) => onChange({ ...seal, class: c })} />
      <Card flush><Row title="Allow the last four" sub="An assistant may be told the last four characters of a long value." end={<Switch label="Allow the last four" on={seal.hint_allowed} onChange={(hint_allowed) => onChange({ ...seal, hint_allowed })} />} /></Card>
    </View>
  );
}
