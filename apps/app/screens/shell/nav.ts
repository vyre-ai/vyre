// The places of /u, in the prototype's order. Routes may not all exist yet: the other builders add theirs under app/u/.
import type { NavDef } from "@vyre/ui";

export const NAV: NavDef = {
  items: [
    { id: "now", label: "Now", icon: "now", href: "/u/now" },
    { id: "chat", label: "Chat", icon: "chat", href: "/u/chats" },
    { id: "projects", label: "Projects", icon: "projects", href: "/u/projects", match: ["/u/project"] },
    { id: "contacts", label: "Contacts", icon: "contacts", href: "/u/records/contact" },
    { id: "drive", label: "Drive", icon: "drive", href: "/u/drive" },
    { id: "sites", label: "Sites", icon: "globe", href: "/u/sites" },
  ],
  more: [
    { id: "memory", label: "Memory", icon: "memory", href: "/u/memory" },
    { id: "vault", label: "Vault", icon: "vault", href: "/u/vault" },
    { id: "flows", label: "Flows", icon: "flows", href: "/u/flows" },
    { id: "assistants", label: "Assistants", icon: "assistants", href: "/u/assistants" },
    { id: "kits", label: "Kits", icon: "box", href: "/u/kits" },
    { id: "templates", label: "Templates", icon: "file", href: "/u/records/template" },
  ],
  bottom: [
    { id: "search", label: "Search", icon: "search", href: "/u/search" },
    {
      id: "settings", label: "Settings", icon: "settings", href: "/u/settings",
      match: ["/u/appearance", "/u/spaces", "/u/wink", "/u/access", "/u/about", "/u/install"],
    },
  ],
};
