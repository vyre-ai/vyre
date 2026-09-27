// FilesProvider and its Spotlight siblings: files and folders by name, what was opened this week,
// words inside documents, and mail. All four read the Spotlight index this Mac already keeps;
// none asks for a permission or raises a dialog, and none sends the query anywhere.
//
//   FilesProvider        kMDItemDisplayName contains the query (2+ chars), noise dropped, ranked
//                        by FileTaste.taste(). Section Files.
//   RecentFilesProvider  kMDItemLastUsedDate in the last 7 days, newest first. Shown on an empty
//                        box and for "recent" (then filtered by what follows). Section Files.
//   DocumentsProvider    kMDItemTextContent has the query's words (3+ chars), minus files whose
//                        name already matched (they are in Files). Section In documents, ranked
//                        below name matches.
//   MailProvider         Mail's messages in the index (com.apple.mail.emlx), by subject, sender or
//                        words in the text (3+ chars). Opens in Mail by its message: URL when the
//                        index has the Message-ID, else the .emlx file. Section Mail.
//
// Each keeps one SpotlightQuery (Spotlight.swift) and waits 90 ms for typing to settle, like
// local.js, before re-aiming it. cool() stops the query and forgets cached rows' queries, so
// nothing runs while the Capsule is hidden. Predicates are built by SpotlightPredicates, pure, so
// the tests can check them without an index (the scratch folder is not indexed by Spotlight).

import AppKit
import CoreServices
import Foundation

public enum SpotlightPredicates {
    public static func names(_ q: String) -> String { FileTaste.mdQuery(q) }

    /// Words of the query, each a word-prefix match on the text: "quarterly led" finds "ledger".
    public static func textWords(_ q: String) -> [String] {
        q.split(whereSeparator: \.isWhitespace).map { FileTaste.escape(String($0)) }.filter { !$0.isEmpty }
    }

    public static func documents(_ q: String) -> String {
        let words = textWords(q).map { "kMDItemTextContent == \"\($0)*\"cdw" }
        if words.isEmpty { return "" }
        return "(" + words.joined(separator: " && ") + ") && " + "kMDItemDisplayName != \"*\(FileTaste.escape(q))*\"cd"
            + " && kMDItemContentType != \"com.apple.mail.emlx\" && kMDItemContentType != \"public.folder\""
    }

    public static func mail(_ q: String) -> String {
        let s = FileTaste.escape(q)
        let words = textWords(q).map { "kMDItemTextContent == \"\($0)*\"cdw" }
        let text = words.isEmpty ? "" : " || (" + words.joined(separator: " && ") + ")"
        return "kMDItemContentType == \"com.apple.mail.emlx\" && (kMDItemSubject == \"*\(s)*\"cd || kMDItemAuthors == \"*\(s)*\"cd"
            + " || kMDItemAuthorEmailAddresses == \"*\(s)*\"cd\(text))"
    }

    public static func recent(days: Int = 7) -> String {
        "kMDItemLastUsedDate >= $time.today(-\(days)) && kMDItemContentType != \"public.folder\""
    }

    /// The query string as a predicate, or one that matches nothing. NSPredicate(fromMetadataQueryString:)
    /// raises an Objective-C exception on bad syntax, which Swift cannot catch and which would take
    /// the Capsule down, so the string is parsed first by MDQueryCreate, which answers nil instead.
    public static func predicate(_ s: String) -> NSPredicate {
        guard MDQueryCreate(kCFAllocatorDefault, s as CFString, nil, nil) != nil else { return NSPredicate(value: false) }
        return NSPredicate(fromMetadataQueryString: s) ?? NSPredicate(value: false)
    }
}

/// Runs a block on the main actor now if we are on it, else soon. warm()/cool() arrive from the
/// Capsule on the main thread; this keeps them honest if one ever does not.
func onMainActor(_ fn: @escaping @MainActor () -> Void) {
    if Thread.isMainThread { MainActor.assumeIsolated { fn() } } else { DispatchQueue.main.async { fn() } }
}

