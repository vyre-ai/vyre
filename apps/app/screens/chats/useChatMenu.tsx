// The chat row menu, shared by the Chat list and a project's chats: Open, Move to a project (work.chat.move, the one ProjectPicker), Rename (work.chat.rename), and your own Pin and Mute.
// `menu(id)` is what ChatsList takes; `sheets` is drawn once beside the list. `rows` is only read for a chat's current project and title.
import { useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Button, Field, Sheet, showToast } from "@vyre/ui";
import { callT } from "../../src/real/call-tool";
import { chatPrefs, useChatPrefs } from "../../src/state/chat-prefs";
import { ProjectPicker } from "../../src/chat/ProjectPicker";
import { listProjects, moveChat, type ProjectRef } from "../../src/chat/useChatProject";
import { refresh } from "../../src/state/live";

export function useChatMenu(rows: readonly { id: string; title: string; project: string }[], onChanged?: () => void) {
  const router = useRouter();
  const prefs = useChatPrefs();
  const [moving, setMoving] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [projects, setProjects] = useState<ProjectRef[]>([]);
  useEffect(() => { if (moving) void listProjects().then(setProjects); }, [moving]);
  const menu = (id: string) => [
    { label: "Open", onPress: () => router.push({ pathname: "/u/chats/[id]", params: { id } }) },
    { label: "Move to a project", onPress: () => setMoving(id) },
    { label: "Rename", onPress: () => setRenaming({ id, title: rows.find((c) => c.id === id)?.title ?? "" }) },
    { label: prefs.pinned.includes(id) ? "Unpin" : "Pin", onPress: () => chatPrefs.setPinned(id, !prefs.pinned.includes(id)) },
    { label: prefs.muted.includes(id) ? "Unmute" : "Mute", onPress: () => chatPrefs.setMuted(id, !prefs.muted.includes(id)) },
  ];
  const done = (error: string | null, ok: string) => { if (error) showToast(error); else { showToast(ok); void refresh(); onChanged?.(); } };
  const sheets = (
    <>
      <Sheet open={!!moving} onClose={() => setMoving(null)} title="Move to a project">
        <ProjectPicker projects={projects} current={projects.find((x) => x.name === rows.find((c) => c.id === moving)?.project) ?? null} onBack={() => setMoving(null)}
          onPick={async (slug) => { const id = moving as string; setMoving(null); if (!slug) return; done(await moveChat(id, slug), "Moved to the project."); }} />
      </Sheet>
      <Sheet open={!!renaming} onClose={() => setRenaming(null)} title="Rename chat">
        {renaming ? (
          <View className="gap-s3">
            <Field name="Chat name" value={renaming.title} onChangeText={(t) => setRenaming({ ...renaming, title: t })} />
            <View className="self-start"><Button kind="primary" size="sm" label="Save" onPress={async () => { const r0 = renaming; setRenaming(null); if (r0.title.trim()) { const r = await callT("work.chat.rename", { chat: r0.id, title: r0.title.trim() }); done(r.error ? r.error.message || "That did not go through." : null, "Renamed."); } }} /></View>
          </View>
        ) : null}
      </Sheet>
    </>
  );
  return { menu, sheets };
}
