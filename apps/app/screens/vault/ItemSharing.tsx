// "Who has it" for one item of the Space's vault: the people, groups and agents that hold it, each at Fill in, Read or Edit and rotate, and the Share sheet to add more. It asks the box for the shares
// when the item is opened and writes each change at once (vault.access.set); the kernel decides, and a refusal comes back as words.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Button, Card, Text, showToast } from "@vyre/ui";
import { Footnote } from "../places/Frame";
import { connectionNote } from "./share-model.js";
import type { VaultData } from "./redesign-data";
import type { VItem } from "./redesign.js";
import { ShareRow, ShareSheet, type Directory, type Level, type Share, type Who } from "./ShareSheet";
import { nameOf } from "./share-model.js";

const EMPTY: Directory = { people: [], groups: [], agents: [] };

export type Api = NonNullable<VaultData["sharing"]>;
/** `api` is the Space's sharing of an item, or (connection) a member's own app connection, which is shared at Fill in only. */
export function ItemSharing({ api: sharing, item, connection }: { api: Api; item: VItem; connection?: boolean }) {
  const [state, setState] = useState<{ shares: Share[]; dir: Directory; me: string | null } | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(false);
  const load = useCallback(() => { sharing.load(item).then((s) => { setState(s); setErr(""); }).catch((e) => setErr(String((e as Error)?.message || "That did not load."))); }, [sharing, item]);
  useEffect(() => { setState(null); load(); }, [load]);
  const dir = state?.dir ?? EMPTY;
  const kindOf = (id: string): Who["kind"] => ([...dir.groups].some((g) => g.id === id) || id === "everyone" ? "group" : dir.agents.some((a) => a.id === id) ? "agent" : "person");
  const change = (id: string, level: Level | null) => sharing.set(item, { id, kind: kindOf(id) }, level).then(load).catch((e) => showToast(String((e as Error)?.message || "That did not work.")));
  const whoOf = (id: string): Who => [...dir.people, ...dir.groups, ...dir.agents].find((w) => w.id === id) ?? { id, kind: kindOf(id), name: nameOf(id, dir) };
  const shares = state?.shares ?? [];
  return (
    <View className="gap-s2">
      {err ? <Text tone="muted">{err}</Text> : null}
      {shares.length ? <Card flush>{shares.map((s) => <ShareRow key={s.id} w={whoOf(s.id)} level={s.level} connection={connection} onLevel={(l) => void change(s.id, l)} onRemove={() => void change(s.id, null)} />)}</Card> : <Text tone="muted">{state ? "Only you." : "Loading."}</Text>}
      <View className="flex-row gap-s2 pt-s2"><Button kind="secondary" size="sm" icon="share" label="Share" onPress={() => setOpen(true)} disabled={!state} /></View>
      {connection
        ? <Footnote icon="shield">{connectionNote(item.name, shares, dir.agents)}</Footnote>
        : <Footnote icon="info">Fill in works for API keys now: a member uses one without seeing it. Read and Edit and rotate reach members in the next update.</Footnote>}
      <ShareSheet open={open} onClose={() => setOpen(false)} title={item.name} shares={shares} dir={dir} me={state?.me ?? null} connection={connection} login={!connection && item.group === "Logins"}
        onAdd={(w) => void change(w.id, "use")} onLevel={(id, l) => void change(id, l)} onRemove={(id) => void change(id, null)} />
    </View>
  );
}
