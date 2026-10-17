// Groups in People and roles: named sets of people and agents you can give things to at once (a vault, a Flow, later a chat or a project). The panel holds the editing sheet; where the groups come from and
// where a change goes (the sample world, or spaces.groups.* on the Space's kernel) is the caller's.
import { useState } from "react";
import { View } from "react-native";
import { AvatarStack, Button, Card, Chip, EmptyState, Field, IconTile, Row, Sheet, markRef } from "@vyre/ui";
import { Footnote, Sec } from "../places/Frame";
import type { Who } from "./ShareSheet";
import { groupSub } from "./share-model.js";

const mark = (w: Who) => markRef(w.kind === "agent" ? "agent" : "person", w.name);

export function GroupsPanel({ groups, people, agents, onSave, onRemove, startEditing }: {
  groups: Who[]; people: Who[]; agents: Who[];
  onSave: (g: { id: string; name: string; people: string[]; agents: string[] }) => Promise<void> | void; onRemove: (id: string) => Promise<void> | void; startEditing?: "edit" | "new";
}) {
  const first = startEditing === "edit" ? groups[0] : startEditing === "new" ? { id: "", kind: "group" as const, name: "", people: [], agents: [] } : null;
  const [edit, setEdit] = useState<Who | null>(first ?? null);
  const [name, setName] = useState(first?.name ?? "");
  const [ps, setPs] = useState<string[]>(first?.people ?? []);
  const [as, setAs] = useState<string[]>(first?.agents ?? []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const open = (g: Who | null) => { setErr(""); setEdit(g ?? { id: "", kind: "group", name: "", people: [], agents: [] }); setName(g?.name ?? ""); setPs(g?.people ?? []); setAs(g?.agents ?? []); };
  const toggle = (xs: string[], id: string) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]);
  const run = async (f: () => Promise<void> | void) => { setBusy(true); setErr(""); try { await f(); setEdit(null); } catch (e) { setErr(String((e as Error)?.message || "That did not work.")); } finally { setBusy(false); } };
  const byId = (id: string) => [...people, ...agents].find((w) => w.id === id);
  return (
    <View className="gap-s4">
      <Footnote icon="info">A group is a set of people and agents you can give things to at once: a vault, a Flow, later a chat or a project. People in a group keep their own role. An agent in a group can use what it is given and never see a value.</Footnote>
      {groups.length ? (
        <Card flush>{groups.map((g) => (
          <Row key={g.id} lead={<IconTile name="users" />} title={g.name} sub={groupSub({ people: g.people ?? [], agents: g.agents ?? [] })}
            end={<View className="flex-row items-center gap-s3"><AvatarStack of={[...(g.people ?? []), ...(g.agents ?? [])].map(byId).filter(Boolean).map((w) => mark(w as Who))} size={28} /><Button kind="ghost" size="sm" label="Edit" onPress={() => open(g)} /></View>} />
        ))}</Card>
      ) : <EmptyState title="No groups yet" body="Make a group, like Billing, to give a vault to several people and agents at once." />}
      <View className="self-start"><Button kind="secondary" size="sm" icon="plus" label="New group" onPress={() => open(null)} /></View>
      <Sheet open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? `Edit ${edit.name}` : "New group"}>
        <View className="gap-s4">
          <Field name="Group name" value={name} onChangeText={setName} placeholder="Billing" />
          <Sec title="People"><View className="flex-row flex-wrap gap-s2">{people.map((p) => <Chip key={p.id} selected={ps.includes(p.id)} onPress={() => setPs((xs) => toggle(xs, p.id))}>{p.name}</Chip>)}</View></Sec>
          <Sec title="Agents"><View className="flex-row flex-wrap gap-s2">{agents.map((a) => <Chip key={a.id} selected={as.includes(a.id)} onPress={() => setAs((xs) => toggle(xs, a.id))}>{a.name}</Chip>)}</View></Sec>
          {err ? <Footnote icon="info">{err}</Footnote> : null}
          <View className="flex-row gap-s2">
            <Button kind="primary" label={busy ? "Saving" : "Save"} disabled={busy || !name.trim()} onPress={() => run(() => onSave({ id: edit?.id ?? "", name: name.trim(), people: ps, agents: as }))} />
            <Button kind="ghost" label="Cancel" onPress={() => setEdit(null)} />
            {edit?.id ? <Button kind="danger" label="Remove group" disabled={busy} onPress={() => run(() => onRemove(edit.id))} /> : null}
          </View>
        </View>
      </Sheet>
    </View>
  );
}
