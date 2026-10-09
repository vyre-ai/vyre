// "Link this chat to Northwind?" (R031-41): when the person's last message names a client, a contact or a project of the Space, offer to link the chat to it. Linking keeps the chat private to its people;
// sharing it on the record's timeline is a separate step. Asked once per name per chat, and a No is remembered.
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Text, showToast } from "@vyre/ui";
import { callT } from "../../src/real/call-tool";

type Sug = { urn: string; type: string; title: string };

export function LinkSuggestion({ chat, text }: { chat: string; text: string }) {
  const [sug, setSug] = useState<Sug | null>(null);
  const said = useRef(new Set<string>());
  useEffect(() => {
    setSug(null);
    if (text.trim().length < 4) return;
    let live = true;
    const t = setTimeout(() => {
      void callT<{ suggestions?: Sug[] }>("work.link.suggest", { text }).then((r) => {
        if (!live || r.error) return;
        const next = (r.data?.suggestions ?? []).find((s) => !said.current.has(s.urn));
        if (next) setSug(next);
      });
    }, 800);
    return () => { live = false; clearTimeout(t); };
  }, [text]);
  if (!sug) return null;
  const done = () => { said.current.add(sug.urn); setSug(null); };
  const link = async () => {
    const r = await callT("work.chat.link", { chat, record: sug.urn });
    if (r.error) showToast(r.error.message || "That did not go through.");
    else showToast(`Linked to ${sug.title}. The chat stays private to its people.`);
    done();
  };
  return (
    <View className="px-s4 pb-s2">
      <Banner tone="plain">
        <View className="gap-s2">
          <Text>{`Link this chat to ${sug.title}?`}</Text>
          <View className="flex-row gap-s2">
            <Button kind="primary" size="sm" label="Link" onPress={() => void link()} />
            <Button kind="ghost" size="sm" label="No" onPress={done} />
          </View>
        </View>
      </Banner>
    </View>
  );
}
