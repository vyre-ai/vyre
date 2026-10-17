import { useState } from "react";
import { Platform, Share, View } from "react-native";
import { Button } from "./Button";
import { Card } from "./Card";
import { Text } from "./Text";

/**
 * An invite: the link, with Copy and Share. No code to scan: the person sends the link. The role and the expiry sit with the screen's RolePicker.
 */
export function InviteShare({ link, onCopy }: { link: string; onCopy?: (link: string) => void }) {
  const [said, setSaid] = useState(false);
  const copy = () => {
    if (onCopy) onCopy(link);
    else if (Platform.OS === "web" && typeof navigator !== "undefined" && navigator.clipboard) void navigator.clipboard.writeText(link);
    setSaid(true);
    setTimeout(() => setSaid(false), 1500);
  };
  const share = () => {
    if (Platform.OS === "web" && typeof navigator !== "undefined" && (navigator as { share?: unknown }).share) void (navigator as unknown as { share: (d: { url: string }) => Promise<void> }).share({ url: link }).catch(() => {});
    else void Share.share({ message: link }).catch(() => {});
  };
  return (
    <View className="gap-s4">
      <Card>
        <View className="gap-s3">
          <Text size="caption" strong tone="label">Invite link</Text>
          <Text selectable>{link || "The link appears here."}</Text>
        </View>
      </Card>
      <View className="flex-row gap-s3">
        <Button kind="secondary" icon="copy" label={said ? "Copied" : "Copy link"} disabled={!link} onPress={copy} />
        <Button kind="secondary" icon="share" label="Share" disabled={!link} onPress={share} />
      </View>
    </View>
  );
}
