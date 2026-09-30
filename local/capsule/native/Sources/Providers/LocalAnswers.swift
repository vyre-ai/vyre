// LocalAnswers: the answers the Capsule works out on this Mac from what you typed, and the lists you
// keep yourself. One quick provider, all from memory in the keystroke's own frame:
//   - emoji ("smile emoji", ":tada"), colours ("#ff6347", "rgb(255 99 71)"), time zones
//     ("time in tokyo"), and money ("100 usd in eur"),
//   - your snippets, quicklinks and commands, from <home>/capsule/snippets.json (Core/Snippets.swift
//     says the format). A bad entry is left out and named; the rest still work.
//
// Enter copies an answer. A snippet copies its text with {date}, {time}, {clipboard} filled in. A
// quicklink opens its link with what you typed after its keyword. A command opens its link, or
// runs its shell line after asking once.
//
// Money needs exchange rates. They come from one public source (open.er-api.com, no account, one
// request that carries no words of yours), only when you type something that reads as money, at
// most once every 12 hours, and are kept in <home>/capsule/rates.json. With no rates and no network
// there is simply no money row, never a wrong one. Answers older than a day say how old they are.

import AppKit
import Foundation

/// Where exchange rates come from. Tests give their own; `live` asks the public source.
public struct RatesFetch: Sendable {
    public var get: @Sendable () async -> Data?
    public init(_ get: @escaping @Sendable () async -> Data?) { self.get = get }

    public static let source = URL(string: "https://open.er-api.com/v6/latest/USD")!
    public static let live = RatesFetch {
        var req = URLRequest(url: source, timeoutInterval: 8)
        req.setValue("Vyre-Capsule", forHTTPHeaderField: "User-Agent")
        guard let (data, resp) = try? await URLSession.shared.data(for: req), (resp as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return data
    }

    /// {"result":"success","base_code":"USD","time_last_update_unix":..,"rates":{"EUR":0.92,..}}
    static func parse(_ data: Data, now: Date) -> CurrencyRates? {
        guard let j = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], (j["result"] as? String) == "success",
              let base = j["base_code"] as? String, let table = j["rates"] as? [String: Any] else { return nil }
        var t: [String: Double] = [:]
        for (k, v) in table { if let d = (v as? NSNumber)?.doubleValue, d.isFinite, d > 0 { t[k] = d } }
        guard t.count >= 10 else { return nil }
        let at = (j["time_last_update_unix"] as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue) } ?? now
        return CurrencyRates(base: base, table: t, fetchedAt: at)
    }
}

public final class LocalAnswersProvider: ResultProvider, ImmediateResults, @unchecked Sendable {
    public let id = "local"
    public let speed = Speed.quick

    private let dir: String
    private let fetch: RatesFetch
    private let now: @Sendable () -> Date
    private let lock = NSLock()
    private var user = UserSnippets()
    private var userStamp: Date?
    private var rates: CurrencyRates?
    private var fetching = false
    private var lastTry: Date?
    /// Told when rates land, so a money row that was waiting for them can appear.
    public var onChange: (@Sendable () -> Void)?
    /// Test seams.
    public var use24h = !(DateFormatter.dateFormat(fromTemplate: "j", options: 0, locale: .current) ?? "").contains("a")
    public var homeCurrency = Locale.current.currency?.identifier ?? "USD"
    public static let refreshAfter: TimeInterval = 12 * 3600
    public static let retryAfter: TimeInterval = 10 * 60

    public init(home: String, fetch: RatesFetch = .live, now: @escaping @Sendable () -> Date = { Date() }) {
        dir = (home as NSString).appendingPathComponent("capsule")
        self.fetch = fetch; self.now = now
    }

    var snippetsPath: String { (dir as NSString).appendingPathComponent("snippets.json") }
    var ratesPath: String { (dir as NSString).appendingPathComponent("rates.json") }

    // MARK: state

