// DESIGN PREVIEW ONLY (team/0.6/PROPOSAL-vault-connections.md, V9): the Vault's sharing screens in the sample world, for the owner to approve before anything is wired. Nothing here reads or stores a
// value. The parts: items with app connections beside them, the share sheet (people, groups and agents at Fill in, Read, Edit and rotate), the Groups page of People and roles, and named vaults.
import { useState } from "react";
import { View } from "react-native";
import { Avatar, AvatarStack, Button, Card, Chip, EmptyState, Field, IconTile, Row, Segmented, Sheet, Text, markRef, showToast } from "@vyre/ui";
import { Footnote, Frame, Sec } from "../places/Frame";
import { ShareRow, ShareSheet, type Share, type Who } from "./ShareSheet";
import { GroupsPanel } from "./GroupsPanel";
import { connectionNote, nameOf } from "./share-model.js";

import { ME, PEOPLE, AGENTS, GROUPS0, dirOf } from "./share-sample";
const mark = (w: Who) => markRef(w.kind === "agent" ? "agent" : "person", w.name);
const whoOf = (id: string, groups: Who[]): Who => [...PEOPLE, ...AGENTS, ...groups].find((w) => w.id === id) ?? { id, kind: "group", name: nameOf(id, dirOf(groups)) };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
type Group = Who;

const TONE = { ok: "ok", warn: "warn", err: "err", plain: "plain" } as const;
type Item = { id: string; name: string; sub: string; group: "Apps" | "Logins" | "Keys"; app?: { account: string; how: string; state: "ok" | "warn" | "err"; stateWord: string }; shares: Share[] };
const ITEMS0: Item[] = [
  { id: "clio", name: "Clio", sub: "alex@juniperstudio.example.com", group: "Apps", app: { account: "alex@juniperstudio.example.com", how: "You connected it", state: "ok", stateWord: "Connected" }, shares: [{ id: "kit", level: "use" }] },
  { id: "google", name: "Google Workspace", sub: "Acts as alex@juniperstudio.example.com", group: "Apps", app: { account: "alex@juniperstudio.example.com", how: "Provided by the firm key. Only your own mailbox, calendar and Drive", state: "ok", stateWord: "Provisioned" }, shares: [] },
  { id: "notion", name: "Notion", sub: "Juniper Studio workspace", group: "Apps", app: { account: "Juniper Studio", how: "You connected it", state: "warn", stateWord: "Connect again" }, shares: [] },
  { id: "gmail", name: "Gmail", sub: "intake@juniperstudio.example.com", group: "Logins", shares: [{ id: "billing", level: "use" }, { id: "chris", level: "reveal" }, { id: "kit", level: "use" }] },
  { id: "stripe", name: "Stripe (read only)", sub: "rk_live_...", group: "Keys", shares: [{ id: "kit", level: "use" }] },
  { id: "resend", name: "Resend", sub: "Email sending", group: "Keys", shares: [] },
];

