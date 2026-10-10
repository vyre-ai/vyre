// The people in a space: who, their role (or the temp scope and end), and Extend for a temp member you may manage. Tapping a row you may manage opens its role sheet.
import { View } from "react-native";
import { Avatar, Button, Card, Chip, Divider, Row, Text, markRef } from "@vyre/ui";
import type { Member, Teammate } from "./data";
import { roleLabel, type Role } from "./roles.js";

export function MembersList({ members, can, team = [], onOpen, onExtend }: { members: Member[]; can: (m: Member) => boolean; team?: Teammate[]; onOpen: (m: Member) => void; onExtend: (m: Member) => void }) {
  return (
    <Card flush>
      {members.map((m, i) => {
        const may = can(m);
        const temp = m.role === "temp";
        return (
          <View key={m.id}>
            {i ? <Divider inset={68} /> : null}
            <Row dense lead={<Avatar of={markRef("person", m.name, m.id)} size={40} />} title={m.name}
              end={temp && may ? <Button kind="ghost" size="sm" label="Extend" onPress={() => onExtend(m)} /> : undefined}
              sub={temp ? (
                <View className="gap-s1 pt-s1">
                  <Text size="secondary" tone="label" numberOfLines={1}>{`Only ${m.scope}`}</Text>
                  <View className="flex-row items-center gap-s2"><Chip tone="warn">{`Temp, ends ${m.end}`}</Chip></View>
                </View>
              ) : roleLabel(m.role as Role)}
              onPress={may ? () => onOpen(m) : undefined} />
          </View>
        );
      })}
      {team.map((t) => <View key={t.id}><Divider inset={68} /><Row dense lead={<Avatar of={markRef(t.id === "juno" || t.name === "juno" ? "assistant" : "teammate", t.name, t.id)} size={40} />} title={t.name} sub={t.sub} /></View>)}
    </Card>
  );
}