    public func warm() {
        reloadUser()
        lock.lock(); let have = rates != nil; lock.unlock()
        if !have, let d = FileManager.default.contents(atPath: ratesPath), let r = try? JSONDecoder().decode(CurrencyRates.self, from: d) {
            lock.lock(); rates = r; lock.unlock()
        }
    }

    public func cool() { EmojiIndex.release() }

    /// Read the file again only when it changed.
    func reloadUser() {
        let stamp = (try? FileManager.default.attributesOfItem(atPath: snippetsPath))?[.modificationDate] as? Date
        lock.lock(); defer { lock.unlock() }
        if stamp == userStamp, userStamp != nil || stamp == nil { return }
        userStamp = stamp
        user = UserSnippets.load(path: snippetsPath)
    }

    /// What is wrong with the file, one line each, for the Capsule to show.
    public var problems: [String] { lock.lock(); defer { lock.unlock() }; return user.problems }

    public var currentRates: CurrencyRates? { lock.lock(); defer { lock.unlock() }; return rates }

    // MARK: rates

    static let moneyWords: Set<String> = Set(Currency.names.keys)
    static let moneyCodes: Set<String> = Currency.common

    /// Does this read as money at all: a number with a currency sign, name, or common code. Decides
    /// only whether to fetch rates; the answer itself is Currency.evaluate's.
    static func readsAsMoney(_ text: String) -> Bool {
        guard text.rangeOfCharacter(from: .decimalDigits) != nil, text.count <= 60 else { return false }
        if text.contains(where: { Currency.symbols[$0] != nil }) { return true }
        let words = text.lowercased().split(whereSeparator: { !$0.isLetter }).map(String.init)
        return words.contains { moneyWords.contains($0) || moneyCodes.contains($0.uppercased()) }
    }

    func maybeFetch(for text: String) {
        guard Self.readsAsMoney(text) else { return }
        let t = now()
        lock.lock()
        let stale = rates.map { t.timeIntervalSince($0.fetchedAt) > Self.refreshAfter } ?? true
        if !stale || fetching || (lastTry.map { t.timeIntervalSince($0) < Self.retryAfter } ?? false) { lock.unlock(); return }
        fetching = true; lastTry = t
        lock.unlock()
        Task { [weak self, fetch] in
            let data = await fetch.get()
            guard let self else { return }
            let parsed = data.flatMap { RatesFetch.parse($0, now: self.now()) }
            self.lock.lock(); self.fetching = false
            if let parsed { self.rates = parsed }
            self.lock.unlock()
            guard let parsed else { return }
            try? FileManager.default.createDirectory(atPath: self.dir, withIntermediateDirectories: true)
            if let d = try? JSONEncoder().encode(parsed) { try? d.write(to: URL(fileURLWithPath: self.ratesPath), options: .atomic) }
            self.onChange?()
        }
    }

    // MARK: rows

    public func results(for q: Query) async -> [ResultItem] { resultsNow(for: q) }

    public func resultsNow(for q: Query) -> [ResultItem] {
        let text = q.text.trimmingCharacters(in: .whitespaces)
        if text.isEmpty { return [] }
        var out: [ResultItem] = []
        if let c = colourResult(q) { out.append(Self.copying(c)) }
        if let t = timeResult(q, now: now(), use24h: use24h) { out.append(Self.copying(t)) }
        out += emojiResults(q).map(Self.copying)
        maybeFetch(for: text)
        if let r = currentRates, let m = currencyResult(q, rates: r, home: homeCurrency, now: now()) { out.append(Self.copying(m)) }
        reloadUser()
        lock.lock(); let u = user; lock.unlock()
        for (s, score) in u.matchSnippets(text).prefix(3) { out.append(snippetRow(s, score: score)) }
        if let (l, arg) = u.matchQuicklink(text) { out.append(quicklinkRow(l, arg: arg)) }
        for (c, score) in u.matchCommands(text).prefix(3) { out.append(commandRow(c, score: score)) }
        return out
    }

    static func copying(_ r: ResultItem) -> ResultItem {
        guard let text = r.copyText, !text.isEmpty else { return r }
        var x = r
        x.actions = [copyAction(text)]
        return x
    }

