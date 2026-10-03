import { useState } from "react";
import { View } from "react-native";
import { AskCard, Avatar, AvatarStack, Banner, Board, Button, Card, Chip, Divider, EmptyState, Field, ICON_NAMES, Icon, IconButton, IconTile, Menu, Row, SectionLabel, Segmented, Sheet, SpaceMark, SpaceSwitcherTitle, StageSteps, Switch, Table, Tabs, Text, TimelineItem, markRef, showToast, spaceRef } from "@vyre/ui";

const block = (title: string, children: React.ReactNode) => (
  <View className="gap-s2"><SectionLabel>{title}</SectionLabel>{children}</View>
);
const PEOPLE = ["Alex Rivera", "Chris Park", "Dana Reyes", "Mei Tanaka", "Ben Ortiz", "Marco Ruiz", "Jane Doe"];
const SIZES = [20, 24, 28, 32, 40, 44, 56] as const;
const SPACES = [spaceRef("Harlow Legal"), spaceRef("Northwind Bakery"), spaceRef("Mine", "mine", "alex-personal")];
type Matter = { id: string; title: string; client: string; stage: string; fee: string };
const MATTERS: Matter[] = [
  { id: "1", title: "Estate of Doe", client: "Jane Doe", stage: "Intake", fee: "$4,800" },
  { id: "2", title: "Northwind lease", client: "Northwind Bakery", stage: "Drafting", fee: "$2,200" },
  { id: "3", title: "Harlow trust", client: "Alex Harlow", stage: "Intake", fee: "$6,500" },
];

