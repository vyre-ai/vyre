// DESIGN PREVIEW ONLY (team/0.6/PROPOSAL-vault-connections.md, V9): the Vault's sharing screens in the sample world, for the owner to approve before anything is wired. Nothing here reads or stores a
// value. The parts: items with app connections beside them, the share sheet (people, groups and agents at Fill in, Read, Edit and rotate), the Groups page of People and roles, and named vaults.
import { useMemo, useState } from "react";
import { View } from "react-native";
import { Avatar, AvatarStack, Button, Card, Chip, EmptyState, Field, IconTile, Row, Segmented, Sheet, Text, markRef, showToast } from "@vyre/ui";
import { Footnote, Frame, Sec } from "../places/Frame";
import { usePhone } from "../places/Page";

type Kind = "person" | "group" | "agent";
type Level = "use" | "reveal" | "edit";
type Who = { id: string; kind: Kind; name: string; sub: string };
type Share = { id: string; level: Level };

const LEVELS: [Level, string][] = [["use", "Fill in"], ["reveal", "Read"], ["edit", "Edit and rotate"]];
const LEVEL_HELP: Record<Level, string> = { use: "Uses it, never sees it", reveal: "Also sees the value", edit: "Also changes it, rotates the key" };
const word = (l: Level) => LEVELS.find((x) => x[0] === l)![1];

const PEOPLE: Who[] = [
  { id: "chris", kind: "person", name: "Chris Okafor", sub: "Admin" },
  { id: "dana", kind: "person", name: "Dana Whitfield", sub: "Member" },
  { id: "iris", kind: "person", name: "Iris Chen", sub: "Member" },
];
const AGENTS: Who[] = [
  { id: "kit", kind: "agent", name: "Kit", sub: "Billing agent" },
  { id: "juno", kind: "agent", name: "Juno", sub: "Intake agent" },
];
type Group = { id: string; name: string; people: string[]; agents: string[] };
const GROUPS0: Group[] = [
  { id: "billing", name: "Billing", people: ["chris", "dana"], agents: ["kit"] },
  { id: "marketing", name: "Marketing", people: ["dana", "iris"], agents: ["juno"] },
];
const whoOf = (id: string, groups: Group[]): Who | undefined =>
  [...PEOPLE, ...AGENTS].find((w) => w.id === id) ?? (() => { const g = groups.find((x) => x.id === id); return g ? { id, kind: "group" as const, name: g.name, sub: groupSub(g) } : id === "everyone" ? { id, kind: "group" as const, name: "Everyone in the Space", sub: "All members" } : undefined; })();
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const groupSub = (g: Group) => [plural(g.people.length, "person").replace("persons", "people"), g.agents.length ? plural(g.agents.length, "agent") : ""].filter(Boolean).join(", ");
const mark = (w: Who) => markRef(w.kind === "agent" ? "agent" : "person", w.name);
const Lead = ({ w }: { w: Who }) => (w.kind === "group" ? <IconTile name="users" /> : <Avatar of={mark(w)} size={32} />);

/** One grantee row: who, what they hold, and the level menu. An agent has one level and says why. */
function ShareRow({ w, level, onLevel, onRemove, fixed }: { w: Who; level: Level; onLevel: (l: Level) => void; onRemove: () => void; fixed?: Level[] }) {
  const phone = usePhone();
  const allowed = w.kind === "agent" ? (["use"] as Level[]) : fixed ?? (LEVELS.map((l) => l[0]) as Level[]);
  const seg = <Segmented<Level> label={`${w.name}'s access`} fill={phone} options={allowed.map((l) => [l, word(l)] as [Level, string])} value={level} onChange={onLevel} />;
  const sub = w.kind === "agent" ? "Agent. Fills in without ever seeing it" : LEVEL_HELP[level];
  const remove = <Button kind="ghost" size="sm" label="Remove" onPress={onRemove} />;
  if (allowed.length === 1) return <Row dense lead={<Lead w={w} />} title={w.name} sub={sub} end={<View className="flex-row items-center gap-s2"><Chip>{word(allowed[0])}</Chip>{remove}</View>} />;
  if (phone) return <View><Row dense lead={<Lead w={w} />} title={w.name} sub={sub} end={remove} /><View className="px-s3 pb-s2">{seg}</View></View>;
  return <Row dense lead={<Lead w={w} />} title={w.name} sub={sub} end={<View className="flex-row items-center gap-s2">{seg}{remove}</View>} />;
}

