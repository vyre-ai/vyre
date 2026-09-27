// FileActions: the verbs every file and folder row carries, and what dragging one out writes.
//
// Enter opens; the rest are in the ⌘K list: show in Finder, copy the path, copy the file itself
// (a file URL on the pasteboard, so Finder, Mail and Slack paste the file, not its name), open
// with another app, Quick Look, and move to Trash. Trash is the one destructive verb, so it
// carries `confirm` and never runs from one keypress. Nothing here reads a file's contents.
//
// "Open with" asks LaunchServices (urlsForApplications(toOpen:)), which costs a few milliseconds a
// row, so providers ask for it only for the rows near the top (openWithLimit) and the UI can call
// openWithActions(for:) when ⌘K opens on any other row.
//
// Every pasteboard write goes to a board the caller names. The app passes the general one; tests
// pass a private named board ("vyre-test-<pid>") and never touch the user's clipboard.

import AppKit
import Foundation

public enum FileActions {
    /// Rows near the top that get their "Open with" list computed with the results.
    public static let openWithLimit = 5

    /// Set by the UI to show QLPreviewPanel for these URLs. Nil until the UI wires it.
    @MainActor public static var showQuickLook: (([URL]) -> Void)?

    /// Every action for a file or folder row. `board` is where copies go.
    public static func actions(for url: URL, isFolder: Bool, openWith: [URL] = [],
                               board: @escaping @Sendable () -> NSPasteboard = { .general }) -> [ResultAction] {
        var out: [ResultAction] = [
            ResultAction(id: "open", title: isFolder ? "Open in Finder" : "Open", symbol: "arrow.up.forward.app",
                         shortcut: KeyShortcut("return")) { _, _ in await Launch.open(url) },
            ResultAction(id: "reveal", title: "Show in Finder", symbol: "folder",
                         shortcut: KeyShortcut("return", command: true)) { _, _ in reveal(url) },
            ResultAction(id: "copy-path", title: "Copy path", symbol: "doc.on.clipboard",
                         shortcut: KeyShortcut("c", command: true, shift: true)) { _, _ in
                copyPath(url, to: board()) ? .said("Copied the path") : .failed("Could not copy the path.")
            },
            ResultAction(id: "copy-file", title: isFolder ? "Copy folder" : "Copy file", symbol: "doc.on.doc",
                         shortcut: KeyShortcut("c", command: true, option: true)) { _, _ in
                copyFile(url, to: board()) ? .said("Copied. Paste it in Finder or a message.") : .failed("Could not copy it.")
            },
            ResultAction(id: "quicklook", title: "Quick Look", symbol: "eye", shortcut: KeyShortcut("y", command: true)) { _, _ in
                await MainActor.run {
                    guard let show = showQuickLook else { return .failed("Quick Look is not ready.") }
                    show([url])
                    return .said("")
                }
            },
        ]
        out += openWith.map { openWithAction(url, app: $0) }
        out.append(ResultAction(id: "trash", title: "Move to Trash", symbol: "trash", shortcut: KeyShortcut("delete", command: true),
                                confirm: "Move \(url.lastPathComponent) to the Trash?") { _, _ in await trash(url) })
        return out
    }

    /// Apps that can open `url`, the default first, without duplicates, at most `limit`.
    public static func openWithApps(for url: URL, limit: Int = 6) -> [URL] {
        var seen = Set<String>(), out: [URL] = []
        let def = NSWorkspace.shared.urlForApplication(toOpen: url)
        for app in ([def].compactMap { $0 } + NSWorkspace.shared.urlsForApplications(toOpen: url)) {
            let key = app.standardizedFileURL.path
            if seen.insert(key).inserted { out.append(app) }
            if out.count >= limit { break }
        }
        return out
    }

    /// The "Open with" actions for a row whose list was not computed with the results.
    public static func openWithActions(for url: URL) -> [ResultAction] {
        openWithApps(for: url).map { openWithAction(url, app: $0) }
    }

    static func openWithAction(_ url: URL, app: URL) -> ResultAction {
        let name = FileManager.default.displayName(atPath: app.path).replacingOccurrences(of: ".app", with: "")
        return ResultAction(id: "open-with:" + app.path, title: "Open with \(name)", symbol: "arrow.up.forward.square") { _, _ in
            await Launch.open([url], with: app)
        }
    }

    public static func reveal(_ url: URL) -> ActionOutcome {
        guard FileManager.default.fileExists(atPath: url.path) else { return .failed("That file is gone.") }
        NSWorkspace.shared.activateFileViewerSelecting([url])
        return .close()
    }

    @discardableResult
    public static func copyPath(_ url: URL, to board: NSPasteboard) -> Bool {
        board.clearContents()
        return board.setString(url.path, forType: .string)
    }

    /// The file itself: a file URL, which Finder pastes as a copy of the file.
    @discardableResult
    public static func copyFile(_ url: URL, to board: NSPasteboard) -> Bool {
        guard FileManager.default.fileExists(atPath: url.path) else { return false }
        board.clearContents()
        return board.writeObjects([url as NSURL])
    }

    public static func trash(_ url: URL) async -> ActionOutcome {
        do {
            try FileManager.default.trashItem(at: url, resultingItemURL: nil)
            return .said("Moved \(url.lastPathComponent) to the Trash")
        } catch {
            return .failed("Could not move it to the Trash: \(error.localizedDescription)")
        }
    }

    /// What the UI hands QLPreviewPanel for the selected rows: their files that still exist.
    public static func quickLookURLs(_ items: [ResultItem]) -> [URL] {
        items.compactMap(\.fileURL).filter { FileManager.default.fileExists(atPath: $0.path) }
    }

    /// What a row writes when it is dragged out of the Capsule: its file URL, or nil.
    public static func pasteboardWriter(for item: ResultItem) -> NSPasteboardWriting? {
        guard let u = item.fileURL, u.isFileURL else { return nil }
        return u as NSURL
    }
}
