// Design changes: the owner's page for what an agent or the Engineer proposed (core/design). A screen is drawn before and after with the same renderer the app uses; custom styling is shown as
// text; each says what it reads and runs. Yes makes it the space's, No keeps what was there. Only a person's tap answers.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { BlockScreen, Button, Card, EmptyState, ErrorState, LoadingState, SectionLabel, Text, showToast, useUiTheme } from "@vyre/ui";
import { Page } from "../places/Frame";
import { tool } from "../../src/real/box";
import { byWords, decision, headline, usesLine, type Proposal } from "./proposals-model";

export type Resolved = { before: any | null; after: any | null };

export function DesignChanges() {
  const { phone } = useUiTheme();
  const [items, setItems] = useState<Proposal[] | null>(null);
  const [shots, setShots] = useState<Record<number, Resolved>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  const surface = phone ? "phone" : "app";

  const load = useCallback(async () => {
    setError("");
    try {
      const r = await tool<{ proposals: Proposal[] }>("design.proposals", { status: "pending" });
      setItems(r.proposals);
      const next: Record<number, Resolved> = {};
      await Promise.all(r.proposals.filter((p) => p.kind === "screen").map(async (p) => {
        const one = (screen: any) => (screen ? tool<any>("views.preview", { screen, surface }).catch(() => null) : Promise.resolve(null));
        const [before, after] = await Promise.all([one(p.before), one(p.after)]);
        next[p.id] = { before, after };
      }));
      setShots(next);
    } catch (e) { setError(e instanceof Error ? e.message : "This did not load."); }
  }, [surface]);
  useEffect(() => { void load(); }, [load]);

  const answer = async (p: Proposal, yes: boolean) => {
    setBusy(p.id);
    try { await tool("design.decide", decision(p, yes)); showToast(yes ? "Done. It is live." : "Kept as it was."); await load(); }
    catch (e) { showToast(e instanceof Error ? e.message : "That did not work."); }
    finally { setBusy(null); }
  };

  return <DesignChangesView items={items} shots={shots} phone={phone} busy={busy} error={error} onAnswer={(p, yes) => void answer(p, yes)} onRetry={() => void load()} />;
}

/** The page itself, from what it is given: the container above reads the box, the gallery gives it a sample. */
export function DesignChangesView({ items, shots, phone, busy, error, onAnswer, onRetry }: { items: Proposal[] | null; shots: Record<number, Resolved>; phone: boolean; busy: number | null; error: string; onAnswer: (p: Proposal, yes: boolean) => void; onRetry: () => void }) {
  return (
    <Page title="Design changes" sub="What agents proposed for your screens. Nothing changes until you say yes." back="/u/settings">
      {error ? <ErrorState title="This did not load" reason={error} retry={onRetry} /> : items === null ? <LoadingState /> : !items.length ? <EmptyState title="Nothing waiting" body="When an agent or the Engineer proposes a screen or a style, you see it here, before and after." /> : (
        <View className="gap-s4">
          {items.map((p) => (
            <Card key={p.id} title={headline(p)}>
              <View className="gap-s3">
                <Text size="secondary" tone="label">{`${byWords(p.by)}: ${p.why}`}</Text>
                <Text size="secondary">{usesLine(p)}</Text>
                {p.kind === "screen" ? (
                  <View className={phone ? "gap-s3" : "flex-row items-start gap-s4"}>
                    <View style={phone ? undefined : { flex: 1 }} className="min-w-0 gap-s2"><SectionLabel>Now</SectionLabel>{shots[p.id]?.before ? <BlockScreen screen={shots[p.id].before} /> : <Text tone="label">Nothing yet. This is new.</Text>}</View>
                    <View style={phone ? undefined : { flex: 1 }} className="min-w-0 gap-s2"><SectionLabel>Proposed</SectionLabel>{shots[p.id]?.after ? <BlockScreen screen={shots[p.id].after} /> : <Text tone="label">Could not draw it.</Text>}</View>
                  </View>
                ) : (
                  <View className="gap-s2"><SectionLabel>Proposed styling</SectionLabel><Text mono size="secondary">{String(p.after)}</Text>{p.before ? <><SectionLabel>Now</SectionLabel><Text mono size="secondary">{String(p.before)}</Text></> : null}</View>
                )}
                <View className="flex-row flex-wrap gap-s2">
                  <Button kind="primary" label="Yes, use it" loading={busy === p.id} onPress={() => onAnswer(p, true)} />
                  <Button label="Not now" disabled={busy === p.id} onPress={() => onAnswer(p, false)} />
                </View>
              </View>
            </Card>
          ))}
        </View>
      )}
    </Page>
  );
}
