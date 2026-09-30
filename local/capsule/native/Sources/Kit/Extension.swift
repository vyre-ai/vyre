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
// What it cannot do: take the keyboard while the Capsule is hidden, open a window of its own (the
// one exception is the Capsule-owned session panel, host.sessionWindow, for the side view), or run anything between cool() and the next warm() unless it declares
// `runsHidden` and says why (the Capsule's perf check lists it).

import AppKit
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

    /// What `@` can name in this extension ("Notes", "Slack", "WhatsApp"), for the words after
    /// the `@` (may be empty, may hold spaces). Called on every keystroke while `@` is being
    /// typed: answer from memory. Picked, a target becomes the chip, and Enter calls send.
    func mentions(matching query: String) -> [MentionTarget]
    /// The same question with where it is asked from. With no chip, `context.parent` is nil and
    /// every extension is asked. With a chip from this extension that `nests` (an app, "WhatsApp"),
    /// a second `@` asks this extension alone, with the chip as `context.parent`, for what is inside
    /// it (contacts, channels); Vyre's own agents, projects and sessions are not mixed in. The
    /// default answers the flat question and nothing inside a chip, so an extension written before
    /// nesting keeps working unchanged.
    func mentions(matching query: String, context: MentionContext) -> [MentionTarget]
    /// Newer rows for the same words, when memory was not the whole answer (a contact list read
    /// from the app on first use). Called once, about 120 ms after the last keystroke, only while
    /// the Capsule is shown; cancelled when the words change or the Capsule hides. Return nil when
    /// there is nothing new (the default); a list replaces this extension's rows if the words are
    /// still the same when it lands. Never polled. Only asked when `refreshesMentions` is true.
    func refreshMentions(matching query: String, context: MentionContext) async -> [MentionTarget]?
    /// Say true when you implement refreshMentions. Read once when the Capsule loads the
    /// extension, so one that has no second answer costs no task per keystroke. Default false.
    var refreshesMentions: Bool { get }
    /// A target became the chip. An app chip can start reading its contacts into memory here, so
    /// the next `@` answers from memory. Called once per pick. The default does nothing.
    func mentionPicked(_ target: MentionTarget, context: MentionContext)
    /// The user sent `text` to one of your targets. Say what happened in words; never report a
    /// send that did not happen as done.
    func send(_ text: String, to target: MentionTarget, query: Query) async -> ActionOutcome
    /// The same, with the chip `target` was picked under ("WhatsApp" for "juno"), or nil for a
    /// target picked on its own. The Capsule calls this one; the default forwards to
    /// `send(_:to:query:)`, so implement whichever needs less.
    func send(_ text: String, to target: MentionTarget, in parent: MentionTarget?, query: Query) async -> ActionOutcome

    /// The side panel for a row, or nil to leave it to the Capsule. Called only when the row's
    /// `panel` names this extension, or when the extension asked to show one (host.showPanel).
    func sidePanel(for item: ResultItem?) -> AnyView?
    /// A chord from keyChords was pressed.
    func handle(chord: KeyShortcut, query: Query) -> Bool
    /// A key came up while the Capsule is key (Return, for hold-to-talk). True if it was yours.
    func handleUp(key: String) -> Bool
    /// An ordinary ⏎ (no chord) is about to submit the box while you may be listening: stop the
    /// mic first (keeping whatever words already landed), same as a tap-to-stop, so ⏎ both stops
    /// and sends. True if you were listening and stopped. The default (an extension with no
    /// voice of its own) does nothing.
    func stopTalking() -> Bool
    /// Esc, before anything else the box does with it: if you are listening, stop the mic AND
    /// remove exactly what this dictation added -- never a general clear. True if you were
    /// listening. The default does nothing.
    func cancelTalking() -> Bool

    /// The words in the box or the chip changed (a key, a pick, a chip dropped). Forget anything
    /// that was waiting for a second Enter on the old ones. The default does nothing.
    func boxChanged()

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
    func mentions(matching query: String) -> [MentionTarget] { [] }
    func send(_ text: String, to target: MentionTarget, query: Query) async -> ActionOutcome { .failed("\(target.label) cannot take messages yet.") }
    func mentions(matching query: String, context: MentionContext) -> [MentionTarget] {
        context.parent == nil ? mentions(matching: query) : []
    }
    func refreshMentions(matching query: String, context: MentionContext) async -> [MentionTarget]? { nil }
    var refreshesMentions: Bool { false }
    func mentionPicked(_ target: MentionTarget, context: MentionContext) {}
    func send(_ text: String, to target: MentionTarget, in parent: MentionTarget?, query: Query) async -> ActionOutcome {
        await send(text, to: target, query: query)
    }
    func handle(chord: KeyShortcut, query: Query) -> Bool { false }
    func handleUp(key: String) -> Bool { false }
    func stopTalking() -> Bool { false }
    func cancelTalking() -> Bool { false }
    func boxChanged() {}
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
    /// The same, with the words the panel shows above Touch ID ("Send the email to dana"). One
    /// proof opens a presence session of about 30 minutes for the tools that may ride one
    /// (gate.approve, vault reveal/copy/totp), held in memory only and dropped when the Mac
    /// locks or sleeps or the Capsule quits.
    func call(_ tool: String, _ input: [String: Any], presence: Bool, summary: String?) async -> VyredResult
    /// Tools vyred has right now (GET /v1/tools), for features that need an optional module.
    func has(_ tool: String) -> Bool
    /// Follow events whose type matches a pattern ("thread.text", "hands.*"). The handler runs on
    /// the main actor. Returns a token; cancel it in capsuleDidHide unless you declared runsHidden.
    func on(_ pattern: String, _ handler: @escaping @MainActor (VyredEvent) -> Void) -> VyredSubscription
    /// Open a WebSocket to one of vyred's streams ("/v1/streams/voice/listen") as the "capsule"
    /// caller. `onMessage` gets each JSON text frame and `onClose` runs once, both off the main
    /// thread. Nothing is open before this or after close().
    func stream(_ path: String, onMessage: @escaping @Sendable ([String: Any]) -> Void,
                onClose: @escaping @Sendable () -> Void) async -> Result<VyredStream, VyredStreamFailure>
}

