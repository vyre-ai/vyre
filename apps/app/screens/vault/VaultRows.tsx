// The Vault's item-sheet rows and the AI accounts list (team/0.6/CALM-UI-SPEC.md, the owner's ruling on the Vault tool map). Each row calls an
// existing tool and shows its answer in plain words. No row here shows a value: versions, links, tags and account names carry none.
import { useEffect, useState } from "react";
import { View } from "react-native";
import { Button, Card, Field, Row, Text, showToast } from "@vyre/ui";
import { callT } from "../../src/real/call-tool";

const fail = (e: unknown, fallback: string) => showToast(String((e as { message?: string })?.message || fallback));
const when = (at: unknown) => { const d = new Date(Number(at) || String(at)); return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(); };

/** Earlier versions of one item: when it changed, by whom, and which fields changed. Putting one back makes it the newest version. */
/** canPutBack: only the person's own items get Put back here; a shared item is changed by its owner (sec53: the server refuses the rest). */
export function EarlierVersions({ name, onChanged, canPutBack = false }: { name: string; onChanged?: () => void; canPutBack?: boolean }) {
  const [rows, setRows] = useState<{ ver: number; at: unknown; by: string; fields: string[] }[] | null>(null);
  const load = () => callT<{ versions?: { ver: number; at: unknown; by: string; fields: string[] }[] }>("vault.history", { name })
    .then((r) => setRows(r.data?.versions ?? [])).catch(() => setRows([]));
  useEffect(() => { void load(); }, [name]);
  const revert = (ver: number) => callT("vault.revert", { name, version: ver })
    .then((r) => { if (r.error) throw r.error; showToast("Put back. It is the newest version now."); void load(); onChanged?.(); })
    .catch((e) => fail(e, "That did not put the version back."));
  return (
    <View className="gap-s2">
      <Text size="caption" strong tone="label">Earlier versions</Text>
      {rows === null ? null : rows.length <= 1 ? <Text tone="muted">No earlier version yet.</Text> : (
        <Card flush>
          {rows.slice(1).map((r) => (
            <Row key={r.ver} dense title={`Version ${r.ver}`} sub={`${when(r.at)} · ${r.by || "someone"}${r.fields?.length ? ` · changed ${r.fields.join(", ")}` : ""}`}
              end={canPutBack ? <Button kind="ghost" size="sm" label="Put back" onPress={() => revert(r.ver)} /> : undefined} />
          ))}
        </Card>
      )}
    </View>
  );
}

/** The records this item is linked to, with Link and Unlink. A link grants nothing and moves no value. */
export function LinkedTo({ item }: { item: string }) {
  const [links, setLinks] = useState<{ item: string; to: string }[] | null>(null);
  const [to, setTo] = useState("");
  const load = () => callT<{ links?: { item: string; to: string }[] }>("vault.links", { item })
    .then((r) => setLinks(r.data?.links ?? [])).catch(() => setLinks([]));
  useEffect(() => { void load(); }, [item]);
  const link = () => callT("vault.link", { item, to: to.trim() })
    .then((r) => { if (r.error) throw r.error; setTo(""); void load(); }).catch((e) => fail(e, "That did not link it."));
  const unlink = (target: string) => callT("vault.unlink", { item, to: target })
    .then((r) => { if (r.error) throw r.error; void load(); }).catch((e) => fail(e, "That did not unlink it."));
  return (
    <View className="gap-s2">
      <Text size="caption" strong tone="label">Linked to</Text>
      {links?.length ? <Card flush>{links.map((l) => <Row key={l.to} dense title={l.to} end={<Button kind="ghost" size="sm" label="Unlink" onPress={() => unlink(l.to)} />} />)}</Card>
        : links ? <Text tone="muted">Not linked to a client, matter or project. Linking shows its uses on that record.</Text> : null}
      <Field name="Record to link" value={to} onChangeText={setTo} placeholder="A client, matter or project" />
      <Button kind="secondary" size="sm" label="Link" disabled={!to.trim()} onPress={link} />
    </View>
  );
}

/** The conversations a # tag has lent this login to, with a way to take each one back. */
export function TaggedIn({ item }: { item: string }) {
  const [rows, setRows] = useState<{ id: string; thread: string; lastUsed?: unknown }[] | null>(null);
  const load = () => callT<{ tags?: { id: string; thread: string; lastUsed?: unknown }[] }>("vault.tagged", { item })
    .then((r) => setRows(r.data?.tags ?? [])).catch(() => setRows([]));
  useEffect(() => { void load(); }, [item]);
  const take = (id: string) => callT("vault.untag", { id }).then((r) => { if (r.error) throw r.error; void load(); }).catch((e) => fail(e, "That did not take it back."));
  if (!rows?.length) return null;
  return (
    <View className="gap-s2">
      <Text size="caption" strong tone="label">Used in conversations</Text>
      <Card flush>{rows.map((t) => <Row key={t.id} dense title="A conversation" sub={t.lastUsed ? `Last used ${when(t.lastUsed)}` : "Used by a # tag"} end={<Button kind="ghost" size="sm" label="Take back" onPress={() => take(t.id)} />} />)}</Card>
    </View>
  );
}

/** Move an item into a shared vault. Everyone in that vault can then use it. */
export function MoveToVault({ item, onMoved }: { item: string; onMoved?: () => void }) {
  const [vaults, setVaults] = useState<{ name: string }[] | null>(null);
  useEffect(() => { callT<{ vaults?: { name: string }[] }>("vault.vaults.list", {}).then((r) => setVaults(r.data?.vaults ?? [])).catch(() => setVaults([])); }, []);
  const move = (to: string) => callT("vault.move", { name: item, to })
    .then((r) => { if (r.error) throw r.error; showToast(`Moved to ${to}.`); onMoved?.(); }).catch((e) => fail(e, "That did not move it."));
  if (!vaults?.length) return null;
  return (
    <View className="gap-s2">
      <Text size="caption" strong tone="label">Move to</Text>
      <Card flush>{vaults.map((v) => <Row key={v.name} dense title={v.name} end={<Button kind="ghost" size="sm" label="Move here" onPress={() => move(v.name)} />} />)}</Card>
    </View>
  );
}

/** The AI accounts and apps the Vault holds, by the names the connections list gives. No credential is shown. */
export function AccountNames() {
  const [names, setNames] = useState<{ name: string; detail?: string }[] | null>(null);
  useEffect(() => {
    callT<{ connections?: { name?: string; label?: string; detail?: string }[] } | { name?: string; label?: string; detail?: string }[]>("vault.connections.list", {})
      .then((r) => {
        const d = r.data as any;
        const list: any[] = Array.isArray(d) ? d : d?.connections ?? [];
        setNames(list.map((c) => ({ name: String(c.label ?? c.name ?? ""), detail: c.detail })).filter((c) => c.name));
      }).catch(() => setNames([]));
  }, []);
  if (!names?.length) return null;
  return (
    <View className="gap-s2">
      <Text size="caption" strong tone="label">AI and apps</Text>
      <Card flush>{names.map((c) => <Row key={c.name} dense title={c.name} sub={c.detail} />)}</Card>
    </View>
  );
}
