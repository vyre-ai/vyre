// ProjectContext: which project the Capsule is "in", for memory.ask's context: {project} and the
// small project tile in the panel.
//
// The rule is simple and read-only (the lead, for 0.1.1): the project of the session window in
// front, if one is open; else the project whose folder holds the front app's document or working
// directory, when macOS says what that is; else none. Nothing is guessed: no window titles, no
// file contents, no clipboard. The front path is read from the focused window's AXDocument (the
// proxy icon: a document's file, a Terminal window's folder), only with Accessibility already
// granted (no prompt), never for a password manager, and it never leaves this Mac: only the
// matched project's slug is sent.

import AppKit
import ApplicationServices

public enum ProjectContext {
    /// The current project, by the rule above. `sessionProject` is the shown session's own project
    /// when it knows one; `sessionThread` finds it in the catalog when it does not.
    public static func current(sessionThread: String?, sessionProject: String?, frontPath: String?, catalog: VyreCatalog) -> VyreProject? {
        if let p = sessionProject.flatMap({ catalog.project($0) }) { return p }
        if let t = catalog.thread(sessionThread), let p = catalog.project(t.project) { return p }
        guard sessionThread == nil, sessionProject == nil, let path = frontPath else { return nil }
        return holding(path, catalog.projects)
    }

    /// The project whose home is `path` or holds it; the deepest home wins (a project inside another).
    static func holding(_ path: String, _ projects: [VyreProject]) -> VyreProject? {
        let p = normal(path)
        guard p.hasPrefix("/") else { return nil }
        return projects.compactMap { x -> (VyreProject, Int)? in
            guard let h = x.home.map(normal), h.hasPrefix("/"), h != "/" else { return nil }
            return p == h || p.hasPrefix(h + "/") ? (x, h.count) : nil
        }.max { $0.1 < $1.1 }?.0
    }

    static func normal(_ path: String) -> String {
        var s = (path as NSString).standardizingPath
        while s.count > 1 && s.hasSuffix("/") { s.removeLast() }
        return s
    }

    /// Apps whose windows are never read, even for a path.
    static let privateApps: [String] = ["com.apple.keychainaccess", "com.1password.", "com.agilebits.", "com.bitwarden.", "com.lastpass.", "com.dashlane."]

    static func isPrivate(_ bundle: String) -> Bool { privateApps.contains { bundle == $0 || ($0.hasSuffix(".") && bundle.hasPrefix($0)) } }

    /// The front app's document or working directory, from its focused window's AXDocument; nil
    /// without Accessibility (never asked for here), for a private app, or when it says none.
    @MainActor static func frontPath(_ front: FrontApp?) -> String? {
        // The Swift tests never read a real app's window.
        guard ProcessInfo.processInfo.environment["VYRE_CAPSULE_TEST"] != "1" else { return nil }
        guard let front, front.pid > 0, !isPrivate(front.bundle), AXIsProcessTrusted() else { return nil }
        let app = AXUIElementCreateApplication(front.pid)
        AXUIElementSetMessagingTimeout(app, 0.05)
        var win: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &win) == .success, let w = win,
              CFGetTypeID(w) == AXUIElementGetTypeID() else { return nil }
        var doc: CFTypeRef?
        guard AXUIElementCopyAttributeValue(w as! AXUIElement, kAXDocumentAttribute as CFString, &doc) == .success,
              let s = doc as? String else { return nil }
        return fileURLPath(s)
    }

    /// "file:///Users/alex/Harlow/brief.md" to its path; anything but a file URL or a path is nil.
    static func fileURLPath(_ s: String) -> String? {
        if s.hasPrefix("/") { return s }
        guard let u = URL(string: s), u.isFileURL else { return nil }
        return u.path
    }
}

extension CapsuleModel {
    /// The session window shows a session (a thread of "" is one with no thread yet, such as a
    /// fresh assistant tab), or closed (both nil).
    func sessionShown(thread: String?, project: String?) {
        sessionFront = thread == nil && project == nil ? nil : (thread, project)
        refreshProject()
    }

    /// Decide the current project again: on show, when the catalog lands, when the session window changes.
    func refreshProject() {
        let s = sessionFront
        let path = s == nil ? frontPath(front) : nil
        let p = ProjectContext.current(sessionThread: s?.thread, sessionProject: s?.project, frontPath: path, catalog: catalog)
        if p != currentProject { currentProject = p }
    }

    /// memory.ask's context: the current project's slug, or nothing.
    var askContext: [String: Any]? { currentProject.map { ["project": $0.slug] } }
}