public extension VyredLink {
    func call(_ tool: String, _ input: [String: Any] = [:]) async -> VyredResult { await call(tool, input, presence: false) }
    func call(_ tool: String, _ input: [String: Any], presence: Bool, summary: String?) async -> VyredResult {
        await call(tool, input, presence: presence)
    }
    func stream(_ path: String, onMessage: @escaping @Sendable ([String: Any]) -> Void,
                onClose: @escaping @Sendable () -> Void) async -> Result<VyredStream, VyredStreamFailure> {
        .failure(VyredStreamFailure(code: "refused", message: "This link to vyred has no streams."))
    }
}

/// Something an extension offers to add to words on their way out ("sees: Safari ·
/// Northwind Bakery"). Shown as a chip before sending; one key or a click on its x removes it;
/// nothing is ever attached without the chip on screen.
public struct SendAttachment: Sendable, Equatable {
    /// Stable per kind of attachment ("sight:screen"): removing it keeps it off for this send.
    public var id: String
    /// What the chip says.
    public var chip: String
    public var icon: IconSpec?
    /// Appended to the words on send, already redacted and trimmed by the extension.
    public var body: String
    /// The words are about this attachment (they point at the screen, or text is selected): a
    /// question goes to a model that reads it, never to memory.ask, which cannot.
    public var aboutIt: Bool
    public init(id: String, chip: String, icon: IconSpec? = nil, body: String, aboutIt: Bool = false) {
        self.id = id; self.chip = chip; self.icon = icon; self.body = body; self.aboutIt = aboutIt
    }
}

/// Where the words are headed: an agent, a session, a project's new thread, or a quick Ask.
public enum SendTargetKind: Sendable { case agent, thread, project, ask }

/// Adopted by an extension that attaches things to sends. Asked as the words change (debounce on
/// your side), only while the words are headed to a send; nil means no chip. Answer fast, from
/// what you already hold.
@MainActor
public protocol SendAttaching: AnyObject {
    func attachment(for words: String, to: SendTargetKind) async -> SendAttachment?
    /// At once, with no reads: could these words' attachment be about them (`aboutIt`)? False lets
    /// a quick question go to memory.ask without waiting for the chip.
    func mayBeAbout(_ words: String) -> Bool
}

extension SendAttaching {
    public func mayBeAbout(_ words: String) -> Bool { false }
}

