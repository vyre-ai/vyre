// Frecency: which results this Mac's user picks, and after typing what. A port of the Frecency
// class in local/capsule/lib/local.js; its tests are ported in Tests/FrecencyTests.swift.
//
// A launcher reads every keystroke, including the ones the user deletes, so this file is the one
// thing the launcher writes to disk, and it holds result ids and query prefixes of at most six
// characters, never whole queries. `boost()` lifts a result the user picks often and lately; it
// saturates at +0.45 for frequency plus +0.15 when the same typed prefix picked the same item
// before, so it can reorder close matches but never lift a 0.3 fuzzy hit over an exact one.
// Scores halve every seven days, and the file keeps at most `cap` ids.
//
// The file format is the Electron Capsule's, so a user's history carries over:
//   {"v":1,"items":{"<id>":{"s":<score>,"t":<ms>,"q":{"<prefix>":{"s":..,"t":..}}}}}
// Times are milliseconds since 1970. Writes are debounced (a pick is not a disk write on the
// keystroke), go to a temp file with mode 0600 and are renamed into place, so a crash never
// leaves half a file and nobody else on the Mac can read what was picked.

import Foundation

public final class Frecency: @unchecked Sendable {
    public struct Hit: Codable, Sendable, Equatable { public var s: Double; public var t: Double }
    public struct Entry: Codable, Sendable, Equatable {
        public var s: Double
        public var t: Double
        public var q: [String: Hit]
    }

    static let halfLife = 7.0 * 86_400_000
    static let prefixLength = 6
    static let prefixesKept = 6

    public let file: URL
    let now: @Sendable () -> Double
    let delay: TimeInterval
    let cap: Int
    private let lock = NSLock()
    private var loaded: [String: Entry]?
    private var pending: DispatchWorkItem?
    private let queue = DispatchQueue(label: "vyre.capsule.frecency", qos: .utility)

    /// `now` is milliseconds since 1970 (injected for tests); `delay` is the write debounce.
    public init(file: URL, now: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 * 1000 },
                delay: TimeInterval = 0.5, cap: Int = 2000) {
        self.file = file; self.now = now; self.delay = delay; self.cap = cap
    }

    /// Every id and its entry, loading the file on first use. A missing or corrupt file is empty.
    public var items: [String: Entry] { lock.lock(); defer { lock.unlock() }; return load() }

    private func load() -> [String: Entry] {
        if let l = loaded { return l }
        var out: [String: Entry] = [:]
        if let data = try? Data(contentsOf: file),
           let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let items = j["items"] as? [String: Any] {
            for (id, raw) in items {
                guard let e = raw as? [String: Any], let s = e["s"] as? Double, let t = e["t"] as? Double else { continue }
                var q: [String: Hit] = [:]
                for (p, h) in e["q"] as? [String: Any] ?? [:] {
                    if let h = h as? [String: Any], let hs = h["s"] as? Double, let ht = h["t"] as? Double { q[p] = Hit(s: hs, t: ht) }
                }
                out[id] = Entry(s: s, t: t, q: q)
            }
        }
        loaded = out
        return out
    }

    func decay(_ s: Double, _ t: Double) -> Double { s * pow(0.5, max(0, now() - t) / Self.halfLife) }

    /// The part of a query that is kept: folded, trimmed, six characters at most.
    public static func prefix(_ query: String) -> String {
        String(Match.fold(query).trimmingCharacters(in: .whitespacesAndNewlines).prefix(prefixLength))
    }

    /// Record that `id` was picked after typing `query`.
    public func pick(_ id: String, query: String = "") {
        lock.lock()
        var items = load()
        let t = now()
        var it = items[id] ?? Entry(s: 0, t: t, q: [:])
        it.s = decay(it.s, it.t) + 1; it.t = t
        let p = Self.prefix(query)
        if !p.isEmpty {
            var e = it.q[p] ?? Hit(s: 0, t: t)
            e.s = decay(e.s, e.t) + 1; e.t = t
            it.q[p] = e
            if it.q.count > Self.prefixesKept {
                let order = it.q.keys.sorted { decay(it.q[$0]!.s, it.q[$0]!.t) < decay(it.q[$1]!.s, it.q[$1]!.t) }
                for k in order.prefix(it.q.count - Self.prefixesKept) { it.q[k] = nil }
            }
        }
        items[id] = it
        if items.count > cap {
            let order = items.keys.sorted { decay(items[$0]!.s, items[$0]!.t) < decay(items[$1]!.s, items[$1]!.t) }
            for k in order.prefix(items.count - cap) { items[k] = nil }
        }
        loaded = items
        schedule()
        lock.unlock()
    }

    /// What to add to a 0..1 match score for `id` when the box holds `query`. At most 0.6.
    public func boost(_ id: String, query: String = "") -> Double {
        lock.lock(); defer { lock.unlock() }
        guard let it = load()[id] else { return 0 }
        var b = 0.45 * (1 - exp(-decay(it.s, it.t) / 3))
        let p = Self.prefix(query)
        if !p.isEmpty {
            var best = 0.0
            // "saf" and "safari" agree; "sa" typed now also agrees with "safari" picked before.
            for (k, e) in it.q where k.hasPrefix(p) || p.hasPrefix(k) { best = max(best, decay(e.s, e.t)) }
            b += 0.15 * (1 - exp(-best))
        }
        return min(0.6, b)
    }

    /// Called with the lock held.
    private func schedule() {
        if pending != nil { return }
        let w = DispatchWorkItem { [weak self] in self?.flush() }
        pending = w
        queue.asyncAfter(deadline: .now() + delay, execute: w)
    }

    /// Write now: a 0600 temp file renamed into place.
    public func flush() {
        lock.lock()
        pending?.cancel(); pending = nil
        guard let items = loaded else { lock.unlock(); return }
        lock.unlock()
        struct Doc: Encodable { let v = 1; let items: [String: Entry] }
        guard let data = try? JSONEncoder().encode(Doc(items: items)) else { return }
        let dir = file.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let tmp = dir.appendingPathComponent("\(file.lastPathComponent).\(getpid()).tmp")
        let fd = open(tmp.path, O_WRONLY | O_CREAT | O_TRUNC, 0o600)
        guard fd >= 0 else { return }
        let ok = data.withUnsafeBytes { buf in write(fd, buf.baseAddress, buf.count) == buf.count }
        fchmod(fd, 0o600)
        close(fd)
        if !ok || rename(tmp.path, file.path) != 0 { unlink(tmp.path) }
    }
}
