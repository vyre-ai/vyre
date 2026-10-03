// generated from src/ui/icons.source.json by apps/app/scripts/gen-ui-icons.mjs; do not edit

/** The grid every drawing is on. */
export const ICON_GRID = 24;

/** One element of a drawing on the 24 grid: its SVG tag and attributes. */
export type IconElement =
  | { el: "path"; d: string }
  | { el: "circle"; cx: number; cy: number; r: number }
  | { el: "rect"; x: number; y: number; width: number; height: number; rx?: number }
  | { el: "ellipse"; cx: number; cy: number; rx: number; ry: number };

export type IconName =
  | "access"
  | "agents"
  | "assistants"
  | "back"
  | "bell"
  | "board"
  | "bolt"
  | "budget"
  | "cable"
  | "cal"
  | "camera"
  | "card"
  | "cfg"
  | "chart"
  | "chat"
  | "check"
  | "chev"
  | "chevron"
  | "chevron-down"
  | "chevron-left"
  | "chevron-up"
  | "clip"
  | "clock"
  | "contacts"
  | "copy"
  | "devices"
  | "download"
  | "drive"
  | "edit"
  | "error"
  | "external"
  | "eye"
  | "eye-off"
  | "face"
  | "file"
  | "filter"
  | "flows"
  | "font"
  | "globe"
  | "hand"
  | "hash"
  | "history"
  | "info"
  | "key"
  | "kits"
  | "laptop"
  | "link"
  | "list"
  | "lock"
  | "mail"
  | "memory"
  | "mention"
  | "menu"
  | "mic"
  | "minus"
  | "moon"
  | "more"
  | "now"
  | "offline"
  | "ok"
  | "pause"
  | "person"
  | "phone"
  | "pin"
  | "play"
  | "plus"
  | "projects"
  | "publish"
  | "qr"
  | "records"
  | "recovery"
  | "recovery-code"
  | "refresh"
  | "scan"
  | "sealed"
  | "search"
  | "send"
  | "server"
  | "settings"
  | "share"
  | "shield"
  | "sites"
  | "sort"
  | "space"
  | "spark"
  | "star"
  | "stop"
  | "storage"
  | "sun"
  | "task"
  | "term"
  | "trash"
  | "trip"
  | "undo"
  | "unlock"
  | "upload"
  | "users"
  | "vault"
  | "warning"
  | "wink"
  | "x"
  | "chev-r"
  | "chev-l"
  | "chev-d"
  | "planner"
  | "failed"
  | "terminal"
  | "faceid"
  | "wifi-off"
  | "alarm"
  | "todo"
  | "box";

