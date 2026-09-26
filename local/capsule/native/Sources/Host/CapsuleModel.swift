// CapsuleModel: what the Capsule shows, as one observable value the view draws.
//
// Typing asks every provider at once. Quick providers answer from memory in the same frame; full
// ones (Spotlight) land later and are merged in if the box still says the same thing. Frecency is
// added here, not by providers, and the best row across sections is lifted to the top hit.
//
// The last row is always "Ask": the words go to a model in a thread of its own (threads.start,
// lean, in the Capsule's scratch folder), and the reply streams under the bar.

import AppKit
import Foundation
import SwiftUI

@MainActor
public final class CapsuleModel: ObservableObject {
    public struct Group: Identifiable {
        public var section: Section
        public var items: [ResultItem]
        public var id: String { section.rawValue }
    }

    @Published public var text = "" { didSet { if text != oldValue { search() } } }
    @Published public private(set) var groups: [Group] = []
    @Published public var selected = 0
    /// One line under the bar ("Copied", an error), cleared on the next keystroke.
    @Published public var line: String?
    @Published public private(set) var reply: Reply?
    @Published public private(set) var asked: String?
    @Published public private(set) var pending = false
    /// The inline "Are you sure?" for a destructive action, until Enter again or Escape.
    @Published public var confirming: (item: ResultItem, action: ResultAction)?

    public var front: FrontApp?
    public let icons = IconCache()
    let providers: [ResultProvider]
    let frecency: Frecency
    let vyred: VyredClient
    let home: String
    private var token = 0
    private var partial: [String: [ResultItem]] = [:]
    private var replySub: VyredSubscription?
    /// Asked to close the panel (an action finished with .close).
    public var onClose: ((String?) -> Void)?
    /// Asked to step aside for the front app.
    public var onStepAside: (() async -> Bool)?

    public init(home: String, vyred: VyredClient, providers: [ResultProvider]) {
        self.home = home
        self.vyred = vyred
        self.providers = providers
        self.frecency = Frecency(file: URL(fileURLWithPath: home).appendingPathComponent("capsule/frecency.json"))
    }

    public var flat: [ResultItem] { groups.flatMap(\.items) }
    public var current: ResultItem? { let f = flat; return f.indices.contains(selected) ? f[selected] : nil }

    // MARK: showing and hiding

    public func willShow(front: FrontApp?) {
        self.front = front
        providers.forEach { $0.warm() }
        vyred.follower.setShown(true)
        if !vyred.follower.started { vyred.follower.start() }
        if !text.isEmpty { search() }
    }

    public func didHide() {
        providers.forEach { $0.cool() }
        icons.cool()
        frecency.flush()
        vyred.follower.setShown(false)
        token += 1
        confirming = nil
    }

    /// A fresh open starts with an empty box, unless a reply is still streaming.
    public func reset() {
        if let r = reply, !r.finished { return }
        text = ""; groups = []; selected = 0; line = nil; reply = nil; asked = nil
        replySub?.cancel(); replySub = nil
    }

    // MARK: searching

    func search() {
        token += 1
        let t = token
        line = nil
        confirming = nil
        partial = [:]
        let q = Query(text, front: front)
        if q.normalized.isEmpty { groups = []; selected = 0; return }
        if let c = calcResult(q) { partial["calc"] = [c] }
        partial["commands"] = SystemCommands.match(q.normalized).prefix(3).map { commandItem($0.command, score: $0.score) }
        publish()
        for p in providers {
            Task { @MainActor in
                let rows = await p.results(for: q)
                guard t == self.token else { return }
                self.partial[p.id] = rows
                self.publish()
            }
        }
    }

    func publish() {
        let q = Query(text, front: front)
        var all = partial.values.flatMap { $0 }
        for i in all.indices { all[i].score += frecency.boost(all[i].id, query: q.normalized) }
        all.sort { $0.score > $1.score }
        var out: [Group] = []
        if let top = all.first, top.score >= 0.6, top.section != .answer {
            out.append(Group(section: .top, items: [top]))
            all.removeFirst()
        }
        var by: [Section: [ResultItem]] = [:]
        for r in all { by[r.section, default: []].append(r) }
        for s in Section.allCases where s != .top {
            if let rows = by[s], !rows.isEmpty { out.append(Group(section: s, items: Array(rows.prefix(s == .files ? 6 : 4)))) }
        }
        // Answers (calc) sit first: they are what the user typed, worked out.
        if let i = out.firstIndex(where: { $0.section == .answer }), i != 0 { out.insert(out.remove(at: i), at: 0) }
        out.append(Group(section: .vyre, items: [askItem(q)]))
        let keep = current?.id
        groups = out
        if let keep, let i = flat.firstIndex(where: { $0.id == keep }) { selected = i } else { selected = 0 }
    }

    func commandItem(_ c: SystemCommand, score: Double) -> ResultItem {
        var r = systemCommandResult(c, score: score)
        r.actions = [ResultAction(id: "run", title: c.title, symbol: c.symbol, confirm: c.dangerous) { _, _ in
            await SystemCommandRunner.run(c)
        }]
        return r
    }

    func askItem(_ q: Query) -> ResultItem {
        let words = q.text.trimmingCharacters(in: .whitespacesAndNewlines)
        return ResultItem(id: "ask", kind: "ask", title: "Ask", subtitle: words, icon: .mark, section: .vyre, score: 0,
                          actions: [ResultAction(id: "ask", title: "Ask", symbol: "sparkle") { [weak self] _, _ in
                              await self?.ask(words) ?? .failed("The Capsule closed.")
                          }], sendsTo: "a model, through vyred")
    }

