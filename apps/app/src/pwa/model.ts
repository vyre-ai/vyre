// The installed web app's pure pieces (pwa.web.ts), runnable in Node.

/** Where the app is served; the router's paths are below it. */
export const APP_BASE = "/app";

/**
 * The router path for a worker's {type: "vyre:navigate", path} message, or null for anything else.
 * `path` is under /app/ ("/app/need/abc"); the router's is without it ("/need/abc"). Only a path
 * in this app is taken: never another origin, never outside /app/.
 */
export function navigateTarget(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const d = data as { type?: unknown; path?: unknown };
  if (d.type !== "vyre:navigate" || typeof d.path !== "string") return null;
  const p = d.path;
  if (!p.startsWith("/") || p.startsWith("//") || /[\\\u0000-\u001f]/.test(p)) return null;
  if (p === APP_BASE || p === APP_BASE + "/") return "/";
  if (!p.startsWith(APP_BASE + "/") && !p.startsWith(APP_BASE + "?") && !p.startsWith(APP_BASE + "#")) return null;
  const rest = p.slice(APP_BASE.length);
  return rest.startsWith("/") ? rest : "/" + rest;
}

/** How long a push.seen report stands for: the first input after this long reports again. */
export const SEEN_EVERY = 60_000;

/**
 * push.seen's reports for one page: at launch when visible, on every visibility change, and on
 * the first input after SEEN_EVERY without a report. `send` gets {visible}; hidden reports must
 * outlive the page (the caller uses keepalive). No timer.
 */
export function seenReporter(send: (visible: boolean) => void, now: () => number = Date.now) {
  let at = -Infinity;
  const report = (visible: boolean) => {
    at = now();
    send(visible);
  };
  return {
    shown: () => report(true),
    hidden: () => report(false),
    input(visible: boolean) {
      if (visible && now() - at >= SEEN_EVERY) report(true);
    },
  };
}
