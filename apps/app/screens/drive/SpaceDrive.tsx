// The space's own Drive: versioned, permissioned files. Browse folders, open a file to read it and see its versions, put an older version back (the person's own act, with presence),
// and add a file from the browser (the web app; a phone has no picker in the app yet, so no Upload button there rather than a dead one).
import { useCallback, useEffect, useState } from "react";
import { Platform, View } from "react-native";
import { Banner, Button, Card, Divider, EmptyState, IconTile, Row, Sheet, Text, showToast } from "@vyre/ui";
import { bytesOf, textOf } from "./real-model";
import { children, itemLine, spaceDriveRefusal, toBase64, uploadPath, versionLine, MAX_UPLOAD, type Item, type Version } from "./space-model";
import { spaceList, spaceRead, spaceRestore, spaceUpload, spaceVersions } from "./real";

const say = (e: unknown) => spaceDriveRefusal((e as { code?: string }).code, e instanceof Error ? e.message : "");
const TEXT = /\.(txt|md|csv|json|xml|ya?ml|html?|log)$/i;

export function SpaceDrive() {
  const [prefix, setPrefix] = useState("");
  const [items, setItems] = useState<Item[] | null>(null);
  const [more, setMore] = useState(false);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<{ item: Item; versions: Version[] | null; text: string | null; note: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setErr("");
    spaceList(undefined, prefix).then((r) => { setItems(children(r.entries, prefix, r.names)); setMore(r.more); }).catch((e) => { setErr(say(e)); setItems(null); });
  }, [prefix]);
  useEffect(() => { setItems(null); load(); }, [load]);

  const show = (i: Item) => {
    if (i.dir) { setPrefix(i.path); return; }
    setOpen({ item: i, versions: null, text: null, note: "" });
    spaceVersions(undefined, i.path).then((v) => setOpen((o) => (o && o.item.path === i.path ? { ...o, versions: v } : o))).catch((e) => setOpen((o) => (o ? { ...o, versions: [], note: say(e) } : o)));
    if (TEXT.test(i.name) && i.size <= 262144) spaceRead(undefined, i.path).then((r) => setOpen((o) => (o && o.item.path === i.path ? { ...o, text: textOf(bytesOf(r.base64)) } : o))).catch(() => {});
  };
  const restore = (v: Version) => {
    if (!open) return;
    setBusy(true);
    spaceRestore(undefined, open.item.path, v.ver).then((r) => { showToast(`Version ${v.ver} is back as version ${r.version}. Nothing was lost.`); setOpen(null); load(); }).catch((e) => setOpen((o) => (o ? { ...o, note: say(e) } : o))).finally(() => setBusy(false));
  };
  const pick = () => {
    const doc = (globalThis as { document?: Document }).document;
    if (!doc) return;
    const input = doc.createElement("input");
    input.type = "file";
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return;
      const p = uploadPath(prefix, f.name);
      if ("error" in p) { showToast(p.error); return; }
      if (f.size > MAX_UPLOAD) { showToast(spaceDriveRefusal("too_large", "")); return; }
      setBusy(true);
      const existing = items?.find((x) => !x.dir && x.path === p.path);
      f.arrayBuffer().then((buf) => spaceUpload(undefined, p.path, toBase64(new Uint8Array(buf)), existing?.ver || undefined))
        .then((r) => { showToast(r.conflict ? `Saved as version ${r.version}. Someone else changed it too: both versions are kept.` : `Saved as version ${r.version}.`); load(); })
        .catch((e) => showToast(say(e))).finally(() => setBusy(false));
    };
    input.click();
  };

  const parts = prefix.split("/").filter(Boolean);
  return (
    <>
      <View className="flex-row flex-wrap items-center gap-s1">
        <Button kind="ghost" size="sm" label="Drive" onPress={() => setPrefix("")} />
        {parts.map((p, i) => <View key={p + i} className="flex-row items-center"><Text tone="faint">/</Text><Button kind="ghost" size="sm" label={p} onPress={() => setPrefix(parts.slice(0, i + 1).join("/"))} /></View>)}
        {Platform.OS === "web" ? <View className="ml-auto"><Button size="sm" kind="primary" icon="plus" label={busy ? "Sending" : "Add a file"} onPress={busy ? () => {} : pick} /></View> : null}
      </View>
      {err ? <Card flush><EmptyState title="The space's Drive did not open" body={err} action={{ label: "Try again", onPress: load }} /></Card> : null}
      {!err && items === null ? <Card flush><EmptyState title="Loading" body="Asking your Vyre." /></Card> : null}
      {!err && items ? (
        <Card flush>
          {items.length ? items.map((i, k) => (
            <View key={i.name}>{k ? <Divider inset={60} /> : null}
              <Row dense chevron={i.dir} lead={<IconTile name={i.dir ? "drive" : "file"} />} title={i.label ?? i.name} sub={itemLine(i)} onPress={() => show(i)} />
            </View>
          )) : <EmptyState title={prefix ? "Nothing here" : "The Drive is empty"} body={prefix ? "This folder has no file you may read." : "Files you add, or that assistants save, appear here with their versions."} />}
          {more ? <View className="p-s3"><Text size="caption" tone="label">This folder is large. The first files are shown.</Text></View> : null}
        </Card>
      ) : null}
      <Sheet open={!!open} onClose={() => setOpen(null)} title={open?.item.label ?? open?.item.name}>
        {open ? (
          <View className="gap-s3">
            {open.text != null ? <Text mono size="caption" selectable>{open.text}</Text> : null}
            <Text size="caption" strong tone="label">Versions</Text>
            {open.versions === null ? <Text tone="muted">Loading.</Text> : open.versions.length === 0 ? <Text tone="muted">No versions listed.</Text> : (
              <Card flush>
                {[...open.versions].reverse().map((v, k) => (
                  <View key={v.ver}>{k ? <Divider /> : null}
                    <Row dense title={versionLine(v, open.versions![open.versions!.length - 1].ver)} end={k ? <Button size="sm" kind="ghost" label="Put back" onPress={busy ? () => {} : () => restore(v)} /> : undefined} />
                  </View>
                ))}
              </Card>
            )}
            {open.note ? <Banner tone="warn"><Text>{open.note}</Text></Banner> : null}
            <Text size="caption" tone="label">Putting a version back makes a new version. Nothing is lost.</Text>
          </View>
        ) : null}
      </Sheet>
    </>
  );
}