    // MARK: moving and picking

    public func move(_ by: Int) {
        let n = flat.count
        guard n > 0 else { return }
        selected = (selected + by + n) % n
        confirming = nil
    }

    /// Enter (index 0) or a ⌘ shortcut's action on the selected row.
    public func run(actionAt index: Int = 0) {
        guard let item = current, item.actions.indices.contains(index) else { return }
        let action = item.actions[index]
        if let c = action.confirm, confirming?.item.id != item.id {
            confirming = (item, action)
            line = c
            return
        }
        confirming = nil
        let q = Query(text, front: front)
        if item.kind != "ask" { frecency.pick(item.id, query: q.normalized) }
        Task { @MainActor in
            var back = false
            if action.needsFrontApp, let step = onStepAside { back = await step() }
            let out = await action.run(item, ActionContext(query: q, frontIsBack: back))
            self.handle(out)
        }
    }

    public func run(shortcut: KeyShortcut) -> Bool {
        guard let item = current, let i = item.actions.firstIndex(where: { $0.shortcut == shortcut }) else { return false }
        run(actionAt: i)
        return true
    }

    func handle(_ out: ActionOutcome) {
        switch out {
        case .close(let note): onClose?(note)
        case .said(let s): line = s
        case .failed(let s): line = s
        case .replaceQuery(let s): text = s
        case .openPanel: break
        }
    }

    public func copyCurrent() -> Bool {
        guard let item = current, let s = item.copyText ?? (item.kind == "ask" ? nil : item.title) else { return false }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(s, forType: .string)
        line = "Copied"
        return true
    }

    // MARK: asking

    func ask(_ words: String) async -> ActionOutcome {
        guard !words.isEmpty else { return .said("Type a question first.") }
        let dir = URL(fileURLWithPath: home).appendingPathComponent("capsule/ask")
        do { try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) } catch {
            return .failed("Could not make the Capsule's folder: \(error.localizedDescription)")
        }
        asked = words
        pending = true
        reply = nil
        replySub?.cancel()
        // Follow before starting, so the first words are not missed.
        var early: [VyredEvent] = []
        var thread: String?
        replySub = vyred.on("thread.*") { [weak self] e in
            guard let self else { return }
            guard let t = thread else { early.append(e); return }
            if e.thread == t, let r = self.reply { self.reply = VyState.applyReply(r, e) }
        }
        let name = "Capsule: " + String(words.split(whereSeparator: \.isWhitespace).joined(separator: " ").prefix(40))
        let r = await vyred.call("threads.start", ["prompt": words, "append": Bridge.quickAppend, "lean": true, "model": "haiku",
                                                   "cwd": dir.path, "surface": "capsule", "name": name], presence: false)
        pending = false
        if let why = Bridge.explain(r) { asked = nil; replySub?.cancel(); replySub = nil; return .failed(why) }
        guard let d = r.data as? [String: Any], let id = d["id"].map({ "\($0)" }) else { asked = nil; return .failed("vyred did not say which thread it started.") }
        thread = id
        var rep = VyState.reply(id)
        rep.model = "haiku"
        for e in early where e.thread == id { rep = VyState.applyReply(rep, e) }
        reply = rep
        return .said("")
    }

    public var replyText: String { reply.map(VyState.replyText) ?? "" }

    public func stopReply() {
        guard let r = reply, !r.finished else { return }
        reply = VyState.cancel(r)
        let t = r.thread
        Task { _ = await vyred.call("threads.stop", ["id": t], presence: false) }
    }
}

/// Runs the Mac's system commands. The table and its confirm lines are in Core/SystemCommands.
enum SystemCommandRunner {
    static func run(_ c: SystemCommand) async -> ActionOutcome {
        let script: String
        switch c.id {
        case "lock": return await shell("/usr/bin/pmset", ["displaysleepnow"], done: "Locked")
        case "sleep": return await shell("/usr/bin/pmset", ["sleepnow"], done: "Sleeping")
        case "screen-saver": return await shell("/usr/bin/open", ["-a", "ScreenSaverEngine"], done: "Screen saver")
        case "volume-up": script = "set volume output volume ((output volume of (get volume settings)) + 10)"
        case "volume-down": script = "set volume output volume ((output volume of (get volume settings)) - 10)"
        case "mute": script = "set volume output muted (not (output muted of (get volume settings)))"
        case "dark-mode": script = "tell application \"System Events\" to tell appearance preferences to set dark mode to not dark mode"
        case "empty-trash": script = "tell application \"Finder\" to empty trash"
        case "restart": script = "tell application \"System Events\" to restart"
        case "shutdown": script = "tell application \"System Events\" to shut down"
        case "logout": script = "tell application \"System Events\" to log out"
        default: return .failed("\(c.title) is not wired up yet.")
        }
        guard dialogsAllowed() else { return .failed("\(c.title) is off under tests.") }
        return await shell("/usr/bin/osascript", ["-e", script], done: c.title)
    }

    static func shell(_ path: String, _ args: [String], done: String) async -> ActionOutcome {
        await withCheckedContinuation { k in
            let p = Process()
            p.executableURL = URL(fileURLWithPath: path)
            p.arguments = args
            p.terminationHandler = { p in k.resume(returning: p.terminationStatus == 0 ? .close(nil) : .failed("\(done) did not work (exit \(p.terminationStatus)).")) }
            do { try p.run() } catch { k.resume(returning: .failed("\(done) did not work: \(error.localizedDescription)")) }
        }
    }
}