/** The share sheet: who has it, then people, groups and agents to add. `title` is the thing shared; `everyone` adds the Space-wide row for a whole vault. */
function ShareSheet({ open, onClose, title, shares, setShares, groups, everyone, levels }: {
  open: boolean; onClose: () => void; title: string; shares: Share[]; setShares: (f: (s: Share[]) => Share[]) => void; groups: Group[]; everyone?: boolean; levels?: Level[];
}) {
  const [q, setQ] = useState("");
  const has = new Set(shares.map((s) => s.id));
  const pool = useMemo(() => {
    const all: Who[] = [...PEOPLE, ...groups.map((g) => whoOf(g.id, groups)!), ...(everyone ? [whoOf("everyone", groups)!] : []), ...AGENTS];
    return all.filter((w) => !has.has(w.id) && (!q || w.name.toLowerCase().includes(q.toLowerCase())));
  }, [q, shares, groups, everyone]);
  const add = (w: Who) => { setShares((s) => [...s, { id: w.id, level: "use" }]); showToast(`${w.name} can now fill in ${title}.`); };
  const section = (label: string, kind: Kind, note?: string) => {
    const xs = pool.filter((w) => w.kind === kind);
    if (!xs.length) return null;
    return (
      <Sec title={label}>
        <Card flush>{xs.map((w) => <Row key={w.id} dense lead={<Lead w={w} />} title={w.name} sub={w.sub} end={<Button kind="secondary" size="sm" icon="plus" label="Add" onPress={() => add(w)} />} />)}</Card>
        {note ? <Footnote icon="info">{note}</Footnote> : null}
      </Sec>
    );
  };
  return (
    <Sheet open={open} onClose={onClose} title={`Share ${title}`}>
      <View className="gap-s4">
        <Sec title="Who has it">
          {shares.length ? (
            <Card flush>{shares.map((s) => { const w = whoOf(s.id, groups)!; return <ShareRow key={s.id} w={w} level={s.level} fixed={levels}
              onLevel={(l) => setShares((xs) => xs.map((x) => (x.id === s.id ? { ...x, level: l } : x)))} onRemove={() => { setShares((xs) => xs.filter((x) => x.id !== s.id)); showToast(`${w.name} no longer has ${title}.`); }} />; })}</Card>
          ) : <Text tone="muted">Only you. Nobody else can use this until you give access.</Text>}
        </Sec>
        <Field name="Find a person, group or agent" value={q} onChangeText={setQ} placeholder="Search" />
        {section("People", "person")}
        {section("Groups", "group")}
        {section("Agents", "agent", "Agents can only fill in. They use it without ever seeing the value, and every use is logged.")}
        <Footnote icon="shield">Anything an agent sends, pays or deletes still waits for a yes. You can take access back at any time.</Footnote>
        <View className="flex-row gap-s2"><Button kind="primary" label="Done" onPress={onClose} /></View>
      </View>
    </Sheet>
  );
}

const TONE = { ok: "ok", warn: "warn", err: "err", plain: "plain" } as const;
type Item = { id: string; name: string; sub: string; group: "Apps" | "Logins" | "Keys"; app?: { account: string; how: string; state: "ok" | "warn" | "err"; stateWord: string }; shares: Share[] };
const ITEMS0: Item[] = [
  { id: "clio", name: "Clio", sub: "alex@riverafirm.example", group: "Apps", app: { account: "alex@riverafirm.example", how: "You connected it", state: "ok", stateWord: "Connected" }, shares: [{ id: "kit", level: "use" }] },
  { id: "google", name: "Google Workspace", sub: "Acts as alex@riverafirm.example", group: "Apps", app: { account: "alex@riverafirm.example", how: "Provided by the firm key. Only your own mailbox, calendar and Drive", state: "ok", stateWord: "Provisioned" }, shares: [] },
  { id: "notion", name: "Notion", sub: "Rivera Law workspace", group: "Apps", app: { account: "Rivera Law", how: "You connected it", state: "warn", stateWord: "Connect again" }, shares: [] },
  { id: "gmail", name: "Gmail", sub: "intake@riverafirm.example", group: "Logins", shares: [{ id: "billing", level: "use" }, { id: "chris", level: "reveal" }] },
  { id: "stripe", name: "Stripe (read only)", sub: "rk_live_...", group: "Keys", shares: [{ id: "kit", level: "use" }] },
  { id: "resend", name: "Resend", sub: "Email sending", group: "Keys", shares: [] },
];

