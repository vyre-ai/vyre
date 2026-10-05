// HistoryImportModel: bringing the history on this Mac into the person's own Vyre (#26). Four steps, each
// the person's own: scan this Mac's Claude Code, Codex and Grok folders, tick the projects to bring in,
// see exactly what that is and choose how fast Vyre should understand it, then send it over the paired
// link. The tools are the ones Vyre already has on the Mac (import.scan, import.plan, import.start,
// import.status, import.stop); this file only asks them and says what they answered, in words.
//
// Honest by construction: "nothing found" and "this Mac is not paired" are states of their own and never
// look like done; done is only reached after something was sent, and says how many.

import Foundation
import SwiftUI

/// One folder the scan found sessions for.
struct HistoryFolder: Identifiable, Equatable, Sendable {
    /// The folder the sessions ran in, or, for sessions with no folder, a name made from their source.
    var id: String
    /// What goes to import.plan's `include` for this row.
    var include: String
    var name: String
    var sessions: Int
    var bytes: Int
    var from: Date?
    var to: Date?
    var suggested: Bool
    var why: String?
}

/// One place sessions were found: a provider's own folder.
struct HistorySource: Identifiable, Equatable, Sendable {
    var id: String
    var agent: String
    var path: String
    var sessions: Int
    var bytes: Int
    var from: Date?
    var to: Date?
    var folders: [HistoryFolder]

    /// "Claude Code", "Codex", "Grok", "Gemini": the provider as a person says it.
    var label: String {
        switch agent {
        case "claude-code": return "Claude Code"
        case "codex": return "Codex"
        case "grok": return "Grok"
        case "gemini-cli": return "Gemini"
        default: return agent.prefix(1).uppercased() + agent.dropFirst()
        }
    }
}

struct HistoryPlan: Equatable, Sendable {
    var id: String
    var sessions: Int
    var bytes: Int
    var folders: Int
    var fastHours: Int
    var gentleDays: Int
}

enum HistoryPace: String, Sendable { case fast, gentle }
enum HistoryMode: String, Sendable { case once, sync }

/// How far the sending has got (import.status's upload block).
struct HistoryUpload: Equatable, Sendable {
    var done: Int
    var total: Int
    var failed: Int
    var quarantined: Int
    var state: String
}

@MainActor
final class HistoryImportModel: ObservableObject {
    enum Step: Equatable {
        case idle
        case scanning
        /// This Mac has no box to send to yet.
        case unpaired
        /// Looked, and there is nothing: says where it looked.
        case nothing
        case choose
        case planning
        case confirm
        case sending
        case done
        case failed(String)
    }

    /// Where the scan looks, in the words the screen uses when it finds nothing.
    static let lookedIn = "Claude Code, Codex and Grok"

    private let vyred: VyredLink
    @Published private(set) var step: Step = .idle
    @Published private(set) var sources: [HistorySource] = []
    /// The ids of the ticked folders. Folders Vyre would not suggest start unticked.
    @Published private(set) var ticked: Set<String> = []
    @Published private(set) var plan: HistoryPlan?
    @Published var pace: HistoryPace?
    @Published var mode: HistoryMode?
    @Published private(set) var upload: HistoryUpload?
    @Published private(set) var keepsDays: Int?
    @Published private(set) var boxName: String?
    /// What search has taken in so far (import.status's search block), for the line while sending.
    @Published private(set) var searchable: Int = 0

    init(vyred: VyredLink) { self.vyred = vyred }

    // MARK: reading what is here

    /// The folders of every source, in order.
    var folders: [HistoryFolder] { sources.flatMap(\.folders) }
    var totalSessions: Int { sources.reduce(0) { $0 + $1.sessions } }
    var tickedFolders: [HistoryFolder] { folders.filter { ticked.contains($0.id) } }
    var tickedSessions: Int { tickedFolders.reduce(0) { $0 + $1.sessions } }
    /// Distinct projects (folders) found, for "across 23 projects".
    var projectCount: Int { folders.count }

