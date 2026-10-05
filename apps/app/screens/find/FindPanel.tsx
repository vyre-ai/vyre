// Find: one box over chats, projects, people, files and memory. Typing "p ", "t " or "u " narrows it. The panel is the whole of Find; the page and the command bar both draw it.
import { useCallback, useEffect, useRef, useState } from "react";
import { Image, ScrollView, View } from "react-native";
import { Chip, Divider, Field, LoadingState, Row, SectionLabel, Segmented, Sheet, Text } from "@vyre/ui";
import { DEBOUNCE_MS, MIN, PREFIX_HINT, SCOPES, missingNotes, previewOf, sectionsFor, sizeWords, type Base, type Found, type Row as R, type Scope } from "./model.ts";
import { loadBase, previewFile, search } from "./source";
import { addRecent, readRecent } from "./recent";

const SHOW = 5;
type Err = { chats?: string; files?: string; memory?: string };

export function FindPanel({ initial = "", autoFocus, onGo }: { initial?: string; autoFocus?: boolean; onGo: (href: string) => void }) {
  const [q, setQ] = useState(initial);
  const [scope, setScope] = useState<Scope>("all");
  const [base, setBase] = useState<(Base & { notes: string[] }) | null>(null);
  const [found, setFound] = useState<Found>({ missing: [] });
  const [errs, setErrs] = useState<Err>({});
  const [recent, setRecent] = useState<string[]>(readRecent());
  const [open, setOpen] = useState<Scope | "">("");
  const [file, setFile] = useState<Extract<R, { kind: "file" }>["file"] | null>(null);
  const seq = useRef(0);
  useEffect(() => { loadBase().then(setBase).catch(() => setBase({ sessions: [], projects: [], agents: [], notes: ["Find could not read your chats and projects."] })); }, []);
  const run = useCallback((text: string) => {
    const n = ++seq.current;
    setFound({ missing: [] }); setErrs({}); setOpen("");
    search(text, (f) => {
      if (n !== seq.current) return;
      const { errs: e, ...rest } = f;
      setFound((old) => ({ ...old, ...rest }));
      if (e) setErrs((old) => ({ ...old, ...e }));
    });
  }, []);
  useEffect(() => {
    const t = setTimeout(() => run(q.trim()), q.trim() ? DEBOUNCE_MS : 0);
    return () => clearTimeout(t);
  }, [q, run]);
  const sections = base ? sectionsFor(q, base, found, scope) : [];
  const text = q.trim();
  const long = (text.replace(/^[ptu]\s+/i, "")).length >= MIN;
  const pending = long && (!found.chats || !found.files || !found.memory);
  const go = (r: R) => {
    if (text.length >= MIN) setRecent(addRecent(text));
    if (r.kind === "file") setFile(r.file); else onGo(r.href);
  };
  return (
    <View className="gap-s2">
      <Field label="Search" value={q} onChangeText={setQ} placeholder={`Search, or type ${PREFIX_HINT}`} />
      <Segmented<Scope> label="Search in" options={SCOPES} value={scope} onChange={setScope} />
      {base?.notes.length ? <Text size="caption" tone="muted">{base.notes.join(" ")}</Text> : null}
      {!long ? (
        recent.length ? (
          <View>
            <SectionLabel first>Recent</SectionLabel>
            <View className="flex-row flex-wrap gap-s1">{recent.map((r) => <Chip key={r} onPress={() => setQ(r)}>{r}</Chip>)}</View>
          </View>
        ) : <Text tone="muted">Chats, projects, people, files and memory, in one place.</Text>
      ) : null}
      {long && !base ? <LoadingState rows={3} /> : null}
      {sections.map((s) => {
        const rows = open === s.id ? s.rows : s.rows.slice(0, SHOW);
        return (
          <View key={s.id}>
            <SectionLabel>{s.label}</SectionLabel>
            {rows.map((r, i) => <View key={r.key}>{i ? <Divider /> : null}<Row dense title={r.title} sub={r.sub || undefined} chevron onPress={() => go(r)} /></View>)}
            {s.rows.length > SHOW && open !== s.id ? <Row dense title={`Show all ${s.rows.length}`} onPress={() => setOpen(s.id)} /> : null}
          </View>
        );
      })}
      {long && base && !sections.length && !pending ? <Text tone="muted">{`Nothing found for "${text}".`}</Text> : null}
      {pending && base ? <Text size="caption" tone="muted">Looking…</Text> : null}
      {missingNotes(errs).map((n) => <Text key={n} size="caption" tone="muted">{n}</Text>)}
      {found.files?.notes.length ? <Text size="caption" tone="muted">{found.files.notes.join(" ")}</Text> : null}
      <Preview file={file} onClose={() => setFile(null)} />
    </View>
  );
}

function Preview({ file, onClose }: { file: Extract<R, { kind: "file" }>["file"] | null; onClose: () => void }) {
  const [body, setBody] = useState<ReturnType<typeof previewOf> | null>(null);
  useEffect(() => {
    setBody(null);
    if (!file) return;
    let live = true;
    previewFile(file.path, file.source).then((d) => live && setBody(previewOf(d)), (e) => live && setBody({ kind: "none", note: e instanceof Error ? e.message : "The preview could not be read." }));
    return () => { live = false; };
  }, [file]);
  return (
    <Sheet open={!!file} onClose={onClose} title={file?.name ?? ""}>
      <View className="gap-s2">
        <Text size="caption" tone="muted" selectable>{file ? [file.source === "mac" ? "Mac" : "Box", file.path, sizeWords(file.size)].filter(Boolean).join(" · ") : ""}</Text>
        {!body ? <LoadingState rows={2} /> : body.kind === "text" ? <ScrollView style={{ maxHeight: 360 }}><Text mono selectable>{body.text}</Text></ScrollView>
          : body.kind === "image" ? <Image source={{ uri: body.uri }} style={{ width: "100%", height: 280 }} resizeMode="contain" accessibilityLabel={file?.name} />
          : <Text tone="muted">{body.note}</Text>}
      </View>
    </Sheet>
  );
}