let lastUsedKey = "kMDItemLastUsedDate"
let modifiedKey = "kMDItemContentModificationDate"

/// A file row, the same for every provider that shows files.
func fileItem(path: String, isFolder: Bool, score: Double, subtitle: String, section: Section = .files, idPrefix: String = "file",
              openWith: Bool, board: @escaping @Sendable () -> NSPasteboard) -> ResultItem {
    let url = URL(fileURLWithPath: path, isDirectory: isFolder)
    let apps = openWith && !isFolder ? FileActions.openWithApps(for: url) : []
    return ResultItem(id: "\(idPrefix):\(path)", kind: isFolder ? "folder" : "file", title: (path as NSString).lastPathComponent,
                      subtitle: subtitle, icon: .file(path), section: section, score: score,
                      actions: FileActions.actions(for: url, isFolder: isFolder, openWith: apps, board: board),
                      fileURL: url, copyText: path)
}

/// Rows out of Spotlight into file rows: gone files dropped (Spotlight lags deletes), folders
/// typed by the disk, repos found, ranked by taste, the top ones given their "Open with" list.
public func mapFileRows(_ rows: [SpotlightRow], query: String, home: String, now: Double, limit: Int,
                        exists: (String) -> (exists: Bool, dir: Bool) = { p in
                            var d: ObjCBool = false
                            return (FileManager.default.fileExists(atPath: p, isDirectory: &d), d.boolValue)
                        },
                        openWith: Bool = true, board: @escaping @Sendable () -> NSPasteboard = { .general }) -> [ResultItem] {
    var repos: [String: Bool] = [:]
    var scored: [(FileCandidate, Double)] = []
    var seen = Set<String>()
    for r in rows where seen.insert(r.path).inserted && !FileTaste.noise(r.path) {
        let st = exists(r.path)
        guard st.exists else { continue }
        let dir = (r.path as NSString).deletingLastPathComponent
        let c = FileCandidate(path: r.path, name: (r.path as NSString).lastPathComponent, isFolder: st.dir || r.contentType == "public.folder",
                              used: r.dates[lastUsedKey] ?? 0, modified: r.dates[modifiedKey] ?? 0, uti: r.contentType,
                              repo: FileTaste.inRepo(dir, stop: home, cache: &repos, exists: { exists($0).exists }))
        let s = FileTaste.taste(c, query, now: now, home: home)
        if s > 0 { scored.append((c, s)) }
    }
    scored.sort { a, b in a.1 != b.1 ? a.1 > b.1 : a.0.name.count != b.0.name.count ? a.0.name.count < b.0.name.count : a.0.name < b.0.name }
    return scored.prefix(limit).enumerated().map { i, x in
        fileItem(path: x.0.path, isFolder: x.0.isFolder, score: x.1, subtitle: Launch.tilde((x.0.path as NSString).deletingLastPathComponent, home: home),
                 openWith: openWith && i < FileActions.openWithLimit, board: board)
    }
}

// ---------------------------------------------------------------------------------------------

public final class FilesProvider: ResultProvider, @unchecked Sendable {
    public let id = "files"
    public let speed = Speed.full
    let spot: SpotlightQuery
    let home: String
    let debounce: Debounce
    let board: @Sendable () -> NSPasteboard
    /// Rows shown for a plain query, and for one that reads as a filename.
    public var limit = 8, filenameLimit = 14

    /// `scopes` defaults to the home folder; tests pass a fixture folder and its path as `home`.
    @MainActor
    public init(scopes: [String]? = nil, home: String = NSHomeDirectory(), debounce: TimeInterval = 0.09,
                board: @escaping @Sendable () -> NSPasteboard = { .general }) {
        self.spot = SpotlightQuery(scopes: scopes ?? [NSMetadataQueryUserHomeScope])
        self.home = home; self.debounce = Debounce(debounce); self.board = board
    }

