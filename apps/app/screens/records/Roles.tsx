import { useCallback, useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { Chip, Menu, Text, showToast } from "@vyre/ui";
import { callT } from "../../src/real/call-tool";
import { roleChips, summaryChips } from "./roles-model.js";

type Kind = { role: string; label: string; color?: string; stages?: string[] };
type Held = { role: string; label: string; stage?: string; current: boolean; color?: string; urn: string };

const NAMED: Record<string, "warn" | "ok" | "accent" | "err"> = { lead: "warn", client: "ok", partner: "accent", vendor: "err" };
const toneFor = (c: { ended: boolean; tone: string }) => (c.ended ? "plain" : ((NAMED[c.tone] ?? c.tone) as "plain"));

/**
 * What a contact or organization is to the Space: one pill per role ("Client · Active"), a press on a pill moves it to another stage of that role (records.move on the role record), and "+ Role" gives it a
 * role it does not have yet (records.role.set). A box without the roles summary shows the plain chips, which open the role record.
 */
export function Roles({ urn, onOpen }: { urn: string; onOpen: (urn: string) => void }) {
  const [held, setHeld] = useState<Held[] | null>(null);
  const [kinds, setKinds] = useState<Kind[]>([]);
  const [plain, setPlain] = useState<{ key: string; label: string; urn: string; ended: boolean; tone: string }[] | null>(null);
  const load = useCallback(() => {
    void Promise.all([callT<{ roles: Held[] }>("records.roles.summary", { urn }), callT<{ roles: Kind[] }>("records.roles.summary", {})]).then(([mine, all]) => {
      if (mine.data) { setHeld(mine.data.roles); setKinds(all.data?.roles ?? []); setPlain(null); return; }
      return callT<{ roles: any[] }>("records.roles", { urn }).then((q) => { setHeld(null); setPlain(roleChips(q.data?.roles ?? [])); });
    });
  }, [urn]);
  useEffect(() => { setHeld(null); setPlain(null); load(); }, [load]);
  const move = async (r: Held, stage: string) => {
    const x = await callT<{ needs?: string[] }>("records.move", { urn: r.urn, stage });
    if (x.error) { showToast(x.error.message || "That did not move."); return; }
    if (x.data?.needs?.length) { showToast(`To move ${r.label} to ${stage}, fill in: ${x.data.needs.join(", ")}. Open the role to do it.`); return; }
    load();
  };
  const add = async (k: Kind) => {
    const x = await callT("records.role.set", { urn, role: k.role });
    if (x.error) { showToast(x.error.message || "That did not save."); return; }
    load();
  };
  if (plain) {
    return plain.length ? (
      <View className="flex-row flex-wrap items-center gap-s2">
        {plain.map((c) => <Chip key={c.key} tone={toneFor(c)} onPress={c.urn ? () => onOpen(c.urn) : undefined}>{c.ended ? `${c.label} (ended)` : c.label}</Chip>)}
      </View>
    ) : null;
  }
  if (!held) return null;
  const mine = new Set(held.filter((r) => r.current).map((r) => r.role));
  const free = kinds.filter((k) => !mine.has(k.role));
  const chips = summaryChips(held);
  const roleOf = (i: number) => [...held.filter((r) => r.current), ...held.filter((r) => !r.current)][i];
  if (!chips.length && !free.length) return null;
  // The stage strip: the first role this record holds, with every stage of it in a row and the current one lit; a press moves it (the same records.move as the pill's menu).
  const lead = held.find((r) => r.current && (kinds.find((k) => k.role === r.role)?.stages ?? []).length > 1);
  const strip = lead ? kinds.find((k) => k.role === lead.role)?.stages ?? [] : [];
  return (
    <View className="gap-s3">
    <View className="flex-row flex-wrap items-center gap-s2">
      {chips.map((c, i) => {
        const r = roleOf(i);
        const stages = kinds.find((k) => k.role === r.role)?.stages ?? [];
        const pill = <Pressable accessibilityRole="button" accessibilityLabel={`${c.label}, change stage`}><Chip tone={toneFor(c)}>{c.ended ? `${c.label} (ended)` : c.label}</Chip></Pressable>;
        return (
          <Menu key={c.key} trigger={pill}
            items={[...stages.map((s) => ({ label: s, selected: s === r.stage, onPress: () => void move(r, s) })), { label: "Open the role", onPress: () => onOpen(r.urn) }]} />
        );
      })}
      {free.length ? (
        <Menu trigger={<Pressable accessibilityRole="button" accessibilityLabel="Add a role"><Chip icon="plus">Role</Chip></Pressable>} items={free.map((k) => ({ label: k.label, onPress: () => void add(k) }))} />
      ) : null}
    </View>
    {lead && strip.length ? (
      <View className="flex-row flex-wrap items-center gap-s2">
        <Text size="caption" tone="label">{lead.label}</Text>
        {strip.map((s) => <Chip key={s} selected={s === lead.stage} onPress={() => void move(lead, s)}>{s}</Chip>)}
      </View>
    ) : null}
    </View>
  );
}
