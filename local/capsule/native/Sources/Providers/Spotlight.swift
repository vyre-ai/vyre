// Spotlight: one long-lived NSMetadataQuery per provider, re-predicated per keystroke.
//
// The Electron Capsule spawned `mdfind` per keystroke: 155 to 480 ms, most of it the spawn and a
// full gather before the first line. An NSMetadataQuery made once is re-aimed by setting its
// predicate, which restarts the gather in the same process, and its first batch lands in 8 to
// 115 ms (measured on this Mac, docs/work/capsule.md). So a search takes what the first batches
// bring, as soon as it has enough good rows (or the gather finishes, or the deadline passes), and
// then stops the query: a two-letter name search can match a hundred thousand items, and letting
// the gather run on after the rows are drawn is CPU spent on nothing. The next keystroke starts
// the same query again. cool() stops it and removes the observers, so nothing runs while hidden.
//
// Every value read out of an NSMetadataItem is copied into a plain Sendable row on the main actor,
// so no Spotlight object leaves it. Nothing here logs or keeps what was searched for.

import Foundation

/// One Spotlight hit, copied out of the query.
public struct SpotlightRow: Sendable, Equatable {
    public var path: String
    public var name: String
    public var contentType: String
    /// Dates as milliseconds since 1970 (kMDItemLastUsedDate, kMDItemContentModificationDate...).
    public var dates: [String: Double]
    /// Other string or string-list attributes asked for, lists joined with ", ".
    public var strings: [String: String]

    public init(path: String, name: String = "", contentType: String = "", dates: [String: Double] = [:], strings: [String: String] = [:]) {
        self.path = path; self.name = name.isEmpty ? (path as NSString).lastPathComponent : name
        self.contentType = contentType; self.dates = dates; self.strings = strings
    }

    /// The row as NSMetadataItem attributes would give it, for mapping from a plain dictionary.
    public static func from(_ values: [String: Any]) -> SpotlightRow? {
        guard let path = values[NSMetadataItemPathKey] as? String, path.hasPrefix("/") else { return nil }
        var dates: [String: Double] = [:], strings: [String: String] = [:]
        for (k, v) in values {
            if let d = v as? Date { dates[k] = d.timeIntervalSince1970 * 1000 }
            else if let s = v as? String { strings[k] = s }
            else if let a = v as? [String] { strings[k] = a.joined(separator: ", ") }
        }
        return SpotlightRow(path: path, name: (values[NSMetadataItemDisplayNameKey] as? String) ?? (values[NSMetadataItemFSNameKey] as? String) ?? "",
                            contentType: (values[NSMetadataItemContentTypeKey] as? String) ?? "", dates: dates, strings: strings)
    }
}

/// What one search wants.
public struct SpotlightAsk: @unchecked Sendable {
    public var predicate: NSPredicate
    public var attributes: [String]
    public var sort: [NSSortDescriptor]
    /// Stop once this many rows passed `accept`.
    public var limit: Int
    /// Look at no more than this many hits (the rest is almost always noise).
    public var maxScan: Int
    public var deadline: TimeInterval
    /// Rows enough to draw a good list: once this many passed `accept` and `soon` has gone by,
    /// the search answers without waiting for `limit` or the deadline.
    public var enough: Int
    public var soon: TimeInterval
    public var accept: @Sendable (String) -> Bool

    public init(predicate: NSPredicate, attributes: [String] = [], sort: [NSSortDescriptor] = [], limit: Int = 40, maxScan: Int = 800,
                deadline: TimeInterval = 0.4, enough: Int? = nil, soon: TimeInterval = 0.12,
                accept: @escaping @Sendable (String) -> Bool = { _ in true }) {
        self.predicate = predicate; self.attributes = attributes; self.sort = sort; self.limit = limit
        self.maxScan = maxScan; self.deadline = deadline; self.enough = enough ?? limit; self.soon = soon; self.accept = accept
    }
}

/// One Spotlight search at a time, worked entirely off the main thread. Gathering, reading up to hundreds
/// of results and their attributes (each read is a call into the metadata server) and the timers all
/// happen on one serial queue; the main thread only ever receives the finished rows. It used to do this
/// on the main thread, and a three-letter word could hold a keystroke for a couple of hundred milliseconds.
public final class SpotlightQuery: @unchecked Sendable {
    public let scopes: [Any]
    private let sq = DispatchQueue(label: "sh.vyre.capsule.spotlight", qos: .userInitiated)
    private let ops = OperationQueue()
    // Everything below is touched only on `sq`.
    private var query: NSMetadataQuery?
    private var observers: [NSObjectProtocol] = []
    private var ask: SpotlightAsk?
    private var waiter: CheckedContinuation<[SpotlightRow], Never>?
    private var generation = 0
    private var started = Date()

