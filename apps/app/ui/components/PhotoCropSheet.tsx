import { useEffect, useRef, useState } from "react";
import { Image, View, useWindowDimensions } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Svg, { Circle, Path } from "react-native-svg";
import { Sheet } from "./Sheet";
import { Text } from "./Text";
import { Banner } from "./Banner";
import { Button, IconButton } from "./Button";
import { useUiTheme } from "../theme";
import { ZOOM_MAX, clampView, cropRect, placement } from "./photo-crop-model.js";

export type CropPick = { uri: string; width: number; height: number };
export type Crop = { originX: number; originY: number; width: number; height: number };

const STEP = 0.25;

/**
 * The profile photo crop, the way phones do it: the picture under a circular mask, dragged to move and pinched (or the slider, or the minus and plus buttons) to zoom, with Cancel and Save. The
 * circle shows what everyone will see; Save hands back the square around it, in the picture's own pixels (photo-crop-model.js), and the caller encodes and keeps it. The caller owns `open`.
 */
export function PhotoCropSheet({ open, pick, onCancel, onSave, busy, problem }: { open: boolean; pick: CropPick | null; onCancel: () => void; onSave: (crop: Crop) => void; busy?: boolean; problem?: string }) {
  const { color } = useUiTheme();
  const { width } = useWindowDimensions();
  const stage = Math.round(Math.max(200, Math.min(320, width - 64)));
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const start = useRef({ zoom: 1, x: 0, y: 0 });
  useEffect(() => { setView({ zoom: 1, x: 0, y: 0 }); }, [pick?.uri]);
  const w = pick?.width ?? 1, h = pick?.height ?? 1;
  const fit = (v: { zoom: number; x: number; y: number }) => { const c = clampView({ w, h, stage, ...v }); return { zoom: c.zoom, x: c.x, y: c.y }; };
  const at = placement({ w, h, stage, ...view });

  const pan = Gesture.Pan().runOnJS(true).minDistance(1)
    .onStart(() => { start.current = view; })
    .onUpdate((e) => setView(fit({ ...start.current, x: start.current.x + e.translationX, y: start.current.y + e.translationY })));
  const pinch = Gesture.Pinch().runOnJS(true)
    .onStart(() => { start.current = view; })
    .onUpdate((e) => setView(fit({ ...start.current, zoom: start.current.zoom * e.scale })));
  const gestures = Gesture.Simultaneous(pan, pinch);

  // the slider: the zoom from 1 (left) to ZOOM_MAX (right), set by where the finger or pointer is on the track
  const [track, setTrack] = useState(1);
  const zoomAt = (x: number) => setView((v) => fit({ ...v, zoom: 1 + (Math.min(track, Math.max(0, x)) / track) * (ZOOM_MAX - 1) }));
  const slide = Gesture.Pan().runOnJS(true).minDistance(0).onBegin((e) => zoomAt(e.x)).onUpdate((e) => zoomAt(e.x));
  const nudge = (d: number) => setView((v) => fit({ ...v, zoom: v.zoom + d }));
  const share = (view.zoom - 1) / (ZOOM_MAX - 1);
  const r = stage / 2;
  // the dim corners around the circle: the square with the circle cut out of it
  const mask = `M0 0H${stage}V${stage}H0Z M${r} 0A${r} ${r} 0 1 0 ${r} ${stage}A${r} ${r} 0 1 0 ${r} 0Z`;

  return (
    <Sheet open={open} onClose={onCancel} title="Your photo" scroll={false}>
      <View className="items-center gap-s4">
        <Text tone="muted">Drag to move it. Pinch or use the slider to zoom.</Text>
        <GestureHandlerRootView style={{ width: stage, height: stage }}>
          <GestureDetector gesture={gestures}>
            <View accessibilityLabel="Your photo, inside the circle" style={{ width: stage, height: stage, overflow: "hidden", borderRadius: 12, backgroundColor: color["surface-2"] }}>
              {pick ? <Image source={{ uri: pick.uri }} accessibilityIgnoresInvertColors style={{ position: "absolute", width: at.width, height: at.height, left: at.left, top: at.top }} /> : null}
              <Svg pointerEvents="none" width={stage} height={stage} style={{ position: "absolute", left: 0, top: 0 }}>
                <Path d={mask} fill={color.scrim} fillRule="evenodd" />
                <Circle cx={r} cy={r} r={r - 1} stroke={color.text} strokeOpacity={0.6} strokeWidth={1.5} fill="none" />
              </Svg>
            </View>
          </GestureDetector>
        </GestureHandlerRootView>
        <View className="flex-row items-center gap-s2" style={{ width: stage }}>
          <IconButton icon="minus" label="Zoom out" onPress={() => nudge(-STEP)} />
          <GestureHandlerRootView style={{ flex: 1 }}>
            <GestureDetector gesture={slide}>
              <View accessible accessibilityRole="adjustable" accessibilityLabel="Zoom" accessibilityValue={{ min: 1, max: ZOOM_MAX, now: Math.round(view.zoom * 100) / 100 }}
                accessibilityActions={[{ name: "increment" }, { name: "decrement" }]} onAccessibilityAction={(e) => nudge(e.nativeEvent.actionName === "increment" ? STEP : -STEP)}
                onLayout={(e) => setTrack(Math.max(1, e.nativeEvent.layout.width))} style={{ height: 44, justifyContent: "center" }}>
                <View style={{ height: 4, borderRadius: 2, backgroundColor: color["edge-strong"] }}>
                  <View style={{ width: share * track, height: 4, borderRadius: 2, backgroundColor: color.text }} />
                </View>
                <View pointerEvents="none" style={{ position: "absolute", left: share * track - 10, width: 20, height: 20, borderRadius: 10, backgroundColor: color.text, borderWidth: 2, borderColor: color["surface-3"] }} />
              </View>
            </GestureDetector>
          </GestureHandlerRootView>
          <IconButton icon="plus" label="Zoom in" onPress={() => nudge(STEP)} />
        </View>
        {problem ? <Banner tone="warn">{problem}</Banner> : null}
        <View className="flex-row justify-end gap-s2 self-stretch">
          <Button kind="ghost" label="Cancel" onPress={onCancel} />
          <Button kind="primary" label={busy ? "Saving" : "Save"} disabled={busy || !pick} onPress={() => onSave(cropRect({ w, h, stage, ...view }))} />
        </View>
      </View>
    </Sheet>
  );
}
