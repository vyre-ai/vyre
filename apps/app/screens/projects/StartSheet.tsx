import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { Button, Field, Select, Sheet, Text, useStore } from "@vyre/ui";
import { useMembers } from "../spaces/state";
import { startName } from "../templates/model";

export type StartExtras = { client?: string; lead?: string; team: string[]; names: Record<string, string> };

/**
 * Asks what to call a new project made from a playbook ("Rivera Family Trust"), in its own words: "Start a matter". It may be linked to a client record and given its people: who leads it, and who else is on
 * it. Each is optional; the playbook's own assistants join as before.
 */
export function StartSheet({ noun, playbook, open, busy, onClose, onStart }: { noun: string; /** The playbook it is made from, named in the line under the title. */ playbook?: string; open: boolean; busy: boolean; onClose: () => void; onStart: (name: string, extras: StartExtras) => void }) {
  const store = useStore();
  const { members } = useMembers();
  const [text, setText] = useState("");
  const [client, setClient] = useState("");
  const [lead, setLead] = useState("");
  const [team, setTeam] = useState<string[]>([]);
  const [clients, setClients] = useState<{ urn: string; name: string }[]>([]);
  useEffect(() => {
    if (!open) return;
    Promise.resolve(store.list("contact")).then((rows: any[]) => setClients(rows.map((r) => ({ urn: String(r.urn), name: String(r.data?.name || r.data?.title || r.id) })).sort((a, b) => a.name.localeCompare(b.name)))).catch(() => setClients([]));
  }, [open, store]);
  const names = useMemo(() => Object.fromEntries(members.map((m) => [m.id, m.name])), [members]);
  const n = startName(text);
  const word = noun.toLowerCase();
  const people: [string, string][] = members.map((m) => [m.id, m.name]);
  return (
    <Sheet open={open} onClose={onClose} title={`New ${word}`}>
      <View className="gap-s3 p-s4">
        <Text tone="muted">{`${playbook ? `Starts a ${noun} from the ${playbook} playbook. ` : ""}Gives the ${word} its stages, and puts the first stage's tasks in Now.`}</Text>
        <Field label="Name" value={text} onChangeText={setText} placeholder="Rivera Family Trust" />
        {text && !n.ok ? <Text size="caption" tone="label">{n.why}</Text> : null}
        {clients.length ? <Select label="Client (optional)" value={client} options={[["", "No client record"], ...clients.map((c): [string, string] => [c.urn, c.name])]} onChange={setClient} /> : null}
        {people.length ? <Select label="Who leads it (optional)" value={lead} options={[["", "No one yet"], ...people]} onChange={setLead} /> : null}
        {people.length ? (
          <View className="gap-s1">
            <Text size="caption" strong tone="label">Who else is on it (optional)</Text>
            <View className="flex-row flex-wrap gap-s2">{team.map((p) => <Button key={p} kind="ghost" size="sm" icon="x" label={names[p] || p} onPress={() => setTeam(team.filter((x) => x !== p))} />)}</View>
            <Select label="Add someone" value="" placeholder="Choose someone" options={people.filter(([v]) => !team.includes(v) && v !== lead)} onChange={(v: string) => v && setTeam([...team, v])} />
          </View>
        ) : null}
        <View className="flex-row gap-s2">
          <Button kind="primary" size="sm" label={`Start ${word}`} loading={busy} disabled={!n.ok} onPress={() => n.ok && onStart(n.name, { ...(client ? { client } : {}), ...(lead ? { lead } : {}), team, names })} />
          <Button kind="ghost" size="sm" label="Cancel" onPress={onClose} />
        </View>
      </View>
    </Sheet>
  );
}