/// Something `@` can name that an extension sends to: an app, a service, a person in it.
public struct MentionTarget: Sendable, Equatable {
    /// Stable within the extension, never shown ("notes", "slack:#general").
    public var id: String
    /// What the user reads and matches against ("Notes", "Slack #general").
    public var label: String
    /// A few words under it ("new note", "through Slack", "live").
    public var sub: String
    public var icon: IconSpec
    /// Where the words go, shown in the bar before Enter ("Notes on this Mac", "Slack").
    public var sendsTo: String
    /// True for a target that holds others (an app holding contacts): picked, it is a chip under
    /// which a second `@` asks the same extension for its children. False for a leaf, the default.
    /// Nesting stops at two levels: a child's `nests` is ignored, so "WhatsApp › juno" is as deep
    /// as a chip goes.
    public var nests: Bool
    /// For a child, the id of the target it sits under ("whatsapp" for "juno"), or nil. The
    /// Capsule does not read it; it is there so an extension can tell its own rows apart.
    public var parentID: String?
    public init(id: String, label: String, sub: String = "", icon: IconSpec = .symbol("app"), sendsTo: String,
                nests: Bool = false, parentID: String? = nil) {
        self.id = id; self.label = label; self.sub = sub; self.icon = icon; self.sendsTo = sendsTo
        self.nests = nests; self.parentID = parentID
    }
}

/// Where an `@` is being typed: after nothing, or inside a chip that nests.
public struct MentionContext: Sendable, Equatable {
    /// The current chip, when it belongs to the extension being asked and nests; nil otherwise.
    public var parent: MentionTarget?
    /// The id of the extension the chip belongs to ("whatsapp"), or nil when there is no chip.
    public var extensionID: String?
    public init(parent: MentionTarget? = nil, extensionID: String? = nil) { self.parent = parent; self.extensionID = extensionID }
    /// No chip: every extension is asked, as before nesting.
    public static let top = MentionContext()
}

/// An open stream: JSON and binary frames out, close when done.
public protocol VyredStream: AnyObject, Sendable {
    func sendBinary(_ d: Data)
    func sendJSON(_ obj: [String: Any])
    func close()
}

/// Why a stream did not open, in words to show. Codes: unreachable, timeout, refused, not_found.
public struct VyredStreamFailure: Error, Sendable, Equatable {
    public var code: String
    public var message: String
    public init(code: String, message: String) { self.code = code; self.message = message }
}

/// The one window the Capsule lets an extension put on screen besides the panel: the session
/// panel (the assistant beside the user's work in the side view). The Capsule owns it, so it can
/// animate it (AX cannot animate another app's window), keep it on the user's Space, and close it
/// when the side view closes. It never takes focus from the app the user is in unless they click
/// it, and it opens only because the user asked for something that needs it (a command).
@MainActor
public protocol SessionWindow: AnyObject {
    var isOpen: Bool { get }
    /// Its frame in screen coordinates (AppKit, bottom-left origin).
    var frame: NSRect { get }
    /// Show `content` at `frame`. Replaces what it showed before.
    func show(_ content: AnyView, frame: NSRect)
    /// Move or resize; animated over `duration` seconds when > 0 (0.25 is the Capsule's pace),
    /// easing in and out.
    func setFrame(_ frame: NSRect, duration: TimeInterval)
    /// The same with a curve of your choosing (ease-out for a slide in, ease-in for one out).
    func setFrame(_ frame: NSRect, duration: TimeInterval, curve: SessionWindowCurve)
    func close()
}

public enum SessionWindowCurve: Sendable { case easeInOut, easeOut, easeIn, linear }

public extension SessionWindow {
    /// A window that knows no curves (a test's fake) moves as it always does.
    func setFrame(_ frame: NSRect, duration: TimeInterval, curve: SessionWindowCurve) { setFrame(frame, duration: duration) }
}

