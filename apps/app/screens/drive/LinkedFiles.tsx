// Files > Linked: live, read-through folders from a source such as Google Drive. Link a folder once (the picker shows what YOUR account may link), and it appears under Linked/<name> for the
// Space; each person sees inside it only what their own account allows. Open a file and its content is fetched from the source then, never kept here. A small text file can be edited and
// saved back; a save made on a stale copy is refused and says so. Sync status, Sync now and Unlink sit on the folder. The words and paths are in linked-model.ts.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { AskCard, Banner, Button, Card, Chip, Divider, EmptyState, ErrorState, Field, IconTile, LoadingState, Row, SectionLabel, Sheet, Text, showToast } from "@vyre/ui";
import { bytesOf, textOf } from "./real-model";
import { toBase64 } from "./space-model";
import { crumbsOf, editable, linkedRefusal, nameProblem, pathIn, providerLabel, suggestName, syncLine, type LinkedEntry, type LinkedFolder, type LinkedVersion, type PickFolder, type ProviderInfo, type SyncState } from "./linked-model";
import { linked } from "./real";

const say = (e: unknown) => linkedRefusal((e as { code?: string }).code, e instanceof Error ? e.message : "");
const utf8 = (s: string) => new TextEncoder().encode(s);

type OpenFile = { name: string; path: string; rev: string | null; text: string | null; draft: string | null; versions: LinkedVersion[] | null; note: string; busy: boolean };