const SET = {
  access: [{ el: "circle", cx: 8.5, cy: 12, r: 3.5 }, { el: "path", d: "M12 12h8M17 12v3M20 12v2" }],
  agents: [{ el: "rect", x: 5, y: 8, width: 14, height: 10.5, rx: 3.2 }, { el: "path", d: "M12 8V4.8M9.2 13v1.2M14.8 13v1.2" }, { el: "circle", cx: 12, cy: 4, r: 1 }],
  assistants: [{ el: "rect", x: 5, y: 8, width: 14, height: 10.5, rx: 3.2 }, { el: "path", d: "M12 8V4.8M9.2 13v1.2M14.8 13v1.2" }, { el: "circle", cx: 12, cy: 4, r: 1 }],
  back: [{ el: "path", d: "M15 6l-6 6 6 6" }],
  bell: [{ el: "path", d: "M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15z" }, { el: "path", d: "M10 20.5a2 2 0 0 0 4 0" }],
  board: [{ el: "rect", x: 4, y: 5, width: 5, height: 14, rx: 1.2 }, { el: "rect", x: 10, y: 5, width: 5, height: 9, rx: 1.2 }, { el: "rect", x: 16, y: 5, width: 4, height: 11, rx: 1.2 }],
  bolt: [{ el: "path", d: "M13 3L5.5 13.5H11L10 21l7.5-10.5H12z" }],
  budget: [{ el: "circle", cx: 12, cy: 12, r: 8.5 }, { el: "path", d: "M14.6 9.4c-.6-.8-1.5-1.2-2.6-1.2-1.4 0-2.4.7-2.4 1.8 0 2.4 5 1.2 5 3.7 0 1.1-1.1 1.8-2.6 1.8-1.2 0-2.1-.4-2.8-1.3M12 6.5v1.7M12 15.7v1.8" }],
  cable: [{ el: "path", d: "M9 4v4M15 4v4" }, { el: "path", d: "M7 8h10v3a5 5 0 0 1-10 0z" }, { el: "path", d: "M12 16v4" }],
  cal: [{ el: "rect", x: 4, y: 5.5, width: 16, height: 14.5, rx: 2 }, { el: "path", d: "M4 10h16M8.5 3.5v4M15.5 3.5v4" }],
  camera: [{ el: "path", d: "M4 8.5A1.5 1.5 0 0 1 5.5 7H8l1.2-2h5.6L16 7h2.5A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z" }, { el: "circle", cx: 12, cy: 13, r: 3.4 }],
  card: [{ el: "rect", x: 3.5, y: 6, width: 17, height: 12, rx: 2.5 }, { el: "path", d: "M3.5 10.5h17M7 15h3" }],
  cfg: [{ el: "circle", cx: 12, cy: 12, r: 3 }, { el: "path", d: "M12 3.5v3M12 17.5v3M3.5 12h3M17.5 12h3M6 6l2 2M16 16l2 2M18 6l-2 2M8 16l-2 2" }],
  chart: [{ el: "path", d: "M5 19V9M11 19V5M17 19v-7" }],
  chat: [{ el: "path", d: "M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-4 3.5V16h-.5A2.5 2.5 0 0 1 4 13.5z" }],
  check: [{ el: "path", d: "M5 12.5l4.5 4.5L19 7.5" }],
  chev: [{ el: "path", d: "M9 6l6 6-6 6" }],
  chevron: [{ el: "path", d: "M9 6l6 6-6 6" }],
  "chevron-down": [{ el: "path", d: "M6 9l6 6 6-6" }],
  "chevron-left": [{ el: "path", d: "M15 6l-6 6 6 6" }],
  "chevron-up": [{ el: "path", d: "M6 15l6-6 6 6" }],
  clip: [{ el: "path", d: "M18 11.5l-6 6a4 4 0 0 1-5.7-5.7l6.6-6.6a2.7 2.7 0 0 1 3.8 3.8l-6.6 6.6a1.3 1.3 0 0 1-1.9-1.9l6-6" }],
  clock: [{ el: "circle", cx: 12, cy: 12, r: 8.5 }, { el: "path", d: "M12 7.5V12l3 2" }],
  contacts: [{ el: "circle", cx: 9, cy: 9, r: 3 }, { el: "path", d: "M3.5 19c.6-3.2 2.7-5 5.5-5s4.9 1.8 5.5 5M16 6.5a3 3 0 0 1 0 5.5M17.5 14.3c1.7.6 2.7 2 3 4.7" }],
  copy: [{ el: "rect", x: 8.5, y: 8.5, width: 11, height: 11, rx: 2.5 }, { el: "path", d: "M15.5 8.5v-2a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" }],
  devices: [{ el: "rect", x: 3.5, y: 6, width: 12, height: 9, rx: 1.8 }, { el: "path", d: "M2.5 18.5h14" }, { el: "rect", x: 17.5, y: 9, width: 4, height: 9.5, rx: 1.2 }],
  download: [{ el: "path", d: "M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19h14" }],
  drive: [{ el: "path", d: "M4 14.5l2.7-8A1.5 1.5 0 0 1 8.1 5.5h7.8a1.5 1.5 0 0 1 1.4 1L20 14.5" }, { el: "rect", x: 4, y: 14.5, width: 16, height: 4.5, rx: 2 }],
  edit: [{ el: "path", d: "M4.5 19.5l1-4.2L16 4.8a2.1 2.1 0 0 1 3 3L8.7 18.5z" }, { el: "path", d: "M14.5 6.3l3.2 3.2" }],
  error: [{ el: "circle", cx: 12, cy: 12, r: 8.5 }, { el: "path", d: "M12 7.8v5M12 15.6v.1" }],
  external: [{ el: "path", d: "M14 4.5h5.5V10M19.5 4.5L11 13M17 14v3.5a2 2 0 0 1-2 2H6.5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2H10" }],
  eye: [{ el: "path", d: "M3 12s3.4-6 9-6 9 6 9 6-3.4 6-9 6-9-6-9-6z" }, { el: "circle", cx: 12, cy: 12, r: 2.6 }],
  "eye-off": [{ el: "path", d: "M3 12s3.4-6 9-6 9 6 9 6-3.4 6-9 6-9-6-9-6z" }, { el: "circle", cx: 12, cy: 12, r: 2.6 }, { el: "path", d: "M4 4l16 16" }],
  face: [{ el: "path", d: "M5 9V7a2 2 0 0 1 2-2h2M15 5h2a2 2 0 0 1 2 2v2M19 15v2a2 2 0 0 1-2 2h-2M9 19H7a2 2 0 0 1-2-2v-2M9 10v1.5M15 10v1.5M9.5 15c1.5 1.3 3.5 1.3 5 0" }],
  file: [{ el: "path", d: "M7 3.5h7l4 4V20a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z" }, { el: "path", d: "M14 3.5V8h4" }],
  filter: [{ el: "path", d: "M4 6h16M7 12h10M10 18h4" }],
  flows: [{ el: "circle", cx: 6, cy: 6, r: 2 }, { el: "circle", cx: 18, cy: 12, r: 2 }, { el: "circle", cx: 6, cy: 18, r: 2 }, { el: "path", d: "M8 6h4a2 2 0 0 1 2 2v2M8 18h4a2 2 0 0 0 2-2v-2" }],
  font: [{ el: "path", d: "M5 19L11 5l6 14M7.2 14.5h7.6" }],
  globe: [{ el: "circle", cx: 12, cy: 12, r: 8.5 }, { el: "path", d: "M3.5 12h17" }, { el: "path", d: "M12 3.5c2.4 2.4 3.5 5.2 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.2-3.5-8.5S9.6 5.9 12 3.5z" }],
  hand: [{ el: "path", d: "M8.5 12V6.8a1.4 1.4 0 0 1 2.8 0V11" }, { el: "path", d: "M11.3 10.5V5.4a1.4 1.4 0 0 1 2.8 0v5.1" }, { el: "path", d: "M14.1 6.8a1.4 1.4 0 0 1 2.8 0V13a6.5 6.5 0 0 1-6.5 6.5H10a5.5 5.5 0 0 1-4.3-2L3.8 15a1.4 1.4 0 0 1 2.1-1.8l2.6 2.3" }],
  hash: [{ el: "path", d: "M9.5 4.5L8 19.5M16 4.5l-1.5 15M5 9h14.5M4.5 15H19" }],
  history: [{ el: "path", d: "M4.5 12a7.5 7.5 0 1 0 2.3-5.4L4.5 8.5" }, { el: "path", d: "M4.5 4.5v4h4M12 8v4.2l2.6 1.6" }],
  info: [{ el: "circle", cx: 12, cy: 12, r: 8.5 }, { el: "path", d: "M12 11v5M12 8h.01" }],
  key: [{ el: "circle", cx: 8, cy: 15, r: 3.5 }, { el: "path", d: "M10.5 12.5L19 4M16 7l2 2" }],
  kits: [{ el: "path", d: "M12 3l8 4.5v9L12 21l-8-4.5v-9z" }, { el: "path", d: "M12 12l8-4.5M12 12v9M12 12L4 7.5" }],
  laptop: [{ el: "rect", x: 5, y: 5.5, width: 14, height: 10, rx: 1.5 }, { el: "path", d: "M3.5 18.5h17" }],
  link: [{ el: "path", d: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" }],
  list: [{ el: "path", d: "M5 7h14M5 12h14M5 17h14" }],
  lock: [{ el: "rect", x: 5.5, y: 10.5, width: 13, height: 9, rx: 2 }, { el: "path", d: "M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" }],
  mail: [{ el: "rect", x: 3.5, y: 5.5, width: 17, height: 13, rx: 2.5 }, { el: "path", d: "M4.5 7.5l7.5 5.5 7.5-5.5" }],
  memory: [{ el: "circle", cx: 6.5, cy: 7, r: 2 }, { el: "circle", cx: 17.5, cy: 6.5, r: 2 }, { el: "circle", cx: 12, cy: 17, r: 2.3 }, { el: "path", d: "M8.2 8.2l2.3 6.6M15.8 8.2l-2.3 6.6M8.5 7l7 -.3" }],
  mention: [{ el: "circle", cx: 12, cy: 12, r: 3.2 }, { el: "path", d: "M15.2 12v1.3a2.2 2.2 0 0 0 4.3 0V12a7.5 7.5 0 1 0-3 6" }],
  menu: [{ el: "path", d: "M4.5 7h15M4.5 12h15M4.5 17h15" }],
  mic: [{ el: "rect", x: 9, y: 4, width: 6, height: 10, rx: 3 }, { el: "path", d: "M6 11.5a6 6 0 0 0 12 0M12 17.5V20" }],
  minus: [{ el: "path", d: "M5 12h14" }],
  moon: [{ el: "path", d: "M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z" }],
  more: [{ el: "circle", cx: 6, cy: 12, r: 1.4 }, { el: "circle", cx: 12, cy: 12, r: 1.4 }, { el: "circle", cx: 18, cy: 12, r: 1.4 }],
  now: [{ el: "circle", cx: 12, cy: 12, r: 8.5 }, { el: "path", d: "M12 7.5V12l3 2" }],
  offline: [{ el: "path", d: "M4 4l16 16M8.5 8.8A8 8 0 0 0 4 11M20 11a8 8 0 0 0-6.3-3.9M7.5 14.5a6 6 0 0 1 3-1.6M16.5 14.5a6 6 0 0 0-1.4-1M12 18.5v.1" }],
  ok: [{ el: "circle", cx: 12, cy: 12, r: 8.5 }, { el: "path", d: "M8.5 12.2l2.5 2.5 4.5-5" }],
  pause: [{ el: "path", d: "M8.5 5.5v13M15.5 5.5v13" }],
  person: [{ el: "circle", cx: 12, cy: 8.5, r: 3.5 }, { el: "path", d: "M5 19.5c.6-3.6 3.4-5.5 7-5.5s6.4 1.9 7 5.5" }],
  phone: [{ el: "rect", x: 7, y: 3.5, width: 10, height: 17, rx: 2.5 }, { el: "path", d: "M11 17.5h2" }],
  pin: [{ el: "path", d: "M9 4.5h6l-1 5 3 3.5H7l3-3.5z" }, { el: "path", d: "M12 13v7" }],
  play: [{ el: "path", d: "M8 5.5v13l10.5-6.5z" }],
  plus: [{ el: "path", d: "M12 5v14M5 12h14" }],
  projects: [{ el: "path", d: "M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z" }],
  publish: [{ el: "path", d: "M7 17.5a4.5 4.5 0 0 1-.6-9A5.5 5.5 0 0 1 17 9.2a4 4 0 0 1 .5 8.3" }, { el: "path", d: "M12 20v-7M9 15.5l3-3 3 3" }],
  qr: [{ el: "rect", x: 4, y: 4, width: 6.5, height: 6.5, rx: 1.2 }, { el: "rect", x: 13.5, y: 4, width: 6.5, height: 6.5, rx: 1.2 }, { el: "rect", x: 4, y: 13.5, width: 6.5, height: 6.5, rx: 1.2 }, { el: "path", d: "M13.5 13.5h3v3M20 13.5v.1M13.5 20h.1M17 17.5h3V20" }],
  records: [{ el: "rect", x: 4, y: 5, width: 16, height: 14, rx: 2 }, { el: "path", d: "M4 10h16M10 10v9" }],
  recovery: [{ el: "circle", cx: 12, cy: 12, r: 8.5 }, { el: "circle", cx: 12, cy: 12, r: 3.5 }, { el: "path", d: "M6 6l3.5 3.5M18 6l-3.5 3.5M6 18l3.5-3.5M18 18l-3.5-3.5" }],
  "recovery-code": [{ el: "rect", x: 5, y: 3.5, width: 14, height: 17, rx: 2.5 }, { el: "path", d: "M8.5 8.5h7M8.5 12h7M8.5 15.5h4" }],
  refresh: [{ el: "path", d: "M19 12a7 7 0 1 1-2.2-5.1M19 4.5v4h-4" }],
  scan: [{ el: "path", d: "M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2M4 12h16" }],
  sealed: [{ el: "rect", x: 5, y: 10.5, width: 14, height: 9.5, rx: 2.5 }, { el: "path", d: "M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" }, { el: "path", d: "M12 12.9l1.7 1.7-1.7 1.7-1.7-1.7z" }],
  search: [{ el: "circle", cx: 11, cy: 11, r: 6.5 }, { el: "path", d: "M16 16l4 4" }],
  send: [{ el: "path", d: "M12 19V6M6.5 11.5L12 6l5.5 5.5" }],
  server: [{ el: "rect", x: 4.5, y: 4.5, width: 15, height: 6, rx: 1.5 }, { el: "rect", x: 4.5, y: 13.5, width: 15, height: 6, rx: 1.5 }, { el: "path", d: "M8 7.5h.01M8 16.5h.01" }],
  settings: [{ el: "path", d: "M5 7h8M17 7h2M5 17h2M11 17h8" }, { el: "circle", cx: 15, cy: 7, r: 2 }, { el: "circle", cx: 9, cy: 17, r: 2 }],
  share: [{ el: "path", d: "M12 15V4M8 8l4-4 4 4M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" }],
  shield: [{ el: "path", d: "M12 4l7 2.5v5c0 4.2-3 7.4-7 8.5-4-1.1-7-4.3-7-8.5v-5z" }, { el: "path", d: "M9 12l2.2 2.2L15 10" }],
  sites: [{ el: "circle", cx: 12, cy: 12, r: 8.5 }, { el: "path", d: "M3.5 12h17M12 3.5c2.5 2.5 2.5 14.5 0 17M12 3.5c-2.5 2.5-2.5 14.5 0 17" }],
  sort: [{ el: "path", d: "M8 5v14M5 16l3 3 3-3M16 19V5M13 8l3-3 3 3" }],
  space: [{ el: "path", d: "M12 3.5l7.5 4.3v8.4L12 20.5l-7.5-4.3V7.8z" }],
  spark: [{ el: "path", d: "M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8L12 17.5l-1.8-5.2L5 10.5l5.2-1.8z" }],
  star: [{ el: "path", d: "M12 4l2.4 5 5.4.7-4 3.8 1 5.4-4.8-2.7-4.8 2.7 1-5.4-4-3.8 5.4-.7z" }],
  stop: [{ el: "rect", x: 6, y: 6, width: 12, height: 12, rx: 3 }],
  storage: [{ el: "ellipse", cx: 12, cy: 6.5, rx: 7, ry: 2.7 }, { el: "path", d: "M5 6.5v11c0 1.5 3.1 2.7 7 2.7s7-1.2 7-2.7v-11M5 12c0 1.5 3.1 2.7 7 2.7s7-1.2 7-2.7" }],
  sun: [{ el: "circle", cx: 12, cy: 12, r: 3.8 }, { el: "path", d: "M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6L18 18M18 6l-1.4 1.4M7.4 16.6L6 18" }],
  task: [{ el: "rect", x: 4.5, y: 4.5, width: 15, height: 15, rx: 4 }, { el: "path", d: "M8.5 12.2l2.5 2.5 4.5-5" }],
  term: [{ el: "path", d: "M5 7l5 5-5 5M12 17h7" }],
  trash: [{ el: "path", d: "M5 7h14M9.5 7V5h5v2M7 7l.8 12h8.4L17 7M10.5 11v5M13.5 11v5" }],
  trip: [{ el: "path", d: "M3.5 12.5l17-7-5.5 14-3-5.5z" }],
  undo: [{ el: "path", d: "M9 7L4.5 11.5 9 16" }, { el: "path", d: "M4.5 11.5H15a4.5 4.5 0 0 1 0 9h-3.5" }],
  unlock: [{ el: "rect", x: 5, y: 10.5, width: 14, height: 9.5, rx: 2.5 }, { el: "path", d: "M8.5 10.5V8a3.5 3.5 0 0 1 6.6-1.7" }],
  upload: [{ el: "path", d: "M12 15V4M7.5 8.5L12 4l4.5 4.5M5 19h14" }],
  users: [{ el: "circle", cx: 9, cy: 9, r: 3 }, { el: "path", d: "M3.5 19c.6-3.2 2.7-5 5.5-5s4.9 1.8 5.5 5M16 6.5a3 3 0 0 1 0 5.5M17.5 14.3c1.7.6 2.7 2 3 4.7" }],
  vault: [{ el: "rect", x: 5, y: 10.5, width: 14, height: 9.5, rx: 2.5 }, { el: "path", d: "M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5M12 14.5v2" }],
  warning: [{ el: "path", d: "M12 4.5l8.5 14.5h-17z" }, { el: "path", d: "M12 10v4M12 16.6v.1" }],
  wink: [{ el: "circle", cx: 12, cy: 12, r: 8.5 }, { el: "path", d: "M7.8 10.9q1.3-1.5 2.6 0" }, { el: "circle", cx: 15.2, cy: 10.5, r: 0.7 }, { el: "path", d: "M8.6 14.4q3.4 3 6.8 0" }],
  x: [{ el: "path", d: "M6 6l12 12M18 6L6 18" }],
} as const satisfies Record<string, readonly IconElement[]>;

/** The family's own drawings, without the old names (for the gallery). */
export const ICON_NAMES = ["access","agents","assistants","back","bell","board","bolt","budget","cable","cal","camera","card","cfg","chart","chat","check","chev","chevron","chevron-down","chevron-left","chevron-up","clip","clock","contacts","copy","devices","download","drive","edit","error","external","eye","eye-off","face","file","filter","flows","font","globe","hand","hash","history","info","key","kits","laptop","link","list","lock","mail","memory","mention","menu","mic","minus","moon","more","now","offline","ok","pause","person","phone","pin","play","plus","projects","publish","qr","records","recovery","recovery-code","refresh","scan","sealed","search","send","server","settings","share","shield","sites","sort","space","spark","star","stop","storage","sun","task","term","trash","trip","undo","unlock","upload","users","vault","warning","wink","x"] as const;

export const ICONS: Record<IconName, readonly IconElement[]> = {
  ...SET,
  "chev-r": SET["chevron"],
  "chev-l": SET["chevron-left"],
  "chev-d": SET["chevron-down"],
  planner: SET["cal"],
  failed: SET["error"],
  terminal: SET["term"],
  faceid: SET["face"],
  "wifi-off": SET["offline"],
  alarm: SET["bell"],
  todo: SET["task"],
  box: SET["kits"],
};
