// Launch: opening what a row names, with NSWorkspace, never a shell and never /usr/bin/open.
//
// local.js open() spawned /usr/bin/open and so had to guard against an argument reading as a flag.
// Here there is no argument list: an app is opened by its bundle URL, a file or folder by its file
// URL, a settings pane by its x-apple.systempreferences: URL, and anything else only if its scheme
// is one this file knows (addressbook, dict, message, mailto, http, https). An outcome is always said in
// words, and a failure is never reported as done.

import AppKit
import Foundation

public enum Launch {
    public static let settingsScheme = "x-apple.systempreferences"
    /// Schemes a row may open. Anything else is refused: a result never becomes an arbitrary URL.
    static let schemes: Set<String> = ["x-apple.systempreferences", "addressbook", "dict", "message", "mailto", "http", "https", "file"]

    /// "/Users/alex/Documents/a" reads as "~/Documents/a".
    public static func tilde(_ p: String, home: String = NSHomeDirectory()) -> String {
        if p == home { return "~" }
        return p.hasPrefix(home + "/") ? "~" + p.dropFirst(home.count) : p
    }

    /// Whether `url` is something a row may open.
    public static func allowed(_ url: URL) -> Bool {
        guard let s = url.scheme?.lowercased(), schemes.contains(s) else { return false }
        if s == "file" { return url.path.hasPrefix("/") }
        return true
    }

    /// Open an app bundle, bringing it to the front (a running app is activated, not relaunched).
    public static func openApp(_ url: URL) async -> ActionOutcome {
        guard url.isFileURL, FileManager.default.fileExists(atPath: url.path) else { return .failed("That app is gone.") }
        let cfg = NSWorkspace.OpenConfiguration()
        cfg.activates = true
        do {
            _ = try await NSWorkspace.shared.openApplication(at: url, configuration: cfg)
            return .close()
        } catch {
            return .failed("Could not open \(url.deletingPathExtension().lastPathComponent): \(error.localizedDescription)")
        }
    }

    /// Open a file, a folder or an allowed URL with its default app.
    public static func open(_ url: URL) async -> ActionOutcome {
        guard allowed(url) else { return .failed("Lumen does not open that.") }
        if url.isFileURL {
            guard FileManager.default.fileExists(atPath: url.path) else { return .failed("That file is gone.") }
            if url.pathExtension.lowercased() == "app" { return await openApp(url) }
        }
        let cfg = NSWorkspace.OpenConfiguration()
        cfg.activates = true
        do {
            _ = try await NSWorkspace.shared.open(url, configuration: cfg)
            return .close()
        } catch {
            return .failed("Could not open it: \(error.localizedDescription)")
        }
    }

    /// Open `files` with a chosen app (the "Open with" actions).
    public static func open(_ files: [URL], with app: URL) async -> ActionOutcome {
        let cfg = NSWorkspace.OpenConfiguration()
        cfg.activates = true
        do {
            _ = try await NSWorkspace.shared.open(files, withApplicationAt: app, configuration: cfg)
            return .close()
        } catch {
            return .failed("Could not open it with \(app.deletingPathExtension().lastPathComponent): \(error.localizedDescription)")
        }
    }

    /// A settings pane by its extension id, with an optional anchor: "com.apple.wifi-settings-extension".
    public static func settingsURL(_ pane: String) -> URL? { URL(string: settingsScheme + ":" + pane) }

    public static func openSetting(_ pane: String) async -> ActionOutcome {
        guard let url = settingsURL(pane) else { return .failed("That pane has no address.") }
        return await open(url)
    }
}
