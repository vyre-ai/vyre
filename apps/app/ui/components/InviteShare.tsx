import { useState } from "react";
import { Platform, View } from "react-native";
import { inviteModules } from "../lib/invite-mark.js";
import { Button } from "./Button";
import { Card } from "./Card";
import { Text } from "./Text";

/**
 * An invite: the link, Copy, and the mark a phone can scan. The role and the expiry sit with the screen's RolePicker.
 */
export function InviteShare({ link, onCopy }: { link: string; onCopy?: (link: string) => void }) {
  const [said, setSaid] = useState(false);
  const modules = link ? inviteModules(link) : null;
  const copy = () => {
    if (onCopy) onCopy(link);
    else if (Platform.OS === "web" && typeof navigator !== "undefined" && navigator.clipboard) void navigator.clipboard.writeText(link);
    setSaid(true);
    setTimeout(() => setSaid(false), 1500);
  };
  return (
    <View className="gap-s4">
      <Card>
        <View className="gap-s3">
          <Text size="caption" strong tone="label">Invite link</Text>
          <Text selectable>{link || "The link appears here."}</Text>
          {modules ? (
            <View accessibilityLabel="Invite mark" className="self-start bg-surface p-s2">
              {modules.map((row, y) => (
                <View key={y} className="flex-row">
                  {row.map((on, x) => <View key={x} className={on ? "bg-text" : "bg-surface"} style={{ width: 5, height: 5 }} />)}
                </View>
              ))}
            </View>
          ) : null}
        </View>
      </Card>
      <Button kind="secondary" icon="copy" label={said ? "Copied" : "Copy link"} disabled={!link} onPress={copy} />
    </View>
  );
}
