import { View } from "react-native";
import { Card, Divider } from "../components/Card";
import { Chip } from "../components/Chip";
import { Row } from "../components/Row";
import { Switch } from "../components/Switch";
import { Text } from "../components/Text";
import { seesField, toggleRole } from "./logic.js";
import type { RoleRef } from "./types";

/** Who sees a field, one switch per role. Off means the role never sees it: not in a list, a filter, a total or a search, and cannot write it. Sealed (hidden from every assistant) is its own line. */
export function VisibilityMatrix({ roles, hiddenFrom, sealed, onChange, onSeal }: { roles: RoleRef[]; hiddenFrom: string[]; sealed: boolean; onChange: (hiddenFrom: string[]) => void; onSeal: (on: boolean) => void }) {
  return (
    <View className="gap-s2">
      <Card flush>
        {roles.map(([id, label], i) => (
          <View key={id}>
            {i ? <Divider /> : null}
            <Row title={label} sub={seesField({ hidden_from: hiddenFrom }, id) ? "Sees this field" : "Never sees this field"} end={<Switch label={`${label} sees it`} on={seesField({ hidden_from: hiddenFrom }, id)} onChange={() => onChange(toggleRole(hiddenFrom, id))} />} />
          </View>
        ))}
        <Divider />
        <Row title="Seal this field" sub={sealed ? "Hidden from every assistant; they see only that a value is on file." : "For a Social Security number or an account number."} end={<View className="flex-row items-center gap-s2">{sealed ? <Chip tone="sealed" icon="vault">Sealed</Chip> : null}<Switch label="Seal this field" on={sealed} onChange={onSeal} /></View>} />
      </Card>
      <Text size="caption" tone="label">The owner always sees every field. Hiding a field from a role is privacy; a rule that only hides it on screen is not.</Text>
    </View>
  );
}
