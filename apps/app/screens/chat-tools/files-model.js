// @ts-check
// The pure half of a chat's Files panel: the files a chat made or received (work.file.list), grouped, with what each can show and what Share to project says about it.

/** @typedef {{ path: string, name: string, kind: "received" | "made", size: number, at: number, shared: boolean }} ChatFile */

const IMAGE = /\.(png|jpe?g|gif|webp)$/i, TEXT = /\.(txt|md|markdown|json|csv|log|ya?ml|xml|html?)$/i;
/** How a file previews: an image, text the panel can read, or neither. @param {string} name @returns {"image" | "text" | "other"} */
export const previewKind = name => (IMAGE.test(name) ? "image" : TEXT.test(name) ? "text" : "other");

/** The most a text preview reads. */
export const TEXT_LIMIT = 262144;
/** Can the panel show this file here? Text and images up to a size, nothing else. @param {ChatFile} f */
export const canPreview = f => { const k = previewKind(f.name); return k === "image" ? f.size <= 4 * 1024 * 1024 : k === "text" && f.size <= TEXT_LIMIT; };

/** Made here and received, each by name; a file in a folder shows its folder in its name. @param {ChatFile[]} files */
export function groupFiles(files) {
  const by = (/** @type {"received" | "made"} */ kind) => files.filter(f => f.kind === kind).sort((a, b) => a.name.localeCompare(b.name));
  return { made: by("made"), received: by("received") };
}

/** @param {number} n */
export const sizeLine = n => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/** What the project sees of a file, in one plain line. @param {ChatFile} f */
export const shareLine = f => (f.shared ? "Shared with the project: its members open this file and nothing else in the chat" : "Private to this chat");

/** The one action a file offers. @param {ChatFile} f */
export const shareAction = f => (f.shared ? { tool: "work.file.unshare", label: "Unshare" } : { tool: "work.file.share", label: "Share to project" });

/** The panel's one-line summary. @param {ChatFile[]} files */
export const summary = files => (files.length ? `${files.length} file${files.length === 1 ? "" : "s"}, ${files.filter(f => f.shared).length} shared` : "No files yet");
