// The Vault's share sheet and its list of who has what: people, groups and agents at Fill in, Read or Edit and rotate (agents and app connections: Fill in only; agents: only those you may instruct).
// It holds no state of its own about the grants: the page hands in `shares` and the handlers, so the sample world, a Space item and a member's own connection all use the same sheet. The rules are
// in share-model.js.
import { useState } from "react";
import { View } from "react-native";
import { Avatar, Button, Card, Chip, Field, IconTile, Row, Segmented, Sheet, Text, markRef, showToast } from "@vyre/ui";
import { Footnote, Sec } from "../places/Frame";
import { usePhone } from "../places/Page";
import { LEVELS, LEVEL_HELP, allowedLevels, candidates, groupSub, levelWord, loginNotes, nameOf } from "./share-model.js";

export type Level = "use" | "reveal" | "edit";
export type Who = { id: string; kind: "person" | "group" | "agent"; name: string; sub?: string; people?: string[]; agents?: string[]; instructors?: string[]; names?: Record<string, string> };
export type Share = { id: string; level: Level };
export type Directory = { people: Who[]; groups: Who[]; agents: Who[] };

const find = (id: string, d: Directory): Who => [...d.people, ...d.groups, ...d.agents].find((w) => w.id === id) ?? { id, kind: id === "everyone" ? "group" : "person", name: nameOf(id, d), sub: id === "everyone" ? "All members" : "" };
const mark = (w: Who) => markRef(w.kind === "agent" ? "agent" : "person", w.name);
const Lead = ({ w }: { w: Who }) => (w.kind === "group" ? <IconTile name="users" /> : <Avatar of={mark(w)} size={32} />);
const subOf = (w: Who) => (w.kind === "group" ? (w.id === "everyone" ? "All members" : groupSub({ people: w.people ?? [], agents: w.agents ?? [] })) : w.sub ?? "");

/** One holder: who, what they hold, and the level picker. An agent, or anyone on an app connection, has one level. */
export function ShareRow({ w, level, onLevel, onRemove, connection, levels }: { w: Who; level: Level; onLevel: (l: Level) => void; onRemove: () => void; connection?: boolean; levels?: Level[] }) {
  const phone = usePhone();
  const allowed = ((): Level[] => { const a = allowedLevels(w.kind, { connection, levels }) as Level[]; return a.includes(level) || w.kind === "agent" || connection ? a : [...a, level]; })();
  const sub = w.kind === "agent" ? "Agent. Fills in without ever seeing it" : LEVEL_HELP[level];
  const remove = <Button kind="ghost" size="sm" label="Remove" onPress={onRemove} />;
  const seg = <Segmented<Level> label={`${w.name}'s access`} fill={phone} options={allowed.map((l) => [l, levelWord(l)] as [Level, string])} value={level} onChange={onLevel} />;
  if (allowed.length === 1) return <Row dense lead={<Lead w={w} />} title={w.name} sub={sub} end={<View className="flex-row items-center gap-s2"><Chip>{levelWord(allowed[0])}</Chip>{remove}</View>} />;
  if (phone) return <View><Row dense lead={<Lead w={w} />} title={w.name} sub={sub} end={remove} /><View className="px-s3 pb-s2">{seg}</View></View>;
  return <Row dense lead={<Lead w={w} />} title={w.name} sub={sub} end={<View className="flex-row items-center gap-s2">{seg}{remove}</View>} />;
}

/** The share sheet. `title` is the thing shared; `everyone` adds the Space-wide row (a whole vault); `login` adds the agent note; `me` is who is signed in (the agents offered are those she may instruct). */
export function ShareSheet({ open, onClose, title, shares, dir, me, onAdd, onLevel, onRemove, everyone, connection, login, levels }: {
  open: boolean; onClose: () => void; title: string; shares: Share[]; dir: Directory; me: string | null;
  onAdd: (w: Who) => void; onLevel: (id: string, l: Level) => void; onRemove: (id: string) => void; everyone?: boolean; connection?: boolean; login?: boolean; levels?: Level[];
}) {
  const [q, setQ] = useState("");
  const pool = candidates({ people: dir.people, groups: dir.groups, agents: dir.agents, shares, me, q, everyone });
  const section = (label: string, xs: Who[], note?: string) => (xs.length ? (
    <Sec title={label}>
      <Card flush>{xs.map((w) => <Row key={w.id} dense lead={<Lead w={w} />} title={w.name} sub={w.kind === "agent" ? agentSub(w, me) : subOf(w)} end={<Button kind="secondary" size="sm" icon="plus" label="Add" onPress={() => { onAdd(w); showToast(`${w.name} can now fill in ${title}.`); }} />} />)}</Card>
      {note ? <Footnote icon="info">{note}</Footnote> : null}
    </Sec>
  ) : null);
  const notes = login ? loginNotes(shares, dir.agents, me) : [];
  return (
    <Sheet open={open} onClose={onClose} title={`Share ${title}`}>
      <View className="gap-s4">
        <Sec title="Who has it">
          {shares.length ? (
            <Card flush>{shares.map((s) => { const w = find(s.id, dir); return <ShareRow key={s.id} w={w} level={s.level} connection={connection} levels={levels} onLevel={(l) => onLevel(s.id, l)} onRemove={() => { onRemove(s.id); showToast(`${w.name} no longer has ${title}.`); }} />; })}</Card>
          ) : <Text tone="muted">Only you. Nobody else can use this until you give access.</Text>}
        </Sec>
        {notes.length ? <Footnote icon="shield">{notes.join(" ")}</Footnote> : null}
        <Field name="Find a person, group or agent" value={q} onChangeText={setQ} placeholder="Search" />
        {connection ? null : section("People", pool.people)}
        {connection ? null : section("Groups", pool.groups)}
        {section("Agents", pool.agents, "Agents can only fill in. They use it without ever seeing the value, and every use is logged. Only agents you can instruct are listed.")}
        {connection ? section("People", pool.people) : null}
        <Footnote icon="shield">Anything an agent sends, pays or deletes still waits for a yes. You can take access back at any time.</Footnote>
        <View className="flex-row gap-s2"><Button kind="primary" label="Done" onPress={onClose} /></View>
      </View>
    </Sheet>
  );
}

const agentSub = (w: Who, me: string | null) => {
  const others = (w.instructors ?? []).filter((x) => x !== me).map((x) => w.names?.[x]?.split(" ")[0] ?? x);
  return `${w.sub ?? "Agent"}. ${others.length ? `${others.join(", ")} can also instruct it` : "Only you instruct it"}`;
};

export { LEVELS };
