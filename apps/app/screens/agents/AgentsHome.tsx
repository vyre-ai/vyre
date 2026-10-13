import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { useRouter } from "expo-router";
import { Avatar, Button, Card, Chip, EmptyState, ErrorState, GroupedList, IconButton, Icon, ListHeader, LoadingState, Menu, Segmented, Sheet, SpaceTag, Text, allowsMock, listRows, markRef, showToast, useStore, useUiTheme } from "@vyre/ui";
import type { FilterChip, Group } from "@vyre/ui";
import { Page } from "../places/Frame";
import { PlaceTag, usePlaceText } from "../../src/real/PlaceTag";
import { TeammatesPage } from "../teammates/TeammatesPage";
import { useSettings } from "../settings/state";
import { AUTONOMY } from "../settings/logic.js";
import { agentDelete, agentResume, agentStop, agentsList } from "../settings/real";
import { AGENT_GROUPS, agentRow, agentsDef, asRecords, loadGroups, saveGroups } from "./home-model.js";

type Row = ReturnType<typeof agentRow>;
const say = (e: unknown) => (e instanceof Error ? e.message : "That did not work.");
const store = () => { try { return typeof localStorage !== "undefined" ? localStorage : null; } catch { return null; } };

/** Agents, the home of every agent: header with search and filters, groups a person can make, and a row each that says who it is, what it does, which model, where it works and whether it runs. */
export function AgentsHome() {
  const router = useRouter();
  const homeTag = usePlaceText("home");
  const { phone } = useUiTheme();
  const mock = allowsMock();
  const sample = useSettings();
  const [live, setLive] = useState<any[] | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [me, setMe] = useState<string>("");
  const [confirm, setConfirm] = useState<string | null>(null);
  const st = useStore();
  useEffect(() => { void (st.me?.() as Promise<string> | undefined)?.then((m) => setMe(String(m ?? ""))).catch(() => {}); }, [st]);
  const [tab, setTab] = useState<"agents" | "teammates">("agents");
  const [query, setQuery] = useState("");
  const [chips, setChips] = useState<FilterChip[]>([]);
  const saved = useMemo(() => { const s = store(); return s ? loadGroups(s) : { groups: [], placed: {} }; }, []);
  const [groups, setGroups] = useState<Group[]>(saved.groups.length ? saved.groups : AGENT_GROUPS.map(([, t]) => ({ name: t })));
  const [placed, setPlaced] = useState<Record<string, string>>(saved.placed);
  const load = useCallback(() => { if (mock) return; setErr(""); agentsList().then(setLive).catch((e) => setErr(say(e))); }, [mock]);
  useEffect(load, [load]);
  const persist = (g: Group[], p: Record<string, string>) => { const s = store(); if (s) saveGroups(s, { groups: g, placed: p }); };

  const agents: any[] | null = mock ? sample.assistants.map((a) => ({ name: a.name, kind: a.family === "assistant" ? "assistant" : "agent", status: a.paused ? "stopped" : "idle", thread: "x", model: a.model, instructions: a.role, autonomy: a.autonomy, id: a.id, ...(a.name === "rev" ? { made_by: "other", shares: [{ person: me || "me", level: "use" }] } : {}) })) : live;
  const rows: Row[] = useMemo(() => (agents ?? []).map((a) => agentRow(a, me)), [agents, me]);
  const titleOf = (id: string) => AGENT_GROUPS.find(([g]) => g === id)?.[1] ?? id;
  const items = rows.map((r) => ({ ...r, group: placed[r.name] ?? titleOf(r.group) }));
  const def = useMemo(() => agentsDef(rows), [rows]);
  const recs = useMemo(() => asRecords(rows), [rows]);
  const keep = new Set(listRows(def, recs, chips, query, {}).map((r: any) => r.id));
  const shown = items.filter((i) => keep.has(i.name));

  const flip = (r: Row) => {
    const stopped = r.status === "Paused";
    if (mock) { const a = sample.assistants.find((x) => x.name === r.name); if (a) sample.setPaused(a.id, !stopped); showToast(stopped ? `${r.name} is working again.` : `Paused ${r.name}. It keeps its notes.`); return; }
    setBusy(r.name);
    (stopped ? agentResume(r.name) : agentStop(r.name)).then(() => { showToast(stopped ? `${r.name} is working again.` : `Paused ${r.name}. It keeps its notes.`); load(); }).catch((e) => showToast(say(e))).finally(() => setBusy(null));
  };
  const open = (r: Row) => router.push(`/u/assistants/${encodeURIComponent(r.name)}` as never);
  const move = (r: Row, g: string) => { const p = { ...placed, [r.name]: g }; setPlaced(p); persist(groups, p); };

  const rowCard = (r: Row & { group?: string }) => {
    const paused = r.status === "Paused";
    const pill = r.autonomy ? (
      <Menu trigger={<Pressable accessibilityRole="button" accessibilityLabel={`${r.name} works: ${AUTONOMY.find(([k]) => k === r.autonomy)?.[1]}`} className="flex-row items-center gap-s1 rounded-chip bg-hover px-s2" style={{ minHeight: 26 }}><Text size="caption" medium tone="muted">{AUTONOMY.find(([k]) => k === r.autonomy)?.[1] ?? r.autonomy}</Text><Icon name="chevron-down" size={12} tone="label" /></Pressable>}
        items={(AUTONOMY as [string, string][]).map(([k, l]) => ({ label: l, selected: r.autonomy === k, onPress: () => { const a = sample.assistants.find((x) => x.name === r.name); if (a) sample.setAutonomy(a.id, k); } }))} />
    ) : null;
    const menu = (
      <Menu trigger={<IconButton icon="more" label={`${r.name}, more`} />} items={[
        { label: "Open", onPress: () => open(r) },
        ...(r.canPause ? [{ label: paused ? "Resume" : "Pause", onPress: () => flip(r) }] : []),
        { label: "Share", onPress: () => open(r) },
        ...(!mock && !r.builtin && r.kind !== "assistant" ? [{ label: "Delete", onPress: () => setConfirm(r.name) }] : []),
        ...groups.filter((g) => g.name !== (placed[r.name] ?? titleOf(r.group as string))).slice(0, 6).map((g) => ({ label: `Move to ${g.name}`, onPress: () => move(r, g.name) })),
      ]} />
    );
    const status = <Chip tone={paused ? "warn" : r.status === "Running now" ? "ok" : "plain"}>{r.status}</Chip>;
    return (
      <Pressable accessibilityRole="button" accessibilityLabel={`Open ${r.name}`} onPress={() => open(r)} disabled={busy === r.name} className="gap-s2 p-s3">
        <View className="flex-row items-center gap-s3">
          <Avatar of={markRef(r.kind === "assistant" ? "assistant" : "teammate", r.name)} size={40} />
          <View className="min-w-0 flex-1 gap-s1">
            <View className="flex-row flex-wrap items-center gap-s2"><Text strong>{r.name}</Text>{homeTag ? <SpaceTag text={homeTag} /> : null}{status}{r.builtin ? <Chip>Admins only</Chip> : null}{r.mine ? <Chip>{r.mine}</Chip> : null}{r.sharedWith > 1 && !r.mine ? <Chip>{`Shared with ${r.sharedWith}`}</Chip> : null}</View>
            <Text size="secondary" tone="muted" numberOfLines={phone ? 2 : 1}>{r.role}</Text>
            <Text size="caption" tone="label" numberOfLines={phone ? 3 : 1}>{[r.model, r.works].join(", ")}</Text>
          </View>
          {phone ? menu : <View className="flex-row items-center gap-s2">{pill}{menu}</View>}
        </View>
        {phone && pill ? <View className="flex-row">{pill}</View> : null}
      </Pressable>
    );
  };

  const remove = (name: string) => {
    setBusy(name);
    agentDelete(name).then(() => { showToast(`${name} is deleted.`); setConfirm(null); load(); }).catch((e) => { setConfirm(null); showToast(say(e)); }).finally(() => setBusy(null));
  };
  return (
    <Page title="Agents" top sub={undefined}>
      <PlaceTag of="home" />
      <Segmented label="Agents" value={tab} onChange={setTab} options={[["agents", "Agents"], ["teammates", "Teammates"]]} />
      {tab === "teammates" ? <TeammatesPage /> : (
        <View className="gap-s3">
          {err ? <Card flush><ErrorState title="Agents did not load" reason={err} retry={load} /></Card> : null}
          {agents === null && !err ? <LoadingState rows={4} /> : null}
          {agents && !agents.length ? (
            <Card><EmptyState title="No agents yet" body="Your assistant and any agents you make appear here." action={{ label: "New agent", onPress: () => router.push("/u/settings/assistants/new" as never) }} /></Card>
          ) : null}
          {agents && agents.length ? (
            <>
              <View className="flex-row items-end gap-s3">
                <View className="min-w-0 flex-1">
                  <ListHeader title={null} noun="agents" shown={shown.length} total={rows.length} query={query} onQuery={setQuery} chips={chips} onChips={setChips} def={def} ctx={{}} />
                </View>
                <Button kind="primary" size={phone ? "md" : "sm"} icon="plus" label="New agent" onPress={() => router.push("/u/settings/assistants/new" as never)} />
              </View>
              {shown.length ? (
                <GroupedList groups={groups} items={shown} itemNoun="agents"
                  onChange={({ groups: g, items: it }) => { const p = { ...placed, ...Object.fromEntries(it.map((i) => [i.name, i.group as string])) }; setGroups(g); setPlaced(p); persist(g, p); }}
                  renderItems={(its) => <Card flush>{its.map((r, i) => <View key={r.name}>{i ? <View className="h-px bg-edge" /> : null}{rowCard(r)}</View>)}</Card>} />
              ) : <Card><EmptyState title="No agents match" body="Clear the search or a filter to see them all." action={{ label: "Clear", onPress: () => { setQuery(""); setChips([]); } }} /></Card>}
            </>
          ) : null}
        </View>
      )}
      <Sheet open={!!confirm} onClose={() => setConfirm(null)} title={confirm ? `Delete ${confirm}?` : undefined}>
        <Text tone="muted">It stops working for good and its notes go with it. If it is running, pause it first; the box will say so.</Text>
        <View className="flex-row gap-s2"><Button kind="primary" label="Delete" loading={busy === confirm} onPress={() => confirm && remove(confirm)} /><Button kind="ghost" label="Cancel" onPress={() => setConfirm(null)} /></View>
      </Sheet>
    </Page>
  );
}
