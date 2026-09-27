// generated from docs/design/one-app/icons.txt by apps/app/scripts/gen-icons.mjs; do not edit

/** One element of a drawing on the 16 grid: its SVG tag and attributes, as icons.txt writes them. */
export type IconElement =
  | { el: "path"; d: string }
  | { el: "circle"; cx: number; cy: number; r: number }
  | { el: "rect"; x: number; y: number; width: number; height: number; rx?: number }
  | { el: "line"; x1: number; y1: number; x2: number; y2: number }
  | { el: "polyline"; points: string };

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
  | "todo"
  | "unlock"
  | "minus";

export const ICONS: Record<IconName, readonly IconElement[]> = {
  now: [{ el: "path", d: "M1.5 8h3l2-5 3 10 2-5h3" }],
  chat: [{ el: "path", d: "M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" }],
  agents: [{ el: "circle", cx: 8, cy: 5.5, r: 2.5 }, { el: "path", d: "M3 13.5c.8-2.6 2.7-4 5-4s4.2 1.4 5 4" }],
  projects: [{ el: "path", d: "M1.5 4.5v8h13v-6.5h-6.5l-1.5-1.5z" }],
  memory: [{ el: "path", d: "M8 2l6 3-6 3-6-3z" }, { el: "path", d: "M2 8l6 3 6-3" }, { el: "path", d: "M2 11l6 3 6-3" }],
  vault: [{ el: "rect", x: 3, y: 7, width: 10, height: 7, rx: 1.5 }, { el: "path", d: "M5 7V5a3 3 0 0 1 6 0v2" }],
  planner: [{ el: "rect", x: 2, y: 3, width: 12, height: 11, rx: 1.5 }, { el: "path", d: "M2 6.5h12M5.5 1.5v3M10.5 1.5v3" }],
  devices: [{ el: "rect", x: 1.5, y: 3, width: 9, height: 7, rx: 1 }, { el: "path", d: "M4 13h4" }, { el: "rect", x: 11, y: 5.5, width: 3.5, height: 8, rx: 0.8 }],
  settings: [{ el: "path", d: "M2 4.5h7M12 4.5h2M2 11.5h2M7 11.5h7" }, { el: "circle", cx: 10.5, cy: 4.5, r: 1.5 }, { el: "circle", cx: 5.5, cy: 11.5, r: 1.5 }],
  search: [{ el: "circle", cx: 7, cy: 7, r: 4.5 }, { el: "path", d: "M10.5 10.5l3.5 3.5" }],
  check: [{ el: "path", d: "M3 8.5l3 3 7-7" }],
  x: [{ el: "path", d: "M4 4l8 8M12 4l-8 8" }],
  failed: [{ el: "circle", cx: 8, cy: 8, r: 6 }, { el: "path", d: "M6 6l4 4M10 6l-4 4" }],
  "chev-r": [{ el: "path", d: "M6 3.5l4.5 4.5-4.5 4.5" }],
  "chev-l": [{ el: "path", d: "M10 3.5l-4.5 4.5 4.5 4.5" }],
  "chev-d": [{ el: "path", d: "M3.5 6l4.5 4.5 4.5-4.5" }],
  plus: [{ el: "path", d: "M8 3v10M3 8h10" }],
  more: [{ el: "circle", cx: 3.5, cy: 8, r: 0.8 }, { el: "circle", cx: 8, cy: 8, r: 0.8 }, { el: "circle", cx: 12.5, cy: 8, r: 0.8 }],
  terminal: [{ el: "rect", x: 1.5, y: 2.5, width: 13, height: 11, rx: 1.5 }, { el: "path", d: "M4.5 6l2 2-2 2M8.5 10.5h3" }],
  mic: [{ el: "rect", x: 6, y: 1.5, width: 4, height: 8, rx: 2 }, { el: "path", d: "M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5" }],
  send: [{ el: "path", d: "M8 13V3M4 7l4-4 4 4" }],
  stop: [{ el: "rect", x: 4, y: 4, width: 8, height: 8, rx: 1.5 }],
  faceid: [{ el: "path", d: "M2 5V3.5A1.5 1.5 0 0 1 3.5 2H5M11 2h1.5A1.5 1.5 0 0 1 14 3.5V5M14 11v1.5a1.5 1.5 0 0 1-1.5 1.5H11M5 14H3.5A1.5 1.5 0 0 1 2 12.5V11" }, { el: "path", d: "M5.5 6v1M10.5 6v1M8 6v3h-.8M6 10.8c1.2.9 2.8.9 4 0" }],
  eye: [{ el: "path", d: "M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8z" }, { el: "circle", cx: 8, cy: 8, r: 2 }],
  hand: [{ el: "path", d: "M5.5 8V3.5a1 1 0 0 1 2 0V7M7.5 7V2.5a1 1 0 0 1 2 0V7M9.5 7V3.5a1 1 0 0 1 2 0V9c0 3-1.8 5-4.3 5C5 14 4 12.7 3 11L2 9.2a1 1 0 0 1 1.7-1L5.5 10" }],
  clock: [{ el: "circle", cx: 8, cy: 8, r: 6 }, { el: "path", d: "M8 4.5V8l2.5 1.5" }],
  bell: [{ el: "path", d: "M4 11V7a4 4 0 0 1 8 0v4l1.5 1.5h-11zM6.5 14h3" }],
  file: [{ el: "path", d: "M4 1.5h5l3 3v10H4z" }, { el: "path", d: "M9 1.5v3h3" }],
  key: [{ el: "circle", cx: 5, cy: 11, r: 2.5 }, { el: "path", d: "M6.8 9.2l6.2-6.2M11 5l2 2M9.5 6.5l1.5 1.5" }],
  copy: [{ el: "rect", x: 5, y: 5, width: 9, height: 9, rx: 1.5 }, { el: "path", d: "M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" }],
  qr: [{ el: "rect", x: 2, y: 2, width: 4.5, height: 4.5, rx: 0.5 }, { el: "rect", x: 9.5, y: 2, width: 4.5, height: 4.5, rx: 0.5 }, { el: "rect", x: 2, y: 9.5, width: 4.5, height: 4.5, rx: 0.5 }, { el: "path", d: "M9.5 9.5h2v2M14 9.5v4.5h-4.5" }],
  phone: [{ el: "rect", x: 4, y: 1.5, width: 8, height: 13, rx: 1.5 }, { el: "path", d: "M7 12.5h2" }],
  laptop: [{ el: "rect", x: 3, y: 3, width: 10, height: 7, rx: 1 }, { el: "path", d: "M1.5 12.5h13" }],
  box: [{ el: "rect", x: 2, y: 3, width: 12, height: 4, rx: 1 }, { el: "rect", x: 2, y: 9, width: 12, height: 4, rx: 1 }, { el: "path", d: "M4.5 5h.5M4.5 11h.5" }],
  "wifi-off": [{ el: "path", d: "M2 2l12 12M5.5 8.5a4 4 0 0 1 2.5-1M3 6a8 8 0 0 1 3-1.7M10.5 5A8 8 0 0 1 13 6.2M7 11.5a1.5 1.5 0 0 1 2 0" }],
  refresh: [{ el: "path", d: "M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" }],
  drive: [{ el: "path", d: "M1.5 10.5l2.5-7h8l2.5 7v2h-13z" }, { el: "path", d: "M1.5 10.5h13M11.5 12h.5" }],
  link: [{ el: "path", d: "M7 9a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-.8.8M9 7a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l.8-.8" }],
  download: [{ el: "path", d: "M8 2v8M4.5 6.5L8 10l3.5-3.5M2.5 13.5h11" }],
  share: [{ el: "path", d: "M8 10V1.5M5 4.5l3-3 3 3M4.5 7h-2v7h11V7h-2" }],
  globe: [{ el: "circle", cx: 8, cy: 8, r: 6 }, { el: "path", d: "M2 8h12M8 2c1.8 1.8 2.5 3.8 2.5 6S9.8 12.2 8 14M8 2C6.2 3.8 5.5 5.8 5.5 8S6.2 12.2 8 14" }],
  shield: [{ el: "path", d: "M8 1.5l5.5 2v4c0 3.5-2.4 6-5.5 7-3.1-1-5.5-3.5-5.5-7v-4z" }],
  pause: [{ el: "path", d: "M5.5 3.5v9M10.5 3.5v9" }],
  play: [{ el: "path", d: "M5 3l8 5-8 5z" }],
  cable: [{ el: "path", d: "M5 1.5v4M11 1.5v4M3.5 5.5h9v3a4.5 4.5 0 0 1-9 0zM8 13v1.5" }],
  alarm: [{ el: "circle", cx: 8, cy: 9, r: 5 }, { el: "path", d: "M8 6.5V9l1.5 1.5M2 3.5l2-2M14 3.5l-2-2" }],
  todo: [{ el: "rect", x: 2, y: 2, width: 12, height: 12, rx: 2 }, { el: "path", d: "M5 8l2 2 4-4" }],
  unlock: [{ el: "rect", x: 3, y: 7, width: 10, height: 7, rx: 1.5 }, { el: "path", d: "M5 7V5a3 3 0 0 1 5.8-1.1" }],
  minus: [{ el: "path", d: "M3 8h10" }],
};
