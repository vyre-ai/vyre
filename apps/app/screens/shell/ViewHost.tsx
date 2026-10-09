import { useCallback, useEffect, useState } from "react";
import { Linking, View } from "react-native";
import { Banner, Board, Button, Card, Chip, EmptyState, ErrorState, Field, LoadingState, Meter, Row, SectionLabel, Sheet, Text, showToast } from "@vyre/ui";
import { Page } from "../places/Frame";
import { tool } from "../../src/real/box";
import { actInput, actionsOf, barHeights, getInput, initialValues, missingFields, moveAction, outcome } from "./module-view.js";

type Frame = { v: number; kind: string; title?: string; from?: string; rows?: any[]; columns?: any[]; cards?: { label: string; value: string }[]; chart?: any; body?: string; fields?: any[]; actions?: any[]; empty?: string; message?: string; submit?: { title: string; outward?: boolean }; id?: string; need?: any };
type Preview = { title: string; words: { label: string; value: string }[]; asked: { hash: string; token: string }; again: () => Promise<void> };

/**
 * A module's view, drawn by Vyre. The module only DESCRIBES it (its manifest's `views`); the server reads that, calls the module's own tool and answers a small frame (core/views, views.get), and this
 * draws the frame with Vyre's own components: a list, a board, a summary, a detail or a form. Actions go back as ids (views.act). No module code runs in this window. An action that sends something
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
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [detailId, setDetailId] = useState<string | undefined>();

  const load = useCallback(async (text: string) => {
    setError("");
    try { setFrame(await tool<Frame>("views.get", getInput({ module, view, q: text }))); setTrail([]); }
    catch (e) { setError(e instanceof Error ? e.message : "This view did not load."); }
  }, [module, view]);
  useEffect(() => { void load(initialQ ?? ""); }, [load, initialQ]);
  useEffect(() => {
    tool<{ commands: { module: string; id: string; arg?: { name?: string; placeholder?: string } }[] }>("views.list", {}).then((r) => setArg(r.commands.find((c) => c.module === module && c.id === view)?.arg ?? null)).catch(() => {});
  }, [module, view]);

  const settle = async (r: unknown) => {
    const o = outcome(r) as any;
    setNote(null);
    if (o.effect === "frame") { setTrail((t) => (frame ? [...t, frame] : t)); setFrame(o.frame); setValues(initialValues(o.frame)); return; }
    if (o.effect === "reload") { showToast(o.said); await load(q); return; }
    if (o.effect === "open") { await Linking.openURL(o.url).catch(() => setNote({ tone: "err", text: "That link did not open." })); return; }
    if (o.effect === "copy") { showToast("Copied."); return; }
    if (o.effect === "command") { setNote({ tone: "plain", text: "That opens another view of this module; pick it in the sidebar." }); return; }
    setNote({ tone: o.effect === "held" ? "plain" : o.effect === "needs" ? "warn" : "err", text: o.message });
  };

  /** One action. An outward one answers a preview first; "Send" in the sheet calls it again with the preview's proof. */
  const act = async (a: Omit<Parameters<typeof actInput>[0], "asked">, asked: Preview["asked"] | null = null): Promise<void> => {
    setBusy(true);
    try {
      const r = await tool("views.act", actInput({ ...a, asked }));
      const o = outcome(r) as any;
      if (o.effect === "preview") { setPreview({ title: o.title, words: o.words, asked: o.asked, again: async () => { setPreview(null); await act(a, o.asked); } }); return; }
      await settle(r);
    } catch (e) { setNote({ tone: "err", text: e instanceof Error ? e.message : "That did not work." }); }
    finally { setBusy(false); }
  };

  const open = (row: any) => tool<Frame>("views.get", getInput({ module, view, id: row.id })).then((f) => { setDetailId(row.id); setTrail((t) => (frame ? [...t, frame] : t)); setFrame(f); }).catch((e) => setNote({ tone: "err", text: e instanceof Error ? e.message : "That did not open." }));
  const back = trail.length ? () => { const t = [...trail]; const f = t.pop()!; setTrail(t); setFrame(f); } : undefined;
  const from = frame?.from ? `From ${frame.from}` : undefined;

  const rowActions = (row: any, owner?: any) => actionsOf(row, owner?.actions).map((a) => <Button key={a.id} label={a.title} size="sm" onPress={() => void act({ module, view, action: a.id, id: row.id, q })} />);

  let body: React.ReactNode = <LoadingState />;
  if (error) body = <ErrorState title="This view did not load" reason={error} retry={() => void load(q)} />;
  else if (frame) {
    switch (frame.kind) {
      case "list":
        body = frame.rows?.length ? (
          <Card flush>{frame.rows.map((r) => <Row key={r.id} title={r.title} sub={r.subtitle} end={r.accessory ? <Chip>{r.accessory}</Chip> : undefined} onPress={() => void open(r)} />)}</Card>
        ) : <EmptyState title={frame.empty || "Nothing here."} />;
        break;
      case "board": {
        const cols = (frame.columns ?? []).map((c) => ({ id: c.id, title: c.title }));
        const items = (frame.columns ?? []).flatMap((c) => (c.rows ?? []).map((r: any) => ({ ...r, column: c.id })));
        body = items.length ? (
          <Board columns={cols} items={items} columnOf={(r: any) => r.column} keyOf={(r: any) => r.id}
            onMove={(r: any, to: string) => { const m = moveAction(r, to, r.column, r.actions); if (m) void act({ module, view, ...m }); }}
            renderCard={(r: any) => (
              <Card><Text strong>{r.title}</Text>{r.subtitle ? <Text tone="muted" size="caption">{r.subtitle}</Text> : null}<View className="mt-s2 flex-row flex-wrap gap-s2">{rowActions(r)}</View></Card>
            )} />
        ) : <EmptyState title={frame.empty || "Nothing here."} />;
        break;
      }
      case "summary":
        body = (
          <View className="gap-s3">
            <View className="flex-row flex-wrap gap-s3">{(frame.cards ?? []).map((c) => <Card key={c.label} className="min-w-[140px] flex-1"><Text size="caption" tone="label">{c.label}</Text><Text strong size="title">{c.value}</Text></Card>)}</View>
            {frame.chart ? <Card>{barHeights(frame.chart).map((b) => <View key={b.label} className="mb-s2"><Text size="caption" tone="label">{`${b.label}: ${b.value}`}</Text><Meter value={b.share} label={`${b.label} ${b.value}`} /></View>)}</Card> : <></>}
            {!(frame.cards?.length || frame.chart) ? <EmptyState title={frame.empty || "Nothing to count yet."} /> : null}
          </View>
        );
        break;
      case "detail":
        body = (
          <View className="gap-s3">
            {frame.body ? <Card><Text>{frame.body}</Text></Card> : null}
            {frame.fields?.length ? <Card flush>{frame.fields.map((f: any) => <Row key={f.label} title={f.label} sub={f.value} />)}</Card> : null}
            <View className="flex-row flex-wrap gap-s2">{(frame.actions ?? []).map((a: any) => <Button key={a.id} label={a.title} onPress={() => void act({ module, view, action: a.id, id: detailId })} />)}</View>
          </View>
        );
        break;
      case "form": {
        const miss = missingFields(frame, values);
        body = (
          <View className="gap-s3">
            {(frame.fields ?? []).map((f: any) => <Field key={f.name} label={f.label} value={values[f.name] ?? ""} multiline={f.type === "multiline"} kind={f.type === "number" ? "number" : "text"} onChangeText={(t) => setValues((v) => ({ ...v, [f.name]: t }))} />)}
            <View className="flex-row"><Button kind="primary" label={frame.submit?.title ?? "Send"} loading={busy} disabled={miss.length > 0} onPress={() => void act({ module, view, action: "submit", form: frame.id, fields: values })} /></View>
            {miss.length ? <Text size="caption" tone="label">{`Needed: ${miss.join(", ")}`}</Text> : null}
          </View>
        );
        break;
      }
      case "needs": case "held": case "error":
        body = <Banner tone={frame.kind === "error" ? "err" : frame.kind === "needs" ? "warn" : "plain"}>{frame.message ?? "That did not work."}</Banner>;
        break;
      default: body = <ErrorState title="This view is not one this app can draw yet" />;
    }
  }

  return (
    <Page title={frame?.title || label} back="/u/now">
      {back ? <View className="flex-row"><Button label="Back" size="sm" onPress={back} /></View> : null}
      {from ? <Text size="caption" tone="label">{from}</Text> : null}
      {arg && frame && !trail.length && (frame.kind === "list" || frame.kind === "board" || frame.kind === "summary") ? <Field label={arg.placeholder ?? "Search"} value={q} onChangeText={setQ} placeholder={arg.placeholder} /> : null}
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