    /// The one honest sentence for what was found (or not), per the issue.
    var foundLine: String {
        switch step {
        case .unpaired: return "Pair this Mac first, then import from here."
        case .nothing: return "No sessions found. Looked in your \(Self.lookedIn) folders."
        default:
            let n = totalSessions, p = projectCount
            return "Found \(n) \(n == 1 ? "session" : "sessions") on this Mac across \(p) \(p == 1 ? "project" : "projects")."
        }
    }

    // MARK: scan

    func scan() async {
        step = .scanning
        sources = []; ticked = []; plan = nil; upload = nil; pace = nil; mode = nil
        // Is there a box to send to? Without one a choice would go nowhere: say so first.
        let link = await vyred.call(WinkServer.home, [:])
        if case .success(let d) = link, let h = WinkServer.parseHome(d) {
            if !h.linked { step = .unpaired; return }
            boxName = h.name
        }
        let r = await vyred.call("import.scan", [:])
        switch r {
        case .failure(_, let m): step = .failed(m)
        case .success(let d):
            let o = d as? [String: Any] ?? [:]
            sources = Self.sources(from: o["sources"])
            keepsDays = Self.int(o["claude_keeps_days"])
            ticked = Set(folders.filter(\.suggested).map(\.id))
            step = totalSessions == 0 ? .nothing : .choose
        }
    }

    func toggle(_ folder: HistoryFolder) {
        guard step == .choose else { return }
        if ticked.contains(folder.id) { ticked.remove(folder.id) } else { ticked.insert(folder.id) }
    }

    func tickAll(_ on: Bool) {
        guard step == .choose else { return }
        ticked = on ? Set(folders.map(\.id)) : []
    }

    // MARK: plan

    /// Exactly what the ticked folders would take. Nothing ticked asks for nothing.
    func makePlan() async {
        guard step == .choose, !ticked.isEmpty else { return }
        step = .planning
        let include = tickedFolders.map(\.include)
        let r = await vyred.call("import.plan", ["include": include])
        switch r {
        case .failure(_, let m): step = .failed(m)
        case .success(let d):
            let o = d as? [String: Any] ?? [:]
            let pace = o["pace"] as? [String: Any] ?? [:]
            plan = HistoryPlan(id: String(describing: o["plan"] ?? ""), sessions: Self.int(o["sessions"]) ?? 0, bytes: Self.int(o["bytes"]) ?? 0,
                               folders: (o["folders"] as? [Any])?.count ?? 0,
                               fastHours: Self.int((pace["fast"] as? [String: Any])?["hours"]) ?? 1,
                               gentleDays: Self.int((pace["gentle"] as? [String: Any])?["days"]) ?? 1)
            step = (plan?.sessions ?? 0) == 0 ? .nothing : .confirm
        }
    }

    func back() { if step == .confirm { step = .choose; plan = nil } }

    /// Neither speed is chosen for the person: Start waits for both choices.
    var canStart: Bool { step == .confirm && plan != nil && pace != nil && mode != nil }

    // MARK: send

    func start() async {
        guard canStart, let plan, let pace, let mode else { return }
        let r = await vyred.call("import.start", ["plan": plan.id, "mode": mode.rawValue, "pace": pace.rawValue], presence: false)
        switch r {
        case .failure(let code, let m):
            // The server did not take it (no pairing, no consent): say what it said.
            step = (code == "unavailable" || code == "no_such_tool") ? .unpaired : .failed(m)
        case .success(let d):
            let o = d as? [String: Any] ?? [:]
            upload = HistoryUpload(done: 0, total: Self.int(o["sessions"]) ?? plan.sessions, failed: 0, quarantined: 0, state: "sending")
            step = .sending
            await refresh()
        }
    }

    func stop() async {
        _ = await vyred.call("import.stop", [:])
        await refresh()
    }

