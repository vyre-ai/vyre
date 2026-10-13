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
import { AGENT_GROUPS, agentRow, agentsDef, asRecords, chatHas, loadGroups, rowActions, saveGroups, visibleAgents } from "./home-model.js";
import { useChats } from "../../src/state/chats";
import { useMembers } from "../spaces/state";
import { teammates } from "../teammates/teammates";
import { assistantChatRoute, startChat } from "../../src/state/start-chat";

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
  const load = useCallback(() => { setErr(""); agentsList().then(setLive).catch((e) => setErr(say(e))); }, [mock]);
  useEffect(load, [load]);
  // Owners and admins may share and delete any agent; anyone else only the agents they made. The sample world is the owner's.
  const role = useMembers((m) => m.spaces.find((x) => x.id === m.space)?.role);
  const staff = mock || role === "owner" || role === "admin";
  const chats = useChats();
  const [listFor, setListFor] = useState<string | null>(null);
  const persist = (g: Group[], p: Record<string, string>) => { const s = store(); if (s) saveGroups(s, { groups: g, placed: p }); };

  // The sample world answers the same agents.list the page reads (mock-agents.ts); only the pause and autonomy a person sets here are layered on it.
  const agents: any[] | null = live && mock ? live.map((a) => { const x = sample.assistants.find((y) => y.name === a.name); return x ? { ...a, status: x.paused ? "stopped" : "idle", autonomy: x.autonomy } : a; }) : live;
  // the projects' own names, so "Works on" says Juniper Studio and not its id
  const [names, setNames] = useState<Record<string, string>>({});
  const slugs = [...new Set((agents ?? []).flatMap((a) => (Array.isArray(a.projects) ? a.projects.map(String) : [])))].join(",");
  useEffect(() => { let on = true; if (slugs) void teammates.names(slugs.split(",")).then((n) => { if (on) setNames(n); }).catch(() => {}); return () => { on = false; }; }, [slugs]);
  const rows: Row[] = useMemo(() => visibleAgents((agents ?? []).map((a) => agentRow(a, me, names)), me), [agents, me, names]);
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
  const open = (r: Row, tab?: string) => router.push(`/u/assistants/${encodeURIComponent(r.name)}${tab ? `?tab=${tab}` : ""}` as never);
  const go = (route: string) => router.push(route as never);
  const talk = (r: Row) => { setBusy(r.name); startChat({ people: [], agents: [r.name] }).then((x) => { if ("chat" in x) go(`/u/chats/${encodeURIComponent(x.chat)}`); else showToast(x.say); }).catch((e) => showToast(say(e))).finally(() => setBusy(null)); };
  const withIt = (r: Row) => chats.rows.filter((c) => chatHas(c, r.name));
  const assistantChat = (r: Row) => { setBusy(r.name); assistantChatRoute().then(go).finally(() => setBusy(null)); };
  const press = (r: Row) => (r.kind === "assistant" ? assistantChat(r) : open(r));
  const move = (r: Row, g: string) => { const p = { ...placed, [r.name]: g }; setPlaced(p); persist(groups, p); };

  const rowCard = (r: Row & { group?: string }) => {
    const paused = r.status === "Paused";
    const pill = r.autonomy ? (
      <Menu trigger={<Pressable accessibilityRole="button" accessibilityLabel={`${r.name} works: ${AUTONOMY.find(([k]) => k === r.autonomy)?.[1]}`} className="flex-row items-center gap-s1 rounded-chip bg-hover px-s2" style={{ minHeight: 26 }}><Text size="caption" medium tone="muted">{AUTONOMY.find(([k]) => k === r.autonomy)?.[1] ?? r.autonomy}</Text><Icon name="chevron-down" size={12} tone="label" /></Pressable>}
        items={(AUTONOMY as [string, string][]).map(([k, l]) => ({ label: l, selected: r.autonomy === k, onPress: () => { const a = sample.assistants.find((x) => x.name === r.name); if (a) sample.setAutonomy(a.id, k); } }))} />
    ) : null;
    const mine = withIt(r);
    const run: Record<string, (x?: { to?: string }) => void> = { open: () => open(r), chat: () => assistantChat(r), "new-chat": () => talk(r), chats: () => (mine.length === 1 ? go(`/u/chats/${encodeURIComponent(mine[0].id)}`) : setListFor(r.name)), pause: () => flip(r), share: () => open(r, "used"), delete: () => setConfirm(r.name), move: (x) => x?.to && move(r, x.to) };
    const menu = (
      <Menu trigger={<IconButton icon="more" label={`${r.name}, more`} />}
        items={rowActions(r, { me, staff, chats: mine.length, groups: groups.map((g) => g.name), placed: placed[r.name] ?? titleOf(r.group as string), canDelete: !mock }).map((a) => ({ label: a.label, onPress: () => run[a.key]?.(a) }))} />
    );
    const status = <Chip tone={paused ? "warn" : r.status === "Running now" ? "ok" : "plain"}>{r.status}</Chip>;
    return (
      <Pressable accessibilityRole="button" accessibilityLabel={r.kind === "assistant" ? "Open your assistant" : `Open ${r.name}`} onPress={() => press(r)} disabled={busy === r.name} className="gap-s2 p-s3">
        <View className="flex-row items-center gap-s3">
          <Avatar of={markRef(r.kind === "assistant" ? "assistant" : "teammate", r.name)} size={40} />
          <View className="min-w-0 flex-1 gap-s1">
            <View className="flex-row flex-wrap items-center gap-s2"><Text strong>{r.name}</Text>{r.kind === "assistant" ? <Chip>Your assistant</Chip> : null}{homeTag ? <SpaceTag text={homeTag} /> : null}{status}{r.builtin ? <Chip>Admins only</Chip> : null}{r.mine ? <Chip>{r.mine}</Chip> : null}{r.sharedWith > 1 && !r.mine ? <Chip>{`Shared with ${r.sharedWith}`}</Chip> : null}</View>
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
            <Card><EmptyState title="No agents yet" body="Your agent and any agents you make appear here." action={{ label: "New agent", onPress: () => router.push("/u/settings/assistants/new" as never) }} /></Card>
          ) : null}
          {agents && agents.length ? (
            <>
              <ListHeader title={null} noun="agents" shown={shown.length} total={rows.length} query={query} onQuery={setQuery} chips={chips} onChips={setChips} def={def} ctx={{}}
                actions={phone ? <IconButton kind="primary" icon="plus" label="New agent" onPress={() => router.push("/u/settings/assistants/new" as never)} /> : <Button kind="primary" size="sm" icon="plus" label="New agent" onPress={() => router.push("/u/settings/assistants/new" as never)} />} />
              {shown.length ? (
                <GroupedList groups={groups} items={shown} itemNoun="agents"
                  onChange={({ groups: g, items: it }) => { const p = { ...placed, ...Object.fromEntries(it.map((i) => [i.name, i.group as string])) }; setGroups(g); setPlaced(p); persist(g, p); }}
                  renderItems={(its) => <Card flush>{its.map((r, i) => <View key={r.name}>{i ? <View className="h-px bg-edge" /> : null}{rowCard(r)}</View>)}</Card>} />
              ) : <Card><EmptyState title="No agents match" body="Clear the search or a filter to see them all." action={{ label: "Clear", onPress: () => { setQuery(""); setChips([]); } }} /></Card>}
            </>
          ) : null}
        </View>
      )}
      <Sheet open={!!listFor} onClose={() => setListFor(null)} title={listFor ? `Chats with ${listFor}` : undefined}>
        <View className="gap-s1">
          {(listFor ? chats.rows.filter((c) => chatHas(c, listFor)) : []).map((c) => <Pressable key={c.id} accessibilityRole="button" onPress={() => { setListFor(null); go(`/u/chats/${encodeURIComponent(c.id)}`); }} className="rounded-card p-s2"><Text>{c.title || "Chat"}</Text></Pressable>)}
        </View>
      </Sheet>
      <Sheet open={!!confirm} onClose={() => setConfirm(null)} title={confirm ? `Delete ${confirm}?` : undefined}>
        <Text tone="muted">It stops working for good and its notes go with it. If it is running, pause it first; the box will say so.</Text>
        <View className="flex-row gap-s2"><Button kind="primary" label="Delete" loading={busy === confirm} onPress={() => confirm && remove(confirm)} /><Button kind="ghost" label="Cancel" onPress={() => setConfirm(null)} /></View>
      </Sheet>
    </Page>
  );
}
