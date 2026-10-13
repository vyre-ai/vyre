import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Button, Card, Chip, Divider, EmptyState, IconButton, LoadingState, Row, showToast } from "@vyre/ui";
import { callT } from "../../src/real/call-tool";
import { dayOf } from "../../src/time/show.js";
import { isPromoted, memoryRows, withLesson } from "./memory-model.js";

/** 5. Memory: what this agent has learned, newest first. Its own writes (memory.writes by this agent) and the corrections people made to it. A lesson can become an instruction: it is added to AGENTS.md under "## Lessons" (agents.docs.set). */
export function AgentMemory({ name }: { name: string }) {
  const router = useRouter();
  const [rows, setRows] = useState<ReturnType<typeof memoryRows> | null>(null);
  const [doc, setDoc] = useState("");
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    void Promise.all([
      callT<{ writes?: any[] }>("memory.writes", { from: name, limit: 100 }),
      callT<{ heard?: any[] }>("memory.corrections", { suggested: true }),
      callT<{ files?: Record<string, string> }>("agents.docs.get", { agent: name }),
    ]).then(([w, h, d]) => { if (!live) return; setRows(memoryRows(name, w.error ? [] : w.data?.writes ?? [], h.error ? [] : h.data?.heard ?? [])); setDoc(String(d.data?.files?.["AGENTS.md"] ?? "")); });
    return () => { live = false; };
  }, [name, n]);
  const again = useCallback(() => setN((x) => x + 1), []);
  const forget = async (r: NonNullable<typeof rows>[number]) => { const x = await callT(r.forget.tool, r.forget.input); if (x.error) showToast(x.error.message || "That did not go through."); else again(); };
  const promote = async (text: string) => {
    const fresh = await callT<{ files?: Record<string, string> }>("agents.docs.get", { agent: name });
    if (fresh.error) { showToast(fresh.error.message || "That did not go through."); return; }
    const x = await callT("agents.docs.set", { agent: name, file: "AGENTS.md", text: withLesson(String(fresh.data?.files?.["AGENTS.md"] ?? ""), text) });
    if (x.error) showToast(x.error.message || "That did not go through."); else { showToast("Added to its instructions."); again(); }
  };
  if (rows === null) return <LoadingState rows={3} />;
  if (!rows.length) return <Card><EmptyState title="Nothing learned yet" body={`When you correct ${name} in a chat, or it keeps a note, it shows here with where it came from.`} /></Card>;
  return (
    <Card flush>
      {rows.map((r, i) => {
        const done = r.lesson && isPromoted(doc, r.text);
        const when = r.at ? dayOf(r.at) : "";
        return (
          <View key={r.id}>{i ? <Divider /> : null}
            <Row dense title={r.text} sub={[r.line, when, r.by].filter(Boolean).join(" · ")} onPress={r.href ? () => router.push(r.href as never) : undefined}
              end={<View className="flex-row items-center gap-s1"><Chip>{r.label}</Chip>
                {done ? <Chip>In its instructions</Chip> : r.lesson ? <Button size="sm" kind="ghost" label="Make it an instruction" onPress={() => void promote(r.text)} /> : null}
                <IconButton icon="trash" label={r.id.startsWith("heard:") ? "Undo this correction" : "Forget this"} onPress={() => void forget(r)} /></View>} />
          </View>
        );
      })}
    </Card>
  );
}
