// Watches: "tell me when the intake thread is done". The Capsule keeps watches on threads and
// reports back when one finishes, stops or asks for something. Ported from lib/watch.js.
//
// It needs nothing new from vyred: VyreModel already follows the event stream, so a watch is a
// filter on events it sees anyway. Each watch fires once and is gone. What fired stays as a
// report (the thread, why, the last thing it said) until the user reads or clears it, and each
// new report becomes a macOS notification (host.notify).
//
// Watches and reports are kept in a small file beside the frecency file, mode 0600, so a Capsule
// that restarts still knows what the user is waiting for. Only thread ids, their labels, and the
// last reply's first 600 characters are kept.

import Foundation

public enum WatchUntil: String, Codable, Sendable { case done, asks, either }

public struct Watch: Codable, Sendable, Equatable {
    public var thread: String
    public var label: String
    public var until: WatchUntil
    public var at: Double
    /// The switchboard's watch id when threads.watch holds it: then its thread.watched is what
    /// fires, not the raw events.
    public var server: String?
}

public enum WatchWhy: String, Codable, Sendable { case finished, failed, stopped, asked }

public struct WatchReport: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var thread: String
    public var label: String
    public var why: WatchWhy
    public var text: String
    public var cost: Double?
    public var at: Double
    public var read: Bool
}

public final class Watches {
    static let keepText = 600
    static let maxReports = 30

    public let file: URL?
    let now: () -> Double
    private var watches: [String: Watch] = [:]
    private var order: [String] = []
    /// Newest first.
    public private(set) var reports: [WatchReport] = []
    /// The last whole message each watched thread said.
    private var last: [String: String] = [:]

    public init(file: URL? = nil, now: @escaping () -> Double = vyNowMs) {
        self.file = file
        self.now = now
        load()
    }

    private struct Saved: Codable { var watches: [Watch]; var reports: [WatchReport] }

    func load() {
        guard let file, let d = try? Data(contentsOf: file), let j = try? JSONDecoder().decode(Saved.self, from: d) else { return }
        for w in j.watches where !w.thread.isEmpty { set(w) }
        reports = Array(j.reports.prefix(Self.maxReports))
    }

    func save() {
        guard let file else { return }
        let dir = file.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        guard let data = try? JSONEncoder().encode(Saved(watches: list(), reports: reports)) else { return }
        let tmp = file.path + ".tmp"
        unlink(tmp)
        // Created 0600 from the start, so the file is never readable by others, not even for a moment.
        guard FileManager.default.createFile(atPath: tmp, contents: data, attributes: [.posixPermissions: 0o600]) else { return }
        chmod(tmp, 0o600)
        rename(tmp, file.path)
    }

    private func set(_ w: Watch) {
        if watches[w.thread] == nil { order.append(w.thread) }
        watches[w.thread] = w
    }

    private func delete(_ thread: String) -> Bool {
        guard watches.removeValue(forKey: thread) != nil else { return false }
        order.removeAll { $0 == thread }
        return true
    }

    /// Watch a thread. Watching it again replaces the old watch.
    @discardableResult
    public func add(_ thread: String, label: String, until: WatchUntil = .either, server: String? = nil) -> Watch {
        let w = Watch(thread: thread, label: String((label.isEmpty ? thread : label).prefix(80)), until: until, at: now(), server: server)
        set(w)
        save()
        return w
    }

    @discardableResult
    public func remove(_ thread: String) -> Bool { let had = delete(thread); if had { save() }; return had }
    public func has(_ thread: String) -> Bool { watches[thread] != nil }
    public func list() -> [Watch] { order.compactMap { watches[$0] } }
    public func watch(_ thread: String) -> Watch? { watches[thread] }

    /// Reports not yet read, newest first.
    public func unread() -> [WatchReport] { reports.filter { !$0.read } }

