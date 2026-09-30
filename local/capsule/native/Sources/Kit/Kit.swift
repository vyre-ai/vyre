// Kit: the types every part of the Capsule shares, and the seam other teams build into.
//
// The Capsule is one Swift process (ADR 0017). Everything that puts something in it (a result
// row, a command, a side panel) goes through the types in this folder, whether it is the
// Capsule's own launcher or an extension another team owns (Sources/Extensions/<name>/). The rules
// that keep it light and honest live here too, because an extension inherits them by using these
// types, not by reading a document:
//
//   - A provider answers from what it already holds (quick) or within its budget (full). The
//     Capsule never waits on a slow provider to draw the rows it has.
//   - Nothing runs while the Capsule is hidden unless it has to. Providers get warm() on show and
//     cool() on hide; a timer or a query left running after cool() is a bug.
//   - A permission is asked for on first use only, through CapsuleHost.request(_:), which says
//     why before macOS asks and never raises an OS dialog in a test (dialogsAllowed()).
//   - What the user types stays in this process. A provider that sends the query anywhere (vyred,
//     a module) says so in `sendsQuery`, and the Capsule shows where before the row is picked.

import Foundation

/// What the user typed, and what the Capsule knows about the moment.
public struct Query: Sendable, Equatable {
    public var text: String
    /// Lowercased, trimmed, single-spaced. What providers match against.
    public var normalized: String
    /// The app that was in front when the Capsule opened (what fill, paste and "ask about my
    /// screen" act on). Nil when the Capsule opened over the desktop or itself.
    public var front: FrontApp?

    public init(_ text: String, front: FrontApp? = nil) {
        self.text = text
        self.normalized = text.lowercased().split(whereSeparator: \.isWhitespace).joined(separator: " ")
        self.front = front
    }
}

public struct FrontApp: Sendable, Equatable, Codable {
    public var bundle: String
    public var pid: Int32
    public var name: String
    public init(bundle: String, pid: Int32, name: String) { self.bundle = bundle; self.pid = pid; self.name = name }
}

/// What is drawn beside a row. The Capsule resolves each to a real picture, cached.
public enum IconSpec: Sendable, Equatable {
    /// The icon Finder shows for this path: an app's own icon, a file's type or thumbnail.
    case file(String)
    /// An app by bundle id.
    case bundle(String)
    /// An SF Symbol, optionally tinted with one of the Capsule's token colours.
    case symbol(String, Tint = .stone)
    /// The Vyre mark.
    case mark
    /// A contact's photo, by contact identifier; falls back to initials.
    case contact(String, initials: String)
    /// A solid colour swatch (the colour picker, a calendar's colour).
    case swatch(r: Double, g: Double, b: Double)
    /// An emoji or short text drawn as the picture.
    case glyph(String)
    case none
}

/// The token colours an extension may tint with (docs/design/TOKENS.md). No others.
public enum Tint: String, Sendable {
    case bone, stone, ash, signal, recall, attention
}

/// Which group a row is listed under. Order here is the order groups are drawn in when scores tie.
public enum Section: String, Sendable, CaseIterable {
    case top = "Top hit"
    case vyre = "Vyre"
    case answer = "Answer"
    case commands = "Commands"
    case apps = "Apps"
    case people = "People"
    case files = "Files"
    case documents = "In documents"
    case mail = "Mail"
    case calendar = "Calendar"
    case browser = "Browser"
    case windows = "Windows"
    case clipboard = "Clipboard"
    case snippets = "Snippets"
    case settings = "Settings"
    case modules = "From modules"
    case web = "Web"
    case other = "Other"
}

/// One row. `id` is stable for the same thing across queries (frecency is keyed by it) and is
/// never shown: copy uses `title` (a gallery gap was "Code for p1"; see brief item 6).
public struct ResultItem: Identifiable, Sendable {
    public var id: String
    public var kind: String
    public var title: String
    public var subtitle: String
    public var icon: IconSpec
    public var section: Section
    /// 0..1 from the match tier (exact 1, prefix 0.8, word-prefix 0.6, substring 0.3), plus
    /// whatever the provider knows. Frecency is added by the Capsule, not the provider.
    public var score: Double
    /// Verbs, first is Enter. ⌘K lists them all.
    public var actions: [ResultAction]
    /// A file URL for Quick Look on Space and for dragging out, when the row is a file.
    public var fileURL: URL?
    /// Text to copy on ⌘C when the row has no selection of its own (a calc answer, a path).
    public var copyText: String?
    /// Where the query goes if this row is picked, for rows that send it off this Mac process
    /// ("the assistant", "the web", "the vault module"). Nil for local rows.
    public var sendsTo: String?
    /// An extension's own detail view for the side panel, by the extension's id.
    public var panel: String?
    /// Free-form, for the provider's own use when an action runs.
    public var payload: [String: String]

