// ScreenAttach: what is on the screen, attached to words that point at it (ADR 0015).
//
// The Capsule always knows what is on screen (the user, 2026-09-27): every send from its box
// (quick answers, "do ...", a session) carries a short block of screen context: the app, the
// window, the URL, the selection and an excerpt of the visible text. The Capsule shows it first
// as a chip ("sees: Safari · ...") that the user can remove for that send, and "Stop sharing the
// screen" turns it off until turned back on; off, only words that point at the screen ("summarize
// this", "what's this error") or a selection attach it. Nothing about the screen is ever sent
// without the chip showing.
//
// screen.context already redacts: a password field's value and selection never leave the helper,
// and the floor's blind places (password managers, sign-in dialogs, security settings, Vyre's own
// surfaces) come back with the app and window title only. A blind place gets no chip at all.
//
// Reads happen on demand: one cheap read without text when the Capsule shows (for the
// selection), and one read with text the first time the words trigger. That second read is what
// the chip names and what is sent, so the chip never promises something other than what goes.

import Foundation

/// One screen.context answer (local/screen-mac/screen.js shape, or the floor's blind result).
struct ScreenSnapshot: Equatable {
    var app: String
    var bundle: String?
    var window: String
    var url: String?
    var selection: String?
    var text: String
    var truncated: Bool
    var secure: Bool
    var blind: String?

    init(app: String, bundle: String? = nil, window: String = "", url: String? = nil, selection: String? = nil,
         text: String = "", truncated: Bool = false, secure: Bool = false, blind: String? = nil) {
        self.app = app; self.bundle = bundle; self.window = window; self.url = url; self.selection = selection
        self.text = text; self.truncated = truncated; self.secure = secure; self.blind = blind
    }

    static func from(_ data: Any?) -> ScreenSnapshot? {
        guard let d = data as? [String: Any] else { return nil }
        func s(_ v: Any?) -> String? { (v as? String).flatMap { $0.isEmpty ? nil : $0 } }
        let app = d["app"] as? [String: Any]
        let focused = d["focused"] as? [String: Any]
        let secure = d["secure"] as? Bool ?? false
        return ScreenSnapshot(app: s(app?["name"]) ?? "", bundle: s(app?["bundle"]), window: s((d["window"] as? [String: Any])?["title"]) ?? "",
                              url: s(d["url"]), selection: secure ? nil : s(focused?["selectedText"]), text: d["text"] as? String ?? "",
                              truncated: d["truncated"] as? Bool ?? false, secure: secure, blind: s(d["blind"]))
    }

