// Find: one box. As you type, what matches comes in below in a fixed order (Go to, Chats, Projects, People, Records, Files, From memory). With the box empty: the last searches, the recent chats and
// the places. Enter runs what the line says: "@kit ..." asks that agent, "tell <chat> to ..." types into a chat and watches it, "watch <chat>" watches it, anything else asks the assistant; a
// line under the box says which. The same panel is the /u/search page on every device and the Cmd-K command bar on desktop and web.
import { useEffect, useMemo, useRef, useState } from "react";
import { Image, Platform, View } from "react-native";
import { useRouter } from "expo-router";
import { Banner, Button, Card, Chip, Composer, Divider, EmptyState, Icon, LoadingState, Row, Segmented, Sheet, Text, useRecordsWorld, type IconName } from "@vyre/ui";
import { NAV } from "../shell/nav";
import { find } from "./source-real";
import { MIN, SCOPES, SHOW, addRecent, doneLine, emptyBase, flatRows, idle, mentionSections, missingNote, planLine, previewOf, readCommand, recordRows, sections, stepHi, type Base, type Fetched, type FileHit, type Row as Hit, type Scope } from "./model";
import { loadRecents, saveRecents } from "./recents";

const ICON: Record<string, IconName> = { chat: "chat", project: "projects", agent: "assistants", person: "contacts", record: "file", file: "file", memory: "memory", place: "chevron" as IconName };