/** Every base component, drawn live from the tokens: the one place a change shows up for everyone. */
export function ComponentGallery() {
  const [on, setOn] = useState(true);
  const [tab, setTab] = useState("matters");
  const [sheet, setSheet] = useState(false);
  const [scope, setScope] = useState("all");
  const [items, setItems] = useState(MATTERS);
  return (
    <View className="gap-s6">
      {block("Buttons", (
        <View className="flex-row flex-wrap gap-s2">
          <Button kind="primary" label="Primary" /><Button label="Secondary" /><Button kind="ghost" label="Ghost" /><Button kind="danger" label="Danger" />
          <Button kind="hold" label="Remove Alex's Mac" /><Button kind="primary" icon="plus" label="Add" /><Button kind="ghost" icon="filter" label="Filter" /><Button label="Working" loading /><Button label="Locked" disabled />
          <IconButton icon="search" label="Search" /><IconButton icon="plus" label="Add" kind="primary" />
        </View>
      ))}
      {block("Chips", (
        <View className="flex-row flex-wrap gap-s2"><Chip>Plain</Chip><Chip tone="accent">Needs you</Chip><Chip tone="ok">Done</Chip><Chip tone="warn">Slow</Chip><Chip tone="err">Failed</Chip><Chip tone="sealed" icon="sealed">Sealed</Chip></View>
      ))}
      {block("Fields and controls", (
        <View className="gap-s3 max-w-read">
          <Field label="Name" value="Jane Doe" /><Field label="Phone" value="+1 415 555 0142" error="That number is too short." />
          <View className="flex-row items-center gap-s3"><Switch label="Notify me" on={on} onChange={setOn} /><Text>Notify me</Text></View>
          <Tabs value={tab} onChange={setTab} items={[["contacts", "Contacts"], ["matters", "Matters"], ["docs", "Documents"]]} />
        </View>
      ))}
      {block("Avatars: people, assistants, teammates, agents", (
        <View className="gap-s3">
          <View className="flex-row flex-wrap items-center gap-s3">{PEOPLE.map((n) => <Avatar key={n} of={markRef("person", n)} size={40} onPress={() => showToast(n)} />)}</View>
          <View className="flex-row flex-wrap items-center gap-s3">
            <Avatar of={markRef("assistant", "juno")} size={40} onPress={() => showToast("juno")} /><Avatar of={markRef("agent", "kit")} size={40} /><Avatar of={markRef("agent", "iris")} size={40} />
            {["Research", "Intake", "Drafting", "Reviewer"].map((n) => <Avatar key={n} of={markRef("teammate", n, `${n.toLowerCase()}-harlow`)} size={40} />)}
          </View>
        </View>
      ))}
      {block("Avatars: sizes, and the space badge", (
        <View className="gap-s3">
          <View className="flex-row flex-wrap items-end gap-s3">{SIZES.map((z) => <Avatar key={z} of={markRef("person", "Alex Rivera")} size={z} space={SPACES[0]} />)}</View>
          <View className="flex-row flex-wrap items-center gap-s3"><AvatarStack of={[markRef("person", "Alex Rivera"), markRef("person", "Chris Park"), markRef("assistant", "juno"), markRef("agent", "kit"), markRef("agent", "iris")]} /><AvatarStack size={24} of={[markRef("person", "Dana Reyes"), markRef("person", "Mei Tanaka")]} /></View>
        </View>
      ))}
      {block("Emblems: projects, spaces, devices", (
        <View className="flex-row flex-wrap items-center gap-s3">
          {["Doe estate plan", "Roe succession plan", "Shah will update", "Ortiz power of attorney", "Site rebuild", "Passport renewal"].map((n) => <Avatar key={n} of={markRef("project", n)} size={44} space={SPACES[0]} />)}
          {SPACES.map((sp) => <SpaceMark key={sp.id} space={sp} size={56} />)}
          {["Alex's iPhone", "Alex's Mac", "nova", "Harlow archive"].map((n) => <Avatar key={n} of={markRef("device", n)} size={44} />)}
          <IconTile name="kits" size={44} />
        </View>
      ))}
      {block("Space switcher", <SpaceSwitcherTitle spaces={[{ id: "all", name: "All spaces" }, { id: "mine", name: "Mine" }, { id: "harlow", name: "Harlow Legal" }]} space="harlow" onSpace={(id) => showToast(`Switched to ${id}`)} />)}
      {block(`Icons, ${ICON_NAMES.length} in one family`, (
        <View className="flex-row flex-wrap gap-s3">{ICON_NAMES.map((n) => <View key={n} className="w-s12 items-center gap-s1"><Icon name={n} size={24} tone="text" /><Text size="caption" tone="label" numberOfLines={1}>{n}</Text></View>)}</View>
      ))}
      {block("Card of rows", (
        <Card title="Contacts" flush>
          <Row lead={<Avatar of={markRef("person", "Jane Doe")} />} title="Jane Doe" sub="Harlow Legal" end={<Chip tone="accent">Intake</Chip>} onPress={() => showToast("Opened Jane Doe")} />
          <Divider />
          <Row lead={<Avatar of={markRef("project", "Northwind Bakery")} />} title="Northwind Bakery" sub="Customer" onPress={() => {}} />
        </Card>
      ))}
      {block("Scope control", <Segmented label="Space" value={scope} onChange={setScope} options={[["all", "All spaces"], ["mine", "Mine"], ["harlow", "Harlow Legal"]]} />)}
      {block("Card, and the Ask hero card", (
        <View className="gap-s3">
          <Card><Text strong size="headline">A standard card</Text><Text size="secondary" tone="label">Surface two on the ground, one step up, level-one shadow, no coloured edge.</Text></Card>
          <AskCard hero lead={<Avatar of={markRef("teammate", "Intake", "intake-harlow")} size={44} space={SPACES[0]} />} title="Welcome email for Jane Doe is ready" why="Intake drafted it from Welcome, using Research's notes." actions={[{ label: "Send with Face ID", kind: "primary", onPress: () => setSheet(true) }, { label: "Edit" }]} />
        </View>
      ))}
      {block("Grouped list: one card, inset separators", (
        <Card flush>
          <Row lead={<Avatar of={markRef("person", "Marco Ruiz")} space={SPACES[1]} />} title="Marco Ruiz" sub="Reads Intake and Billing" onPress={() => {}} />
          <Divider inset={60} />
          <Row lead={<Avatar of={markRef("person", "Mei Tanaka")} />} title="Mei Tanaka" sub="Member of Harlow Legal" onPress={() => {}} />
        </Card>
      ))}
      {block("Banner", <View className="gap-s2"><Banner>Everything is up to date.</Banner><Banner tone="warn">Something to look at.</Banner><Banner tone="err">Could not reach the server.</Banner></View>)}
      {block("Stage steps", <StageSteps stages={["Intake", "Engagement", "Drafting", "Signing", "Funding", "Closed"]} current={2} />)}
      {block("Table", (
        <Table rowKey={(r: Matter) => r.id} rows={items} onRow={() => {}} columns={[
          { key: "title", label: "Matter" }, { key: "client", label: "Client" }, { key: "stage", label: "Stage", render: (r: Matter) => <Chip>{r.stage}</Chip> }, { key: "fee", label: "Fee", align: "right" },
        ]} />
      ))}
      {block("Board", (
        <Board columns={["Intake", "Drafting"].map((s) => ({ id: s, title: s }))} items={items} columnOf={(m) => m.stage} keyOf={(m) => m.id}
          onMove={(m, to) => setItems((xs) => xs.map((x) => (x.id === m.id ? { ...x, stage: to } : x)))}
          renderCard={(m) => <Card><Text strong>{m.title}</Text><Text size="caption" tone="muted">{m.client} · {m.fee}</Text></Card>} />
      ))}
      {block("Timeline", <View><TimelineItem actor="Intake" what="drafted the Welcome email" at="2 min ago" why="From Welcome, using Research's notes" /><TimelineItem actor="Research" what="added 3 facts to the project" at="4 min ago" /></View>)}
      {block("Menu", <View className="self-start"><Menu trigger={<Button label="Actions" />} items={[{ label: "Rename", onPress: () => showToast("Rename") }, { label: "Remove", danger: true, onPress: () => {} }]} /></View>)}
      {block("Empty", <Card><EmptyState title="No matters yet" body="Add one, or install a Kit." action={{ label: "Add a matter", onPress: () => {} }} /></Card>)}
      <Sheet open={sheet} onClose={() => setSheet(false)} title="Send with Face ID"><Text tone="muted">The email goes to jane@example.com.</Text><Button kind="primary" label="Approve with Face ID" onPress={() => setSheet(false)} /></Sheet>
    </View>
  );
}