    public func warm() { onMainActor { [spot] in spot.prepare() } }
    public func cool() { debounce.cancel(); onMainActor { [spot] in spot.cool() } }

    public func results(for query: Query) async -> [ResultItem] {
        let q = query.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard q.count >= 2, await debounce.settle() else { return [] }
        let like = FileTaste.filenameLike(q)
        // "invoice pdf" names "invoice" in a pdf: search the name part, taste() uses the rest.
        var name = q
        if like, let sp = q.lastIndex(of: " "), !q.contains("/") { name = String(q[..<sp]) }
        if let sl = name.lastIndex(of: "/") { name = String(name[name.index(after: sl)...]) }
        if name.count < 2 { return [] }
        let ask = SpotlightAsk(predicate: SpotlightPredicates.predicate(SpotlightPredicates.names(name)), attributes: [lastUsedKey, modifiedKey],
                               limit: 60, deadline: 0.4, enough: 24, soon: 0.12, accept: { !FileTaste.noise($0) })
        let rows = await spot.run(ask)
        return mapFileRows(rows, query: q, home: home, now: Date().timeIntervalSince1970 * 1000, limit: like ? filenameLimit : limit, board: board)
    }
}

// ---------------------------------------------------------------------------------------------

public final class RecentFilesProvider: ResultProvider, @unchecked Sendable {
    public let id = "recent-files"
    public let speed = Speed.full
    let spot: SpotlightQuery
    let home: String
    let days: Int
    let board: @Sendable () -> NSPasteboard
    private let lock = NSLock()
    private var cached: (at: Date, rows: [SpotlightRow])?
    public var limit = 8

    static let prefix = try! NSRegularExpression(pattern: #"^(?:recents?|recent files|recently opened)(?:\s+(.*))?$"#, options: .caseInsensitive)

    @MainActor
    public init(scopes: [String]? = nil, home: String = NSHomeDirectory(), days: Int = 7, board: @escaping @Sendable () -> NSPasteboard = { .general }) {
        self.spot = SpotlightQuery(scopes: scopes ?? [NSMetadataQueryUserHomeScope])
        self.home = home; self.days = days; self.board = board
    }

    /// What the box asks of recent files: nil for not at all, "" for all of them, else a filter.
    public static func wants(_ text: String) -> String? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { return "" }
        guard let g = FileTaste.groups(prefix, t) else { return nil }
        return g.count > 1 ? g[1].trimmingCharacters(in: .whitespaces) : ""
    }

    public func warm() { onMainActor { [spot] in spot.prepare() } }
    public func cool() { lock.withLock { cached = nil }; onMainActor { [spot] in spot.cool() } }

    func fetch() async -> [SpotlightRow] {
        if let c = lock.withLock({ cached }), Date().timeIntervalSince(c.at) < 30 { return c.rows }
        let ask = SpotlightAsk(predicate: SpotlightPredicates.predicate(SpotlightPredicates.recent(days: days)), attributes: [lastUsedKey],
                               sort: [NSSortDescriptor(key: lastUsedKey, ascending: false)], limit: 200, maxScan: 400, deadline: 0.6,
                               accept: { !FileTaste.noise($0) })
        let rows = await spot.run(ask)
        lock.withLock { cached = (Date(), rows) }
        return rows
    }

    public func results(for query: Query) async -> [ResultItem] {
        guard let filter = Self.wants(query.text) else { return [] }
        let rows = await fetch()
        return Self.map(rows, filter: filter, listing: !query.text.trimmingCharacters(in: .whitespaces).isEmpty, home: home,
                        now: Date().timeIntervalSince1970 * 1000, limit: limit, board: board)
    }