    /// import.status: counts only. Called after start and on each import.progress event.
    func refresh() async {
        guard case .success(let d) = await vyred.call("import.status", [:]), let o = d as? [String: Any] else { return }
        if let u = o["upload"] as? [String: Any] {
            let up = HistoryUpload(done: Self.int(u["done"]) ?? 0, total: Self.int(u["total"]) ?? 0, failed: Self.int(u["failed"]) ?? 0,
                                   quarantined: Self.int(u["quarantined"]) ?? 0, state: (u["state"] as? String) ?? "")
            upload = up
            if step == .sending && (up.state == "done" || up.state == "stopped") { step = up.done > 0 ? .done : .failed("Nothing was sent.") }
        }
        searchable = Self.int(o["searchable_sessions"]) ?? searchable
    }

    func apply(_ e: VyredEvent) {
        guard e.type == "import.progress" else { return }
        Task { await refresh() }
    }

    /// What the screen says about the sending: counts, never the names of anything.
    var sendingLine: String {
        guard let u = upload else { return "Starting." }
        var s = "Sent \(u.done) of \(u.total)."
        if u.failed > 0 { s += " \(u.failed) did not go and will be tried again." }
        if u.quarantined > 0 { s += " \(u.quarantined) held back for a check." }
        return s
    }

    var doneLine: String {
        let n = upload?.done ?? 0
        let where_ = boxName.map { " to \($0)" } ?? ""
        return "Sent \(n) \(n == 1 ? "session" : "sessions")\(where_). Search works now; Vyre keeps understanding them in the background."
    }

    // MARK: parsing (the tools' answers are plain JSON)

    nonisolated static func int(_ v: Any?) -> Int? {
        if let n = v as? NSNumber { return n.intValue }
        if let s = v as? String { return Int(s) }
        return nil
    }

    nonisolated static func date(_ v: Any?) -> Date? {
        guard let ms = int(v), ms > 0 else { return nil }
        return Date(timeIntervalSince1970: Double(ms) / 1000)
    }

    nonisolated static func sources(from v: Any?) -> [HistorySource] {
        guard let list = v as? [[String: Any]] else { return [] }
        return list.map { s in
            let agent = (s["agent"] as? String) ?? (s["kind"] as? String) ?? "claude-code"
            let path = (s["path"] as? String) ?? ""
            let folders: [HistoryFolder] = ((s["folders"] as? [[String: Any]]) ?? []).map { f in
                let cwd = f["cwd"] as? String
                let id = cwd ?? "\(agent):\(path)#other"
                let name = (f["name"] as? String) ?? cwd.map { ($0 as NSString).lastPathComponent } ?? "Other sessions"
                return HistoryFolder(id: id, include: cwd ?? path, name: name.isEmpty ? (cwd ?? "Other sessions") : name,
                                     sessions: int(f["sessions"]) ?? 0, bytes: int(f["bytes"]) ?? 0, from: date(f["from"]), to: date(f["to"]),
                                     suggested: (f["suggested"] as? Bool) ?? true, why: f["why"] as? String)
            }
            return HistorySource(id: "\(agent):\(path)", agent: agent, path: path, sessions: int(s["sessions"]) ?? folders.reduce(0) { $0 + $1.sessions },
                                 bytes: int(s["bytes"]) ?? 0, from: date(s["from"]), to: date(s["to"]), folders: folders)
        }
    }

    /// "412 KB", "38 MB": a size a person reads.
    nonisolated static func size(_ bytes: Int) -> String {
        if bytes >= 1_048_576 { return String(format: "%.0f MB", Double(bytes) / 1_048_576) }
        if bytes >= 1024 { return "\(bytes / 1024) KB" }
        return "\(bytes) B"
    }

    /// "Mar 3 to Sep 29", or one date when they are the same day, or nothing.
    nonisolated static func range(_ from: Date?, _ to: Date?) -> String {
        guard let from, let to else { return "" }
        let f = DateFormatter(); f.dateFormat = "MMM d"; f.locale = Locale(identifier: "en_US_POSIX")
        let a = f.string(from: from), b = f.string(from: to)
        return a == b ? a : "\(a) to \(b)"
    }

    /// How long understanding takes at each speed, in the words the choice shows.
    nonisolated static func fastWords(_ hours: Int) -> String { hours <= 1 ? "about an hour" : "about \(hours) hours" }
    nonisolated static func gentleWords(_ days: Int) -> String { days <= 1 ? "about a day" : "about \(days) days" }
}
