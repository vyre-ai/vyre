import { View } from "react-native";
import { Row } from "./Row";
import { Segmented } from "./Segmented";
import { Switch } from "./Switch";
import { Text } from "./Text";

/**
 * One setting with its control (docs/design/system/components/control-row.md): a title, one line under it, and either a switch (`on`) or a segmented choice (`value` and
 * `options`). The choice sits under the text so it never crowds a phone; the switch sits at the end. `children` shows under the row (the fields a data rule can hide).
 * `locked` draws the control disabled with its own words under the title, for a built-in role.
 */
export function ControlRow({ title, sub, on, onToggle, value, options, onChoose, locked, children }: {
  title: string; sub?: string; on?: boolean; onToggle?: (on: boolean) => void;
  value?: string; options?: [string, string][]; onChoose?: (v: string) => void; locked?: boolean; children?: React.ReactNode;
}) {
  if (options) {
    return (
      <View className="gap-s2 px-s4 py-s3">
        <View className="min-w-0 gap-s1">
          <Text medium>{title}</Text>
          {sub ? <Text size="secondary" tone="label">{sub}</Text> : null}
        </View>
        <Segmented label={title} value={value} onChange={locked ? undefined : onChoose} options={options} fill />
        {children}
      </View>
    );
  }
  return <Row dense title={title} sub={sub} end={<Switch on={!!on} label={title} onChange={onToggle} disabled={locked} />} />;
}