function ItemsPart({ groups, first }: { groups: Group[]; first?: string }) {
  const [items, setItems] = useState(ITEMS0);
  const [sel, setSel] = useState(first === "stripe" || first === "gmail" ? first : "clio");
  const [open, setOpen] = useState(first === "share" || first === "stripe" || first === "gmail");
  const cur = items.find((i) => i.id === sel)!;
  const set = (f: (s: Share[]) => Share[]) => setItems((xs) => xs.map((i) => (i.id === sel ? { ...i, shares: f(i.shares) } : i)));
  const row = (i: Item) => (
    <Row key={i.id} dense selected={i.id === sel} onPress={() => setSel(i.id)} lead={<IconTile name={i.group === "Apps" ? "link" : i.group === "Logins" ? "key" : "vault"} />} title={i.name} sub={i.sub}
      end={i.app ? <Chip tone={TONE[i.app.state]}>{i.app.stateWord}</Chip> : i.shares.length ? <AvatarStack of={i.shares.map((s) => mark(whoOf(s.id, groups)!))} size={24} /> : undefined} />
  );
  const isApp = Boolean(cur.app);
  return (
    <View className="flex-row items-start gap-s4">
      <View className="min-w-0 flex-1 gap-s4">
        {(["Apps", "Logins", "Keys"] as const).map((g) => (
          <Sec key={g} title={g === "Apps" ? "Apps you connected" : g}>
            <Card flush>{items.filter((i) => i.group === g).map(row)}</Card>
          </Sec>
        ))}
        <Button kind="secondary" size="sm" icon="plus" label="Connect an app" onPress={() => showToast("Connect lists the apps you can connect with one click.")} />
      </View>
      <View className="min-w-pane min-w-0 flex-[1.2]">
        <Card>
          <View className="gap-s4">
            <View className="gap-s1">
              <View className="flex-row flex-wrap items-center gap-s2"><Text size="title" strong>{cur.name}</Text>{cur.app ? <Chip tone={TONE[cur.app.state]}>{cur.app.stateWord}</Chip> : null}</View>
              <Text tone="label">{cur.sub}</Text>
            </View>
            {cur.app ? (
              <Sec title="The connection">
                <Card flush>
                  <Row dense title="Account" sub={cur.app.account} />
                  <Row dense title="How it got here" sub={cur.app.how} />
                  <Row dense title="Token" sub="Kept in the Vault. Nobody sees it, and no agent or tool is given it." />
                </Card>
                <View className="flex-row gap-s2 pt-s2"><Button kind="secondary" size="sm" label={cur.app.state === "warn" ? "Connect again" : "Reconnect"} onPress={() => showToast("Opens the app's own sign-in.")} /><Button kind="ghost" size="sm" label="Disconnect" /></View>
              </Sec>
            ) : (
              <View className="gap-s2 rounded-card border border-edge bg-surface-3 p-s3"><Text size="caption" strong tone="label">The value</Text><Text tone="muted">Hidden until you reveal it.</Text></View>
            )}
            <Sec title={isApp ? "Who can use it" : "Who has it"}>
              {cur.shares.length ? (
                <Card flush>{cur.shares.map((s) => { const w = whoOf(s.id, groups)!; return <ShareRow key={s.id} w={w} level={s.level} fixed={isApp ? ["use"] : undefined}
                  onLevel={(l) => set((xs) => xs.map((x) => (x.id === s.id ? { ...x, level: l } : x)))} onRemove={() => set((xs) => xs.filter((x) => x.id !== s.id))} />; })}</Card>
              ) : <Text tone="muted">Only you.</Text>}
              <View className="flex-row gap-s2 pt-s2"><Button kind="secondary" size="sm" icon="share" label="Share" onPress={() => setOpen(true)} /></View>
              {isApp ? <Footnote icon="shield">Their agent can act in {cur.name} as you, and only fill in. Anything that sends or changes data still waits for your yes.</Footnote> : null}
            </Sec>
          </View>
        </Card>
      </View>
      <ShareSheet open={open} onClose={() => setOpen(false)} title={cur.name} shares={cur.shares} setShares={set} groups={groups} levels={isApp ? ["use"] : undefined} />
    </View>
  );
}