    static func copyAction(_ text: String) -> ResultAction {
        ResultAction(id: "copy", title: "Copy", symbol: "doc.on.doc") { _, _ in
            await MainActor.run {
                CapsuleModel.replyBoard.clearContents()
                CapsuleModel.replyBoard.setString(text, forType: .string)
            }
            return .close(nil)
        }
    }

    func snippetRow(_ s: Snippet, score: Double) -> ResultItem {
        var r = snippetResult(s, score: score)
        let now = self.now
        r.actions = [ResultAction(id: "copy", title: "Copy", symbol: "doc.on.doc") { _, _ in
            let clip: String? = s.usesClipboard ? await MainActor.run { NSPasteboard.general.string(forType: .string) } : nil
            let text = UserSnippets.expand(s.text, now: now(), clipboard: clip).text
            await MainActor.run {
                CapsuleModel.replyBoard.clearContents()
                CapsuleModel.replyBoard.setString(text, forType: .string)
            }
            return .close(nil)
        }]
        return r
    }

    func quicklinkRow(_ l: Quicklink, arg: String?) -> ResultItem {
        let id = "quicklink:\(l.keyword.lowercased())"
        if l.takesQuery, arg == nil {
            return ResultItem(id: id, kind: "quicklink", title: l.name, subtitle: "Type what to look for after \u{201C}\(l.keyword)\u{201D}",
                              icon: .symbol("link"), section: .commands, score: 1,
                              actions: [ResultAction(id: "fill", title: "Search", symbol: "return") { _, _ in .replaceQuery("\(l.keyword) ") }])
        }
        let url = l.link(arg)
        let title = arg.map { "\(l.name): \($0)" } ?? l.name
        return ResultItem(id: id, kind: "quicklink", title: title, subtitle: url?.absoluteString ?? "", icon: .symbol("link"),
                          section: .commands, score: 1, actions: [Self.openAction(url)])
    }

    func commandRow(_ c: UserCommand, score: Double) -> ResultItem {
        var r = userCommandResult(c, score: score)
        switch c.run {
        case .open(let url): r.actions = [Self.openAction(url)]
        case .shell(let line): r.actions = [ResultAction(id: "run", title: "Run", symbol: "terminal", confirm: c.confirm) { _, _ in Self.runShell(line) }]
        }
        return r
    }

    static func openAction(_ url: URL?) -> ResultAction {
        ResultAction(id: "open", title: "Open", symbol: "arrow.up.right.square") { _, _ in
            guard let url else { return .failed("That is not a link to open.") }
            let ok = await MainActor.run { NSWorkspace.shared.open(url) }
            return ok ? .close(nil) : .failed("Nothing opened \(url.absoluteString).")
        }
    }

    /// Runs the line in /bin/sh from the home folder and lets go of it; its output is not kept.
    static func runShell(_ line: String) -> ActionOutcome {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", line]
        p.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
        p.standardInput = FileHandle.nullDevice; p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return .failed("Could not start it: \(error.localizedDescription)") }
        return .close("Started \u{201C}\(line)\u{201D}")
    }
}

extension LocalAnswersProvider: RowResolver {
    /// A snippet, quicklink or command of yours again, by the id its row had.
    func row(forID id: String) -> ResultItem? {
        reloadUser()
        lock.lock(); let u = user; lock.unlock()
        if id.hasPrefix("snippet:") {
            let kw = String(id.dropFirst(8))
            return u.snippets.first { $0.keyword == kw }.map { snippetRow($0, score: 1) }
        }
        if id.hasPrefix("quicklink:") {
            let kw = String(id.dropFirst(10))
            return u.quicklinks.first { $0.keyword.lowercased() == kw }.map { quicklinkRow($0, arg: nil) }
        }
        if id.hasPrefix("user-command:") {
            let title = String(id.dropFirst(13))
            return u.commands.first { $0.title == title }.map { commandRow($0, score: 1) }
        }
        return nil
    }
}
