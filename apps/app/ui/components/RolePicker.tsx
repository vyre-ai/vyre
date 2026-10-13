import { View } from "react-native";
import { Chip } from "./Chip";
import { ControlRow } from "./ControlRow";
import { Card, Divider } from "./Card";
import { Icon } from "./Icon";
import { Row } from "./Row";
import { Segmented } from "./Segmented";
import { SectionLabel } from "./SectionLabel";
import { Text } from "./Text";

export type RoleChoice = { id: string; name: string; line: string; note?: string };

/**
 * The one role picker (docs/design/system/components/role-picker.md): a grouped list of the roles a person may give, one chosen, each with one sentence of what it can see.
 * Optionally the projects the person is added to (chips that toggle) and, when the chosen role is the guest role, how long the access lasts. Controlled: the screen keeps the
 * choice. The invite step and the people list use it, so the words and the look are one.
 */
export function RolePicker({ roles, value, onChange, projects, chosen = [], onChosen, guest = "guest", ends, onEnds, endOptions, levels, onLevel, levelOptions, levelDefault }: {
  roles: RoleChoice[]; value: string; onChange: (id: string) => void;
  projects?: { id: string; name: string }[]; chosen?: string[]; onChosen?: (ids: string[]) => void;
  /** The id of the role that ends on a date. */ guest?: string; ends?: string; onEnds?: (v: string) => void; endOptions?: [string, string][];
  /** The seat each chosen project gives (Lead, Contributor, Viewer): the level by project id, the change, and the choices. */ levels?: Record<string, string>; onLevel?: (project: string, level: string) => void; levelOptions?: [string, string][]; /** The level shown for a project the person has not set. */ levelDefault?: string;
}) {
  const toggle = (id: string) => onChosen?.(chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id]);
  return (
    <View className="gap-s2">
      <Card flush accessibilityRole="radiogroup">
        {roles.map((r, i) => (
          <View key={r.id}>
            {i ? <Divider inset={0} /> : null}
            <Row dense title={r.name} sub={r.line} selected={r.id === value} accessibilityLabel={`${r.name}. ${r.line}`} onPress={() => onChange(r.id)}
              end={r.id === value ? <Icon name="check" size={18} tone="accent" /> : r.note ? <Text size="secondary" tone="label">{r.note}</Text> : undefined} />
          </View>
        ))}
      </Card>
      {projects && projects.length && onChosen ? (
        <View>
          <SectionLabel meta="Optional">Projects</SectionLabel>
          <View className="flex-row flex-wrap gap-s2">{projects.map((p) => <Chip key={p.id} selected={chosen.includes(p.id)} onPress={() => toggle(p.id)}>{p.name}</Chip>)}</View>
          {chosen.length && levelOptions && onLevel ? (
            <Card flush className="mt-s3">
              {chosen.map((id, i) => <View key={id}>{i ? <Divider /> : null}<ControlRow title={projects.find((p) => p.id === id)?.name ?? "A project"} value={levels?.[id] ?? levelDefault ?? levelOptions[0][0]} options={levelOptions} onChoose={(v) => onLevel(id, v)} /></View>)}
            </Card>
          ) : null}
          <Text size="caption" tone="label" className="pt-s2">{chosen.length ? "They are added to these projects when they join." : "None chosen: they join with the role's own reach."}</Text>
        </View>
      ) : null}
      {value === guest && ends !== undefined && onEnds && endOptions ? (
        <View>
          <SectionLabel>Access ends</SectionLabel>
          <Segmented label="Access ends" value={ends} onChange={onEnds} options={endOptions} />
        </View>
      ) : null}
    </View>
  );
}
