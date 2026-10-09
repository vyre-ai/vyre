import { useCallback, useEffect, useState } from "react";
import { Linking, View } from "react-native";
import { Banner, BlockScreen, Button, ErrorState, Field, LoadingState, Row, SectionLabel, Sheet, Text, showToast } from "@vyre/ui";
import type { BlockHandlers, BlockScreenData } from "@vyre/ui";
import { useUiTheme } from "@vyre/ui";
import { Page } from "../places/Frame";
import { tool } from "../../src/real/box";
import { actInput, getInput, moveAction, outcome } from "./module-view.js";

type Frame = BlockScreenData & { title?: string; from?: string };
type Preview = { title: string; words: { label: string; value: string }[]; asked: { hash: string; token: string }; again: () => Promise<void> };

/**
 * A module's view, drawn by Vyre. The module only DESCRIBES it (its manifest's `views`); the server reads that, calls the module's own tool and answers a small frame (core/views, views.get), and this
 * draws the screen the answer describes (apps/app/ui/blocks: one description, drawn from blocks) with Vyre's own components. Actions go back as ids (views.act). No module code runs in this window. An action that sends something
 * outward shows its exact words first and sends only on a second yes.
 */
export function ViewHost({ module, view, label, initialQ }: { module: string; view: string; label: string; initialQ?: string }) {
  const [frame, setFrame] = useState<Frame | null>(null);
  const [trail, setTrail] = useState<Frame[]>([]);
  const [q, setQ] = useState(initialQ ?? "");
  const [arg, setArg] = useState<{ name?: string; placeholder?: string } | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState<{ tone: "plain" | "warn" | "err"; text: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
    const [busy, setBusy] = useState(false);
  const surface = useUiTheme().phone ? "phone" : "app";
  const [detailId, setDetailId] = useState<string | undefined>();

  const load = useCallback(async (text: string) => {
    setError("");
    try { setFrame(await tool<Frame>("views.get", getInput({ module, view, q: text, surface }))); setTrail([]); }
    catch (e) { setError(e instanceof Error ? e.message : "This view did not load."); }
  }, [module, view, surface]);
  useEffect(() => { void load(initialQ ?? ""); }, [load, initialQ]);
  useEffect(() => {
    tool<{ commands: { module: string; id: string; arg?: { name?: string; placeholder?: string } }[] }>("views.list", {}).then((r) => setArg(r.commands.find((c) => c.module === module && c.id === view)?.arg ?? null)).catch(() => {});
  }, [module, view]);

  const settle = async (r: unknown) => {
    const o = outcome(r) as any;
    setNote(null);
    if (o.effect === "frame") { setTrail((t) => (frame ? [...t, frame] : t)); setFrame(o.frame); return; }
    if (o.effect === "reload") { showToast(o.said); await load(q); return; }
    if (o.effect === "open") { await Linking.openURL(o.url).catch(() => setNote({ tone: "err", text: "That link did not open." })); return; }
    if (o.effect === "copy") { showToast("Copied."); return; }
    if (o.effect === "command") { setNote({ tone: "plain", text: "That opens another view of this module; pick it in the sidebar." }); return; }
    setNote({ tone: o.effect === "held" ? "plain" : o.effect === "needs" ? "warn" : "err", text: o.message });
  };

  /** One action. An outward one answers a preview first; "Send" in the sheet calls it again with the preview's proof. */
  const act = async (a: Omit<Parameters<typeof actInput>[0], "asked" | "surface">, asked: Preview["asked"] | null = null): Promise<void> => {
    setBusy(true);
    try {
      const r = await tool("views.act", actInput({ ...a, asked, surface }));
      const o = outcome(r) as any;
      if (o.effect === "preview") { setPreview({ title: o.title, words: o.words, asked: o.asked, again: async () => { setPreview(null); await act(a, o.asked); } }); return; }
      await settle(r);
    } catch (e) { setNote({ tone: "err", text: e instanceof Error ? e.message : "That did not work." }); }
    finally { setBusy(false); }
  };

  const open = (row: any, block?: string) => tool<Frame>("views.get", getInput({ module, view, id: row.id, surface, block })).then((f) => { setDetailId(row.id); setTrail((t) => (frame ? [...t, frame] : t)); setFrame(f); }).catch((e) => setNote({ tone: "err", text: e instanceof Error ? e.message : "That did not open." }));
  const back = trail.length ? () => { const t = [...trail]; const f = t.pop()!; setTrail(t); setFrame(f); } : undefined;
  const from = frame?.from ? `From ${frame.from}` : undefined;

  const handlers: BlockHandlers = {
    open: (block, row) => void open(row, block),
    act: (block, action, id) => void act({ module, view, action, id: id ?? detailId, q, block }),
    move: (block, row, to) => { const m = moveAction(row, to, row.column, row.actions); if (m) void act({ module, view, block, ...m }); },
    filter: (_block, text) => { setQ(text); void load(text); },
    submit: (block, form, fields) => void act({ module, view, block, action: "submit", form, fields }),
  };
  const kinds = new Set(Object.values(frame?.blocks ?? {}).map((b) => b.type));
  let body: React.ReactNode = <LoadingState />;
  if (error) body = <ErrorState title="This view did not load" reason={error} retry={() => void load(q)} />;
  else if (frame) body = <BlockScreen screen={frame} handlers={handlers} />;

  return (
    <Page title={frame?.title || label} back="/u/now">
      {back ? <View className="flex-row"><Button label="Back" size="sm" onPress={back} /></View> : null}
      {from ? <Text size="caption" tone="label">{from}</Text> : null}
      {arg && frame && !trail.length && (kinds.has("list") || kinds.has("board") || kinds.has("summary") || kinds.has("table")) ? <Field label={arg.placeholder ?? "Search"} value={q} onChangeText={setQ} placeholder={arg.placeholder} /> : null}
      {arg && frame && !trail.length ? <View className="flex-row"><Button label="Search" size="sm" onPress={() => void load(q)} /></View> : null}
      {note ? <Banner tone={note.tone}>{note.text}</Banner> : null}
      {body}
      <Sheet open={Boolean(preview)} onClose={() => setPreview(null)} title={preview?.title || "Check before it goes"}>
        <SectionLabel>This is exactly what will be sent</SectionLabel>
        {(preview?.words ?? []).map((w) => <Row key={w.label} title={w.label} sub={w.value} />)}
        <View className="mt-s3 flex-row gap-s2">
          <Button kind="primary" label="Send" loading={busy} onPress={() => { const p = preview; if (p) void p.again(); }} />
          <Button label="Cancel" onPress={() => setPreview(null)} />
        </View>
      </Sheet>
    </Page>
  );
}
