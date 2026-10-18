// The New menu: a compact popover from the compose button (Cmd N), not a modal. A To: field, then the agents (each starts a new thread), the people, then New group, New agent and New Flow.
// It draws what new-menu-model.js shapes and calls nothing itself; the screen says what each pick does.

import { useEffect, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { Avatar } from "../components/Avatar";
import { Field } from "../components/Field";
import { Icon } from "../components/Icon";
import { Text } from "../components/Text";
import { markRef } from "../marks/useMark";
import { RAIL } from "../shell/rail-tokens.js";
import { useUiTheme } from "../theme";
import { elevation } from "../lib/elevation";
import { firstRow, newMenuRows, type NewRow } from "./new-menu-model.js";

export type { NewRow };

export function NewPopover({ open, onClose, agents, people, onPick }: {
  open: boolean; onClose: () => void;
  agents: readonly { name: string; role?: string; id?: string }[]; people: readonly { id: string; name: string; role?: string }[];
  onPick: (row: NewRow) => void;
}) {
  const { color, resolved } = useUiTheme();
  const [q, setQ] = useState("");
  useEffect(() => { if (open) setQ(""); }, [open]);
  const rows = useMemo(() => newMenuRows(q, agents, people), [q, agents, people]);
  if (!open) return null;
  const pick = (r: NewRow) => { onClose(); onPick(r); };
  const row = (r: NewRow) => (
    <Pressable key={`${r.kind}:${r.id}`} accessibilityRole="button" accessibilityLabel={r.kind === "agent" ? `${r.label}, a new thread` : r.label} onPress={() => pick(r)}
      style={({ hovered, focused }: any) => ({ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 36, paddingHorizontal: 8, borderRadius: 8, backgroundColor: hovered || focused ? color.hover : "transparent" })}>
      {r.kind === "agent" ? <Avatar of={markRef("agent", r.label, r.id)} size={24} /> : r.kind === "person" ? <Avatar of={markRef("person", r.label, r.id)} size={24} /> : <View style={{ width: 24, alignItems: "center" }}><Icon name={r.kind === "flow" ? "flows" : r.kind === "new-agent" ? "spark" : "users"} size={18} tone="label" /></View>}
      <Text numberOfLines={1} style={{ flex: 1 }}>{r.label}</Text>
      {r.sub ? <Text tone="label" size="caption" numberOfLines={1}>{r.sub}</Text> : null}
    </Pressable>
  );
  const label = (t: string) => <Text size="caption" tone="label" style={{ paddingHorizontal: 8, paddingTop: 8, paddingBottom: 2 }}>{t}</Text>;
  return (
    <View accessibilityLabel="New" style={{ position: "absolute", top: 4, left: RAIL.rowInset + 4, right: RAIL.rowInset + 4, zIndex: 30, padding: 8, gap: 2, borderRadius: 12, borderWidth: 1, borderColor: color.edge, backgroundColor: color["surface-2"], ...elevation(resolved.scheme, 2) } as any}>
      <Field name="To" value={q} onChangeText={setQ} placeholder="To: a person or an agent" autoFocus onKey={(k) => { if (k === "Escape") onClose(); }} onSubmit={() => { const f = firstRow(rows); if (f) pick(f); }} />
      {rows.agents.length ? <>{label("Agents, each starts a new thread")}{rows.agents.map(row)}</> : null}
      {rows.people.length ? <>{label("People")}{rows.people.map(row)}</> : null}
      {rows.make.length ? <View style={{ paddingTop: 6 }}>{rows.make.map(row)}</View> : null}
      {!rows.agents.length && !rows.people.length && !rows.make.length ? <Text tone="label" style={{ padding: 8 }}>Nobody by that name.</Text> : null}
    </View>
  );
}