    public init(id: String, kind: String, title: String, subtitle: String = "", icon: IconSpec = .none,
                section: Section = .other, score: Double = 0.3, actions: [ResultAction] = [], fileURL: URL? = nil,
                copyText: String? = nil, sendsTo: String? = nil, panel: String? = nil, payload: [String: String] = [:]) {
        self.id = id; self.kind = kind; self.title = title; self.subtitle = subtitle; self.icon = icon
        self.section = section; self.score = score; self.actions = actions; self.fileURL = fileURL
        self.copyText = copyText; self.sendsTo = sendsTo; self.panel = panel; self.payload = payload
    }
}

/// What running an action did, said in words the Capsule shows as they are.
public enum ActionOutcome: Sendable, Equatable {
    /// Done: close the Capsule, optionally with a line to show as a notification.
    case close(String? = nil)
    /// Done, stay open, show this line under the box.
    case said(String)
    /// Replace the box's text (a completion, a command that takes an argument).
    case replaceQuery(String)
    /// Open the side panel for this row.
    case openPanel
    /// Not done, and why. Never reported as success (a gallery gap was "Filled p1 in no app").
    case failed(String)
}

public struct KeyShortcut: Sendable, Equatable {
    public var key: String          // "return", "c", "o", "delete", "space"
    public var command = false, option = false, shift = false, control = false
    public init(_ key: String, command: Bool = false, option: Bool = false, shift: Bool = false, control: Bool = false) {
        self.key = key; self.command = command; self.option = option; self.shift = shift; self.control = control
    }
}

public struct ResultAction: Identifiable, Sendable {
    public var id: String
    public var title: String
    public var symbol: String
    public var shortcut: KeyShortcut?
    /// Asks "Are you sure?" inline first (restart, empty trash, quit all). Destructive work never
    /// runs from one keypress.
    public var confirm: String?
    /// Steps the Capsule out of the way and waits for the front app to be frontmost before running
    /// (fill, paste, type into the app).
    public var needsFrontApp: Bool
    public var run: @Sendable (ResultItem, ActionContext) async -> ActionOutcome

    public init(id: String, title: String, symbol: String = "return", shortcut: KeyShortcut? = nil, confirm: String? = nil,
                needsFrontApp: Bool = false, run: @escaping @Sendable (ResultItem, ActionContext) async -> ActionOutcome) {
        self.id = id; self.title = title; self.symbol = symbol; self.shortcut = shortcut; self.confirm = confirm
        self.needsFrontApp = needsFrontApp; self.run = run
    }
}

public struct ActionContext: Sendable {
    public var query: Query
    /// Whether the front app was frontmost again when the action ran (only for needsFrontApp).
    public var frontIsBack: Bool
    public init(query: Query, frontIsBack: Bool = false) { self.query = query; self.frontIsBack = frontIsBack }
}

/// How long a provider may take. The Capsule draws quick rows in the same frame as the keystroke
/// and merges full rows when they land, if the box still says the same thing.
public enum Speed: Sendable { case quick, full }

/// A source of rows. Called on the main actor for quick (keep it under 4 ms, from memory), and off
/// it for full.
public protocol ResultProvider: AnyObject, Sendable {
    var id: String { get }
    var speed: Speed { get }
    /// Non-nil when the query itself leaves the process while typing (a module search). Shown.
    var sendsQuery: String? { get }
    func results(for query: Query) async -> [ResultItem]
    /// The Capsule is about to show: fill caches that are cheap to fill.
    func warm()
    /// The Capsule hid: stop queries, timers and observers. Keep only what is needed to be quick
    /// next time within the memory budget.
    func cool()
}

/// A quick provider that can answer in the keystroke's own frame, from memory, without a Task
/// hop: its rows are drawn with the text that asked for them.
public protocol ImmediateResults: ResultProvider {
    func resultsNow(for query: Query) -> [ResultItem]
}

public extension ResultProvider {
    var sendsQuery: String? { nil }
    func warm() {}
    func cool() {}
}

/// A named command in the list ("Lock screen", "Toggle dark mode", "Ask about my screen").
/// Matched on title and keywords like any row; its actions are what Enter and ⌘K run.
public struct CapsuleCommand: Sendable {
    public var id: String
    public var title: String
    public var keywords: [String]
    public var icon: IconSpec
    public var subtitle: String
    public var actions: [ResultAction]
    public init(id: String, title: String, keywords: [String] = [], icon: IconSpec = .symbol("command"),
                subtitle: String = "", actions: [ResultAction]) {
        self.id = id; self.title = title; self.keywords = keywords; self.icon = icon; self.subtitle = subtitle; self.actions = actions
    }
}

/// The macOS permissions the Capsule can ask for. Each is asked for on first use, never at install.
public enum Permission: String, Sendable, CaseIterable {
    case accessibility, inputMonitoring, screenRecording, contacts, calendars, reminders, automation, microphone, speech, fullDisk
}

public enum PermissionState: String, Sendable { case granted, denied, notAsked, restricted }
