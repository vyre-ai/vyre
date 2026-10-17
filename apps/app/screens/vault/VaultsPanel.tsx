// Named vaults: cards for each vault with what is in it and who holds it, Share vault (a person, a group, an agent, or everyone in the Space) and New vault. Where the vaults come from and where a change
// goes (the sample world, or vault.named.* on the Space's kernel) is the caller's; the share sheet is the Vault's one sheet.
import { useState } from "react";
import { View } from "react-native";
import { AvatarStack, Button, Card, Chip, Field, IconTile, Segmented, Sheet, Text, markRef, showToast } from "@vyre/ui";
import { Footnote } from "../places/Frame";
import { ShareSheet, type Directory, type Level, type Share, type Who } from "./ShareSheet";
import { nameOf } from "./share-model.js";

export type Vlt = { id: string; name: string; sub: string; count: number; shares: Share[]; mine?: boolean };

export function VaultsPanel({ vaults, dir, me, levels, onCreate, onAdd, onLevel, onRemove, onRemoveVault, openFirst }: {
  vaults: Vlt[]; dir: Directory; me: string | null; levels?: Level[];
  onCreate: (name: string, everyone: boolean) => Promise<void> | void;
  onAdd: (vault: string, w: Who) => Promise<void> | void; onLevel: (vault: string, id: string, l: Level) => Promise<void> | void; onRemove: (vault: string, id: string) => Promise<void> | void;
  onRemoveVault?: (id: string) => Promise<void> | void; openFirst?: "share" | "new";
}) {
  const [open, setOpen] = useState<string | null>(openFirst === "share" ? vaults.find((v) => !v.mine)?.id ?? null : null);
  const [making, setMaking] = useState(openFirst === "new");
  const [name, setName] = useState("");
  const [start, setStart] = useState("me");
  const [err, setErr] = useState("");
  const cur = vaults.find((v) => v.id === open);
  const mark = (id: string) => { const w = [...dir.people, ...dir.groups, ...dir.agents].find((x) => x.id === id); return markRef(w?.kind === "agent" ? "agent" : "person", w?.name ?? nameOf(id, dir)); };
  const make = async () => { setErr(""); try { await onCreate(name.trim(), start === "all"); setMaking(false); setName(""); setStart("me"); showToast("Vault made."); } catch (e) { setErr(String((e as Error)?.message || "That did not work.")); } };
  const fail = (e: unknown) => showToast(String((e as Error)?.message || "That did not work."));
  return (
    <View className="gap-s4">
      <Footnote icon="shield">Each vault is kept apart: your own things and a client's things never sit in one place. Share a whole vault, and everyone you pick can use what is in it. Point a project at a vault and its agents use the keys without seeing them.</Footnote>
      <View className="flex-row flex-wrap gap-s3">
        {vaults.map((v) => (
          <View key={v.id} className="min-w-pane flex-1">
            <Card>
              <View className="gap-s3">
                <View className="flex-row items-center gap-s3"><IconTile name={v.mine ? "lock" : "vault"} size={40} /><View className="min-w-0 flex-1"><Text size="title" strong>{v.name}</Text><Text tone="label">{v.sub}</Text></View></View>
                <View className="flex-row items-center justify-between gap-s2">
                  <Text tone="label">{v.count === 1 ? "1 item" : `${v.count} items`}</Text>
                  {v.shares.some((s) => s.id === "everyone") ? <Chip>Everyone in the Space</Chip> : v.shares.length ? <AvatarStack of={v.shares.map((s) => mark(s.id))} size={24} /> : <Text tone="label">Only you</Text>}
                </View>
                <View className="flex-row gap-s2">
                  {v.mine ? null : <Button kind="secondary" size="sm" icon="share" label="Share vault" onPress={() => setOpen(v.id)} />}
                  {v.mine || !onRemoveVault || v.count ? null : <Button kind="ghost" size="sm" label="Remove" onPress={() => Promise.resolve(onRemoveVault(v.id)).then(() => showToast("Vault removed.")).catch(fail)} />}
                </View>
              </View>
            </Card>
          </View>
        ))}
      </View>
      <View className="self-start"><Button kind="secondary" size="sm" icon="plus" label="New vault" onPress={() => setMaking(true)} /></View>
      {cur ? <ShareSheet open title={cur.name} onClose={() => setOpen(null)} shares={cur.shares} dir={dir} me={me} levels={levels} everyone
        onAdd={(w) => void Promise.resolve(onAdd(cur.id, w)).catch(fail)} onLevel={(id, l) => void Promise.resolve(onLevel(cur.id, id, l)).catch(fail)} onRemove={(id) => void Promise.resolve(onRemove(cur.id, id)).catch(fail)} /> : null}
      <Sheet open={making} onClose={() => setMaking(false)} title="New vault">
        <View className="gap-s4">
          <Field name="Vault name" value={name} onChangeText={setName} placeholder="Northwind Bakery (client)" />
          <Segmented<string> label="Who starts with access" options={[["me", "Only me"], ["all", "Everyone in the Space"]]} value={start} onChange={setStart} />
          <Text tone="label">You can share it with people, groups and agents afterwards, one at a time or all at once.</Text>
          {err ? <Footnote icon="info">{err}</Footnote> : null}
          <View className="flex-row gap-s2"><Button kind="primary" label="Make vault" onPress={make} disabled={!name.trim()} /><Button kind="ghost" label="Cancel" onPress={() => setMaking(false)} /></View>
        </View>
      </Sheet>
    </View>
  );
}
