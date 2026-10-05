// What each connection may be used from: one card per connection (Google, mail, Apps Script, an MCP server) with a chip per surface. Letting Agents use one is the person's own act
// (the app's box call asks for it); everything else, and taking access away, is immediate and shows an Undo.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Card, Chip, Divider, EmptyState, ErrorState, LoadingState, Row, Text, showToast } from "@vyre/ui";
import { connections } from "./source-real";
import { SURFACES, SURFACE_LABEL, since, words, type Conn } from "./model";

export default function RealAccess() {
  const [list, setList] = useState<Conn[] | null>(null);
  const [problem, setProblem] = useState("");
  const load = useCallback(() => { connections.connections().then((x) => { setList(x); setProblem(""); }).catch((e) => setProblem(words(e))); }, []);
  useEffect(load, [load]);
  const toggle = (c: Conn, surface: string, next: boolean) => {
    const label = SURFACE_LABEL[surface];
    const before = c.surfaces;
    // Optimistic, except Agents: that grant waits for the person's proof, so it shows only once given.
    if (!(next && surface === "agents")) setList((l) => l && l.map((x) => (x.id === c.id ? { ...x, surfaces: next ? [...new Set([...x.surfaces, surface])] : x.surfaces.filter((s) => s !== surface) } : x)));
    (next ? connections.grantSurface(c.id, surface) : connections.revokeSurface(c.id, surface)).then(() => {
      if (next) { setList((l) => l && l.map((x) => (x.id === c.id ? { ...x, surfaces: [...new Set([...x.surfaces, surface])] } : x))); showToast(`${label} granted for ${c.label}.`); }
    }).catch((e) => { setList((l) => l && l.map((x) => (x.id === c.id ? { ...x, surfaces: before } : x))); if ((e as { code?: string }).code !== "cancelled" && (e as { code?: string }).code !== "presence_refused") showToast(`Could not change ${label} for ${c.label}: ${words(e)}`); });
  };
  if (problem && !list) return <ErrorState title="Connections did not load" reason={problem} retry={load} />;
  if (!list) return <LoadingState rows={3} />;
  if (!list.length) return <Card><EmptyState title="Nothing connected yet" body="Add a service, an MCP server or an account, and it is listed here with where it may be used." /></Card>;
  return (
    <View className="gap-s3 pt-s2">
      <Text tone="muted" size="secondary">Where each connection may be used. Assistants never see a credential; every use is logged.</Text>
      <Card flush>
        {list.map((c, i) => (
          <View key={c.id}>{i ? <Divider /> : null}
            <Row title={<View className="flex-row items-center gap-s2"><Text>{c.label}</Text><Text size="caption" tone="faint">{c.word}</Text></View>} sub={
              <View className="gap-s1 pt-s1">
                {!c.ready ? <Text size="secondary" tone="warn">{c.needs.length ? `Needs: ${c.needs.map((n) => n.need || n.module).join(", ")}` : "Not ready"}</Text> : null}
                {c.capabilities.length ? <Text size="secondary" tone="label">{c.capabilities.join(", ")}</Text> : null}
                <Text size="caption" tone="faint">{`Last used ${since(c.lastUsed)}`}</Text>
                <View className="flex-row flex-wrap gap-s2 pt-s1">{SURFACES.map((s) => <Chip key={s} selected={c.surfaces.includes(s)} onPress={() => toggle(c, s, !c.surfaces.includes(s))}>{SURFACE_LABEL[s]}</Chip>)}</View>
              </View>} />
          </View>
        ))}
      </Card>
    </View>
  );
}
