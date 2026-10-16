// Drive from the real vyred: the box's offered folders (files.drive.status), browsed a page at a time (files.drive.list), and a text file opened
// from its first chunk (files.drive.read). The box refuses secrets and anything outside a share; a refusal reads as "not available".
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Banner, Button, Card, Chip, Divider, EmptyState, IconTile, Row, SectionLabel, Sheet, Tabs, Text, ErrorState, LoadingState } from "@vyre/ui";
import { Frame } from "../places/Frame";
import { driveRefusal, entryLine, crumbs, isText, join, bytesOf, sizeWord, textOf, type Chunk, type Entry, type Listing, type Status } from "./real-model";
import { listReal, readReal, statusReal } from "./real";
import { SpaceDrive } from "./SpaceDrive";
import { Breadcrumb } from "./Breadcrumb";
import { SharedLinks } from "./SharedLinks";
import { LinkedFiles } from "./LinkedFiles";
import { SharedArtifacts } from "../chat-tools";
import { REAL_TABS } from "./tabs.js";
import { PlaceTag } from "../../src/real/PlaceTag";
import { usePlaceText } from "../../src/real/PlaceTag";
import { SpaceTag } from "@vyre/ui";

type Tab = "space" | "shared" | "linked" | "files";
const ROOT_ICON: Record<string, string> = { space: "drive", shared: "share", linked: "link", files: "server" };
const ROOT_SUB: Record<string, string> = { space: "The space's files, with their versions", shared: "Links you made, and what agents made for you", linked: "Live folders from Google Drive", files: "Folders your server offers" };
const say = (e: unknown) => driveRefusal((e as { code?: string }).code, e instanceof Error ? e.message : "");

export default function RealDrive() {
  const router = useRouter();
  const driveTag = usePlaceText("home");
  const [tab, setTab] = useState<Tab | null>(null);
  const [made, setMade] = useState(0);
  const [status, setStatus] = useState<Status | null>(null);
  const [share, setShare] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [list, setList] = useState<Listing | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<{ e: Entry; text: string | null; note: string } | null>(null);

  useEffect(() => { statusReal().then((s) => { setStatus(s); setShare((cur) => cur ?? s.shares[0]?.name ?? null); }).catch((e) => setErr(say(e))); }, []);

  const load = useCallback((sh: string, p: string, offset = 0) => {
    setErr("");
    listReal(sh, p, offset).then((l) => { setList(l); setEntries((xs) => (offset ? [...xs, ...l.entries] : l.entries)); }).catch((e) => { setErr(say(e)); setList(null); setEntries([]); });
  }, []);
  useEffect(() => { if (share) { setEntries([]); load(share, path); } }, [share, path, load]);

  const show = (e: Entry) => {
    if (!share) return;
    if (e.dir) { setPath(join(path, e.name)); return; }
    if (!isText(e)) { setOpen({ e, text: null, note: `${e.kind || "File"}, ${sizeWord(e.size)}. Opening this kind of file is not in the app yet.` }); return; }
    readReal(share, join(path, e.name))
      .then((c: Chunk) => setOpen({ e, text: textOf(bytesOf(c.base64)), note: c.done ? "" : `The first part of ${sizeWord(c.size)}.` }))
      .catch((x) => setOpen({ e, text: null, note: say(x) }));
  };

  const files = (
    <>
      {!status && !err ? <LoadingState rows={3} /> : null}
      {status && !status.shares.length ? <Card><EmptyState title="No folders offered" body="Your home has not offered a folder to the app yet." /></Card> : null}
      {status && status.shares.length > 1 ? (
        <View className="flex-row flex-wrap gap-s2">
          {status.shares.map((s) => <Chip key={s.name} selected={share === s.name} onPress={() => { setShare(s.name); setPath(""); }}>{s.name}</Chip>)}
        </View>
      ) : null}
      {share ? (
        <Breadcrumb crumbs={crumbs(share, path).map((c) => ({ name: c.name, key: c.path }))} onPress={setPath} />
      ) : null}
      {err ? <Card flush><ErrorState title="Files did not load" reason={err} retry={() => (share ? load(share, path) : statusReal().then(setStatus).catch((e) => setErr(say(e))))} /></Card> : null}
      {!err && share && list === null ? <LoadingState rows={3} /> : null}
      {!err && list ? (
        <Card flush>
          {entries.length ? entries.map((e, i) => (
            <View key={e.name}>{i ? <Divider inset={60} /> : null}
              <Row dense chevron={e.dir} lead={<IconTile name={e.dir ? "folder" : "file"} />} title={e.name} sub={entryLine(e)} end={driveTag ? <SpaceTag text={driveTag} /> : undefined} onPress={() => show(e)} />
            </View>
          )) : <EmptyState title="Nothing here yet" body="This folder is empty, or everything in it is kept away from the app." />}
          {list.next != null ? <View className="p-s3"><Button kind="ghost" size="sm" label={`Show more (${entries.length} of ${list.total})`} onPress={() => share && load(share, path, list.next)} /></View> : null}
        </Card>
      ) : null}
    </>
  );

  return (
    <Frame title="Files" sub="The space's files with their versions, and the box's own folders." actions={<Button kind="secondary" size="sm" icon="file" label="Documents" onPress={() => router.push("/u/documents" as never)} />}>
      <PlaceTag of="home" />
      {tab === null ? (
        <Card flush>
          {(REAL_TABS as unknown as [Tab, string][]).map(([id, label], i) => (
            <View key={id}>{i ? <Divider inset={60} /> : null}<Row chevron lead={<IconTile name={ROOT_ICON[id] as never} />} title={label} sub={ROOT_SUB[id]} onPress={() => setTab(id)} /></View>
          ))}
        </Card>
      ) : <Breadcrumb crumbs={[{ name: "Files", key: "" }, { name: (REAL_TABS as unknown as [Tab, string][]).find((t) => t[0] === tab)?.[1] ?? "", key: tab }]} onPress={() => setTab(null)} />}
      {tab === null ? null : tab === "space" ? <SpaceDrive onLink={() => { setMade((n) => n + 1); setTab("shared"); }} /> : tab === "shared" ? <View className="gap-s3"><SectionLabel first>Links to files</SectionLabel><SharedLinks refresh={made} /><SectionLabel>Made for you</SectionLabel><SharedArtifacts /></View> : tab === "linked" ? <LinkedFiles /> : files}
      <Sheet open={!!open} onClose={() => setOpen(null)} title={open?.e.name}>
        {open ? (
          <View className="gap-s2">
            {open.text != null ? <Text mono size="caption" selectable>{open.text}</Text> : null}
            {open.note ? <Banner><Text>{open.note}</Text></Banner> : null}
          </View>
        ) : null}
      </Sheet>
    </Frame>
  );
}