public enum VyredResult: @unchecked Sendable {
    case success(Any)
    case failure(code: String, message: String)
    public var data: Any? { if case .success(let d) = self { return d }; return nil }
    public var error: String? { if case .failure(_, let m) = self { return m }; return nil }
    public var errorCode: String? { if case .failure(let c, _) = self { return c }; return nil }
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
    /// The box's own words right now, for an extension that needs to remember them before it
    /// starts changing the box itself (voice's dictation baseline). The default answers "".
    func currentQuery() -> String
    /// Words being spoken into the box. While `final` is false they are shown as they come and
    /// ask nothing; `final: true` ends the dictation with the words left in the box to edit --
    /// nothing is submitted on its own (tap-to-stop keeps the words; only submitDictation() or an
    /// ordinary ⏎ actually asks).
    func dictate(_ text: String, final: Bool)
    /// ⏎ pressed while still listening, or the "send it" command word: submit the box's current
    /// words right now, as ⏎ would (a question answers, a follow-up continues). The default does
    /// nothing (a test's fake host has no box to submit from).
    func submitDictation()
    /// Esc while listening: the dictation is cancelled and the box goes back to exactly `restore`
    /// (what it held before this utterance started) -- never a general clear, and nothing typed
    /// before or after the dictation is touched. The default falls back to setQuery.
    func cancelDictation(_ restore: String)
    /// A line under the box, for a moment ("Copied", "No window in front").
    func say(_ line: String)
    /// Hide the Capsule and wait until `front` is frontmost again (up to 800 ms). True if it is.
    func stepAside() async -> Bool
    /// A macOS notification, only if the Capsule is hidden; otherwise said under the box.
    func notify(title: String, body: String)
    func log(_ message: String)
    /// The session panel, owned by the Capsule, one for all extensions. `owner` is the extension's
    /// id; a second owner gets the same window and the first is told nothing, so take it only
    /// from a command the user ran.
    func sessionWindow(owner: String) -> SessionWindow
    /// The session window now shows this session (nil: it closed). The Capsule takes that
    /// session's project as the current one (memory.ask's context, the project chip).
    func sessionShown(thread: String?, project: String?)
    /// Your `commands` (or `providers`) changed while the Capsule is open, for example a session
    /// started: the Capsule reads them again and redraws the list.
    func commandsChanged()
    /// Call a human-only tool (ADR 0004) with your words above Touch ID in the panel ("Send
    /// 'on my way' to Dana in WhatsApp"). A live presence session covers it without asking when
    /// the tool may ride one. Esc or a refusal comes back as `.failure(code: "presence")`.
    func prove(tool: String, input: [String: Any], summary: String) async -> VyredResult

    /// A module needs a key or a login: the Capsule shows "Add your <label>" in the panel with a
    /// secure field, saves it through the vault as the person, then calls `saved`. Never a
    /// terminal command to run (the user, 2026-09-27). See Host/Credentials.swift.
    func askCredential(_ need: CredentialNeed, saved: @escaping @MainActor () -> Void)
}

/// What a module needs saved in the vault: vault's need (module + need id, ADR 0028 decision 9),
/// and for a vyred without vault.connect, the item name the module reads.
public struct CredentialNeed: Sendable, Equatable {
    public struct Field: Sendable, Equatable {
        public var name: String
        public var label: String
        public var secret: Bool
        public init(name: String, label: String, secret: Bool = true) { self.name = name; self.label = label; self.secret = secret }
    }
    public var module: String
    public var need: String
    /// "Deepgram key": what the row asks for.
    public var label: String
    public var fields: [Field]
    /// The vault item the module reads (voice-deepgram-key), for vault.put + vault.grant.
    public var item: String?
    public var help: String?
    public init(module: String, need: String, label: String, fields: [Field] = [Field(name: "value", label: "Key")], item: String? = nil, help: String? = nil) {
        self.module = module; self.need = need; self.label = label; self.fields = fields; self.item = item; self.help = help
    }
}

public extension CapsuleHost {
    /// A host with no windows (a test's fake host) hands out one that shows nothing.
    func sessionWindow(owner: String) -> SessionWindow { NoSessionWindow() }
    func sessionShown(thread: String?, project: String?) {}
    func currentQuery() -> String { "" }
    func dictate(_ text: String, final: Bool) { setQuery(text) }
    func submitDictation() {}
    func cancelDictation(_ restore: String) { setQuery(restore) }
    func prove(tool: String, input: [String: Any], summary: String) async -> VyredResult {
        await vyred.call(tool, input, presence: true, summary: summary)
    }
    func commandsChanged() {}
    func askCredential(_ need: CredentialNeed, saved: @escaping @MainActor () -> Void) {}
}

@MainActor
final class NoSessionWindow: SessionWindow {
    var isOpen: Bool { false }
    var frame: NSRect { .zero }
    func show(_ content: AnyView, frame: NSRect) {}
    func setFrame(_ frame: NSRect, duration: TimeInterval) {}
    func close() {}
}

/// True only when a person has said dialogs may appear (the lead sets VYRE_TEST_DIALOGS=1 for a
/// test that needs one), or outside tests entirely. A test home is marked by VYRE_CAPSULE_TEST.
public func dialogsAllowed(_ env: [String: String] = ProcessInfo.processInfo.environment) -> Bool {
    if env["VYRE_TEST_DIALOGS"] == "1" { return true }
    return env["VYRE_CAPSULE_TEST"] == nil
}
