// ViewCommandsProvider: the commands modules declare for the Capsule (`view:` entries, and the older
// results: and action: keys folded in by vyred), as rows you can go into. It asks vyred for the list
// (`capsule.commands`) when the Capsule shows, at most twice a minute, and matches titles, keywords
// and aliases in memory on every key, so nothing waits on a call to show a command.
//
// Return on a command opens it in the box (Host/ViewMode.swift). "mail invoice", with `mail` an alias
// of the command, opens it already searching for "invoice".

import Foundation

public final class ViewCommandsProvider: ResultProvider, ImmediateResults, @unchecked Sendable {
    public let id = "view-commands"
    public let speed = Speed.quick
    private let vyred: VyredLink
    private let lock = NSLock()
    private var list: [ViewCommand] = []
    private var readAt: Date?
    private var reading = false
    private let now: @Sendable () -> Date
    static let readEvery: TimeInterval = 30
    /// Open this command, searching for these words. Set by the model.
    var enter: @Sendable (ViewCommand, String) -> Void = { _, _ in }
    /// The list changed (read again): the model searches again for the words in the box.
    var onChange: @Sendable () -> Void = {}

    public init(vyred: VyredLink, now: @escaping @Sendable () -> Date = { Date() }) { self.vyred = vyred; self.now = now }

    public var commands: [ViewCommand] { lock.lock(); defer { lock.unlock() }; return list }

    public func command(module: String, id: String) -> ViewCommand? { commands.first { $0.module == module && $0.id == id } }

    /// Read `capsule.commands` if this vyred has it and the last read is old. Also on `capsule.changed`.
    public func warm() { read(force: false) }

    public func read(force: Bool) {
        guard vyred.has("capsule.commands") else { return }
        let t = now()
        lock.lock()
        if reading || (!force && (readAt.map { t.timeIntervalSince($0) < Self.readEvery } ?? false)) { lock.unlock(); return }
        reading = true; readAt = t
        lock.unlock()
        Task { [weak self] in await self?.fetch() }
    }

    /// Read now and wait for it (the next-meeting line needs the list before it can ask for a row).
    public func readNow() async {
        guard vyred.has("capsule.commands") else { return }
        lock.lock()
        if reading { lock.unlock(); return }
        reading = true; readAt = now()
        lock.unlock()
        await fetch()
    }

    private func fetch() async {
        let r = await vyred.call("capsule.commands", [:], presence: false)
        lock.lock(); reading = false
        let changed = r.data != nil && ViewCommand.parse(r.data) != list
        if r.data != nil { list = ViewCommand.parse(r.data) }
        lock.unlock()
        if changed { onChange() }
    }

    public func results(for q: Query) async -> [ResultItem] { resultsNow(for: q) }

    public func resultsNow(for q: Query) -> [ResultItem] {
        let t = q.normalized
        guard t.count >= 2 else { return [] }
        let all = commands
        if all.isEmpty { return [] }
        var out: [ResultItem] = []
        // "mail invoice": an alias, a space, and the words to search for.
        if let sp = t.firstIndex(of: " ") {
            let head = String(t[..<sp]), rest = String(t[t.index(after: sp)...]).trimmingCharacters(in: .whitespaces)
            if !rest.isEmpty, let c = all.first(where: { $0.alias?.lowercased() == head && $0.takesArg }) {
                out.append(row(c, score: 1.4, words: rest, title: "\(c.title): \(rest)"))
            }
        }
        for c in all {
            var s = Match.score(t, c.title, synonyms: c.keywords)
            if c.alias?.lowercased() == t { s = max(s, 1.2) }
            guard s >= 0.5 else { continue }
            out.append(row(c, score: s, words: "", title: c.title))
        }
        return out.sorted { $0.score > $1.score }.prefix(4).map { $0 }
    }

    func row(_ c: ViewCommand, score: Double, words: String, title: String) -> ResultItem {
        let enter = self.enter
        let icon: IconSpec = c.icon.flatMap { ViewIcon.spec($0) } ?? .symbol("square.grid.2x2")
        return ResultItem(id: "view-command:\(c.key)\(words.isEmpty ? "" : ":" + words)", kind: "view-command", title: title,
                          subtitle: c.firstParty ? c.module.capitalized : "from \(c.module)", icon: icon, section: .commands, score: score,
                          actions: [ResultAction(id: "open", title: "Open", symbol: "return") { _, _ in enter(c, words); return .said("") }])
    }
}

enum ViewIcon {
    /// A module supplies a symbol name or `app:<bundle id>`, never a picture. Anything else is not drawn.
    static func spec(_ s: String) -> IconSpec? {
        if s.hasPrefix("app:") {
            let b = String(s.dropFirst(4))
            return b.range(of: #"^[A-Za-z0-9.\-]{3,120}$"#, options: .regularExpression) != nil ? .bundle(b) : nil
        }
        return s.range(of: #"^[a-z0-9]+(\.[a-z0-9]+){0,4}$"#, options: .regularExpression) != nil ? .symbol(s) : nil
    }
}
