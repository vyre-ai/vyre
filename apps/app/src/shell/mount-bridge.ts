// The page's half of Vyre in Finder (Mac): the app's file extension asks the Mac app for server calls, and the Mac app has THIS page make them, because this page holds the Mac's own device channel.
// So the files are read and written as the person's device, under the server's grants. window.__vyreMount.call answers { data } or { error: { code, message } } and only for the mount tools.
import { tool } from "../real/box";
import { mountCallable } from "./mount-model.js";
import { shellKind } from "./shell";

type Answer = { data?: unknown; error?: { code: string; message: string } };

export function installMountBridge(): void {
  if (typeof window === "undefined" || shellKind() !== "mac") return;
  const w = window as unknown as { __vyreMount?: { call(name: string, input: Record<string, unknown>): Promise<Answer> } };
  if (w.__vyreMount) return;
  w.__vyreMount = {
    async call(name, input) {
      if (!mountCallable(name)) return { error: { code: "refused", message: "That is not something Finder may ask for." } };
      try { return { data: await tool(name, input || {}) }; }
      catch (e) { const x = e as { code?: string; message?: string }; return { error: { code: x.code ?? "failed", message: x.message ?? "" } }; }
    },
  };
}
