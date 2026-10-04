// Drive from the real vyred: the box's offered folders (files.drive.status), browsed a page at a time (files.drive.list), and a text file opened
// from its first chunk (files.drive.read). The box refuses secrets and anything outside a share; a refusal reads as "not available".
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Card, Chip, Divider, EmptyState, IconTile, Row, Sheet, Tabs, Text } from "@vyre/ui";
import { Frame } from "../places/Frame";
import { driveRefusal, entryLine, crumbs, isText, join, bytesOf, sizeWord, textOf, type Chunk, type Entry, type Listing, type Status } from "./real-model";
import { listReal, readReal, statusReal } from "./real";

type Tab = "files" | "sharing";
const say = (e: unknown) => driveRefusal((e as { code?: string }).code, e instanceof Error ? e.message : "");

export default function RealDrive() {
  const [tab, setTab] = useState<Tab>("files");
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
      {!status && !err ? <Card flush><EmptyState title="Loading" body="Asking your Vyre." /></Card> : null}
      {status && !status.shares.length ? <Card><EmptyState title="No folders offered" body="Your home has not offered a folder to the app yet." /></Card> : null}
      {status && status.shares.length > 1 ? (
        <View className="flex-row flex-wrap gap-s2">
          {status.shares.map((s) => <Chip key={s.name} selected={share === s.name} onPress={() => { setShare(s.name); setPath(""); }}>{s.name}</Chip>)}
        </View>
      ) : null}
      {share ? (
        <View className="flex-row flex-wrap items-center gap-s1">
          {crumbs(share, path).map((c, i, all) => (
            <View key={c.path} className="flex-row items-center">
              <Button kind="ghost" size="sm" label={c.name} disabled={i === all.length - 1} onPress={() => setPath(c.path)} />
              {i < all.length - 1 ? <Text tone="faint">/</Text> : null}
            </View>
          ))}
        </View>
      ) : null}
      {err ? <Card flush><EmptyState title="Drive did not open that" body={err} action={{ label: "Try again", onPress: () => (share ? load(share, path) : statusReal().then(setStatus).catch((e) => setErr(say(e)))) }} /></Card> : null}
      {!err && share && list === null ? <Card flush><EmptyState title="Loading" body="Asking your Vyre." /></Card> : null}
      {!err && list ? (
        <Card flush>
          {entries.length ? entries.map((e, i) => (
            <View key={e.name}>{i ? <Divider inset={60} /> : null}
              <Row dense chevron={e.dir} lead={<IconTile name={e.dir ? "drive" : "file"} />} title={e.name} sub={entryLine(e)} onPress={() => show(e)} />
            </View>
          )) : <EmptyState title="Nothing here" body="This folder is empty, or everything in it is kept away from the app." />}
          {list.next != null ? <View className="p-s3"><Button kind="ghost" size="sm" label={`Show more (${entries.length} of ${list.total})`} onPress={() => share && load(share, path, list.next)} /></View> : null}
        </Card>
      ) : null}
    </>
  );

  const sharing = status ? (
    <Card>
      <View className="gap-s3">
        <Text strong>{status.enabled ? "Sharing to your computer is on" : "Sharing to your computer is off"}</Text>
        {status.why ? <Text tone="muted">{status.why}</Text> : null}
        {status.fix ? <Text tone="label">{status.fix}</Text> : null}
        {status.shares.map((s) => <Row key={s.name} dense title={s.name} sub={`${s.access === "rw" ? "Read and write" : "Read only"}, ${s.shared ? "shared now" : "not shared now"}`} />)}
      </View>
    </Card>
  ) : <Card><EmptyState title="Loading" body="Asking your Vyre." /></Card>;

  return (
    <Frame title="Drive" sub="Folders your home shares, as it allows them.">
      <Tabs<Tab> value={tab} onChange={setTab} items={[["files", "Files"], ["sharing", "On your computer"]]} />
      {tab === "files" ? files : sharing}
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
