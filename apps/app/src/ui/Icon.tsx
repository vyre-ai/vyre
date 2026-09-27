import { View } from "react-native";
import Svg, { Circle, Path, Rect } from "react-native-svg";
import { tokens } from "../theme/tokens";

/**
 * The one icon set (the icons spec, docs/design/one-app/icons.txt) on its 16 grid, drawn with
 * react-native-svg: the set's path data unchanged, no fill, round caps and joins, in the ink of
 * the control it sits in. A new icon needs a design review, so the names are exactly the set's.
 */
export type IconName =
  | "now"
  | "chat"
  | "agents"
  | "projects"
  | "memory"
  | "vault"
  | "planner"
  | "devices"
  | "settings"
  | "search"
  | "check"
  | "x"
  | "failed"
  | "chev-r"
  | "chev-l"
  | "chev-d"
  | "plus"
  | "more"
  | "terminal"
  | "mic"
  | "send"
  | "stop"
  | "faceid"
  | "eye"
  | "hand"
  | "clock"
  | "bell"
  | "file"
  | "key"
  | "copy"
  | "qr"
  | "phone"
  | "laptop"
  | "box"
  | "wifi-off"
  | "refresh"
  | "drive"
  | "link"
  | "download"
  | "share"
  | "globe"
  | "shield"
  | "pause"
  | "play"
  | "cable"
  | "alarm"
  | "todo";

/** 12 in chips, tags and meta lines; 16 the default; 20 on rail buttons and empty-state tiles. */
export type IconSize = (typeof tokens.icon.sizes)[number];

type Part = { d: string } | { cx: number; cy: number; r: number } | { x: number; y: number; w: number; h: number; rx: number };

