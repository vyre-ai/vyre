import { View } from "react-native";
import * as P from "@rn-primitives/dialog";
import { cn } from "../lib/cn";
import { Text } from "./Text";
import { elevation } from "../lib/elevation";
import { PHONE_MAX, useUiTheme } from "../theme";
import { useWindowDimensions } from "react-native";

/** A bottom sheet on a phone, centred on a wide screen. Face ID, confirm, field editors. The caller owns `open`. */
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title?: string; children: React.ReactNode }) {
  const { width } = useWindowDimensions();
  const { resolved } = useUiTheme();
  const phone = width < PHONE_MAX;
  return (
    <P.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <P.Portal>
        <P.Overlay className="absolute inset-0 bg-scrim" onPress={onClose} />
        <View pointerEvents="box-none" className={cn("absolute inset-0", phone ? "justify-end" : "items-center justify-center")}>
          <P.Content style={elevation(resolved.scheme, 3)} className={cn("bg-surface-3 border border-edge-strong p-s4 gap-s3", phone ? "w-full rounded-t-sheet" : "w-full max-w-read rounded-sheet")}>
            {title ? <P.Title asChild><Text size="title" strong>{title}</Text></P.Title> : null}
            {children}
          </P.Content>
        </View>
      </P.Portal>
    </P.Root>
  );
}
