// A project's instructions and context, kept as real files in its folder in Vyre Files, the same shape as an agent's: AGENTS.md at the root (CLAUDE.md beside it, pointing at it so Claude Code and
// the other tools read one set of words) and a context/ folder. Context is references to files in Files (a small .link.md note naming the path, never a copy) and free notes (.md).
// Chats in the project read the folder through the same path an agent's chats do.
import { useCallback, useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { Button, Card, Divider, EmptyState, Field, Icon, LoadingState, PickerList, Row, Sheet, Text, showToast, type PickerItem } from "@vyre/ui";
import { filterItems } from "@vyre/ui/lib/picker-model.js";
import { projectDir } from "../../../../lib/files/layout.js";
import { spaceList, spaceRead, spaceUpload } from "../drive/real";

const b64 = (t: string) => btoa(unescape(encodeURIComponent(t)));
const unb64 = (s: string) => { try { return decodeURIComponent(escape(atob(s))); } catch { return ""; } };
const POINTER = "@AGENTS.md\n";

/** Instructions: the project's AGENTS.md, edited in place; CLAUDE.md is kept as a pointer to it. */
export function ProjectInstructions({ pid }: { pid: string }) {
  const dir = projectDir(pid);
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void spaceRead(undefined, `${dir}/AGENTS.md`).then((r) => { const t = unb64(r.base64); setText(t); setSaved(t); }).catch(() => { setText(""); setSaved(""); }); }, [dir]);
  const save = async () => {
    setBusy(true);
    try {
      const body = (text ?? "").trim() ? (text ?? "").trim() + "\n" : "";
      await spaceUpload(undefined, `${dir}/AGENTS.md`, b64(body));
      // CLAUDE.md follows: a pointer to AGENTS.md unless the person keeps their own words there.
      const cur = await spaceRead(undefined, `${dir}/CLAUDE.md`).then((r) => unb64(r.base64)).catch(() => "");
      if (!cur.trim() || cur === POINTER) await spaceUpload(undefined, `${dir}/CLAUDE.md`, b64(POINTER));
      setSaved(body); setText(body); setOpen(false);
      showToast("Saved. Chats in this project read it from the next turn.");
    } catch (e) { showToast(e instanceof Error && e.message ? e.message : "That did not save."); } finally { setBusy(false); }
  };
  if (text === null) return <LoadingState rows={2} />;
  return (
    <Card className="gap-s2">
      {open ? (
        <>
          <Field name="Project instructions (AGENTS.md)" value={text} onChangeText={setText} multiline lines={10} placeholder="What is this project, and how should anyone working on it go about it?" />
          <View className="flex-row gap-s2"><Button size="sm" label="Save" disabled={busy || text === saved} onPress={() => void save()} /><Button size="sm" kind="ghost" label="Cancel" onPress={() => { setText(saved); setOpen(false); }} /></View>
        </>
      ) : (
        <>
          <Text numberOfLines={5} tone={saved ? "default" : "muted"}>{saved || "No instructions yet. Say what this project is and how to work on it; every chat here starts with it."}</Text>
          <View className="flex-row"><Button size="sm" kind="secondary" label={saved ? "Edit" : "Write instructions"} onPress={() => setOpen(true)} /></View>
        </>
      )}
    </Card>
  );
}

type Item = { name: string; path: string; link: boolean };

