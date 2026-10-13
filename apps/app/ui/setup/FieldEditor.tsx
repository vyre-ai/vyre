import { View } from "react-native";
import { Button } from "../components/Button";
import { Card, Divider } from "../components/Card";
import { Chip } from "../components/Chip";
import { Field } from "../components/Field";
import { Row } from "../components/Row";
import { Select } from "../components/Select";
import { SectionLabel } from "../components/SectionLabel";
import { Switch } from "../components/Switch";
import { Text } from "../components/Text";
import { KINDS as FIELD_KINDS } from "../fields/registry";
import { ChoicesEditor } from "./ChoicesEditor";
import { RelationEditor } from "./RelationEditor";
import { SealEditor } from "./SealEditor";
import { RuleBuilder, type Rule } from "./RuleBuilder";
import { VisibilityMatrix } from "./VisibilityMatrix";
import { canBeUnique, checkField, CHOICE_KINDS } from "./logic.js";
import type { Draft } from "./logic.js";
import type { FieldRef, RoleRef, TypeRef } from "./types";

export type Rules = { visible: Rule | null; required: Rule | null };

/**
 * One field, all of it: name and kind, then only what the kind needs (options for a choice, a relation for a link), then rules (required, unique, hidden), the conditions
 * (shown when, required when) and who sees it. It is a pane, drawn in a sheet on a phone and beside the field list on a desk. Errors show after the first Save.
 */
export function FieldEditor({ draft, onChange, owner, types, roles, siblings, rules, onRules, tried, onSave, onCancel, editing, groups, sealLocked }: {
  draft: Draft; onChange: (d: Draft) => void; owner: TypeRef; types: TypeRef[]; roles: RoleRef[]; siblings: FieldRef[]; rules: Rules; onRules: (r: Rules) => void;
  tried: boolean; onSave: () => void; onCancel: () => void; editing?: boolean; /** The type's group names, in order; given, the editor offers a Group picker. */ groups?: string[]; /** Why sealing is not offered (a field that already holds values cannot be sealed in place), in words. */ sealLocked?: string;
}) {
  const { errors } = checkField(draft, editing ? siblings.filter((s) => s.name !== draft.name) : siblings, types);
  const err = (k: string) => (tried ? errors[k] : undefined);
  const set = (p: Partial<Draft>) => onChange({ ...draft, ...p });
  const choice = CHOICE_KINDS.includes(draft.kind) && draft.kind !== "stage";
  const uniqueOk = canBeUnique(draft.kind) && !draft.sealed;
  return (
    <View className="gap-s4">
      <View className="gap-s3">
        <Field label="Name" value={draft.label} onChangeText={(label) => set({ label })} placeholder="For example Estimated value" error={err("label")} />
        <Field label="Help text (optional)" value={draft.description} onChangeText={(description) => set({ description })} placeholder="What goes here, for the person filling it in" />
        {groups ? <Select label="Group" value={draft.group} options={[["", "No group"], ...groups.map((g) => [g, g] as [string, string])]} onChange={(group) => set({ group })} /> : null}
        <View className="gap-s1">
          <Text size="caption" strong tone="label">Kind</Text>
          <View className="flex-row flex-wrap gap-s2">{(FIELD_KINDS as [string, string][]).filter(([k]) => k !== "sealed" && k !== "stage").map(([k, l]) => <Chip key={k} selected={draft.kind === k} icon={draft.kind === k ? "check" : undefined} onPress={() => set({ kind: k })}>{l}</Chip>)}</View>
        </View>
      </View>

      {choice ? <View className="gap-s2"><SectionLabel first>Options</SectionLabel><ChoicesEditor options={draft.options} onChange={(options) => set({ options })} error={err("options")} /></View> : null}
      {draft.kind === "link" ? <View className="gap-s2"><SectionLabel first>Link</SectionLabel><RelationEditor owner={owner} types={types} to={draft.to} many={draft.many} inverse={draft.inverse} error={err("to")} onChange={(p) => set(p)} /></View> : null}

      <View className="gap-s2">
        <SectionLabel first>Rules</SectionLabel>
        <Card flush>
          <Row title="Required" sub="A record cannot be saved with this empty." end={<Switch label="Required" on={draft.required} onChange={(required) => set({ required })} />} />
          <Divider />
          <Row title="Must be unique" sub={uniqueOk ? `No two ${owner.plural.toLowerCase()} can hold the same value.` : "Not available for this kind of field."} end={<Switch label="Must be unique" on={draft.unique && uniqueOk} disabled={!uniqueOk} onChange={(unique) => set({ unique })} />} />
          <Divider />
          <Row title="Hide for now" sub="Removed from every screen. The values are kept and come back when you turn it on again." end={<Switch label="Hide for now" on={draft.hidden} onChange={(hidden) => set({ hidden })} />} />
        </Card>
        {err("hidden") ?? err("unique") ? <Text size="caption" tone="err">{err("hidden") ?? err("unique")}</Text> : null}
      </View>

      <View className="gap-s3">
        <SectionLabel first>Only sometimes</SectionLabel>
        <RuleBuilder title="Show this field only when" fields={siblings} rule={rules.visible} onChange={(visible, expr) => { onRules({ ...rules, visible }); set({ visible_if: expr }); }} />
        <RuleBuilder title="Require this field only when" fields={siblings} rule={rules.required} onChange={(required, expr) => { onRules({ ...rules, required }); set({ required_if: expr }); }} />
        {err("required_if") ? <Text size="caption" tone="err">{err("required_if")}</Text> : null}
      </View>

      <View className="gap-s2">
        <SectionLabel first>Who sees it</SectionLabel>
        <VisibilityMatrix roles={roles} hiddenFrom={draft.hidden_from} sealed={draft.sealed} onChange={(hidden_from) => set({ hidden_from })} onSeal={(sealed) => set({ sealed })} sealLocked={sealLocked} />
        {draft.sealed ? <SealEditor seal={draft.seal} roles={roles} error={err("seal")} onChange={(seal) => set({ seal })} /> : null}
      </View>

      <View className="flex-row gap-s2">
        <Button kind="primary" label={editing ? "Save field" : `Add to ${owner.plural}`} onPress={onSave} />
        <Button kind="ghost" label="Cancel" onPress={onCancel} />
      </View>
    </View>
  );
}
