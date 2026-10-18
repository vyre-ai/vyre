import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { Button, Card, Field, Icon, Select, Sheet, Text, useStore } from "@vyre/ui";
// @ts-ignore a plain .js module
import { KINDS, DEFAULT_STAGES, parseStages, stagesProblem, createInput } from "./kinds.js";

type Kind = (typeof KINDS)[number]["key"];
export type NewProject = { name: string; kind: Kind; stages?: string[]; client?: string };

/**
 * New project: pick how it runs (Stages, For a client, Ongoing, Simple), then name it. Stages shows its default stage list to edit and offers the team's playbooks, whose stages it takes; For a client asks which
 * company or person in Records. Personal is the pinned private one and is not offered. `onPlaybook` hands over to the playbook start sheet.
 */
export function NewProjectSheet({ open, busy, playbooks, onClose, onMake, onPlaybook }: { open: boolean; busy: boolean; playbooks: { key: string; label: string }[]; onClose: () => void; onMake: (p: NewProject) => void; onPlaybook: (key: string) => void }) {
  const store = useStore();
  const [kind, setKind] = useState<Kind>("simple");
  const [name, setName] = useState("");
  const [stages, setStages] = useState((DEFAULT_STAGES as readonly string[]).join(", "));
  const [client, setClient] = useState("");
  const [clients, setClients] = useState<{ urn: string; name: string }[]>([]);
  useEffect(() => {
    if (!open || kind !== "client") return;
    Promise.resolve(store.list("contact")).then((rows: any[]) => setClients(rows.map((r) => ({ urn: String(r.urn), name: String(r.data?.name || r.data?.title || r.id) })).sort((a, b) => a.name.localeCompare(b.name)))).catch(() => setClients([]));
  }, [open, kind, store]);
  const list = parseStages(stages);
  const problem = kind === "stages" ? stagesProblem(list) : null;
  const ok = name.trim().length > 0 && !problem;
  return (
    <Sheet open={open} onClose={onClose} title="New project">
      <View className="gap-s3 p-s4">
        <Text tone="muted">Pick how it runs. You can change it later. Every project gets a group chat for its people.</Text>
        <View className="gap-s2">
          {KINDS.map((k: (typeof KINDS)[number]) => (
            <Pressable key={k.key} accessibilityRole="radio" accessibilityState={{ selected: kind === k.key }} accessibilityLabel={`${k.label}. ${k.blurb}`} onPress={() => setKind(k.key)}>
              <Card>
                <View className="flex-row items-center gap-s2">
                  <View className="min-w-0 flex-1"><Text strong>{k.label}</Text><Text size="secondary" tone="label">{k.blurb}</Text></View>
                  {kind === k.key ? <Icon name="check" tone="accent" /> : null}
                </View>
              </Card>
            </Pressable>
          ))}
        </View>
        <Field label="Name" value={name} onChangeText={setName} placeholder="Spring launch" />
        {kind === "stages" ? (
          <View className="gap-s2">
            <Field label="Stages, in order" value={stages} onChangeText={setStages} placeholder="Brief, Draft, Review, Launch" />
            {problem ? <Text size="caption" tone="err">{problem}</Text> : <Text size="caption" tone="label">{`${list.length} ${list.length === 1 ? "stage" : "stages"}. Separate them with commas.`}</Text>}
            {playbooks.length ? <Select label="Or take the stages of a playbook" value="" placeholder="Choose a playbook" options={playbooks.map((p): [string, string] => [p.key, p.label])} onChange={(v: string) => v && onPlaybook(v)} /> : null}
          </View>
        ) : null}
        {kind === "client" ? <Select label="Client" value={client} options={[["", "No client record yet"], ...clients.map((c): [string, string] => [c.urn, c.name])]} onChange={setClient} /> : null}
        <View className="flex-row gap-s2">
          <Button kind="primary" size="sm" label="Start project" loading={busy} disabled={!ok} onPress={() => ok && onMake({ name: name.trim(), kind, ...(kind === "stages" ? { stages: list } : {}), ...(kind === "client" && client ? { client } : {}) })} />
          <Button kind="ghost" size="sm" label="Cancel" onPress={onClose} />
        </View>
      </View>
    </Sheet>
  );
}
