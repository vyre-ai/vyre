import { useState } from "react";
import { TextInput, View } from "react-native";
import { facesFor } from "../../src/theme/fonts";
import { useUiTheme } from "../theme";
import { IconButton } from "./Button";

/**
 * The ask field (ui-review Memory 1): surface-3, radius 18, 48 high, the send button inside at the right. Enter sends. Not a form field: it has no label
 * above it, so `label` is its accessible name and its placeholder says what to type.
 */
export function Composer({ value, onChangeText, onSend, placeholder, label, sendLabel = "Ask" }: { value: string; onChangeText: (v: string) => void; onSend: () => void; placeholder?: string; label: string; sendLabel?: string }) {
  const { color, resolved } = useUiTheme();
  const [focus, setFocus] = useState(false);
  const faces = facesFor(resolved.font);
  return (
    <View style={{ height: 48, borderRadius: 18, borderWidth: 1, borderColor: focus ? color.accent : color.edge, backgroundColor: color["surface-3"], flexDirection: "row", alignItems: "center", paddingLeft: 16, paddingRight: 6 }}>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        onSubmitEditing={onSend}
        returnKeyType="send"
        placeholder={placeholder}
        placeholderTextColor={color.label}
        accessibilityLabel={label}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        style={[faces.regular, { flex: 1, minWidth: 0, color: color.text, fontSize: 16, outlineStyle: "none" } as any]}
      />
      <IconButton icon="send" label={sendLabel} kind="primary" onPress={onSend} />
    </View>
  );
}