    /// Newest first; a filter keeps names it matches. "recent" is a listing asked for by name, so
    /// it ranks above everything, like "clipboard"; the empty box's rows sit low.
    public static func map(_ rows: [SpotlightRow], filter: String, listing: Bool, home: String, now: Double, limit: Int,
                           exists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) },
                           board: @escaping @Sendable () -> NSPasteboard = { .general }) -> [ResultItem] {
        let kept = rows.filter { r in !FileTaste.noise(r.path) && (filter.isEmpty || Match.score(filter, r.name) >= 0.5) }
            .sorted { ($0.dates[lastUsedKey] ?? 0) > ($1.dates[lastUsedKey] ?? 0) }
        var out: [ResultItem] = []
        for r in kept where exists(r.path) {
            let i = Double(out.count)
            let used = r.dates[lastUsedKey] ?? 0
            let sub = "Opened " + ClipText.age(now - used) + " · " + Launch.tilde((r.path as NSString).deletingLastPathComponent, home: home)
            out.append(fileItem(path: r.path, isFolder: false, score: listing ? 3 - i * 0.01 : 0.5 - i * 0.01, subtitle: sub,
                                idPrefix: "file", openWith: out.count < FileActions.openWithLimit, board: board))
            if out.count >= limit { break }
        }
        return out
    }
}

// ---------------------------------------------------------------------------------------------

public final class DocumentsProvider: ResultProvider, @unchecked Sendable {
    public let id = "documents"
    public let speed = Speed.full
    let spot: SpotlightQuery
    let home: String
    let debounce: Debounce
    let board: @Sendable () -> NSPasteboard
    public var limit = 5

    @MainActor
    public init(scopes: [String]? = nil, home: String = NSHomeDirectory(), debounce: TimeInterval = 0.09,
                board: @escaping @Sendable () -> NSPasteboard = { .general }) {
        self.spot = SpotlightQuery(scopes: scopes ?? [NSMetadataQueryUserHomeScope])
        self.home = home; self.debounce = Debounce(debounce); self.board = board
    }

    public func warm() { onMainActor { [spot] in spot.prepare() } }
    public func cool() { debounce.cancel(); onMainActor { [spot] in spot.cool() } }

    public func results(for query: Query) async -> [ResultItem] {
        let q = query.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard q.count >= 3, await debounce.settle() else { return [] }
        let ask = SpotlightAsk(predicate: SpotlightPredicates.predicate(SpotlightPredicates.documents(q)), attributes: [lastUsedKey, modifiedKey],
                               limit: 30, deadline: 0.5, accept: { !FileTaste.noise($0) })
        let rows = await spot.run(ask)
        return Self.map(rows, home: home, now: Date().timeIntervalSince1970 * 1000, limit: limit, board: board)
    }

    /// Lower than any name match (a name match is at least 0.25): 0.2, plus a little for recent use.
    public static func map(_ rows: [SpotlightRow], home: String, now: Double, limit: Int,
                           exists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) },
                           board: @escaping @Sendable () -> NSPasteboard = { .general }) -> [ResultItem] {
        var out: [(SpotlightRow, Double)] = []
        for r in rows where !FileTaste.noise(r.path) && exists(r.path) {
            let used = r.dates[lastUsedKey] ?? 0, age = now - used
            let s = 0.2 + (used > 0 ? (age < 7 * FileTaste.DAY ? 0.04 : age < 30 * FileTaste.DAY ? 0.02 : 0) : 0)
            out.append((r, s))
        }
        out.sort { $0.1 != $1.1 ? $0.1 > $1.1 : ($0.0.dates[lastUsedKey] ?? 0) > ($1.0.dates[lastUsedKey] ?? 0) }
        return out.prefix(limit).enumerated().map { i, x in
            fileItem(path: x.0.path, isFolder: false, score: x.1, subtitle: Launch.tilde((x.0.path as NSString).deletingLastPathComponent, home: home),
                     section: .documents, idPrefix: "doc", openWith: i < 2, board: board)
        }
    }
}

// ---------------------------------------------------------------------------------------------