export default function FindPanel({ onDone, initial = "" }: { onDone?: () => void; initial?: string }) {
  const router = useRouter();
  const { data: world } = useRecordsWorld();
  const [base, setBase] = useState<Base>(emptyBase);
  const [loaded, setLoaded] = useState(false);
  const [q, setQ] = useState(initial);
  const [scope, setScope] = useState<Scope>("all");
  const [fetched, setFetched] = useState<Fetched>({});
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [recents, setRecents] = useState<string[]>([]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [chosen, setChosen] = useState<string | null>(null);
  const [done, setDone] = useState("");
  const [preview, setPreview] = useState<{ file: FileHit; state: ReturnType<typeof previewOf> | "loading" } | null>(null);
  const [hi, setHi] = useState(-1);
  const seq = useRef(0);

  useEffect(() => {
    let live = true;
    void loadRecents().then((r) => { if (live) setRecents(r); });
    find.load().then((l) => { if (live) { setBase((b) => ({ ...b, ...l })); setLoaded(true); } }).catch(() => { if (live) setLoaded(true); });
    return () => { live = false; };
  }, []);

  const places = useMemo(() => [...NAV.items, ...(NAV.more ?? []), ...(NAV.bottom ?? [])].filter((i) => i.id !== "search").map((i) => ({ id: i.id, label: i.label, href: i.href })), []);
  const records = useMemo(() => (world ? recordRows(world.types, world.byType) : []), [world]);
  const all: Base = useMemo(() => ({ ...base, records, places }), [base, records, places]);

  // A query asks the three tools, 150 ms after typing stops; an answer for an old query is dropped.
  useEffect(() => {
    const line = q.trim();
    const n = ++seq.current;
    setDone("");
    setFetched({}); setErrs({});
    if (line.length < MIN) return;
    const t = setTimeout(() => {
      const sq = /^[ptu]\s+/i.test(line) ? line.replace(/^[ptu]\s+/i, "") : line;
      const got = (key: keyof Fetched, label: string) => (r: { data?: unknown; error?: { code: string; message: string } }) => {
        if (n !== seq.current) return;
        if (r.error) setErrs((e) => ({ ...e, [key]: label })); else setFetched((f) => ({ ...f, [key]: r.data ?? [] }));
      };
      find.search(sq, { recall: got("recall", "Chats were not searched."), files: got("files", "Files were not searched."), memory: got("memory", "Memory was not searched."), mentions: got("mentions", "") });
    }, 150);
    return () => clearTimeout(t);
  }, [q]);

  const line = q.trim();
  const secs = useMemo(() => sections(all, line, scope, fetched), [all, line, scope, fetched]);
  const { cmd, chosen: target } = useMemo(() => readCommand(line, all, chosen), [line, all, chosen]);
  const cands: any[] = "candidates" in cmd ? cmd.candidates : [];
  const idleNow = useMemo(() => idle(all, recents), [all, recents]);
  const flat = useMemo(() => flatRows(secs, open, [...idleNow.chats, ...idleNow.places]), [secs, open, idleNow]);
  const flatRef = useRef(flat);
  flatRef.current = flat;
  useEffect(() => setHi(-1), [line, scope]);
  // Arrow keys move the highlight through the rows, as in the Deck's Find; Enter opens the highlighted one. Escape (and Up from the first row) goes back to the box. Web only: a phone has no arrow keys.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      if (!flatRef.current.length) return;
      e.preventDefault();
      setHi((h) => stepHi(h, e.key as "ArrowDown" | "ArrowUp", flatRef.current.length));
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);
  const mentionNote = fetched.mentions !== undefined && line.length >= MIN ? mentionSections(fetched.mentions).note : "";
  const assistant = all.assistant || "the assistant";
  const targetName = target ? String(target.name || target.id.slice(0, 8)) : "";

  const go = (href: string) => { onDone?.(); router.push(href as never); };
  const remember = () => { if (line.length >= MIN) { const next = addRecent(recents, line); setRecents(next); void saveRecents(next); } };
  const pick = (r: Hit) => {
    remember();
    if (r.file) { setPreview({ file: r.file, state: "loading" }); find.preview(r.file.path, r.file.source).then((x) => setPreview((p) => (p && p.file.path === r.file!.path ? { file: p.file, state: x.error ? { kind: "none", note: "No preview." } : previewOf(p.file, x.data) } : p))); return; }
    if (r.session) { go(`/session/${r.session}`); return; }
    if (r.href) go(r.href);
  };

  const run = async () => {
    if (hi >= 0 && flatRef.current[hi]) { pick(flatRef.current[hi]); return; }
    if (!line) return;
    remember();
    try {
      if (cmd.kind === "agent") {
        setDone(`Asking ${cmd.agent}.`);
        const r = await find.ask(cmd.agent, cmd.text);
        if (r.thread) { go(`/session/${r.thread}`); return; }
        setDone(r.note || doneLine(cmd, "")); return;
      }
      if ((cmd.kind === "drive" || cmd.kind === "watch") && target) {
        setDone(cmd.kind === "drive" ? `Typing into ${targetName}.` : `Watching ${targetName}.`);
        const r = await find.run(cmd, target, targetName);
        setDone(r.done ? doneLine(cmd, targetName) : r.note);
        if (r.done) setQ("");
        return;
      }
      // Anything else asks the assistant, and its thread opens.
      if (!all.assistant) { setDone("No assistant is set up yet."); return; }
      setDone(`Asking ${assistant}.`);
      const r = await find.ask(all.assistant, line);
      if (r.thread) { go(`/session/${r.thread}`); return; }
      setDone(r.note || `Sent to ${assistant}.`);
    } catch (e) { setDone(missingNote(e as { code?: string; message?: string })); }
  };

  const hit = (r: Hit) => (
    <Row key={r.key} dense selected={flat[hi]?.key === r.key} lead={<Icon name={ICON[r.kind] ?? "file"} size={16} tone="label" />} title={r.title}
      sub={<View className="gap-s1">{r.snippet ? <Text size="secondary" tone="muted" numberOfLines={2}>{r.snippet.replace(/[«»]/g, "")}</Text> : null}{r.sub ? <Text size="caption" tone="faint" numberOfLines={1}>{r.sub}</Text> : null}</View>}
      state={r.right} onPress={() => pick(r)} />
  );
  const pending = line.length >= MIN && (["recall", "files", "memory", "mentions"] as const).some((k) => fetched[k] === undefined && !errs[k]);
  return (
    <View className="gap-s3">
      <Composer label="Find or ask" placeholder={`Ask ${assistant}, find, or run`} value={q} onChangeText={setQ} onSend={() => void run()} sendLabel="Run" />
      <Segmented label="Search in" value={scope} onChange={setScope} options={SCOPES} />
      {line && cmd.kind !== "ask" ? <Text size="secondary" tone="label" accessibilityLiveRegion="polite">{planLine(cmd, targetName, assistant)}</Text> : line ? <Text size="secondary" tone="label">{`Enter asks ${assistant}.`}</Text> : <Text size="caption" tone="faint">p projects, t chats, u people</Text>}
      {done ? <Banner><Text>{done}</Text></Banner> : null}
      {cands.length > 1 ? (
        <View className="gap-s1">
          <Text size="caption" strong tone="label">{cmd.kind === "drive" ? "Type into" : "Watch"}</Text>
          <View className="flex-row flex-wrap gap-s2">{cands.slice(0, 5).map((c) => <Chip key={c.id} selected={c.id === target?.id} onPress={() => setChosen(c.id)}>{String(c.name || c.id.slice(0, 8))}</Chip>)}</View>
        </View>
      ) : null}
      {!line ? (
        <View className="gap-s3">
          {idleNow.recents.length ? <View className="gap-s1"><Text size="caption" strong tone="label">Recent searches</Text><View className="flex-row flex-wrap gap-s2">{idleNow.recents.map((r) => <Chip key={r} onPress={() => setQ(r)}>{r}</Chip>)}</View></View> : null}
          {idleNow.chats.length ? <View className="gap-s1"><Text size="caption" strong tone="label">Recent chats</Text><Card flush>{idleNow.chats.map((r, i) => <View key={r.key}>{i ? <Divider /> : null}{hit(r)}</View>)}</Card></View> : null}
          {loaded ? <View className="gap-s1"><Text size="caption" strong tone="label">Go to</Text><Card flush>{idleNow.places.map((r, i) => <View key={r.key}>{i ? <Divider /> : null}{hit(r)}</View>)}</Card></View> : <LoadingState rows={3} />}
        </View>
      ) : (
        <View className="gap-s3">
          {secs.map((s) => {
            const shown = open[s.key] ? s.rows : s.rows.slice(0, SHOW);
            return (
              <View key={s.key} className="gap-s1">
                <Text size="caption" strong tone="label">{s.label}</Text>
                {shown.length ? <Card flush>{shown.map((r, i) => <View key={r.key}>{i ? <Divider /> : null}{hit(r)}</View>)}</Card> : null}
                {s.rows.length > SHOW && !open[s.key] ? <View className="self-start"><Button kind="ghost" size="sm" label={`Show all ${s.rows.length}`} onPress={() => setOpen((o) => ({ ...o, [s.key]: true }))} /></View> : null}
                {(s.notes ?? []).map((n) => <Text key={n} size="caption" tone="faint">{n}</Text>)}
              </View>
            );
          })}
          {pending ? <Text size="caption" tone="faint">Looking.</Text> : null}
          {!pending && !secs.length && loaded ? <Card><EmptyState title="Nothing found" body={`Nothing matches "${line}". Enter asks ${assistant}.`} /></Card> : null}
          {[...Object.values(errs).filter(Boolean), ...(mentionNote ? [mentionNote] : [])].map((e) => <Text key={e} size="caption" tone="faint">{e}</Text>)}
        </View>
      )}
      <Sheet open={!!preview} onClose={() => setPreview(null)} title={preview?.file.name}>
        {preview ? (preview.state === "loading" ? <Text tone="faint">Opening.</Text>
          : preview.state.kind === "image" ? <Image source={{ uri: preview.state.uri }} accessibilityLabel={preview.file.name} style={{ width: "100%", height: 300 }} resizeMode="contain" />
          : preview.state.kind === "text" ? <View className="gap-s1"><Text mono size="caption" selectable>{preview.state.text}</Text>{preview.state.truncated ? <Text size="caption" tone="faint">The start of the file only.</Text> : null}</View>
          : <Text tone="muted">{preview.state.note}</Text>) : null}
      </Sheet>
    </View>
  );
}
