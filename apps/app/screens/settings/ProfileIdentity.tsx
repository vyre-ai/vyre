// The identity on Your profile: one face, the name, the @username and the role. The face is the photo when there is one, otherwise the look.
// Hover (a tap on a phone) shows Change photo. The menu beside the face changes the photo, opens the look picker, or removes the photo.
import { useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, View } from "react-native";
import { Avatar, Chip, Field, Icon, IconButton, Menu, Text, markRef, showToast, useUiTheme } from "@vyre/ui";
import { displayNameOk } from "./account-model";
import { profileLine } from "./profile-model.js";

const say = (e: unknown) => (e instanceof Error && e.message ? e.message : "That did not go through.");

async function copyUsername(handle: string) {
  const text = handle.replace(/^@/, "");
  try {
    if (Platform.OS === "web" && typeof navigator !== "undefined" && navigator.clipboard) await navigator.clipboard.writeText(text);
    else { const mod = await import("expo-clipboard"); await mod.setStringAsync(text); }
    showToast("Copied.");
  } catch {
    showToast("Copying did not work here. Select the text and copy it.");
  }
}

export function ProfileIdentity({ name, handle, role, spaceName, look, personId, canEditName, hasPhoto, busy, onChangePhoto, onRemovePhoto, onUseLook, onRename }: {
  name: string; handle: string; role: string; spaceName: string; look?: string; personId?: string;
  canEditName: boolean; hasPhoto: boolean; busy: boolean;
  onChangePhoto: () => void; onRemovePhoto: () => void; onUseLook: () => void;
  onRename: (next: string) => Promise<void>;
}) {
  const { phone, color, resolved } = useUiTheme();
  const [over, setOver] = useState(false);
  const [armed, setArmed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const lock = useRef(false);
  const ink = resolved.scheme === "paper" ? "primary-ink" : "text";
  const showOverlay = !busy && (over || (phone && armed));
  const face = () => {
    if (busy) return;
    if (phone && !armed) { setArmed(true); return; }
    onChangePhoto();
  };
  const commit = async () => {
    if (lock.current) return;
    const v = draft.trim();
    if (!displayNameOk(v)) { showToast("Use one line with a letter, up to 60 characters."); return; }
    lock.current = true;
    try { await onRename(v); setEditing(false); }
    catch (e) { showToast(say(e)); }
    finally { lock.current = false; }
  };
  const cancel = () => { if (!lock.current) setEditing(false); };
  const items = [
    { label: "Change photo", onPress: () => { if (!busy) onChangePhoto(); } },
    { label: "Use a look instead", onPress: () => { if (!busy) onUseLook(); } },
    ...(hasPhoto ? [{ label: "Remove photo", danger: true, onPress: () => { if (!busy) onRemovePhoto(); } }] : []),
  ];
  return (
    <View className="gap-s4">
      <View className="flex-row items-start gap-s4">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Change photo"
          onHoverIn={() => setOver(true)}
          onHoverOut={() => setOver(false)}
          onPress={face}
          style={{ width: 96, height: 96, borderRadius: 48, overflow: "hidden" }}
        >
          <Avatar of={markRef("person", name, personId, look || undefined)} size={96} />
          {busy ? (
            <View style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center", backgroundColor: color.scrim }}>
              <ActivityIndicator color={color.text} />
            </View>
          ) : showOverlay ? (
            <View style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center", gap: 4, padding: 8, backgroundColor: color.scrim }}>
              <Icon name="camera" size={20} tone={ink} />
              <Text size="caption" style={{ color: color[ink], textAlign: "center" }}>Change photo</Text>
            </View>
          ) : null}
        </Pressable>
        <View className="min-w-0 flex-1 gap-s2">
          {/* On a wide page the menu sits with the name. On a phone the name takes the row and the menu stays at its end, still beside the face. */}
          <View className={phone ? "flex-row items-center gap-s2" : "max-w-full flex-row items-center gap-s2 self-start"}>
            <View className={phone ? "min-w-0 flex-1" : "min-w-0 shrink"}>
              {editing ? (
                <Field label="Your name" value={draft} onChangeText={setDraft} autoFocus onSubmit={() => void commit()} onKey={(key) => { if (key === "Escape") cancel(); }} help="One line, up to 60 characters. Your username stays the same." />
              ) : canEditName ? (
                <Pressable accessibilityRole="button" accessibilityLabel="Change name" onPress={() => { setDraft(name); setEditing(true); }} style={phone ? { minHeight: 44, justifyContent: "center" } : undefined}>
                  <Text size="page" strong numberOfLines={2}>{name}</Text>
                </Pressable>
              ) : <Text size="page" strong numberOfLines={2}>{name}</Text>}
            </View>
            <View style={{ flexShrink: 0 }}>
              <Menu align="end" items={items} trigger={<IconButton icon="more" label="Photo and look" touch={phone} />} />
            </View>
          </View>
          {handle ? (
            <View className="flex-row flex-wrap items-center gap-s1">
              <Text size="caption" tone="muted" numberOfLines={1}>{handle}</Text>
              <IconButton icon="copy" label="Copy username" touch={phone} onPress={() => void copyUsername(handle)} />
            </View>
          ) : null}
          <Chip>{role}</Chip>
        </View>
      </View>
      <Text size="secondary" tone="muted">{profileLine(spaceName)}</Text>
    </View>
  );
}