/** Context: what chats here read before they work: files in Files linked as references, and notes. */
export function ProjectContext({ pid }: { pid: string }) {
  const dir = `${projectDir(pid)}/context`;
  const [items, setItems] = useState<Item[] | null>(null);
  const [adding, setAdding] = useState<"" | "file" | "note">("");
  const reload = useCallback(() => { void spaceList(undefined, dir).then((l) => setItems(l.entries.filter((e) => e.path && String(e.path).startsWith(dir + "/")).map((e) => { const path = String(e.path); const name = path.split("/").pop() ?? path; return { name: name.replace(/\.link\.md$/, ""), path, link: /\.link\.md$/.test(name) }; }))).catch(() => setItems([])); }, [dir]);
  useEffect(reload, [reload]);
  if (items === null) return <LoadingState rows={2} />;
  return (
    <View className="gap-s2">
      {items.length ? (
        <Card flush>{items.map((x, i) => <View key={x.path}>{i ? <Divider /> : null}<Row dense lead={<Icon name={x.link ? "link" : "file"} size={18} />} title={x.name} sub={x.link ? "Linked from Files" : "Note"} /></View>)}</Card>
      ) : <EmptyState title="No context yet" body="Link files from Files and add notes. Every chat in this project reads them." />}
      <View className="flex-row gap-s2"><Button size="sm" kind="secondary" icon="plus" label="Add from Files" onPress={() => setAdding("file")} /><Button size="sm" kind="ghost" label="Add a note" onPress={() => setAdding("note")} /></View>
      <AddFile open={adding === "file"} dir={dir} onClose={() => setAdding("")} onDone={() => { setAdding(""); reload(); }} />
      <AddNote open={adding === "note"} dir={dir} onClose={() => setAdding("")} onDone={() => { setAdding(""); reload(); }} />
    </View>
  );
}

/** Pick files in Vyre Files (type to filter, Up and Down, Enter) and link each: a reference note naming the path, not a copy. */
function AddFile({ open, dir, onClose, onDone }: { open: boolean; dir: string; onClose: () => void; onDone: () => void }) {
  const [all, setAll] = useState<{ path: string; name: string }[]>([]);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  useEffect(() => { if (open) void spaceList(undefined, "").then((l) => setAll(l.entries.filter((e) => e.path && !String(e.path).includes("/context/")).map((e) => ({ path: String(e.path), name: String(e.path).split("/").pop() ?? "" })))).catch(() => setAll([])); }, [open]);
  const rows = useMemo(() => filterItems(all.map((f) => ({ ...f, label: f.name })), q, 40), [all, q]);
  const items: PickerItem[] = rows.map((f) => ({ key: f.path, label: f.name, sub: f.path.split("/").slice(0, -1).join(" / "), leading: <Icon name="file" size={18} /> }));
  const link = async (i: number) => {
    const f = rows[i]; if (!f) return;
    try { await spaceUpload(undefined, `${dir}/${f.name}.link.md`, b64(`# ${f.name}\n\nA reference to a file in Vyre Files: \`${f.path}\`\n`)); showToast(`${f.name} added to the context.`); onDone(); } catch (e) { showToast(e instanceof Error && e.message ? e.message : "That did not save."); }
  };
  return (
    <Sheet open={open} onClose={onClose} title="Add context from Files">
      <View className="gap-s2">
        <Field name="Find a file" value={q} onChangeText={(v) => { setQ(v); setActive(0); }} placeholder="Part of the file's name" />
        <PickerList id="ctx-files" label="Files" items={items} active={active} onActive={setActive} onPick={(i) => void link(i)} footer="Pick a file to link it. It is not copied." maxRows={8} empty="No file matches" />
      </View>
    </Sheet>
  );
}

function AddNote({ open, dir, onClose, onDone }: { open: boolean; dir: string; onClose: () => void; onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const save = async () => {
    const t = title.trim().replace(/[\\/]/g, " ") || "Note";
    try { await spaceUpload(undefined, `${dir}/${t}.md`, b64(`# ${t}\n\n${body.trim()}\n`)); setTitle(""); setBody(""); showToast("Note added to the context."); onDone(); } catch (e) { showToast(e instanceof Error && e.message ? e.message : "That did not save."); }
  };
  return (
    <Sheet open={open} onClose={onClose} title="Add a note">
      <View className="gap-s2">
        <Field name="Title" value={title} onChangeText={setTitle} />
        <Field name="Note" value={body} onChangeText={setBody} multiline lines={6} />
        <View className="self-start"><Button size="sm" label="Add" disabled={!body.trim()} onPress={() => void save()} /></View>
      </View>
    </Sheet>
  );
}
