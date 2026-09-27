import Foundation

/// The offline cache, the Deck's rule (ADR 0018 section 6): `projects.list`, `agents.list`, and
/// `threads.get` for threads the person opened, at most 20 threads and 7 days. Files are written
/// with complete file protection (unreadable while the phone is locked) and excluded from
/// backups. Nothing else is ever cached: no held item, vault item, memory fact or file.
final class OfflineCache: Sendable {
    static let maxThreads = 20
    static let maxAge: TimeInterval = 7 * 24 * 3600
    static let allowed: Set<String> = ["projects.list", "agents.list"]

    let dir: URL

    init(dir: URL? = nil) {
        let base = dir ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("offline", isDirectory: true)
        self.dir = base
        try? FileManager.default.createDirectory(at: base.appendingPathComponent("threads"), withIntermediateDirectories: true,
                                                 attributes: [.protectionKey: FileProtectionType.complete])
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var u = base
        try? u.setResourceValues(values)
    }

    private func file(_ name: String) -> URL { dir.appendingPathComponent(name + ".json") }
    private func threadFile(_ id: String) -> URL {
        let safe = id.filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
        return dir.appendingPathComponent("threads", isDirectory: true).appendingPathComponent(safe + ".json")
    }

    /// Store one of the two cached reads. Any other tool is refused.
    func put(_ tool: String, _ value: JSON) {
        guard OfflineCache.allowed.contains(tool) else { return }
        write(value, to: file(tool))
    }

    func get(_ tool: String) -> JSON? {
        guard OfflineCache.allowed.contains(tool) else { return nil }
        return read(file(tool))
    }

    /// `threads.get` for a thread the person opened. Evicts past 20 threads, oldest first.
    func putThread(_ id: String, _ value: JSON) {
        write(value, to: threadFile(id))
        prune()
    }

    func thread(_ id: String) -> JSON? { read(threadFile(id)) }

    func prune(now: Date = Date()) {
        let fm = FileManager.default
        let tdir = dir.appendingPathComponent("threads", isDirectory: true)
        let files = (try? fm.contentsOfDirectory(at: tdir, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        let dated = files.map { ($0, (try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) }
            .sorted { $0.1 > $1.1 }
        for (i, (url, date)) in dated.enumerated() where i >= OfflineCache.maxThreads || now.timeIntervalSince(date) > OfflineCache.maxAge {
            try? fm.removeItem(at: url)
        }
        for name in OfflineCache.allowed {
            let u = file(name)
            if let d = try? u.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate,
               now.timeIntervalSince(d) > OfflineCache.maxAge { try? fm.removeItem(at: u) }
        }
    }

    var threadCount: Int {
        ((try? FileManager.default.contentsOfDirectory(atPath: dir.appendingPathComponent("threads").path)) ?? []).count
    }

    func wipe() {
        try? FileManager.default.removeItem(at: dir)
        try? FileManager.default.createDirectory(at: dir.appendingPathComponent("threads"), withIntermediateDirectories: true,
                                                 attributes: [.protectionKey: FileProtectionType.complete])
    }

    private func write(_ v: JSON, to url: URL) {
        guard let data = try? JSONEncoder().encode(v) else { return }
        try? data.write(to: url, options: [.atomic, .completeFileProtection])
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var u = url
        try? u.setResourceValues(values)
    }

    private func read(_ url: URL) -> JSON? {
        guard let d = try? Data(contentsOf: url), let date = try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate,
              Date().timeIntervalSince(date) <= OfflineCache.maxAge else { return nil }
        return try? JSON.parse(d)
    }
}
