// @ts-check
// The one list of places, read by the desk rail (js/rail.js) and the phone's Places and More sheets (js/places.js): nothing else keeps a copy.
// `rail` puts it on the desk rail (`key` is its digit with Cmd or Ctrl, `end` the bottom group); `views` are the routes (deck/views) it is current on.
// Planner is folded into Now and Devices into Settings on the desk, so neither has a rail tile; the phone still lists both as tiles.

/** @type {readonly { href: string, label: string, icon: string, views: string[], rail: boolean, key?: string, end?: boolean }[]} */
export const ALL = Object.freeze([
  { href: "/now", label: "Now", icon: "now", views: ["now", "needs", "planner"], rail: true, key: "1" },
  { href: "/chat", label: "Chat", icon: "chat", views: ["chat"], rail: true, key: "2" },
  { href: "/projects", label: "Projects", icon: "projects", views: ["projects"], rail: true, key: "3" },
  { href: "/agents", label: "Agents", icon: "agents", views: ["agents", "glass"], rail: true, key: "4" },
  { href: "/planner", label: "Planner", icon: "planner", views: [], rail: false },
  { href: "/memory", label: "Memory", icon: "memory", views: ["memory"], rail: true, key: "5" },
  { href: "/vault", label: "Vault", icon: "vault", views: ["vault"], rail: true, key: "6" },
  { href: "/files", label: "Drive", icon: "drive", views: ["files"], rail: true, key: "7" },
  { href: "/settings#devices", label: "Devices", icon: "devices", views: [], rail: false },
  { href: "/settings", label: "Settings", icon: "settings", views: ["settings"], rail: true, key: "8", end: true },
]);