    /// A selection worth attaching: some non-blank text, outside a password field and the floor.
    var hasSelection: Bool {
        guard !secure, blind == nil, let s = selection else { return false }
        return !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

/// What an Ask carries about the screen: the chip to show and the block to append.
struct ScreenChip: Equatable {
    static let id = "sight:screen"
    var chip: String
    var bundle: String?
    var body: String
}

enum ScreenAttach {
    static let selectionMax = 2000
    static let excerptMax = 1500
    static let titleMax = 40

    // MARK: - Do the words point at the screen?

    /// Words after "this"/"that"/"these" that make it a time, not a thing on the screen.
    private static let timeWords: Set<String> = [
        "week", "weekend", "weeks", "morning", "afternoon", "evening", "night", "year", "years", "month", "months",
        "time", "times", "quarter", "season", "day", "days", "summer", "winter", "spring", "fall", "autumn",
        "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "semester", "term",
    ]
    /// Words before "that" that make it the thing being pointed at rather than a conjunction.
    private static let thatPointers: Set<String> = [
        "what's", "whats", "what", "about", "explain", "summarize", "summarise", "translate",
        "fix", "read", "see", "check", "rewrite", "proofread", "copy", "open", "does",
    ]
    /// Verbs whose object is implied to be what is on screen.
    private static let verbs: Set<String> = ["summarize", "summarise", "translate", "reply", "explain", "rewrite", "proofread", "tldr", "tl;dr"]
    /// What may follow such a verb and still leave the object implied.
    private static let impliedObjects: Set<String> = [
        "it", "this", "that", "these", "here", "page", "email", "mail", "error", "article", "doc", "document",
        "thread", "message", "selection", "text", "screen", "tab", "window", "pdf", "chat", "post", "comment", "to", "into", "in", "for", "back", "please",
    ]

    /// Lowercased words, apostrophes kept, curly quotes straightened.
    static func words(_ s: String) -> [String] {
        let t = s.lowercased().replacingOccurrences(of: "\u{2019}", with: "'").replacingOccurrences(of: "\u{2018}", with: "'")
        var out: [String] = [], cur = ""
        for ch in t {
            if ch.isLetter || ch.isNumber || ch == "'" || ch == ";" && cur == "tl" { cur.append(ch) }
            else if !cur.isEmpty { out.append(cur); cur = "" }
        }
        if !cur.isEmpty { out.append(cur) }
        return out.map { $0.trimmingCharacters(in: CharacterSet(charactersIn: "'")) }.filter { !$0.isEmpty }
    }

    /// True when the words refer to something on the screen: "this", "here", "on my screen", or a
    /// verb such as "summarize" left without an object of its own.
    static func refersToScreen(_ text: String) -> Bool {
        let w = words(text)
        guard !w.isEmpty else { return false }
        for (i, word) in w.enumerated() {
            let next = i + 1 < w.count ? w[i + 1] : nil
            let prev = i > 0 ? w[i - 1] : nil
            switch word {
            case "this", "these":
                if let n = next, timeWords.contains(n) { continue }
                if word == "these", next == "days" { continue }
                return true
            case "that":
                if let n = next, timeWords.contains(n) { continue }
                if next == nil { return true }
                if let p = prev, thatPointers.contains(p) { return true }
            case "here":
                // "here's my ...", "here is my ...", "here are my ...": the words are the content.
                if next == "my" { continue }
                if (next == "is" || next == "are"), i + 2 < w.count, w[i + 2] == "my" { continue }
                if prev == "come" || prev == "over" { continue }
                return true
            case "here's":
                if next == "my" { continue }
                return true
            case "screen":
                if prev == "my" || prev == "the" || prev == "on" { return true }
            default:
                break
            }
        }
        // An imperative verb with no object of its own: "summarize", "translate to French",
        // "reply saying yes", "explain please". "explain recursion" has its own object.
        if let first = w.first, verbs.contains(first) {
            if w.count == 1 { return true }
            let second = w[1]
            if impliedObjects.contains(second) { return true }
            // "summarize the page", "explain my error": a determiner, then one of the same things.
            if ["the", "my", "this", "that"].contains(second), w.count > 2, impliedObjects.contains(w[2]) { return true }
            if first == "reply" { return true }
        }
        return false
    }

    /// Attach always while sharing is on, else when the words point at the screen or text is
    /// selected; never in a blind place, and never a password field's value (body() leaves it out).
    static func decide(words: String, light: ScreenSnapshot, always: Bool = false) -> Bool {
        if light.blind != nil { return false }
        return always || refersToScreen(words) || light.hasSelection
    }

    // MARK: - The chip and the block

    static func chip(_ s: ScreenSnapshot) -> String {
        let app = s.app.isEmpty ? "the app in front" : s.app
        let title = s.window.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, title != s.app else { return "sees: \(app)" }
        let short = title.count > titleMax ? String(title.prefix(titleMax - 1)).trimmingCharacters(in: .whitespaces) + "\u{2026}" : title
        return "sees: \(app) \u{00B7} \(short)"
    }

    /// The block appended to the words. Empty for a blind place (which never gets a chip).
    static func body(_ s: ScreenSnapshot) -> String {
        guard s.blind == nil else { return "" }
        var lines = ["[Screen context, shared by the user from the Capsule]"]
        if !s.app.isEmpty { lines.append("App: \(s.app)") }
        let title = s.window.trimmingCharacters(in: .whitespacesAndNewlines)
        if !title.isEmpty { lines.append("Window: \(title)") }
        if let u = s.url, !u.isEmpty { lines.append("URL: \(cleanURL(u))") }
        if s.secure {
            lines.append("(a password field was focused; its value was left out)")
        } else if s.hasSelection, let sel = s.selection {
            let t = sel.trimmingCharacters(in: .whitespacesAndNewlines)
            lines.append("Selected text:")
            lines.append(t.count > selectionMax ? String(t.prefix(selectionMax)) + "..." : t)
        }
        let ex = excerpt(s.text, truncated: s.truncated)
        if !ex.isEmpty {
            lines.append("Visible text (excerpt):")
            lines.append(ex)
        }
        return "\n\n" + lines.joined(separator: "\n")
    }

    /// The visible text with runs of spaces collapsed and blank lines dropped, cut on a line
    /// boundary at about `excerptMax` characters, with "..." where it was cut.
    static func excerpt(_ text: String, truncated: Bool = false, max: Int = excerptMax) -> String {
        var kept: [String] = [], used = 0, cut = false
        for raw in text.split(whereSeparator: \.isNewline) {
            let line = raw.split(whereSeparator: { $0 == " " || $0 == "\t" }).joined(separator: " ")
            if line.isEmpty { continue }
            let cost = line.count + (kept.isEmpty ? 0 : 1)
            if used + cost > max {
                cut = true
                if kept.isEmpty {
                    // One very long line: cut it on a word boundary.
                    var head = String(line.prefix(max))
                    if let sp = head.lastIndex(of: " "), head.distance(from: head.startIndex, to: sp) > max / 2 { head = String(head[..<sp]) }
                    kept.append(head)
                }
                break
            }
            kept.append(line); used += cost
        }
        if kept.isEmpty { return "" }
        return kept.joined(separator: "\n") + (cut || truncated ? "\n..." : "")
    }

    /// Query or fragment parameter names that look like credentials.
    private static let tokenKeys: Set<String> = ["token", "key", "code", "sig", "signature", "auth", "session", "password", "pass", "secret", "otp", "jwt"]

    private static func looksLikeToken(_ name: String) -> Bool {
        let parts = name.lowercased().split(whereSeparator: { $0 == "_" || $0 == "-" || $0 == "." })
        return parts.contains { tokenKeys.contains(String($0)) }
    }

    /// The URL with its query and fragment removed when either carries something that looks like a
    /// credential (token, key, code, sig, auth, session, password). The path is always kept.
    static func cleanURL(_ s: String) -> String {
        guard var c = URLComponents(string: s) else { return s }
        if let items = c.queryItems, items.contains(where: { looksLikeToken($0.name) }) { c.query = nil }
        if let f = c.fragment {
            let names = f.split(separator: "&").map { $0.split(separator: "=", maxSplits: 1).first.map(String.init) ?? "" }
            if f.contains("="), names.contains(where: looksLikeToken) { c.fragment = nil }
        }
        return c.string ?? s
    }
}

/// Holds the two reads for one Capsule show (or one panel draft): the light one for the
/// selection, and the full one that the chip names and the send carries.
@MainActor
final class ScreenAttacher {
    private let vyred: VyredLink
    private let log: (String) -> Void
    private var light: ScreenSnapshot?
    private var lightTask: Task<ScreenSnapshot?, Never>?
    private var full: ScreenSnapshot?
    private var generation = 0

    /// Whether every send carries the screen (ScreenSharing), asked at each attachment.
    var always: () -> Bool = { false }

    init(vyred: VyredLink, log: @escaping (String) -> Void = { _ in }) { self.vyred = vyred; self.log = log }

    var available: Bool { vyred.has("screen.context") }

    /// The cheap read, started now so the first keystroke does not wait on it.
    func prime() {
        guard available, light == nil, lightTask == nil else { return }
        let gen = generation
        lightTask = Task { @MainActor [weak self] in
            guard let self else { return nil }
            let s = await self.read(text: false)
            if gen == self.generation { self.light = s }
            return s
        }
    }

    /// Forget both reads: the next attachment reads the screen again.
    func reset() {
        generation += 1
        lightTask?.cancel(); lightTask = nil
        light = nil; full = nil
    }

    /// The chip and block for these words, or nil: nothing points at the screen, the place is
    /// blind, or screen.context could not be read (not granted, not built, no module).
    func attachment(for words: String) async -> ScreenChip? {
        guard available else { return nil }
        let gen = generation
        if light == nil {
            if lightTask == nil { prime() }
            let s = await lightTask?.value
            guard gen == generation else { return nil }
            light = light ?? s
        }
        guard let l = light, ScreenAttach.decide(words: words, light: l, always: always()) else { return nil }
        if full == nil {
            let s = await read(text: true)
            guard gen == generation else { return nil }
            full = s
        }
        guard let f = full, f.blind == nil else { return nil }
        return ScreenChip(chip: ScreenAttach.chip(f), bundle: f.bundle, body: ScreenAttach.body(f))
    }

    private func read(text: Bool) async -> ScreenSnapshot? {
        var input: [String: Any] = ["text": text]
        if text { input["textMax"] = 4000 }
        let r = await vyred.call("screen.context", input, presence: false)
        if let e = r.error { log("sight: no screen context for the chip: \(e)"); return nil }
        return ScreenSnapshot.from(r.data)
    }
}

/// Whether the Capsule shares the screen with every send: on unless the person turned it off.
/// Kept in the app's own defaults; a test home keeps it in memory only.
@MainActor final class ScreenSharing {
    static let key = "shareScreen"
    private let defaults: UserDefaults?
    private var memory: Bool

    init(defaults: UserDefaults?) {
        self.defaults = defaults
        memory = defaults?.object(forKey: Self.key) as? Bool ?? true
    }

    /// The app's own suite, or nothing under tests.
    static func standard() -> ScreenSharing {
        ScreenSharing(defaults: ProcessInfo.processInfo.environment["VYRE_CAPSULE_TEST"] == nil ? UserDefaults(suiteName: "sh.vyre.capsule") : nil)
    }

    var on: Bool {
        get { memory }
        set { memory = newValue; defaults?.set(newValue, forKey: Self.key) }
    }
}