export function LinkedFiles() {
  const [folders, setFolders] = useState<LinkedFolder[] | null>(null);
  const [syncs, setSyncs] = useState<Record<string, SyncState | null>>({});
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [err, setErr] = useState("");
  const [at, setAt] = useState<{ link: LinkedFolder; path: string } | null>(null);
  const [entries, setEntries] = useState<LinkedEntry[] | null>(null);
  const [browseErr, setBrowseErr] = useState("");
  const [file, setFile] = useState<OpenFile | null>(null);
  const [linking, setLinking] = useState(false);
  const now = Date.now();

  const load = useCallback(() => {
    setErr("");
    Promise.all([linked.list(), linked.providers()])
      .then(([fs, ps]) => {
        setFolders(fs); setProviders(ps);
        fs.forEach((f) => linked.status(f.id).then((s) => setSyncs((m) => ({ ...m, [f.id]: s.sync }))).catch(() => {}));
      })
      .catch((e) => { setErr(say(e)); setFolders(null); });
  }, []);
  useEffect(load, [load]);

  const browse = useCallback((link: LinkedFolder, path: string) => {
    setAt({ link, path }); setEntries(null); setBrowseErr("");
    linked.ls(link.id, path).then((r) => setEntries(r.entries)).catch((e) => setBrowseErr(say(e)));
  }, []);

  const syncNow = (f: LinkedFolder) => linked.sync(f.id).then((s) => { setSyncs((m) => ({ ...m, [f.id]: s })); if (s.status === "error") showToast(syncLine(s, Date.now())); if (at?.link.id === f.id) browse(f, at.path); }).catch((e) => showToast(say(e)));
  const unlink = (f: LinkedFolder) => linked.unlink(f.id).then(() => { showToast(`${f.name} is no longer linked. Nothing at the source changed.`); if (at?.link.id === f.id) setAt(null); load(); }).catch((e) => showToast(say(e)));

  const show = (e: LinkedEntry) => {
    if (!at) return;
    const rel = pathIn(at.link.name, e.path);
    if (e.dir) { browse(at.link, rel); return; }
    const can = editable(e.name, e.size);
    setFile({ name: e.name, path: rel, rev: null, text: null, draft: null, versions: null, note: can ? "" : "This kind of file opens at the source.", busy: false });
    linked.versions(at.link.id, rel).then((v) => setFile((o) => (o && o.path === rel ? { ...o, versions: v } : o))).catch(() => setFile((o) => (o && o.path === rel ? { ...o, versions: [] } : o)));
    if (can) reload(at.link, rel);
  };
  const reload = (link: LinkedFolder, rel: string) =>
    linked.read(link.id, rel).then((r) => setFile((o) => (o && o.path === rel ? { ...o, rev: r.rev, text: textOf(bytesOf(r.base64)), draft: null, note: "" } : o))).catch((x) => setFile((o) => (o && o.path === rel ? { ...o, note: say(x) } : o)));
  const save = () => {
    if (!at || !file || file.draft === null) return;
    const rel = file.path;
    setFile({ ...file, busy: true });
    linked.write(at.link.id, rel, toBase64(utf8(file.draft)), file.rev ?? undefined)
      .then(() => { showToast("Saved to the source."); reload(at.link, rel); browse(at.link, at.path); })
      .catch((x) => setFile((o) => (o ? { ...o, note: say(x) } : o)))
      .finally(() => setFile((o) => (o ? { ...o, busy: false } : o)));
  };

  if (at) {
    const parts = crumbsOf(at.link.name, at.path);
    return (
      <>
        <View className="flex-row flex-wrap items-center gap-s1">
          <Button kind="ghost" size="sm" label="Linked" onPress={() => setAt(null)} />
          {parts.map((c, i) => <View key={c.path + i} className="flex-row items-center"><Text tone="faint">/</Text><Button kind="ghost" size="sm" label={c.name} disabled={i === parts.length - 1} onPress={() => browse(at.link, c.path)} /></View>)}
          <View className="ml-auto"><Button kind="ghost" size="sm" label="Sync now" onPress={() => syncNow(at.link)} /></View>
        </View>
        {browseErr ? <Card flush><ErrorState title="This folder did not open" reason={browseErr} retry={() => browse(at.link, at.path)} /></Card> : null}
        {!browseErr && entries === null ? <LoadingState rows={3} /> : null}
        {!browseErr && entries ? (
          <Card flush>
            {entries.length ? entries.map((e, i) => (
              <View key={e.path}>{i ? <Divider inset={60} /> : null}
                <Row dense chevron={e.dir} lead={<IconTile name={e.dir ? "drive" : "file"} />} title={e.name} sub={e.dir ? "" : [`${Math.max(1, Math.round(e.size / 1024))} KB`].join("")} onPress={() => show(e)} />
              </View>
            )) : <EmptyState title="Nothing here" body="This folder is empty, or your account at the source cannot see anything in it." />}
          </Card>
        ) : null}
        <Sheet open={!!file} onClose={() => setFile(null)} title={file?.name}>
          {file ? (
            <View className="gap-s3">
              {file.draft !== null ? (
                <>
                  <Field label="Contents" value={file.draft} onChangeText={(t: string) => setFile((o) => (o ? { ...o, draft: t } : o))} multiline lines={12} mono />
                  <View className="flex-row gap-s2">
                    <Button kind="primary" size="sm" label={file.busy ? "Saving" : "Save to the source"} onPress={file.busy ? () => {} : save} />
                    <Button kind="ghost" size="sm" label="Cancel" onPress={() => setFile((o) => (o ? { ...o, draft: null } : o))} />
                  </View>
                </>
              ) : (
                <>
                  {file.text != null ? <Text mono size="caption" selectable>{file.text}</Text> : null}
                  {file.text != null ? <View className="self-start"><Button kind="ghost" size="sm" icon="edit" label="Edit" onPress={() => setFile((o) => (o ? { ...o, draft: o.text ?? "" } : o))} /></View> : null}
                </>
              )}
              {file.note ? <Banner tone="warn"><Text>{file.note}</Text></Banner> : null}
              <Text size="caption" strong tone="label">History</Text>
              {file.versions === null ? <Text tone="muted">Loading.</Text> : file.versions.length === 0 ? <Text tone="muted">The source lists no history for this file.</Text> : (
                <Card flush>{[...file.versions].reverse().map((v, k) => <View key={v.rev}>{k ? <Divider /> : null}<Row dense title={`${new Date(v.modified).toLocaleString()}${v.by ? `, ${v.by}` : ""}`} /></View>)}</Card>
              )}
            </View>
          ) : null}
        </Sheet>
      </>
    );
  }

  return (
    <>
      <View className="flex-row items-center">
        <SectionLabel first>Linked folders</SectionLabel>
        <View className="ml-auto"><Button size="sm" kind="primary" icon="plus" label="Link a folder" onPress={() => setLinking(true)} /></View>
      </View>
      {err ? <Card flush><ErrorState title="Linked folders did not load" reason={err} retry={load} /></Card> : null}
      {!err && folders === null ? <LoadingState rows={2} /> : null}
      {!err && folders ? (
        <Card flush>
          {folders.length ? folders.map((f, i) => (
            <View key={f.id}>{i ? <Divider inset={60} /> : null}
              <Row dense chevron lead={<IconTile name="drive" tone="accent" />} title={f.name} sub={`${providerLabel(providers, f.provider)}. ${syncLine(syncs[f.id] ?? null, now)}`} onPress={() => browse(f, "")}
                end={<View className="flex-row items-center"><Button kind="ghost" size="sm" label="Sync" onPress={() => syncNow(f)} /><Button kind="holdText" size="sm" label="Unlink" onPress={() => unlink(f)} /></View>} />
            </View>
          )) : <EmptyState title="No linked folders" body={providers.length ? "Link a folder from Google Drive and it shows up here, live. You see inside it only what your own account allows." : "No source is set up on this box yet."} />}
        </Card>
      ) : null}
      <LinkSheet open={linking} providers={providers} taken={(folders ?? []).map((f) => f.name)} onClose={() => setLinking(false)} onLinked={(f) => { setLinking(false); load(); linked.sync(f.id).then(() => load()).catch(() => {}); showToast(`${f.name} is linked.`); }} />
    </>
  );
}

