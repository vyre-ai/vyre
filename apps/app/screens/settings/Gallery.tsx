import { useState } from "react";
import { View } from "react-native";
import { AskCard, Avatar, SpaceMark, markRef, spaceRef, Banner, Board, Button, Card, Chip, Divider, EmptyState, Field, IconButton, Menu, Row, Segmented, Sheet, StageSteps, Switch, Table, Tabs, Text, TimelineItem, showToast } from "@vyre/ui";

const block = (title: string, children: React.ReactNode) => (
  <View className="gap-s2"><Text size="caption" strong tone="label">{title}</Text>{children}</View>
);
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
  const [items, setItems] = useState(MATTERS);
  return (
    <View className="gap-s6">
      {block("Buttons", (
        <View className="flex-row flex-wrap gap-s2">
          <Button kind="primary" label="Primary" /><Button label="Secondary" /><Button kind="ghost" label="Ghost" /><Button kind="danger" label="Danger" />
          <Button kind="hold" label="Remove Alex's Mac" /><Button kind="primary" icon="plus" label="Add" /><Button label="Working" loading /><Button label="Locked" disabled />
          <IconButton icon="search" label="Search" /><IconButton icon="plus" label="Add" kind="primary" />
        </View>
      ))}
      {block("Chips", (
        <View className="flex-row flex-wrap gap-s2"><Chip>Plain</Chip><Chip tone="accent">Needs you</Chip><Chip tone="ok">Done</Chip><Chip tone="warn">Slow</Chip><Chip tone="err">Failed</Chip><Chip tone="sealed" icon="vault">Sealed</Chip><Chip tone="space">Harlow Legal</Chip></View>
      ))}
      {block("Fields and controls", (
        <View className="gap-s3 max-w-read">
          <Field label="Name" value="Jane Doe" /><Field label="Phone" value="+1 415 555 0142" error="That number is too short." />
          <View className="flex-row items-center gap-s3"><Switch label="Notify me" on={on} onChange={setOn} /><Text>Notify me</Text></View>
          <Tabs value={tab} onChange={setTab} items={[["contacts", "Contacts"], ["matters", "Matters"], ["docs", "Documents"]]} />
        </View>
      ))}
      {block("Avatar", (
        <View className="flex-row items-center gap-s3"><Avatar of={markRef("person", "Alex Rivera")} /><Avatar of={markRef("assistant", "juno")} /><Avatar of={markRef("teammate", "Research", "research-harlow")} space={spaceRef("Harlow Legal")} size={40} /><SpaceMark space={spaceRef("Harlow Legal")} size={40} /></View>
      ))}
      {block("Card of rows", (
        <Card title="Contacts" flush>
          <Row lead={<Avatar of={markRef("person", "Jane Doe")} />} title="Jane Doe" sub="Harlow Legal" end={<Chip tone="accent">Intake</Chip>} onPress={() => showToast("Opened Jane Doe")} />
          <Divider />
          <Row lead={<Avatar of={markRef("project", "Northwind Bakery")} />} title="Northwind Bakery" sub="Customer" onPress={() => {}} />
        </Card>
      ))}
      {block("Ask card", (
        <AskCard lead={<Avatar of={markRef("teammate", "Intake", "intake-harlow")} size={40} />} title="Welcome email for Jane Doe is ready" why="Intake drafted it from Welcome, using Research's notes." actions={[{ label: "Send with Face ID", kind: "primary", onPress: () => setSheet(true) }, { label: "Edit" }]} />
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
