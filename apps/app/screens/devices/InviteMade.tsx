import { useState } from "react";
import { Linking, Platform, Share, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Button, Card, Chip, PressableScale, SpaceTile, Text, showToast } from "@vyre/ui";
import { emailIt } from "./invite.js";

/**
 * What the person sees once an invitation is made: the space's mark and who it is for, the invite code (tap it to copy), and two ways to send it, Copy link and Email it.
 * Email it opens the person's own mail with the link and one line; Vyre sends nothing itself.
 */
export function InviteMade({ space, who, role, line, code, link }: { space: { id: string; name: string; logo?: string | null }; who: string; role: string; line: string; code: string; link: string }) {
  const [copied, setCopied] = useState("");
  const copy = (what: string, text: string) => { Clipboard.setStringAsync(text).catch(() => {}); setCopied(what); showToast("Copied"); setTimeout(() => setCopied((c) => (c === what ? "" : c)), 2000); };
  const email = () => {
    const e = emailIt(space.name, link);
    if (Platform.OS === "web") void Linking.openURL(e.mailto).catch(() => {}); else void Share.share({ title: e.subject, message: e.body }).catch(() => {});
  };
  const shown = code || link;
  return (
    <Card className="max-w-read gap-s4">
      <View className="flex-row items-center gap-s3">
        <SpaceTile space={space} size={40} />
        <View className="min-w-0 flex-1">
          <Text strong size="headline" numberOfLines={1}>{`Invitation for ${who}`}</Text>
          <Text size="secondary" tone="label" numberOfLines={1}>{`${role} · ${line}`}</Text>
        </View>
      </View>
      <PressableScale accessibilityRole="button" accessibilityLabel={`Invite code ${shown}. Tap to copy.`} onPress={() => copy("code", shown)} depth={0.99}>
        <View className="items-center gap-s2 rounded-card border border-edge bg-surface-3 px-s4 py-s5">
          <Text mono strong size="page" numberOfLines={code ? 1 : 3} className="text-center">{shown}</Text>
          {copied === "code" ? <Chip tone="ok" icon="check">Copied</Chip> : <Text size="caption" tone="label">Tap to copy</Text>}
        </View>
      </PressableScale>
      <View className="flex-row flex-wrap gap-s2">
        <Button kind="primary" label={copied === "link" ? "Copied" : "Copy link"} onPress={() => copy("link", link)} />
        <Button label="Email it" onPress={email} />
      </View>
    </Card>
  );
}