/** Groups in People and roles: named sets of people and agents. */
function GroupsPart({ groups, setGroups, first }: { groups: Group[]; setGroups: (f: (g: Group[]) => Group[]) => void; first?: string }) {
  const start = first === "edit" ? groups[0] : first === "new" ? { id: "", name: "", people: [], agents: [] } : null;
  const [edit, setEdit] = useState<Group | null>(start);
  const [name, setName] = useState(start?.name ?? "");
  const [people, setPeople] = useState<string[]>(start?.people ?? []);
  const [agents, setAgents] = useState<string[]>(start?.agents ?? []);
  const open = (g: Group | null) => { setEdit(g ?? { id: "", name: "", people: [], agents: [] }); setName(g?.name ?? ""); setPeople(g?.people ?? []); setAgents(g?.agents ?? []); };
  const toggle = (xs: string[], id: string) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]);
  const save = () => {
    if (!edit) return;
    const g: Group = { id: edit.id || name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-"), name: name.trim(), people, agents };
    setGroups((xs) => (edit.id ? xs.map((x) => (x.id === edit.id ? g : x)) : [...xs, g]));
    showToast(edit.id ? `${g.name} saved.` : `${g.name} made.`); setEdit(null);
  };
  return (
    <View className="gap-s4">
      <Segmented<string> label="People and roles" options={[["people", "People"], ["groups", "Groups"], ["roles", "Roles"]]} value="groups" />
      <Footnote icon="info">A group is a set of people and agents you can give things to at once: a vault, a Flow, later a chat or a project. People in a group keep their own role. An agent in a group can use what it is given and never see a value.</Footnote>
      {groups.length ? (
        <Card flush>{groups.map((g) => (
          <Row key={g.id} lead={<IconTile name="users" />} title={g.name} sub={groupSub(g)}
            end={<View className="flex-row items-center gap-s3"><AvatarStack of={[...g.people, ...g.agents].map((id) => mark(whoOf(id, groups)!))} size={28} /><Button kind="ghost" size="sm" label="Edit" onPress={() => open(g)} /></View>} />
        ))}</Card>
      ) : <EmptyState title="No groups yet" body="Make a group, like Billing, to give a vault to several people and agents at once." />}
      <View className="self-start"><Button kind="secondary" size="sm" icon="plus" label="New group" onPress={() => open(null)} /></View>
      <Sheet open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? `Edit ${edit.name}` : "New group"}>
        <View className="gap-s4">
          <Field name="Group name" value={name} onChangeText={setName} placeholder="Billing" />
          <Sec title="People"><View className="flex-row flex-wrap gap-s2">{PEOPLE.map((p) => <Chip key={p.id} selected={people.includes(p.id)} onPress={() => setPeople((xs) => toggle(xs, p.id))}>{p.name}</Chip>)}</View></Sec>
          <Sec title="Agents"><View className="flex-row flex-wrap gap-s2">{AGENTS.map((a) => <Chip key={a.id} selected={agents.includes(a.id)} onPress={() => setAgents((xs) => toggle(xs, a.id))}>{a.name}</Chip>)}</View></Sec>
          <View className="flex-row gap-s2"><Button kind="primary" label="Save" onPress={save} /><Button kind="ghost" label="Cancel" onPress={() => setEdit(null)} />{edit?.id ? <Button kind="danger" label="Remove group" onPress={() => { setGroups((xs) => xs.filter((x) => x.id !== edit.id)); setEdit(null); showToast("Group removed. What was shared with it reaches no one."); }} /> : null}</View>
        </View>
      </Sheet>
    </View>
  );
}

type Vlt = { id: string; name: string; sub: string; count: number; shares: Share[]; mine?: boolean };
const VAULTS0: Vlt[] = [
  { id: "mine", name: "Personal", sub: "Only you can open it", count: 7, shares: [], mine: true },
  { id: "space", name: "Rivera Law keys", sub: "The firm's own keys and logins", count: 24, shares: [{ id: "everyone", level: "use" }] },
  { id: "acme", name: "Acme Co. (client)", sub: "Everything for this client, apart from the rest", count: 9, shares: [{ id: "billing", level: "use" }, { id: "dana", level: "edit" }] },
  { id: "marketing", name: "Marketing", sub: "Ad accounts and email sending", count: 12, shares: [{ id: "marketing", level: "reveal" }, { id: "juno", level: "use" }] },
];

