// ModuleProviders: what running modules put in the Capsule, read from their manifests'
// `shows.capsule`. Ported from lib/providers.js.
//
// A module names two kinds of thing there (SPEC section 5.1, and the vault's contract in ADR 0006):
//
//   "results:<tool>"          a search provider: { q, limit } -> { rows: [{ id, name, kind, sub }] }
//   "action:<tool>[#suffix]"  a verb on that module's results, called with { ...input, id, front }
//
// Each value is { title, input?, hide? }. The suffix after # only keeps a key unique, so one tool
// can back several actions ("copy username", "copy one-time code") that differ by `input`. Object
// order is list order (so the listing is read with OrderedJSON), and Enter runs the first action.
// A plain array of keys is allowed too; then titles are made from the module or tool name.
//
// Nothing here runs unless called: refresh() reads the listing (on open, at most twice a minute),
// the search asks the providers, an action calls one tool. A query is sent to the providers and
// nowhere else: never logged, never emitted, never kept. `sendsQuery` names the modules, so the
// Capsule shows where the words go before a row is picked.
//
// Two gallery gaps are fixed here. Copy says the row's name, never its id ("Code for p1" was
// shown). And a fill is not reported as done when no app took it ("Filled p1 in no app" was
// shown): no front app, a front app that did not come back, or a module that says nothing was
// filled is `.failed`, with the reason.

import Foundation

public struct ModuleProvider: @unchecked Sendable {
    public var tool: String
    public var title: String
    public var input: [String: Any]
}

public struct ModuleAction: @unchecked Sendable {
    public var key: String
    public var tool: String
    public var title: String
    public var input: [String: Any]
    /// It works on the front app, so the Capsule steps out of the way first (needsFrontApp).
    public var hide: Bool
}

public struct ModuleShows: @unchecked Sendable {
    public var module: String
    public var results: [ModuleProvider]
    public var actions: [ModuleAction]
}

/// One row a module's search gave back.
public struct ModuleRow: Sendable, Equatable {
    public var id: String
    public var label: String
    public var sub: String
    public var module: String
    public var provider: String
    public var rowId: String
    public var rowKind: String
    public var score: Double
}

/// What an action said: its line, a one-time code, or an error in words.
public enum ModuleRun: @unchecked Sendable {
    case done(said: String?, code: String?, period: Double?, remaining: Double?, data: Any)
    case error(String, reason: String?)
}

public final class ModuleProviders: ResultProvider, @unchecked Sendable {
    /// How long an action may take: it may wait on Touch ID inside the tool.
    public static let actionTimeout: TimeInterval = 45
    /// A search is typed, so shorter queries are not sent to any provider.
    public static let minQuery = 2
    /// Which modules show what changes rarely: read on open, at most twice a minute.
    public static let refreshEvery: TimeInterval = 30

    public let id = "modules"
    public let speed = Speed.full
    let link: VyredTransport
    let now: () -> Date
    private let lock = NSLock()
    private var modules: [ModuleShows] = []
    private var refreshedAt: Date?
    private var refreshing = false

    public init(link: VyredTransport, now: @escaping () -> Date = Date.init) { self.link = link; self.now = now }

    // MARK: the manifest

    private static func titleCase(_ s: String) -> String { s.prefix(1).uppercased() + s.dropFirst() }

