// Slash commands the chat surfaces in chips and menus (kernel routing lives in lib/thread-composer-route.js).

/** Commands often shown as quick chips in the gallery and panel. */
export const FEATURED_SLASHES = [
  "compact", "rewind", "later", "memory", "export", "roll", "goal", "find", "context", "status",
] as const;

/** The full native set the composer and threads.slash share. */
export const NATIVE_SLASHES = [
  "clear", "compact", "resume", "model", "effort", "init", "memory", "review", "export", "usage", "agents", "help", "status",
  "plan", "permissions", "mcp", "rewind", "remember", "later", "find", "move", "roll", "goal", "context", "cost", "rename", "undo", "vyre",
] as const;

export type FeaturedSlash = (typeof FEATURED_SLASHES)[number];