function ItemsPart({ groups, first }: { groups: Who[]; first?: string }) {
  const [items, setItems] = useState(ITEMS0);
  const [sel, setSel] = useState(first === "stripe" || first === "gmail" ? first : "clio");
  const [open, setOpen] = useState(first === "share" || first === "stripe" || first === "gmail");
  const cur = items.find((i) => i.id === sel)!;
  const dir = dirOf(groups);
  const set = (f: (s: Share[]) => Share[]) => setItems((xs) => xs.map((i) => (i.id === sel ? { ...i, shares: f(i.shares) } : i)));
  const row = (i: Item) => (
    <Row key={i.id} dense selected={i.id === sel} onPress={() => setSel(i.id)} lead={<IconTile name={i.group === "Apps" ? "link" : i.group === "Logins" ? "key" : "vault"} />} title={i.name} sub={i.sub}
      end={i.app ? <Chip tone={TONE[i.app.state]}>{i.app.stateWord}</Chip> : i.shares.length ? <AvatarStack of={i.shares.map((s) => mark(whoOf(s.id, groups)))} size={24} /> : undefined} />
  );
  const isApp = Boolean(cur.app);
  return (
    <View className="flex-row items-start gap-s4">
      <View className="min-w-0 flex-1 gap-s4">
        {(["Apps", "Logins", "Keys"] as const).map((g) => (
          <Sec key={g} title={g === "Apps" ? "Apps you connected" : g}><Card flush>{items.filter((i) => i.group === g).map(row)}</Card></Sec>
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
                <Card flush>{cur.shares.map((s) => <ShareRow key={s.id} w={whoOf(s.id, groups)} level={s.level} connection={isApp}
                  onLevel={(l) => set((xs) => xs.map((x) => (x.id === s.id ? { ...x, level: l } : x)))} onRemove={() => set((xs) => xs.filter((x) => x.id !== s.id))} />)}</Card>
              ) : <Text tone="muted">Only you.</Text>}
              <View className="flex-row gap-s2 pt-s2"><Button kind="secondary" size="sm" icon="share" label="Share" onPress={() => setOpen(true)} /></View>
              {isApp ? <Footnote icon="shield">{connectionNote(cur.name, cur.shares, AGENTS)}</Footnote> : null}
            </Sec>
          </View>
        </Card>
      </View>
      <ShareSheet open={open} onClose={() => setOpen(false)} title={cur.name} shares={cur.shares} dir={dir} me={ME} connection={isApp} login={!isApp && cur.group === "Logins"}
        onAdd={(w) => set((xs) => [...xs, { id: w.id, level: "use" }])} onLevel={(id, l) => set((xs) => xs.map((x) => (x.id === id ? { ...x, level: l } : x)))} onRemove={(id) => set((xs) => xs.filter((x) => x.id !== id))} />
    </View>
  );
}

function GroupsPart({ groups, setGroups, first }: { groups: Who[]; setGroups: (f: (g: Who[]) => Who[]) => void; first?: string }) {
  return (
    <View className="gap-s4">
      <Segmented<string> label="People and roles" options={[["people", "People"], ["groups", "Groups"], ["roles", "Roles"]]} value="groups" />
      <GroupsPanel groups={groups} people={PEOPLE} agents={AGENTS} startEditing={first === "edit" ? "edit" : first === "new" ? "new" : undefined}
        onSave={(g) => { setGroups((xs) => (g.id ? xs.map((x) => (x.id === g.id ? { ...x, ...g } : x)) : [...xs, { id: g.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), kind: "group", name: g.name, people: g.people, agents: g.agents }])); showToast(`${g.name} saved.`); }}
        onRemove={(id) => { setGroups((xs) => xs.filter((x) => x.id !== id)); showToast("Group removed. What was shared with it reaches no one."); }} />
    </View>
  );
}

type Vlt = { id: string; name: string; sub: string; count: number; shares: Share[]; mine?: boolean };
const VAULTS0: Vlt[] = [
  { id: "mine", name: "Personal", sub: "Only you can open it", count: 7, shares: [], mine: true },
  { id: "space", name: "Juniper Studio keys", sub: "The studio's own keys and logins", count: 24, shares: [{ id: "everyone", level: "use" }] },
  { id: "acme", name: "Northwind Bakery (client)", sub: "Everything for this client, apart from the rest", count: 9, shares: [{ id: "billing", level: "use" }, { id: "dana", level: "edit" }] },
  { id: "marketing", name: "Marketing", sub: "Ad accounts and email sending", count: 12, shares: [{ id: "marketing", level: "reveal" }, { id: "juno", level: "use" }] },
];

function VaultsPart({ groups, first }: { groups: Who[]; first?: string }) {
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
                  {v.shares.some((s) => s.id === "everyone") ? <Chip>Everyone in the Space</Chip> : v.shares.length ? <AvatarStack of={v.shares.map((s) => mark(whoOf(s.id, groups)))} size={24} /> : <Text tone="label">Only you</Text>}
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
      {cur ? <ShareSheet open title={cur.name} onClose={() => setOpen(null)} shares={cur.shares} dir={dirOf(groups)} me={ME} everyone
        onAdd={(w) => setShares((xs) => [...xs, { id: w.id, level: "use" }])} onLevel={(id, l) => setShares((xs) => xs.map((x) => (x.id === id ? { ...x, level: l } : x)))} onRemove={(id) => setShares((xs) => xs.filter((x) => x.id !== id))} /> : null}
      <Sheet open={making} onClose={() => setMaking(false)} title="New vault">
        <View className="gap-s4">
          <Field name="Vault name" value={name} onChangeText={setName} placeholder="Northwind Bakery (client)" />
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