    /// One module's `shows.capsule`, in either shape, as ordered providers and actions. Unknown
    /// keys are skipped, so a later kind of entry does not break an older Capsule.
    public static func parseShows(_ module: String, _ capsule: OJ?) -> ModuleShows {
        var entries: [(String, OJ)] = []
        if let a = capsule?.array { entries = a.compactMap { $0.string.map { ($0, OJ.object([])) } } }
        else if let kv = capsule?.pairs { entries = kv }
        var out = ModuleShows(module: module, results: [], actions: [])
        var seen = Set<String>()
        for (key, raw) in entries {
            if !seen.insert(key).inserted { continue }
            let v = raw.isObject ? raw : OJ.object([])
            let input = (v["input"]?.isObject == true ? v["input"]!.any as? [String: Any] : nil) ?? [:]
            let given = v["title"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if let g = VyRx.groups("^results:([^#\\s]+)$", key, caseless: false) {
                out.results.append(ModuleProvider(tool: g[1], title: given.isEmpty ? titleCase(module) : given, input: input))
            } else if let g = VyRx.groups("^action:([^#\\s]+)(?:#.*)?$", key, caseless: false) {
                var hide = false
                if case .bool(true)? = v["hide"] { hide = true }
                out.actions.append(ModuleAction(key: key, tool: g[1], title: given.isEmpty ? g[1] : given, input: input, hide: hide))
            }
        }
        return out
    }

    /// The host part of a vault row's sub ("login · github.com"), or "".
    static func hostOf(_ sub: String) -> String {
        let h = (sub.range(of: "·", options: .backwards).map { String(sub[$0.upperBound...]) } ?? sub).trimmingCharacters(in: .whitespaces).lowercased()
        return h.contains(".") && !h.contains(where: \.isWhitespace) ? h : ""
    }

    /// How much a launcher user wants this module row for `q`: the name's match, never below 0.5
    /// (the provider matched it on something, a host or a description), and a small bump when the
    /// vault's row lives on a site the query names, so "github" puts the GitHub login first.
    public static func scoreRow(_ module: String, _ q: String, name: String, sub: String?) -> Double {
        var s = max(0.5, Match.score(q, name))
        if module == "vault" {
            let host = hostOf(sub ?? "")
            if !host.isEmpty && q.lowercased().split(whereSeparator: \.isWhitespace).contains(where: { $0.count >= 2 && host.contains($0) }) { s += 0.1 }
        }
        return s
    }

    // MARK: the listing

    /// Read GET /v1/modules and keep what each running module shows in the Capsule. When
    /// GET /v1/tools answers (it lists only the tools this caller may use), anything naming a tool
    /// not on it is dropped. A failed listing keeps what was known before.
    @discardableResult
    public func refresh() async -> Result<Int, VyredFailure> {
        async let modsA = link.getOrdered("/v1/modules", timeout: 5)
        async let toolsA = link.get("/v1/tools", timeout: 5)
        let (mods, tools) = await (modsA, toolsA)
        guard let rows = mods.data?.array else { return .failure(VyredFailure(mods.error ?? "no module listing")) }
        var callable: Set<String>?
        if case .success(let d) = tools, let a = d as? [Any] {
            callable = Set(a.compactMap { ($0 as? String) ?? VJ.str(($0 as? [String: Any])?["name"]) })
        }
        let ok = { (t: String) in callable?.contains(t) ?? true }
        var next: [ModuleShows] = []
        for row in rows {
            guard let name = row["name"]?.string else { continue }
            if let state = row["state"], state.string != "running" { continue }
            guard let cap = row["shows"]?["capsule"] ?? row["manifest"]?["shows"]?["capsule"] else { continue }
            var s = Self.parseShows(name, cap)
            s.results = s.results.filter { ok($0.tool) }
            s.actions = s.actions.filter { ok($0.tool) }
            if !s.results.isEmpty || !s.actions.isEmpty { next.append(s) }
        }
        setModules(next)
        return .success(next.count)
    }

    private func setModules(_ next: [ModuleShows]) { lock.lock(); modules = next; refreshedAt = now(); lock.unlock() }
    private func endRefresh() { lock.lock(); refreshing = false; lock.unlock() }

    /// What each module shows, in listing order.
    public func list() -> [ModuleShows] { lock.lock(); defer { lock.unlock() }; return modules }

    // MARK: search

    /// Ask every search provider at once, each with its own timeout. A provider that is slow,
    /// errs or answers nonsense adds nothing and hides no one else.
    public func search(_ q: String, limit: Int = 5, timeout: TimeInterval = 0.6) async -> [ModuleRow] {
        let query = q.trimmingCharacters(in: .whitespacesAndNewlines)
        if query.count < Self.minQuery { return [] }
        let mods = list()
        return await withTaskGroup(of: (Int, [ModuleRow]).self) { g in
            var i = 0
            for m in mods {
                for p in m.results {
                    let n = i; i += 1
                    var ask = p.input; ask["q"] = query; ask["limit"] = limit
                    let input = ask, link = self.link
                    g.addTask {
                        let ans = await vyWithin(timeout) { await link.call(p.tool, input, timeout: timeout) }
                        return (n, Self.rows(m.module, p, query, ans, limit))
                    }
                }
            }
            var got: [(Int, [ModuleRow])] = []
            for await x in g { got.append(x) }
            return got.sorted { $0.0 < $1.0 }.flatMap(\.1)
        }
    }

    static func rows(_ module: String, _ p: ModuleProvider, _ q: String, _ ans: VyredResult?, _ limit: Int) -> [ModuleRow] {
        guard case .success(let d)? = ans else { return [] }
        let rows = (d as? [Any]) ?? ((d as? [String: Any])?["rows"] as? [Any]) ?? []
        var out: [ModuleRow] = []
        for case let r as [String: Any] in rows {
            guard let rid = (r["id"] as? String) ?? (VJ.num(r["id"]) != nil ? VJ.str(r["id"]) : nil) else { continue }
            let name = VJ.nonEmpty(r["name"] as? String) ?? rid
            let sub = VJ.nonEmpty(r["sub"] as? String)
            out.append(ModuleRow(id: "\(module):\(rid)", label: name, sub: sub ?? p.title, module: module, provider: p.title, rowId: rid,
                                 rowKind: (r["kind"] as? String) ?? "", score: scoreRow(module, q, name: name, sub: sub)))
            if out.count >= limit { break }
        }
        return out
    }

    // MARK: actions

    /// The verbs for one of a module's results, in the manifest's order. The first is Enter's.
    public func actions(module: String) -> [ModuleAction] {
        list().first { $0.module == module }?.actions ?? []
    }

    /// Run one action on a result: the tool gets { ...input, id, front }. Allow for Touch ID: the
    /// answer can take many seconds.
    public func run(module: String, rowId: String, key: String, front: FrontApp?, timeout: TimeInterval = ModuleProviders.actionTimeout) async -> ModuleRun {
        guard let a = actions(module: module).first(where: { $0.key == key }) else { return .error("That action is no longer offered.", reason: nil) }
        var ask = a.input
        ask["id"] = rowId
        if let f = front { ask["front"] = ["bundle": f.bundle, "pid": Int(f.pid)] }
        let input = ask
        let link = self.link
        let late = VyredResult.failure(code: "timeout", message: "No answer in time. Try again.")
        let ans = await vyWithin(timeout + min(1, timeout / 10)) { await link.call(a.tool, input, timeout: timeout) } ?? late
        switch ans {
        case .failure(let code, let message):
            return .error(message.isEmpty ? (code.isEmpty ? "It did not work." : code) : message, reason: code.isEmpty || code == "error" ? nil : code)
        case .success(let d):
            let o = d as? [String: Any]
            return .done(said: o?["said"] as? String, code: o?["code"] as? String, period: VJ.num(o?["period"]), remaining: VJ.num(o?["remaining"]), data: d)
        }
    }

    // MARK: the Capsule's seam

    /// The modules the words are sent to while typing, or nil when none searches.
    public var sendsQuery: String? {
        let names = list().filter { !$0.results.isEmpty }.map(\.module)
        return names.isEmpty ? nil : names.joined(separator: ", ")
    }

    /// Read the listing when the Capsule opens, at most twice a minute.
    public func warm() {
        lock.lock()
        let due = !refreshing && (refreshedAt.map { now().timeIntervalSince($0) >= Self.refreshEvery } ?? true)
        if due { refreshing = true; refreshedAt = now() }
        lock.unlock()
        guard due else { return }
        Task { [weak self] in
            await self?.refresh()
            self?.endRefresh()
        }
    }

    public func results(for query: Query) async -> [ResultItem] {
        let rows = await search(query.text)
        let byModule = Dictionary(grouping: list(), by: \.module).compactMapValues(\.first)
        return rows.map { item(for: $0, actions: byModule[$0.module]?.actions ?? []) }
    }

    static func symbol(_ r: ModuleRow) -> String {
        if r.module == "vault" { return r.rowKind == "note" ? "lock.doc" : r.rowKind == "card" ? "creditcard" : "key.fill" }
        if r.rowKind == "note" { return "note.text" }
        return "puzzlepiece.extension"
    }

    func item(for r: ModuleRow, actions: [ModuleAction]) -> ResultItem {
        ResultItem(id: r.id, kind: "module", title: r.label, subtitle: r.sub, icon: .symbol(Self.symbol(r), .stone), section: .modules, score: r.score,
                   actions: actions.enumerated().map { i, a in resultAction(a, first: i == 0) }, sendsTo: r.module,
                   payload: ["module": r.module, "rowId": r.rowId, "rowKind": r.rowKind, "provider": r.provider])
    }

    func resultAction(_ a: ModuleAction, first: Bool) -> ResultAction {
        let symbol = a.hide ? "rectangle.and.pencil.and.ellipsis" : a.tool.hasSuffix(".copy") ? "doc.on.doc" : a.tool.hasSuffix(".lock") ? "lock" : "return"
        return ResultAction(id: a.key, title: a.title, symbol: symbol, shortcut: first ? KeyShortcut("return") : nil, needsFrontApp: a.hide) { [weak self] item, ctx in
            guard let self else { return .failed("The module is gone.") }
            return await self.perform(a, item: item, ctx: ctx)
        }
    }

    /// Run an action for a row and say what happened in the row's own name.
    func perform(_ a: ModuleAction, item: ResultItem, ctx: ActionContext) async -> ActionOutcome {
        let module = item.payload["module"] ?? "", rowId = item.payload["rowId"] ?? ""
        if a.hide {
            // A fill with nothing to fill into is not done, and must not say it is.
            guard let front = ctx.query.front else { return .failed("No app was in front to fill, so nothing was filled.") }
            guard ctx.frontIsBack else { return .failed("\(front.name) did not come back to the front, so nothing was filled.") }
        }
        let out = await run(module: module, rowId: rowId, key: a.key, front: ctx.query.front)
        return Self.outcome(out, item: item, action: a)
    }

    static func outcome(_ out: ModuleRun, item: ResultItem, action a: ModuleAction) -> ActionOutcome {
        let rowId = item.payload["rowId"] ?? ""
        switch out {
        case .error(let m, _): return .failed(named(m, rowId, item.title))
        case .done(let said, let code, _, let remaining, let data):
            if let code {
                let left = remaining.map { ", \(Int($0)) s left" } ?? ""
                return .said("Code for \(item.title): \(code)\(left)")
            }
            let line = said.map { named($0, rowId, item.title) }
            if a.hide {
                let o = data as? [String: Any]
                let nothing = VJ.bool(o?["filled"]) == false || VJ.bool(o?["ok"]) == false
                    || VyRx.test("\\bin no app\\b|nothing (was )?filled|no field", said ?? "")
                if nothing { return .failed(line.flatMap { VyRx.test("\\bin no app\\b", $0) ? nil : $0 } ?? "Nothing was filled: no field in the front app took it.") }
                return .close(line ?? "Filled \(item.title).")
            }
            return .said(line ?? "Done.")
        }
    }

    /// A module's words with the row's id put back as its name: people read names, not ids.
    static func named(_ line: String, _ rowId: String, _ name: String) -> String {
        guard !rowId.isEmpty, rowId != name else { return line }
        return line.replacingOccurrences(of: "(?<![A-Za-z0-9_-])\(NSRegularExpression.escapedPattern(for: rowId))(?![A-Za-z0-9_-])",
                                         with: NSRegularExpression.escapedTemplate(for: name), options: .regularExpression)
    }
}

public struct VyredFailure: Error, Sendable, Equatable {
    public var message: String
    public init(_ m: String) { message = m }
}

/// A continuation resumed once, by whichever of two racers comes first.
final class VyOnce<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    var k: CheckedContinuation<T?, Never>?
    func finish(_ v: T?) { lock.lock(); let c = k; k = nil; lock.unlock(); c?.resume(returning: v) }
}

/// The answer if it comes within `seconds`, else nil, at the deadline and not later: work that
/// cannot be cancelled (a blocking socket read) finishes on its own, and its answer is dropped.
func vyWithin<T: Sendable>(_ seconds: TimeInterval, _ work: @escaping @Sendable () async -> T) async -> T? {
    let once = VyOnce<T>()
    return await withCheckedContinuation { (k: CheckedContinuation<T?, Never>) in
        once.k = k
        let job = Task { once.finish(await work()) }
        DispatchQueue.global().asyncAfter(deadline: .now() + max(0, seconds)) { once.finish(nil); job.cancel() }
    }
}
