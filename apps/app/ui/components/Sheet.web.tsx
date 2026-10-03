import { ScrollView, View } from "react-native";
import * as P from "@rn-primitives/dialog";
import { cn } from "../lib/cn";
import { Text } from "./Text";
import { elevation } from "../lib/elevation";
import { PHONE_MAX, useUiTheme } from "../theme";
import { px } from "../lib/measure";
import { useWindowDimensions } from "react-native";

/** The web Sheet (a dialog): a bottom sheet at phone width, centred on a wide screen. The native sheet is Sheet.tsx (springs and drag to dismiss). Same props. */
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title?: string; children: React.ReactNode }) {
  const { width, height } = useWindowDimensions();
  const { resolved, color, map } = useUiTheme();
  const phone = width < PHONE_MAX;
  const r = px(map, "--r-sheet");
  // @rn-primitives drops className on its Overlay and Content on the web (they are not compiled by NativeWind), so the look is real style props from the theme.
  const content = {
    backgroundColor: color["surface-3"], borderWidth: 1, borderColor: color["edge-strong"], padding: px(map, "--s-4"), gap: px(map, "--s-3"), width: phone ? ("100%" as const) : Math.min(px(map, "--read-max"), width - 32),
    maxHeight: height * 0.9,
    ...(phone ? { borderTopLeftRadius: r, borderTopRightRadius: r } : { borderRadius: r }),
  };
  return (
    <P.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <P.Portal>
        <P.Overlay style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: color.scrim }} onPress={onClose} />
        <View pointerEvents="box-none" className={cn("absolute inset-0", phone ? "justify-end" : "items-center justify-center")}>
          <P.Content style={[elevation(resolved.scheme, 3), content]}>
            {title ? <P.Title asChild><Text size="title" strong>{title}</Text></P.Title> : null}
            <ScrollView className="flex-shrink" contentContainerClassName="gap-s3" keyboardShouldPersistTaps="handled">{children}</ScrollView>
          </P.Content>
        </View>
      </P.Portal>
    </P.Root>
  );
}
