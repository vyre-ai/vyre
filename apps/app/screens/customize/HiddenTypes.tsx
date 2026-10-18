import { useState } from "react";
import { Pressable, View } from "react-native";
import { Card, Icon, Row, Switch, Text, showToast } from "@vyre/ui";
import { isMissing, recordsApi } from "../records/records-api";

/**
 * Types the Space keeps out of Records (Files, Templates, Playbooks): they work as they always did, they just are not tabs there. A collapsed group at the end of Objects; each has a "Show in Records" switch.
 */
export function HiddenTypes({ types, onChanged }: { types: { name: string; label: string; plural: string }[]; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  if (!types.length) return null;
  const show = async (name: string) => {
    const r = await recordsApi.typeUpdate(name, { hidden_in_records: false });
    if (r.error) { showToast(isMissing(r.error) ? "That is not available on this box yet." : r.error.message || "That did not save."); return; }
    showToast("Now in Records.");
    onChanged();
  };
  return (
    <Card flush>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} className="min-h-control flex-row items-center justify-between px-s4 py-s3">
        <Text tone="label">{`Hidden from Records, ${types.length}`}</Text>
        <Icon name={open ? "chevron-up" : "chevron-down"} size={16} tone="label" />
      </Pressable>
      {open ? (
        <View>
          {types.map((t) => <Row key={t.name} title={t.plural} sub="Works as before, not a tab in Records" end={<Switch on={false} label={`Show ${t.plural} in Records`} onChange={() => void show(t.name)} />} />)}
        </View>
      ) : null}
    </Card>
  );
}