function VaultsPart({ groups, first }: { groups: Group[]; first?: string }) {
  const [vs, setVs] = useState(VAULTS0);
  const [open, setOpen] = useState<string | null>(first === "share" ? "acme" : null);
  const [making, setMaking] = useState(first === "new");
  const [name, setName] = useState("");
  const [start, setStart] = useState("me");
  const cur = vs.find((v) => v.id === open);
  const setShares = (f: (s: Share[]) => Share[]) => setVs((xs) => xs.map((v) => (v.id === open ? { ...v, shares: f(v.shares) } : v)));
  const make = () => {
    const id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
    setVs((xs) => [...xs, { id, name: name.trim(), sub: "Made just now", count: 0, shares: start === "all" ? [{ id: "everyone", level: "use" }] : [] }]);
    showToast(`${name.trim()} made.`); setMaking(false); setName(""); setStart("me");
  };
  return (
    <View className="gap-s4">
      <Footnote icon="shield">Each vault is kept apart: your own things and a client's things never sit in one place. Share a whole vault, and everyone you pick can use what is in it. Point a project at a vault and its agents use the keys without seeing them.</Footnote>
      <View className="flex-row flex-wrap gap-s3">
        {vs.map((v) => (
          <View key={v.id} className="min-w-pane flex-1">
            <Card>
              <View className="gap-s3">
                <View className="flex-row items-center gap-s3"><IconTile name={v.mine ? "lock" : "vault"} size={40} /><View className="min-w-0 flex-1"><Text size="title" strong>{v.name}</Text><Text tone="label">{v.sub}</Text></View></View>
                <View className="flex-row items-center justify-between gap-s2">
                  <Text tone="label">{plural(v.count, "item")}</Text>
                  {v.shares.some((s) => s.id === "everyone") ? <Chip>Everyone in the Space</Chip> : v.shares.length ? <AvatarStack of={v.shares.map((s) => mark(whoOf(s.id, groups)!))} size={24} /> : <Text tone="label">Only you</Text>}
                </View>
                <View className="flex-row gap-s2">
                  <Button kind="secondary" size="sm" label="Open" onPress={() => showToast(`${v.name} lists its items here.`)} />
                  {v.mine ? null : <Button kind="secondary" size="sm" icon="share" label="Share vault" onPress={() => setOpen(v.id)} />}
                </View>
              </View>
            </Card>
          </View>
        ))}
      </View>
      <View className="self-start"><Button kind="secondary" size="sm" icon="plus" label="New vault" onPress={() => setMaking(true)} /></View>
      {cur ? <ShareSheet open title={cur.name} onClose={() => setOpen(null)} shares={cur.shares} setShares={setShares} groups={groups} everyone /> : null}
      <Sheet open={making} onClose={() => setMaking(false)} title="New vault">
        <View className="gap-s4">
          <Field name="Vault name" value={name} onChangeText={setName} placeholder="Acme Co. (client)" />
          <Segmented<string> label="Who starts with access" options={[["me", "Only me"], ["all", "Everyone in the Space"]]} value={start} onChange={setStart} />
          <Text tone="label">You can share it with people, groups and agents afterwards, one at a time or all at once.</Text>
          <View className="flex-row gap-s2"><Button kind="primary" label="Make vault" onPress={make} disabled={!name.trim()} /><Button kind="ghost" label="Cancel" onPress={() => setMaking(false)} /></View>
        </View>
      </Sheet>
    </View>
  );
}

const PARTS = [["items", "Items and apps"], ["groups", "Groups"], ["vaults", "Vaults"]] as const;
export default function ShareDesign({ part: first = "items", open: firstOpen }: { part?: string; open?: string }) {
  const [part, setPart] = useState<string>(first);
  const [groups, setGroups] = useState(GROUPS0);
  return (
    <Frame title={part === "groups" ? "Groups" : part === "vaults" ? "Vaults" : "Vault"} sub="Design preview in the sample world. Nothing is stored or sent." actions={<Chip tone="warn">Preview</Chip>}>
      <Segmented<string> label="Preview part" options={PARTS.map((p) => [p[0], p[1]] as [string, string])} value={part} onChange={setPart} />
      {part === "groups" ? <GroupsPart groups={groups} setGroups={setGroups} first={firstOpen} /> : part === "vaults" ? <VaultsPart groups={groups} first={firstOpen} /> : <ItemsPart groups={groups} first={firstOpen} />}
    </Frame>
  );
}
