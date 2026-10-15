// @ts-check
// The Settings sidebar panel's list, pure so a test can check every entry opens a real screen (settings-routes.test.js).

/** Each entry opens one existing screen; the one-line description of each is on the Settings home (settings/logic.js). */
export const SETTINGS_ITEMS = [
  { id: "spaces", label: "Space", href: "/u/spaces", icon: "space", group: "Space" },
  { id: "roles", label: "People and roles", href: "/u/settings/roles", icon: "users", group: "Space" },
  { id: "connections", label: "Connections", href: "/u/connections", icon: "link", group: "Space" },
  { id: "rules", label: "Rules", href: "/u/settings/rules", icon: "list", group: "Space" },
  { id: "audit", label: "Audit", href: "/u/settings/audit", icon: "clock", group: "Security" },
  { id: "tags", label: "Tags", href: "/u/tags", icon: "hash", group: "Space" },
  { id: "memory", label: "Memory", href: "/u/memory", icon: "memory", group: "Space" },
  { id: "sites", label: "Sites and publishing", href: "/u/sites", icon: "globe", group: "Space" },
  { id: "vault", label: "Vault", href: "/u/vault", icon: "vault", group: "Security" },
  { id: "devices", label: "Devices", href: "/u/settings/devices", icon: "devices", group: "Security" },
  { id: "permissions", label: "Permissions", href: "/u/settings/permissions", icon: "shield", group: "Security" },
  { id: "privacy", label: "Privacy", href: "/u/settings/privacy", icon: "eye", group: "Security" },
  { id: "system", label: "Servers", href: "/u/settings/servers", icon: "server", group: "System" },
  { id: "computer", label: "This computer", href: "/u/settings/system", icon: "laptop", group: "System" },
  { id: "updates", label: "Updates", href: "/u/settings/updates", icon: "refresh", group: "System" },
  { id: "backups", label: "Backups", href: "/u/settings/backups", icon: "storage", group: "System" },
  { id: "account", label: "Account", href: "/u/settings/account", icon: "person", group: "You" },
  { id: "appearance", label: "Appearance", href: "/u/appearance", icon: "wink", group: "You" },
  { id: "notifications", label: "Notifications", href: "/u/settings/notifications", icon: "bell", group: "You" },
  { id: "about", label: "About", href: "/u/about", icon: "info", group: "You" },
];
