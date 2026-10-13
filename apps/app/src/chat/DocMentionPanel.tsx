// The @ and # picker of the instructions editor (agents and projects), the chat composer's own: the same nested trees (mention-tree.js, fetched by useMentionNodes), the same list (PickerList), the same keys
// (nest-model.js). A pick is written into the words as "@Sam" or "#Doe estate" and its address is handed to the editor (`remember`), which stores the pair as a markdown link to the vyre:// address
// (lib/doc-refs.js). The editor shows only the name, the preview a chip. The composer sends a pick beside the message; a document keeps it in the text, so this is the one place the two differ.
import { useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { Chip, Icon, PickerList, allowsMock, titleOf, useRecordsWorld, type AssistProps, type PickerItem } from "@vyre/ui";
import { moveActive } from "@vyre/ui/lib/picker-model.js";
import { crumbsOf, nestHint, nestKey, nestRows, nestStep, type NestRow } from "@vyre/ui/lib/nest-model.js";
import { refUrn } from "../../../../lib/doc-refs.js";
import { agentsList } from "../../screens/settings/real";
import { tool } from "../real/box";
import { nestIcon } from "./ChatComposer";
import { Face } from "./Face";
import { sealedChip, triggerAt } from "./composer-model.js";
import { peopleFor, recordPicks } from "./real-composer.js";
import { useMentionNodes } from "./useMentionNodes";
import { useVyreFiles } from "./useVyreFiles";

const POP_ID = "doc-mention-pop";
const noop = async () => {};

export function DocMentionPanel(p: AssistProps) {
  const trigRaw = useMemo(() => triggerAt(p.text, p.caret), [p.text, p.caret]);
  const [dismissed, setDismissed] = useState<number | null>(null);
  useEffect(() => { if (!trigRaw) setDismissed(null); }, [trigRaw]);
  const trig = trigRaw && trigRaw.kind !== "command" && trigRaw.range.start !== dismissed ? trigRaw : null;
  const trigId = trig ? `${trig.kind}:${trig.range.start}` : null;
  const [nestPath, setNestPath] = useState<string[]>([]);
  const [active, setActive] = useState(0);
  const wantActive = useRef<number | null>(null);
  useEffect(() => { setNestPath([]); }, [trigId]);
  const [seen, setSeen] = useState(false);
  useEffect(() => { if (trigId) setSeen(true); }, [trigId]);

  // What the box offers, read the first time a trigger opens: the Space's people and agents, its records and its files, and its name for the addresses.
  const { data: world } = useRecordsWorld();
  const [actors, setActors] = useState<unknown>(null);
  const [agents, setAgents] = useState<unknown>(null);
  const [space, setSpace] = useState("space");
  useEffect(() => {
    if (!seen || allowsMock()) return;
    let live = true;
    void tool("records.actors", {}).then((r) => live && setActors(r)).catch(() => {});
    void agentsList().then((r) => live && setAgents(r)).catch(() => {});
    void tool("records.me", {}).then((r) => { const s = (r as { space?: string } | null)?.space; if (live && s) setSpace(String(s)); }).catch(() => {});
    return () => { live = false; };
  }, [seen]);
  const people = useMemo(() => (allowsMock() ? [{ name: "Dana Okafor", family: "person" as const }, { name: "juno", family: "assistant" as const }] : peopleFor({ actors, agents, viewer: null, here: [] })), [actors, agents]);
  const records = useMemo(() => (world ? recordPicks(world as never, (d: unknown, r: unknown) => titleOf(d as never, r as never)) : []), [world]);
  const files = useVyreFiles(noop, noop).files;
  const nodes = useMentionNodes({ wanted: seen, people: people as never, records, files, ais: [] });
  const root = trig?.kind === "person" ? nodes.at : trig?.kind === "record" ? nodes.hash : null;
  const query = trig?.range.query ?? "";
  const list = useMemo((): NestRow[] => (root && trig ? nestRows(root, nestPath, query) : []), [root, nestPath, trig, query]);
  useEffect(() => { const a = wantActive.current; wantActive.current = null; setActive(a ?? 0); }, [trig?.kind, query, nestPath]);

  const drillRow = (i: number) => {
    const r = list[i];
    if (!r?.drill || !trig) return;
    // What was typed was a search for this row: it is spent once the row is open.
    p.apply(p.text.slice(0, trig.range.start + 1) + p.text.slice(trig.range.end), trig.range.start + 1);
    setNestPath(nestStep(nestPath, "drill", r));
  };
  const goBack = () => {
    const key = nestPath[nestPath.length - 1];
    const parent = nestPath.slice(0, -1);
    wantActive.current = root ? Math.max(0, nestRows(root, parent, "").findIndex((r) => r.trail[r.trail.length - 1] === key)) : 0;
    setNestPath(parent);
  };
  const choose = (i: number) => {
    const r = list[i];
    if (!r?.pick || !trig) return;
    const lead = trig.kind === "person" ? "@" : "#";
    const kind = r.pick.kind ?? (trig.kind === "person" ? "person" : "record");
    const name = r.pick.pick;
    const word = lead + name;
    const gap = p.text.slice(trig.range.end).startsWith(" ") ? "" : " ";
    p.remember(lead, name, refUrn({ space, kind, urn: r.pick.urn, id: r.pick.id }));
    p.apply(p.text.slice(0, trig.range.start) + word + gap + p.text.slice(trig.range.end), trig.range.start + word.length + 1);
  };
  const pickRow = (i: number) => { if (list[i]?.pick) choose(i); else drillRow(i); };

  const items: PickerItem[] = list.map((r, i) => {
    const sealed = typeof r.sealed === "number" ? sealedChip({ sealed: r.sealed }) : null;
    const family = typeof r.family === "string" ? r.family : "";
    const above = r.path && r.path.includes(" › ") ? r.path.slice(0, r.path.lastIndexOf(" › ")) : undefined;
    return {
      key: r.key, label: r.label, group: r.group, sub: above ?? (typeof r.sub === "string" ? r.sub : undefined),
      leading: family ? <Face name={r.label} family={family as "person" | "assistant"} size={24} /> : <Icon name={nestIcon(r)} size={18} />,
      trailing: <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>{sealed ? <Chip tone="sealed" icon="shield">{sealed}</Chip> : null}{r.drill ? <Icon name="chev-r" size={16} tone="label" /> : null}</View>,
    };
  });
  const open = !!root && (items.length > 0 || nestPath.length > 0);

  // The editor asks this on every key: true when the picker took it.
  p.keys.current = (ev) => {
    if (!open) return false;
    const act = nestKey(ev, { query, count: items.length, depth: nestPath.length, row: list[active] });
    if (act === "next" || act === "prev") { setActive((a) => moveActive(a, act === "next" ? 1 : -1, items.length)); return true; }
    if (act === "pick") { pickRow(active); return true; }
    if (act === "drill") { drillRow(active); return true; }
    if (act === "back") { goBack(); return true; }
    if (act === "close" && ev.key === "Escape" && trig) { setDismissed(trig.range.start); return true; }
    return false;
  };

  if (!open) return null;
  const header = trig?.kind === "person" ? "Mention" : "Tag";
  const crumbs = nestPath.length && root ? [header, ...crumbsOf(root, nestPath)] : undefined;
  return (
    <View style={{ paddingHorizontal: 12, paddingVertical: 6, borderBottomWidth: 0 }}>
      <PickerList id={POP_ID} label={header} header={header} crumbs={crumbs} onCrumb={(i) => { if (i < nestPath.length) setNestPath(nestPath.slice(0, i)); }} items={items} active={active} onActive={setActive} onPick={pickRow} footer={nestHint(nestPath.length, list[active]) || "Esc closes"} maxRows={6} />
    </View>
  );
}