    /// Whether a query object exists and is gathering. For tests of cool().
    public var isRunning: Bool { sq.sync { query.map { $0.isStarted && !$0.isStopped } ?? false } }
    public var exists: Bool { sq.sync { query != nil } }

    public init(scopes: [Any] = [NSMetadataQueryUserHomeScope]) {
        self.scopes = scopes
        ops.underlyingQueue = sq
        ops.maxConcurrentOperationCount = 1
    }

    /// Make the query and its observers, without starting a search.
    public func prepare() { sq.async { self.prepareNow() } }

    private func prepareNow() {
        if query != nil { return }
        let q = NSMetadataQuery()
        q.notificationBatchingInterval = 0.03
        // Notifications, and the query's own work, come on `sq`, not on the main thread.
        q.operationQueue = ops
        let nc = NotificationCenter.default
        for name in [Notification.Name.NSMetadataQueryGatheringProgress, .NSMetadataQueryDidFinishGathering] {
            observers.append(nc.addObserver(forName: name, object: q, queue: ops) { [weak self] n in
                self?.collect(done: n.name == .NSMetadataQueryDidFinishGathering)
            })
        }
        query = q
    }

    /// Run one search. A newer call answers an older one with [] at once.
    public func run(_ a: SpotlightAsk) async -> [SpotlightRow] {
        await withCheckedContinuation { (c: CheckedContinuation<[SpotlightRow], Never>) in
            sq.async { self.start(a, c) }
        }
    }

    private func start(_ a: SpotlightAsk, _ c: CheckedContinuation<[SpotlightRow], Never>) {
        prepareNow()
        guard let q = query else { c.resume(returning: []); return }
        finish([])
        generation += 1
        let gen = generation
        ask = a
        waiter = c
        if q.isStarted && !q.isStopped { q.stop() }
        q.searchScopes = scopes
        q.sortDescriptors = a.sort
        q.predicate = a.predicate
        started = Date()
        if !q.start() { finish([]); return }
        if a.enough < a.limit {
            sq.asyncAfter(deadline: .now() + a.soon) { [weak self] in
                guard let self, self.generation == gen, self.waiter != nil else { return }
                self.collect(done: false)
            }
        }
        sq.asyncAfter(deadline: .now() + a.deadline) { [weak self] in
            guard let self, self.generation == gen, self.waiter != nil else { return }
            self.collect(done: true)
        }
    }

    private func collect(done: Bool) {
        guard let q = query, let a = ask, waiter != nil else { return }
        q.disableUpdates()
        var out: [SpotlightRow] = []
        let n = min(q.resultCount, a.maxScan)
        let keys = [NSMetadataItemPathKey, NSMetadataItemDisplayNameKey, NSMetadataItemFSNameKey, NSMetadataItemContentTypeKey] + a.attributes
        for i in 0..<n {
            guard let item = q.result(at: i) as? NSMetadataItem,
                  let path = item.value(forAttribute: NSMetadataItemPathKey) as? String, a.accept(path) else { continue }
            var values: [String: Any] = [:]
            for k in keys { if let v = item.value(forAttribute: k) { values[k] = v } }
            if let row = SpotlightRow.from(values) { out.append(row) }
            if out.count >= a.limit { break }
        }
        q.enableUpdates()
        let settled = out.count >= a.enough && Date().timeIntervalSince(started) >= a.soon
        if done || settled || out.count >= a.limit || q.resultCount >= a.maxScan { finish(out) }
    }

    private func finish(_ rows: [SpotlightRow]) {
        guard let c = waiter else { return }
        waiter = nil
        ask = nil
        // The rows are drawn; a gather still running is work for nothing.
        if let q = query, q.isStarted, !q.isStopped { q.stop() }
        c.resume(returning: rows)
    }

    /// Stop, and let go of the query and its observers.
    public func cool() {
        sq.async {
            self.finish([])
            self.generation += 1
            self.query?.stop()
            for o in self.observers { NotificationCenter.default.removeObserver(o) }
            self.observers = []
            self.query = nil
        }
    }
}

/// Coalesces keystrokes: a search runs only when `delay` passes without a newer one.
public final class Debounce: @unchecked Sendable {
    private let lock = NSLock()
    private var seq = 0
    public let delay: TimeInterval
    public init(_ delay: TimeInterval) { self.delay = delay }

    /// True when this call is still the newest after the delay.
    public func settle() async -> Bool {
        let mine: Int = lock.withLock { seq += 1; return seq }
        if delay > 0 { try? await Task.sleep(nanoseconds: UInt64(delay * 1e9)) }
        return lock.withLock { seq == mine }
    }

    /// Any settle() in flight answers false.
    public func cancel() { lock.withLock { seq += 1 } }
}
