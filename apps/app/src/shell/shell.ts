// The Mac app's shell, seen from the page: Lumen's window (local/capsule/native/Sources/Host/VyreAppWindow.swift) puts window.__vyreShell on the page
// it hosts. Where it is not there (a browser, a phone) every function here answers null and the app carries on with its own way.
import { shellCommand } from "./shell-model.js";

export type MacShell = {
  kind: "mac";
  /** The Mac app's window runs this page with no vyred of its own (On a server): the page pairs to the server by code. */
  boxless?: boolean;
  /** This Mac's identity key (Host/MacIdentity.swift): an Ed25519 key whose seed stays in the Mac's Keychain. The page gets the public key and signatures, never the seed. Values are base64url. */
  identity?: {
    public(create?: boolean): Promise<string>;
    sign(message: string): Promise<string>;
    has(): Promise<boolean>;
    forget(): Promise<void>;
  };
  /** The version of this app, when the bridge says (a release candidate shows its own install line). */
  version?: string;
  /** The x-vyre-presence header for one call, from Touch ID (the person's own prompt). Rejects with plain words when it is refused. */
  presence(tool: string, input: Record<string, unknown>, summary?: string): Promise<string>;
  notify(title: string, body: string): Promise<unknown>;
  open(url: string): Promise<unknown>;
  /** Menu commands: a route, or "back" and "forward". Returns the stop. */
  onCommand(fn: (name: string) => void): () => void;
};

/** The shell the page runs in, or null. */
export function shell(): MacShell | null {
  const w = typeof window === "undefined" ? null : (window as unknown as { __vyreShell?: MacShell });
  return w?.__vyreShell?.kind === "mac" ? w.__vyreShell : null;
}

/** Hook a menu command up to the router: a route goes to it, "back" and "forward" move through history. Returns the stop (a no-op outside the shell). */
export function listenCommands(go: (route: string) => void, back: () => void, forward: () => void): () => void {
  const s = shell();
  if (!s) return () => {};
  return s.onCommand((name) => {
    const c = shellCommand(name);
    if (c.kind === "route") go(c.route);
    else if (c.kind === "back") back();
    else if (c.kind === "forward") forward();
  });
}
