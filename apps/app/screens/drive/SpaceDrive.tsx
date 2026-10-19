// The space's own Drive: versioned, permissioned files. Browse folders, open a file to read it and see its versions, put an older version back (the person's own act, with presence),
// and add a file from the browser (the web app; a phone has no picker in the app yet, so no Upload button there rather than a dead one).
import { useCallback, useEffect, useState } from "react";
import { Platform, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { AskCard, Banner, Button, Card, Divider, EmptyState, Field, IconTile, Row, Sheet, Text, showToast } from "@vyre/ui";
import { boxOrigin } from "../../src/api/box";
import { bytesOf, textOf } from "./real-model";
import { children, itemLine, linkAddress, linkAsk, linkRefusal, newFolderName, spaceDriveRefusal, toBase64, uploadPath, versionLine, MAX_UPLOAD, type Item, type Version } from "./space-model";
import { driveTool, linkCreate, spaceList, spaceRead, spaceRestore, spaceUpload, spaceVersions } from "./real";
import { FolderPicker } from "./FolderPicker";
import { folderNames, learnFolderNames } from "./files-real";
import { editCalls } from "./file-menu-model.js";
import { movedLine, plan as movePlan } from "./move-model.js";
import { Breadcrumb } from "./Breadcrumb";
import { usePlaceText } from "../../src/real/PlaceTag";
import { SpaceTag } from "@vyre/ui";

const say = (e: unknown) => spaceDriveRefusal((e as { code?: string }).code, e instanceof Error ? e.message : "");
const TEXT = /\.(txt|md|csv|json|xml|ya?ml|html?|log)$/i;

export function SpaceDrive({ onLink }: { onLink?: () => void }) {
  const spaceTag = usePlaceText("showing");
  const [prefix, setPrefix] = useState("");
  const [items, setItems] = useState<Item[] | null>(null);
  const [more, setMore] = useState(false);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<{ item: Item; versions: Version[] | null; text: string | null; note: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  // a new folder in the folder shown: null while closed, else the name being typed
  const [newName, setNewName] = useState<string | null>(null);
  // "Move to...": a file opened here is moved by picking a folder (the same picker and the same move as the web file manager)
  const [moving, setMoving] = useState<{ item: Item; to: string; busy: boolean; note: string } | null>(null);

  const load = useCallback(() => {
    setErr("");
    // a project's folder is its id; files.places has its name (files-real.ts)
    Promise.all([spaceList(undefined, prefix), learnFolderNames().then(() => folderNames)]).then(([r, known]) => { setItems(children(r.entries, prefix, { names: { ...known, ...(r.names ?? {}) }, folders: r.folders })); setMore(r.more); }).catch((e) => { setErr(say(e)); setItems(null); });
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
  const moveNow = () => {
    if (!moving) return;
    const r = { root: "space", path: moving.item.path, name: moving.item.name, dir: false };
    const { go, said } = movePlan([r], { root: "space", path: moving.to });
    const c = go.length ? editCalls("move", r, moving.to) : null;
    if (!c) { setMoving({ ...moving, note: said || "That is already where it is." }); return; }
    setMoving({ ...moving, busy: true, note: "" });
    driveTool(c.call.tool, c.call.input).then(() => {
      const undo = c.undo;
      showToast(movedLine(1, moving.to ? moving.to.split("/").pop() ?? moving.to : "the top", 0), undo ? { label: "Undo", run: () => { void driveTool(undo.tool, undo.input).then(() => { showToast("Put back."); load(); }).catch((e) => showToast(say(e))); } } : undefined);
      setMoving(null); setOpen(null); load();
    }).catch((e) => setMoving((m) => (m ? { ...m, busy: false, note: say(e) } : m)));
  };
  const share = () => {
    if (!open) return;
    setBusy(true);
    linkCreate(undefined, open.item.path)
      .then(async (l) => { try { await Clipboard.setStringAsync(linkAddress(boxOrigin() || "", l)); showToast("Link made and copied. It is under Shared links."); } catch { showToast("Link made. It is under Shared links."); } setAsking(false); setOpen(null); onLink?.(); })
      .catch((e) => setOpen((o) => (o ? { ...o, note: linkRefusal((e as { code?: string }).code, e instanceof Error ? e.message : "") } : o))).finally(() => setBusy(false));
  };
  const makeFolder = () => {
    if (newName === null) return;
    const v = newFolderName(newName, (items ?? []).map((x) => x.name));
    if ("error" in v) { showToast(v.error); return; }
    setBusy(true);
    driveTool("files.drive.space.mkdir", { ...(prefix ? { parent: prefix } : {}), name: v.name })
      .then(() => { showToast(`Made ${v.name}.`); setNewName(null); load(); })
      .catch((e) => showToast(say(e))).finally(() => setBusy(false));
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
      <Breadcrumb crumbs={[{ name: "Files", key: "" }, ...parts.map((p, i) => ({ name: folderNames[parts.slice(0, i + 1).join("/")] || p, key: parts.slice(0, i + 1).join("/") }))]} onPress={setPrefix}
        end={<View className="flex-row items-center gap-s2">{Platform.OS === "web" ? <Button size="sm" kind="primary" icon="plus" label={busy ? "Sending" : "Add a file"} onPress={busy ? () => {} : pick} /> : null}<Button size="sm" kind="secondary" icon="plus" label="New folder" onPress={() => setNewName("")} /></View>} />
      {err ? <Card flush><EmptyState title="Files did not open" body={err} action={{ label: "Try again", onPress: load }} /></Card> : null}
      {!err && items === null ? <Card flush><EmptyState title="Loading" body="Asking your Vyre." /></Card> : null}
      {!err && items ? (
        <Card flush>
          {items.length ? items.map((i, k) => (
            <View key={i.path}>{k ? <Divider inset={60} /> : null}
              <View style={i.locked ? { opacity: 0.5 } : undefined}><Row dense chevron={i.dir && !i.locked} lead={<IconTile name={i.dir ? "folder" : "file"} />} title={i.name} sub={i.locked ? "You are not in this chat" : itemLine(i)} end={spaceTag ? <SpaceTag text={spaceTag} /> : undefined} onPress={i.locked ? undefined : () => show(i)} /></View>
            </View>
          )) : <EmptyState title={prefix ? "Nothing here" : "No files yet"} body={prefix ? "This folder has no file you may read." : "Files you add, or that agents save, appear here with their versions."} />}
          {more ? <View className="p-s3"><Text size="caption" tone="label">This folder is large. The first files are shown.</Text></View> : null}
        </Card>
      ) : null}
      <Sheet open={newName !== null} onClose={() => setNewName(null)} title="New folder">
        <View className="gap-s3">
          <Field label="Folder name" value={newName ?? ""} onChangeText={setNewName} placeholder="New folder" autoFocus onSubmit={makeFolder} />
          <View className="flex-row gap-s2"><Button kind="primary" size="sm" label={busy ? "Working" : "Make folder"} onPress={busy ? () => {} : makeFolder} /><Button kind="ghost" size="sm" label="Cancel" onPress={() => setNewName(null)} /></View>
        </View>
      </Sheet>
      <Sheet open={!!open} onClose={() => { setOpen(null); setAsking(false); }} title={open?.item.name}>
        {open ? (
          <View className="gap-s3">
            {open.text != null ? <Text mono size="caption" selectable>{open.text}</Text> : null}
            {asking ? (
              <AskCard lead={<IconTile name="share" />} {...linkAsk(open.item.name)}
                actions={[{ label: busy ? "Making it" : "Make the link", kind: "primary", onPress: busy ? () => {} : share }, { label: "Not now", kind: "ghost", onPress: () => setAsking(false) }]} />
            ) : <View className="flex-row flex-wrap gap-s2"><Button kind="ghost" size="sm" icon="share" label="Share a link" onPress={() => setAsking(true)} /><Button kind="ghost" size="sm" icon="folder" label="Move to…" onPress={() => setMoving({ item: open.item, to: "", busy: false, note: "" })} /></View>}
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
      <Sheet open={!!moving} onClose={() => setMoving(null)} title={moving ? `Move ${moving.item.name}` : undefined}>
        {moving ? (
          <View className="gap-s3">
            <FolderPicker root="space" moving={[{ path: moving.item.path, dir: false, name: moving.item.name, root: "space" }]} value={moving.to} onChange={(to) => setMoving((m) => (m && m.to !== to ? { ...m, to, note: "" } : m))} />
            {moving.note ? <Banner tone="warn"><Text>{moving.note}</Text></Banner> : null}
            <View className="flex-row gap-s2"><Button kind="primary" size="sm" label={moving.busy ? "Working" : "Move here"} onPress={moving.busy ? () => {} : moveNow} /><Button kind="ghost" size="sm" label="Cancel" onPress={() => setMoving(null)} /></View>
          </View>
        ) : null}
      </Sheet>
    </>
  );
}