    @discardableResult
    public func read(_ id: String) -> WatchReport? {
        guard let i = reports.firstIndex(where: { $0.id == id }) else { return nil }
        if !reports[i].read { reports[i].read = true; save() }
        return reports[i]
    }

    public func clear() { reports = []; save() }

    /// One event from the stream. Returns the report it fired, or nil.
    public func onEvent(_ e: VyredEvent) -> WatchReport? {
        let p = e.payload
        let thread = e.thread ?? VJ.s(p["thread"])
        // The switchboard's own watch fired: set here, or by the assistant for the user ("watch
        // the intake thread and tell me"). Only watches meant for the user's screen are reported.
        if e.type == "thread.watched" && !thread.isEmpty {
            let mine = watches[thread]
            if mine == nil, let n = VJ.nonEmpty(p["notify"]), !["capsule", "user"].contains(n) { return nil }
            let reason = VJ.str(p["reason"])
            let why: WatchWhy = reason == "asked" ? .asked : reason == "stopped" ? .stopped : .finished
            return fire(thread, mine?.label ?? (VJ.nonEmpty(p["note"]) ?? String(thread.prefix(8))), why, VJ.s(p["summary"]), nil, e)
        }
        guard !thread.isEmpty, let w = watches[thread], w.server == nil else { return nil }
        if e.type == "thread.text" && VJ.truthy(p["done"]), let text = p["text"] as? String { last[thread] = text; return nil }
        var why: WatchWhy?
        if e.type == "thread.finished" && w.until != .asks { why = VJ.bool(p["ok"]) == false ? .failed : .finished }
        else if e.type == "thread.stopped" && w.until != .asks { why = .stopped }
        else if e.type == "ask.raised" && w.until != .done { why = .asked }
        guard let why else { return nil }
        let text = why == .asked ? (VJ.nonEmpty(p["summary"]) ?? VJ.nonEmpty(p["tool"]) ?? "a question") : why == .failed ? VJ.s(p["error"]) : (last[thread] ?? "")
        return fire(thread, w.label, why, text, VJ.num(p["cost_usd"]), e)
    }

    func fire(_ thread: String, _ label: String, _ why: WatchWhy, _ text: String, _ cost: Double?, _ e: VyredEvent) -> WatchReport {
        let r = WatchReport(id: "\(thread):\(e.id > 0 ? String(e.id) : String(Int(now())))", thread: thread, label: label, why: why,
                            text: String(text.prefix(Self.keepText)), cost: cost, at: e.at != 0 ? Double(e.at) : now(), read: false)
        _ = delete(thread)
        last[thread] = nil
        reports = Array(([r] + reports).prefix(Self.maxReports))
        save()
        return r
    }

    /// The notification a report becomes: a title and one line.
    public static func notice(_ r: WatchReport) -> (title: String, body: String) {
        let title: String
        switch r.why {
        case .asked: title = "\(r.label) is asking"
        case .failed: title = "\(r.label) failed"
        case .stopped: title = "\(r.label) stopped"
        case .finished: title = "\(r.label) is done"
        }
        let flat = r.text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        let body = flat.isEmpty ? (r.why == .finished ? "It finished its turn." : "") : String(flat.prefix(140))
        return (title, body)
    }

    /// "watch the intake thread", "tell me when harlow is done": the name the user means, or nil.
    public static func watchWords(_ text: String) -> String? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let m = VyRx.groups("^(?:watch|monitor|track)\\s+(?:the\\s+)?(.+?)(?:\\s+thread)?(?:\\s+and\\s+tell\\s+me.*)?$", t)
            ?? VyRx.groups("^(?:tell|ping|notify)\\s+me\\s+when\\s+(?:the\\s+)?(.+?)(?:\\s+thread)?\\s+(?:is\\s+)?(?:done|finishes|finished|asks)\\s*\\.?$", t)
        return m.map { $0[1].trimmingCharacters(in: .whitespaces) }
    }
}
