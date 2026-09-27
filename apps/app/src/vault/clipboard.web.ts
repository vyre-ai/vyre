import type { Board } from "./clip-model";

// The browser's clipboard. The write starts inside the tap (a ClipboardItem holding the pending
// value), so Safari keeps the gesture while the box answers; writeText after the answer is the
// fallback. Cleared only where readText works without a prompt (clipboard-read granted).

export const board: Board = {
  os: "web",
  async write(pending) {
    const c = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!c) return false;
    if (typeof ClipboardItem !== "undefined" && typeof c.write === "function") {
      try {
        const blob = pending.then((v) => {
          if (v === null) throw new Error("nothing to copy");
          return new Blob([v], { type: "text/plain" });
        });
        await c.write([new ClipboardItem({ "text/plain": blob })]);
        return true;
      } catch {
        // An older ClipboardItem without promises, or the value never came: fall through.
      }
    }
    const value = await pending;
    if (value === null) return false;
    try {
      await c.writeText(value);
      return true;
    } catch {
      return false;
    }
  },
  async readsSilently() {
    if (typeof navigator === "undefined" || !navigator.clipboard?.readText || !navigator.permissions?.query) return false;
    try {
      const s = await navigator.permissions.query({ name: "clipboard-read" as PermissionName });
      return s.state === "granted";
    } catch {
      return false;
    }
  },
  async read() {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return null;
    }
  },
  async clear() {
    await navigator.clipboard.writeText("");
  },
};