// The set's drawings, element for element: a path's d, a circle's centre and radius, a rect's box.
const SET: Record<IconName, readonly Part[]> = {
  now: [{ d: "M1.5 8h3l2-5 3 10 2-5h3" }],
  chat: [{ d: "M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" }],
  agents: [{ cx: 8, cy: 5.5, r: 2.5 }, { d: "M3 13.5c.8-2.6 2.7-4 5-4s4.2 1.4 5 4" }],
  projects: [{ d: "M1.5 4.5v8h13v-6.5h-6.5l-1.5-1.5z" }],
  memory: [{ d: "M8 2l6 3-6 3-6-3z" }, { d: "M2 8l6 3 6-3" }, { d: "M2 11l6 3 6-3" }],
  vault: [{ x: 3, y: 7, w: 10, h: 7, rx: 1.5 }, { d: "M5 7V5a3 3 0 0 1 6 0v2" }],
  planner: [{ x: 2, y: 3, w: 12, h: 11, rx: 1.5 }, { d: "M2 6.5h12M5.5 1.5v3M10.5 1.5v3" }],
  devices: [{ x: 1.5, y: 3, w: 9, h: 7, rx: 1 }, { d: "M4 13h4" }, { x: 11, y: 5.5, w: 3.5, h: 8, rx: 0.8 }],
  settings: [{ d: "M2 4.5h7M12 4.5h2M2 11.5h2M7 11.5h7" }, { cx: 10.5, cy: 4.5, r: 1.5 }, { cx: 5.5, cy: 11.5, r: 1.5 }],
  search: [{ cx: 7, cy: 7, r: 4.5 }, { d: "M10.5 10.5l3.5 3.5" }],
  check: [{ d: "M3 8.5l3 3 7-7" }],
  x: [{ d: "M4 4l8 8M12 4l-8 8" }],
  failed: [{ cx: 8, cy: 8, r: 6 }, { d: "M6 6l4 4M10 6l-4 4" }],
  "chev-r": [{ d: "M6 3.5l4.5 4.5-4.5 4.5" }],
  "chev-l": [{ d: "M10 3.5l-4.5 4.5 4.5 4.5" }],
  "chev-d": [{ d: "M3.5 6l4.5 4.5 4.5-4.5" }],
  plus: [{ d: "M8 3v10M3 8h10" }],
  more: [{ cx: 3.5, cy: 8, r: 0.8 }, { cx: 8, cy: 8, r: 0.8 }, { cx: 12.5, cy: 8, r: 0.8 }],
  terminal: [{ x: 1.5, y: 2.5, w: 13, h: 11, rx: 1.5 }, { d: "M4.5 6l2 2-2 2M8.5 10.5h3" }],
  mic: [{ x: 6, y: 1.5, w: 4, h: 8, rx: 2 }, { d: "M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5" }],
  send: [{ d: "M8 13V3M4 7l4-4 4 4" }],
  stop: [{ x: 4, y: 4, w: 8, h: 8, rx: 1.5 }],
  faceid: [{ d: "M2 5V3.5A1.5 1.5 0 0 1 3.5 2H5M11 2h1.5A1.5 1.5 0 0 1 14 3.5V5M14 11v1.5a1.5 1.5 0 0 1-1.5 1.5H11M5 14H3.5A1.5 1.5 0 0 1 2 12.5V11" }, { d: "M5.5 6v1M10.5 6v1M8 6v3h-.8M6 10.8c1.2.9 2.8.9 4 0" }],
  eye: [{ d: "M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8z" }, { cx: 8, cy: 8, r: 2 }],
  hand: [{ d: "M5.5 8V3.5a1 1 0 0 1 2 0V7M7.5 7V2.5a1 1 0 0 1 2 0V7M9.5 7V3.5a1 1 0 0 1 2 0V9c0 3-1.8 5-4.3 5C5 14 4 12.7 3 11L2 9.2a1 1 0 0 1 1.7-1L5.5 10" }],
  clock: [{ cx: 8, cy: 8, r: 6 }, { d: "M8 4.5V8l2.5 1.5" }],
  bell: [{ d: "M4 11V7a4 4 0 0 1 8 0v4l1.5 1.5h-11zM6.5 14h3" }],
  file: [{ d: "M4 1.5h5l3 3v10H4z" }, { d: "M9 1.5v3h3" }],
  key: [{ cx: 5, cy: 11, r: 2.5 }, { d: "M6.8 9.2l6.2-6.2M11 5l2 2M9.5 6.5l1.5 1.5" }],
  copy: [{ x: 5, y: 5, w: 9, h: 9, rx: 1.5 }, { d: "M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" }],
  qr: [{ x: 2, y: 2, w: 4.5, h: 4.5, rx: 0.5 }, { x: 9.5, y: 2, w: 4.5, h: 4.5, rx: 0.5 }, { x: 2, y: 9.5, w: 4.5, h: 4.5, rx: 0.5 }, { d: "M9.5 9.5h2v2M14 9.5v4.5h-4.5" }],
  phone: [{ x: 4, y: 1.5, w: 8, h: 13, rx: 1.5 }, { d: "M7 12.5h2" }],
  laptop: [{ x: 3, y: 3, w: 10, h: 7, rx: 1 }, { d: "M1.5 12.5h13" }],
  box: [{ x: 2, y: 3, w: 12, h: 4, rx: 1 }, { x: 2, y: 9, w: 12, h: 4, rx: 1 }, { d: "M4.5 5h.5M4.5 11h.5" }],
  "wifi-off": [{ d: "M2 2l12 12M5.5 8.5a4 4 0 0 1 2.5-1M3 6a8 8 0 0 1 3-1.7M10.5 5A8 8 0 0 1 13 6.2M7 11.5a1.5 1.5 0 0 1 2 0" }],
  refresh: [{ d: "M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" }],
  drive: [{ d: "M1.5 10.5l2.5-7h8l2.5 7v2h-13z" }, { d: "M1.5 10.5h13M11.5 12h.5" }],
  link: [{ d: "M7 9a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-.8.8M9 7a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l.8-.8" }],
  download: [{ d: "M8 2v8M4.5 6.5L8 10l3.5-3.5M2.5 13.5h11" }],
  share: [{ d: "M8 10V1.5M5 4.5l3-3 3 3M4.5 7h-2v7h11V7h-2" }],
  globe: [{ cx: 8, cy: 8, r: 6 }, { d: "M2 8h12M8 2c1.8 1.8 2.5 3.8 2.5 6S9.8 12.2 8 14M8 2C6.2 3.8 5.5 5.8 5.5 8S6.2 12.2 8 14" }],
  shield: [{ d: "M8 1.5l5.5 2v4c0 3.5-2.4 6-5.5 7-3.1-1-5.5-3.5-5.5-7v-4z" }],
  pause: [{ d: "M5.5 3.5v9M10.5 3.5v9" }],
  play: [{ d: "M5 3l8 5-8 5z" }],
  cable: [{ d: "M5 1.5v4M11 1.5v4M3.5 5.5h9v3a4.5 4.5 0 0 1-9 0zM8 13v1.5" }],
  alarm: [{ cx: 8, cy: 9, r: 5 }, { d: "M8 6.5V9l1.5 1.5M2 3.5l2-2M14 3.5l-2-2" }],
  todo: [{ x: 2, y: 2, w: 12, h: 12, rx: 2 }, { d: "M5 8l2 2 4-4" }],
};

const GRID = tokens.icon.grid;
const STROKE = tokens.icon.stroke;

/**
 * Decorative: hidden from assistive tech, the control around it carries the name. The ink is the
 * caller's (the row's, the button's). The stroke stays 1.5 at every size, so it is set in grid
 * units against the scale rather than scaled with the drawing.
 */
export function Icon({ name, color, size = tokens.icon.sizes[1] }: { name: IconName; color: string; size?: IconSize }) {
  const sw = (STROKE * GRID) / size;
  const ink = { fill: "none", stroke: color, strokeWidth: sw, strokeLinecap: "round", strokeLinejoin: "round" } as const;
  return (
    <View pointerEvents="none" aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: size, height: size }}>
      <Svg width={size} height={size} viewBox={`0 0 ${GRID} ${GRID}`}>
        {SET[name].map((p, i) =>
          "d" in p ? (
            <Path key={i} d={p.d} {...ink} />
          ) : "cx" in p ? (
            <Circle key={i} cx={p.cx} cy={p.cy} r={p.r} {...ink} />
          ) : (
            <Rect key={i} x={p.x} y={p.y} width={p.w} height={p.h} rx={p.rx} {...ink} />
          ),
        )}
      </Svg>
    </View>
  );
}
