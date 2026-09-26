// Extension: how another team builds into the Capsule without editing its files.
//
// An extension is a folder, Sources/Extensions/<name>/, compiled into the one Capsule binary. The
// build finds it by a marker comment on the class that conforms to CapsuleExtension:
//
//     // capsule-extension: SightExtension
//     final class SightExtension: CapsuleExtension { ... }
//
// build.sh greps Sources/Extensions/ for that marker and writes Registry.generated.swift, so adding
// an extension touches no file another team owns. An extension that needs an Info.plist key (a
// usage string for a new permission) puts it in Sources/Extensions/<name>/Info.plist.part as
// plain <key>...</key><string>...</string> lines; build.sh splices them into the bundle's plist.
//
// What an extension can do, all through CapsuleHost:
//   - put rows in the list (providers) and commands in it (commands)
//   - draw a side panel beside the list for its own rows, or for any row (sidePanel)
//   - call vyred tools and follow its events (host.vyred), as the "capsule" caller
//   - ask for a permission on first use (host.request)
//   - act on the app that was in front (host.stepAside then its own work)
//   - claim a key chord while the Capsule is open (keyChords), never globally
//
// What it cannot do: take the keyboard while the Capsule is hidden, open a window of its own over
// the user's work, or run anything between cool() and the next warm() unless it declares
// `runsHidden` and says why (the Capsule's perf check lists it).

import Foundation
import SwiftUI

@MainActor
public protocol CapsuleExtension: AnyObject {
    /// Short, lowercase, unique: "sight", "voice". Used in row ids ("sight:..."), logs and settings.
    static var id: String { get }
    init(host: CapsuleHost)

    var providers: [ResultProvider] { get }
    var commands: [CapsuleCommand] { get }
    /// Chords this extension handles while the Capsule is open and key (for example ⌥Space for
    /// voice). The Capsule's own keys win a clash and the extension is told in the log.
    var keyChords: [KeyShortcut] { get }
    /// Why this extension keeps something running while hidden, or nil (the default) if it does
    /// not. Anything non-nil is listed by scripts/perf-check and in Settings.
    var runsHidden: String? { get }

    /// The side panel for a row, or nil to leave it to the Capsule. Called only when the row's
    /// `panel` names this extension, or when the extension asked to show one (host.showPanel).
    func sidePanel(for item: ResultItem?) -> AnyView?
    /// A chord from keyChords was pressed.
    func handle(chord: KeyShortcut, query: Query) -> Bool

    /// The Capsule is showing. `front` is the app that was in front; nothing about its window has
    /// been read yet (reading it is the extension's own act, on request, with its permission).
    func capsuleWillShow(front: FrontApp?)
    /// The Capsule hid. Stop everything.
    func capsuleDidHide()
}

public extension CapsuleExtension {
    var providers: [ResultProvider] { [] }
    var commands: [CapsuleCommand] { [] }
    var keyChords: [KeyShortcut] { [] }
    var runsHidden: String? { nil }
    func sidePanel(for item: ResultItem?) -> AnyView? { nil }
    func handle(chord: KeyShortcut, query: Query) -> Bool { false }
    func capsuleWillShow(front: FrontApp?) {}
    func capsuleDidHide() {}
}

/// vyred as the Capsule reaches it: tools over the unix socket, events over SSE. Every call goes
/// as the "capsule" caller. Never throws: a failure is `.failure` with the words to show.
public protocol VyredLink: AnyObject, Sendable {
    var isUp: Bool { get }
    /// POST /v1/tools/<name>. `presence` attaches a proof for a human-only tool (Touch ID or the
    /// Capsule's key, asked for by the Capsule, never by an extension directly).
    func call(_ tool: String, _ input: [String: Any], presence: Bool) async -> VyredResult
    /// Tools vyred has right now (GET /v1/tools), for features that need an optional module.
    func has(_ tool: String) -> Bool
    /// Follow events whose type matches a pattern ("thread.text", "hands.*"). The handler runs on
    /// the main actor. Returns a token; cancel it in capsuleDidHide unless you declared runsHidden.
    func on(_ pattern: String, _ handler: @escaping @MainActor (VyredEvent) -> Void) -> VyredSubscription
}

public extension VyredLink {
    func call(_ tool: String, _ input: [String: Any] = [:]) async -> VyredResult { await call(tool, input, presence: false) }
}

public enum VyredResult: @unchecked Sendable {
    case success(Any)
    case failure(code: String, message: String)
    public var data: Any? { if case .success(let d) = self { return d }; return nil }
    public var error: String? { if case .failure(_, let m) = self { return m }; return nil }
}

public struct VyredEvent: @unchecked Sendable {
    public var id: Int
    public var type: String
    public var source: String
    public var thread: String?
    public var project: String?
    public var at: Int
    public var payload: [String: Any]
    public init(id: Int, type: String, source: String, thread: String?, project: String?, at: Int, payload: [String: Any]) {
        self.id = id; self.type = type; self.source = source; self.thread = thread; self.project = project; self.at = at; self.payload = payload
    }
}

public protocol VyredSubscription: AnyObject { func cancel() }

/// What the Capsule gives an extension.
@MainActor
public protocol CapsuleHost: AnyObject {
    var vyred: VyredLink { get }
    /// The app in front when the Capsule opened, or nil.
    var front: FrontApp? { get }
    var isShown: Bool { get }

    func permission(_ p: Permission) -> PermissionState
    /// Ask for a permission now, because the user just asked for the thing that needs it. Shows
    /// the Capsule's own one-line reason first; returns false without an OS dialog when dialogs
    /// are not allowed (a test) or the user declined.
    func request(_ p: Permission, reason: String) async -> Bool

    /// Show the side panel with this extension's view (for its own state, not tied to a row).
    func showPanel(_ extensionID: String)
    func hidePanel()
    /// Put the text in the box, as if the user typed it.
    func setQuery(_ text: String)
    /// A line under the box, for a moment ("Copied", "No window in front").
    func say(_ line: String)
    /// Hide the Capsule and wait until `front` is frontmost again (up to 800 ms). True if it is.
    func stepAside() async -> Bool
    /// A macOS notification, only if the Capsule is hidden; otherwise said under the box.
    func notify(title: String, body: String)
    func log(_ message: String)
}

/// True only when a person has said dialogs may appear (the lead sets VYRE_TEST_DIALOGS=1 for a
/// test that needs one), or outside tests entirely. A test home is marked by VYRE_CAPSULE_TEST.
public func dialogsAllowed(_ env: [String: String] = ProcessInfo.processInfo.environment) -> Bool {
    if env["VYRE_TEST_DIALOGS"] == "1" { return true }
    return env["VYRE_CAPSULE_TEST"] == nil
}
