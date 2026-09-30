// WindowsProvider: move and size the window of the app in front: "left half", "maximize",
// "top right", "next display", "restore". Return does it. The window is the one that was focused
// when the Capsule opened; its app never has to be brought forward.
//
// It uses the accessibility API, so it needs Accessibility; macOS is asked once, the first time
// (Host/Paste.swift accessibilityOn), and until it is on the row says what to allow. Nothing here
// runs until Return, and nothing polls.
//
// Restore puts a window back where it was before the Capsule last moved it, for as long as the
// Capsule runs. The old place is kept in memory only.

import AppKit
import ApplicationServices
import Foundation

/// The window of one app and the screens, as the mover sees them. Frames are in AppKit coordinates
/// (bottom-left origin). A fake in tests.
protocol WindowAccess: AnyObject {
    /// The focused window's frame, and an id that stays the same for that window while it lives.
    func focused(pid: Int32) -> (id: String, frame: CGRect)?
    func setFrame(_ frame: CGRect, pid: Int32) -> Bool
    /// The screens' visible frames, main display first.
    var screens: [CGRect] { get }
}

final class AXWindowAccess: WindowAccess {
    var screens: [CGRect] { NSScreen.screens.map(\.visibleFrame) }
    private var primaryHeight: CGFloat { NSScreen.screens.first?.frame.height ?? 0 }

    private func window(_ pid: Int32) -> AXUIElement? {
        let app = AXUIElementCreateApplication(pid)
        var v: CFTypeRef?
        if AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &v) == .success, let w = v { return (w as! AXUIElement) }
        if AXUIElementCopyAttributeValue(app, kAXMainWindowAttribute as CFString, &v) == .success, let w = v { return (w as! AXUIElement) }
        return nil
    }

    func focused(pid: Int32) -> (id: String, frame: CGRect)? {
        guard let w = window(pid) else { return nil }
        var p: CFTypeRef?, s: CFTypeRef?
        guard AXUIElementCopyAttributeValue(w, kAXPositionAttribute as CFString, &p) == .success,
              AXUIElementCopyAttributeValue(w, kAXSizeAttribute as CFString, &s) == .success else { return nil }
        var pos = CGPoint.zero, size = CGSize.zero
        guard AXValueGetValue(p as! AXValue, .cgPoint, &pos), AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
        let ax = CGRect(origin: pos, size: size)
        return ("\(pid):\(CFHash(w))", WindowLayout.flip(ax, primaryHeight: primaryHeight))
    }

    func setFrame(_ frame: CGRect, pid: Int32) -> Bool {
        guard let w = window(pid) else { return false }
        let ax = WindowLayout.flip(frame, primaryHeight: primaryHeight)
        var size = ax.size, pos = ax.origin
        guard let sv = AXValueCreate(.cgSize, &size), let pv = AXValueCreate(.cgPoint, &pos) else { return false }
        // Size, then place, then size again: a window that grows from its corner, or that only
        // accepts a size that fits where it stands, ends up right after the second.
        _ = AXUIElementSetAttributeValue(w, kAXSizeAttribute as CFString, sv)
        let placed = AXUIElementSetAttributeValue(w, kAXPositionAttribute as CFString, pv)
        _ = AXUIElementSetAttributeValue(w, kAXSizeAttribute as CFString, sv)
        return placed == .success
    }
}

public final class WindowsProvider: ResultProvider, ImmediateResults, @unchecked Sendable {
    public let id = "windows"
    public let speed = Speed.quick
    let access: WindowAccess
    private let lock = NSLock()
    private var before: [String: CGRect] = [:]
    /// Ask for Accessibility (once). Tests give their own.
    var allowed: () -> Bool = { Paster.accessibilityOn() }

    init(access: WindowAccess = AXWindowAccess()) { self.access = access }

    /// A window layout is a word or two ("left half", "max"); anything longer is not asking for one.
    public func resultsNow(for q: Query) -> [ResultItem] {
        let t = q.normalized
        guard t.count >= 3, t.count <= 24 else { return [] }
        var out: [ResultItem] = []
        for l in WindowLayout.allCases {
            let s = Match.score(t, l.title, synonyms: l.keywords)
            guard s >= 0.6 else { continue }
            out.append(row(l, score: s * 0.95))
        }
        return out.sorted { $0.score > $1.score }.prefix(4).map { $0 }
    }

    public func results(for q: Query) async -> [ResultItem] { resultsNow(for: q) }

    func row(_ l: WindowLayout, score: Double) -> ResultItem {
        ResultItem(id: "window:\(l.rawValue)", kind: "window", title: l.title, subtitle: "Window", icon: .symbol(l.symbol),
                   section: .windows, score: score,
                   actions: [ResultAction(id: "move", title: l.title, symbol: l.symbol) { [weak self] _, ctx in
                       guard let self else { return .failed("Not now.") }
                       return self.apply(l, front: ctx.query.front)
                   }])
    }

    /// Do it. Says in words what happened, never "done" for a move that did not happen.
    func apply(_ l: WindowLayout, front: FrontApp?) -> ActionOutcome {
        guard let front else { return .failed("There is no app in front to move.") }
        guard allowed() else { return .failed("Allow Lumen under Privacy & Security, Accessibility, to move windows.") }
        guard let win = access.focused(pid: front.pid) else { return .failed("\(front.name) has no window to move.") }
        let screens = access.screens
        guard let here = WindowLayout.screenIndex(of: win.frame, in: screens) else { return .failed("No screen to put it on.") }
        let target: CGRect
        switch l {
        case .restore:
            lock.lock(); let old = before[win.id]; lock.unlock()
            guard let old else { return .failed("Nothing to restore: the Capsule has not moved this window.") }
            target = old
        case .nextDisplay, .previousDisplay:
            guard screens.count > 1 else { return .failed("There is only one display.") }
            let step = l == .nextDisplay ? 1 : screens.count - 1
            target = WindowLayout.move(win.frame, from: screens[here], to: screens[(here + step) % screens.count])
        default:
            guard let f = l.frame(in: screens[here], current: win.frame) else { return .failed("That layout has no place.") }
            target = f
        }
        if l != .restore { lock.lock(); before[win.id] = win.frame; lock.unlock() }
        guard access.setFrame(target, pid: front.pid) else { return .failed("\(front.name) would not let its window move.") }
        return .close(nil)
    }
}