public final class MailProvider: ResultProvider, @unchecked Sendable {
    public let id = "mail"
    public let speed = Speed.full
    let spot: SpotlightQuery
    let debounce: Debounce
    let board: @Sendable () -> NSPasteboard
    public var limit = 5

    static let subjectKey = "kMDItemSubject", authorsKey = "kMDItemAuthors", messageIDKey = "com_apple_mail_messageID"
    static let receivedKey = "com_apple_mail_dateReceived"

    @MainActor
    public init(scopes: [String]? = nil, debounce: TimeInterval = 0.09, board: @escaping @Sendable () -> NSPasteboard = { .general }) {
        self.spot = SpotlightQuery(scopes: scopes ?? [NSMetadataQueryUserHomeScope])
        self.debounce = Debounce(debounce); self.board = board
    }

    public func warm() { onMainActor { [spot] in spot.prepare() } }
    public func cool() { debounce.cancel(); onMainActor { [spot] in spot.cool() } }

    public func results(for query: Query) async -> [ResultItem] {
        let q = query.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard q.count >= 3, await debounce.settle() else { return [] }
        let ask = SpotlightAsk(predicate: SpotlightPredicates.predicate(SpotlightPredicates.mail(q)),
                               attributes: [Self.subjectKey, Self.authorsKey, Self.messageIDKey, Self.receivedKey],
                               sort: [NSSortDescriptor(key: Self.receivedKey, ascending: false)], limit: 20, deadline: 0.5)
        let rows = await spot.run(ask)
        return Self.map(rows, query: q, now: Date().timeIntervalSince1970 * 1000, limit: limit, board: board)
    }

    /// message://%3cID%3e, the URL Mail opens a message by. Nil without an id.
    public static func messageURL(_ id: String?) -> URL? {
        guard var s = id?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return nil }
        if s.hasPrefix("<") { s.removeFirst() }
        if s.hasSuffix(">") { s.removeLast() }
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "<>/?#%")
        guard let enc = s.addingPercentEncoding(withAllowedCharacters: allowed), !enc.isEmpty else { return nil }
        return URL(string: "message://%3c" + enc + "%3e")
    }

    public static func map(_ rows: [SpotlightRow], query: String, now: Double, limit: Int,
                           board: @escaping @Sendable () -> NSPasteboard = { .general }) -> [ResultItem] {
        var out: [ResultItem] = []
        for r in rows {
            let subject = (r.strings[subjectKey] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let from = r.strings[authorsKey] ?? ""
            let when = r.dates[receivedKey] ?? r.dates[modifiedKey] ?? 0
            let m = max(Match.score(query, subject), Match.score(query, from))
            let title = subject.isEmpty ? "(no subject)" : subject
            let target = messageURL(r.strings[messageIDKey]) ?? URL(fileURLWithPath: r.path)
            let sub = [from, when > 0 ? ClipText.age(now - when) : ""].filter { !$0.isEmpty }.joined(separator: " · ")
            out.append(ResultItem(id: "mail:" + r.path, kind: "mail", title: title, subtitle: sub, icon: .bundle("com.apple.mail"),
                                  section: .mail, score: 0.25 + 0.2 * m, actions: [
                                    ResultAction(id: "open", title: "Open in Mail", symbol: "envelope", shortcut: KeyShortcut("return")) { _, _ in
                                        await Launch.open(target)
                                    },
                                    ResultAction(id: "copy-subject", title: "Copy subject", symbol: "doc.on.clipboard",
                                                 shortcut: KeyShortcut("c", command: true, shift: true)) { _, _ in
                                        let b = board(); b.clearContents()
                                        return b.setString(title, forType: .string) ? .said("Copied the subject") : .failed("Could not copy it.")
                                    },
                                  ], copyText: title, payload: ["path": r.path, "url": target.absoluteString]))
        }
        out.sort { $0.score != $1.score ? $0.score > $1.score : false }
        return Array(out.prefix(limit))
    }
}