/** Pick a source, walk its folders as this person, name the link, say yes. */
function LinkSheet({ open, providers, taken, onClose, onLinked }: { open: boolean; providers: ProviderInfo[]; taken: string[]; onClose: () => void; onLinked: (f: LinkedFolder) => void }) {
  const [provider, setProvider] = useState<string>("");
  const [stack, setStack] = useState<PickFolder[]>([]);
  const [kids, setKids] = useState<PickFolder[] | null>(null);
  const [name, setName] = useState("");
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const here = stack[stack.length - 1];

  useEffect(() => { if (open) { setProvider((p) => p || providers.find((x) => x.pick)?.id || ""); } else { setStack([]); setName(""); setAsking(false); setErr(""); } }, [open, providers]);
  useEffect(() => {
    if (!open || !provider) return;
    setKids(null); setErr("");
    linked.pick(provider, here?.id).then((r) => setKids(r.folders)).catch((e) => { setErr(say(e)); setKids([]); });
  }, [open, provider, here?.id]);
  useEffect(() => { if (here) setName(suggestName(here.name)); }, [here?.id]);

  const problem = name ? (nameProblem(name) || (taken.includes(name) ? "That name is already a linked folder." : "")) : "";
  const make = () => {
    if (!here || !provider) return;
    setBusy(true); setErr("");
    linked.link(name, provider, { folder: here.id }).then(onLinked).catch((e) => setErr(say(e))).finally(() => setBusy(false));
  };

  return (
    <Sheet open={open} onClose={onClose} title="Link a folder">
      <View className="gap-s3">
        {providers.length > 1 ? <View className="flex-row flex-wrap gap-s2">{providers.filter((p) => p.pick).map((p) => <Chip key={p.id} selected={provider === p.id} onPress={() => { setProvider(p.id); setStack([]); }}>{p.label}</Chip>)}</View> : null}
        {!provider ? <Text tone="muted">No source is set up on this box yet.</Text> : (
          <>
            <View className="flex-row flex-wrap items-center gap-s1">
              <Button kind="ghost" size="sm" label={providerLabel(providers, provider)} onPress={() => setStack([])} />
              {stack.map((s, i) => <View key={s.id} className="flex-row items-center"><Text tone="faint">/</Text><Button kind="ghost" size="sm" label={s.name} onPress={() => setStack(stack.slice(0, i + 1))} /></View>)}
            </View>
            {kids === null ? <LoadingState rows={3} /> : (
              <Card flush>
                {kids.length ? kids.map((k, i) => <View key={k.id}>{i ? <Divider inset={60} /> : null}<Row dense chevron lead={<IconTile name="drive" />} title={k.name} onPress={() => setStack([...stack, k])} /></View>) : <EmptyState title="No folders here" body={here ? "This folder has no folders inside it. You can link it as it is." : "Your account has no folders at the top of this source."} />}
              </Card>
            )}
            {here && !asking ? (
              <View className="gap-s2">
                <Field label="Name in Files" value={name} onChangeText={setName} error={problem || undefined} help={`It appears at Linked/${name || "..."}.`} />
                <View className="self-start"><Button kind="primary" size="sm" label={`Link ${here.name}`} disabled={!!problem || !name} onPress={() => setAsking(true)} /></View>
              </View>
            ) : null}
            {here && asking ? (
              <AskCard lead={<IconTile name="drive" tone="accent" />} title={`Link ${here.name} as Linked/${name}?`}
                why="The folder shows live in this Space's Files. Everyone sees that it is linked and its name. What each person sees inside is what their own account allows. Nothing is copied, and unlinking never touches the source."
                actions={[{ label: busy ? "Linking" : "Link the folder", kind: "primary", onPress: busy ? () => {} : make }, { label: "Not now", kind: "ghost", onPress: () => setAsking(false) }]} />
            ) : null}
          </>
        )}
        {err ? <Banner tone="warn"><Text>{err}</Text></Banner> : null}
      </View>
    </Sheet>
  );
}
