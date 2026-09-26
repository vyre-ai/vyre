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
    /// What memory says about the words in the box (recall.search and memory.relevant), or nil.
    @Published public private(set) var memory: MemoryAnswer?
    /// What memory showed for the question that was asked, kept beside its reply.
    @Published public private(set) var askedMemory: MemoryAnswer?
    /// The inline "Are you sure?" for a destructive action, until Enter again or Escape.
    @Published public var confirming: (item: ResultItem, action: ResultAction)?
    /// The agent, project or thread picked with `@`: a chip before the box, where Enter sends.
    @Published public var target: VyreCandidate? { didSet { if target != oldValue { targetChanged(); search() } } }
    public private(set) var catalog = VyreCatalog.empty
    /// What extensions add (ExtensionHost.load): rows, named commands, and side panels.
    var extensionProviders: [ResultProvider] = []
    var extensionCommands: [CapsuleCommand] = []
    var panelFor: ((ResultItem?) -> AnyView?)?
    /// Bumped when an extension shows or hides its panel, so the view draws it again.
    @Published var panelTick = 0

    public var front: FrontApp?
    public let icons = IconCache()
    let providers: [ResultProvider]
    let frecency: Frecency
    let vyred: VyredClient
    let home: String
    /// The threads the Capsule holds, released and stopped on hide (Agent/Keeper.swift).
    lazy var keeper = Keeper(vyred: vyred)
    /// The conversation with the agent in the chip (Agent/Direct.swift).
    public lazy var direct: Direct = {
        let d = Direct(vyred: vyred)
        d.changed = { [weak self] in self?.objectWillChange.send() }
        d.projectName = { [weak self] s in self?.catalog.projectName(s) ?? s }
        d.onError = { [weak self] why in self?.line = why }
        return d
    }()
    /// Each agent's threads, for where @agent sends (Agent/Destinations.swift).
    lazy var routes = RouteCache()
    /// What waits on the user and the card that answers it (Agent/Desk.swift).
    public lazy var desk: Desk = {
        let d = Desk(vyred: vyred)
        d.changed = { [weak self] in self?.objectWillChange.send() }
        d.who = { [weak self] t in self?.catalog.who(t) }
        d.projectName = { [weak self] s in self?.catalog.projectName(s) ?? s }
        return d
    }()
    private var token = 0
    private var partial: [String: [ResultItem]] = [:]
    private var replySub: VyredSubscription?
    private var recallTask: Task<Void, Never>?
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
        (providers + extensionProviders).forEach { $0.warm() }
        keeper.shown()
        vyred.follower.setShown(true)
        if !vyred.follower.started { vyred.follower.start() }
        Task { @MainActor [vyred] in
            _ = await vyred.refreshTools()
            guard vyred.isUp else { return }
            self.catalog = await CatalogLoader.load(vyred)
            if Route.mention(self.text).completing != nil { self.search() }
            self.targetChanged()
            self.desk.follow()
            await self.desk.load()
        }
        if !text.isEmpty { search() }
    }

    public func didHide() {
        (providers + extensionProviders).forEach { $0.cool() }
        icons.cool()
        frecency.flush()
        vyred.follower.setShown(false)
        keeper.hidden(busy: reply.flatMap { $0.finished ? nil : $0.thread })
        desk.hidden()
        direct.close()
        token += 1
        confirming = nil
    }

    /// A fresh open starts with an empty box, unless a reply is still streaming.
    public func reset() {
        if let r = reply, !r.finished { return }
        text = ""; groups = []; selected = 0; line = nil; reply = nil; asked = nil; memory = nil; askedMemory = nil; target = nil
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
        // `@` being typed: the list is what it can name, nothing else.
        if target == nil, let m = Route.mention(text).completing {
            recallTask?.cancel(); memory = nil
            let rows = Route.complete(m, catalog).map(candidateItem)
            groups = rows.isEmpty ? [] : [Group(section: .vyre, items: rows)]
            selected = 0
            if rows.isEmpty { line = vyred.isUp ? "Nothing called that in Vyre." : "vyred is not running. Start it with vyre up." }
            return
        }
        if target != nil {
            recallTask?.cancel(); memory = nil
            groups = q.normalized.isEmpty ? [] : [Group(section: .vyre, items: askItems(q))]
            selected = 0
            return
        }
        recall(q.text, token: t)
        if q.normalized.isEmpty { groups = []; selected = 0; return }
        if let c = calcResult(q) { partial["calc"] = [c] }
        partial["commands"] = SystemCommands.match(q.normalized).prefix(3).map { commandItem($0.command, score: $0.score) }
        partial["ext-commands"] = extensionCommands.compactMap { c in
            let s = Match.score(q.normalized, c.title, synonyms: c.keywords)
            guard s >= 0.5 else { return nil }
            return ResultItem(id: "ext:" + c.id, kind: "command", title: c.title, subtitle: c.subtitle, icon: c.icon,
                              section: .commands, score: s, actions: c.actions)
        }
        publish()
        for p in providers + extensionProviders {
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
        let best = all.first { $0.section != .answer }
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
        // Where the words go (Agent/Destinations.swift): first for a question nothing here answers,
        // or with a chip or an answer on screen; last otherwise.
        let asks = Group(section: .vyre, items: askItems(q))
        if asksFirst(q, top: best) { out.insert(asks, at: out.first?.section == .answer ? 1 : 0) } else { out.append(asks) }
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

    func candidateItem(_ c: VyreCandidate) -> ResultItem {
        let symbol = c.kind == .agent ? "person.crop.circle" : c.kind == .project ? "folder" : "text.bubble"
        return ResultItem(id: "at:\(c.kind.rawValue):\(c.id)", kind: "mention", title: c.label, subtitle: c.sub, icon: .symbol(symbol, .bone),
                          section: .vyre, score: 1, actions: [ResultAction(id: "pick", title: "Pick", symbol: "at") { [weak self] _, _ in
                              await self?.pick(c) ?? .failed("The Capsule closed.")
                          }])
    }

    /// The `@` row was picked: it becomes the chip, and the `@...` leaves the box.
    func pick(_ c: VyreCandidate) -> ActionOutcome {
        let m = Route.mention(text)
        var chars = Array(text)
        if m.start >= 0 { chars.removeSubrange(m.start..<m.end) }
        target = c
        return .replaceQuery(String(chars).trimmingCharacters(in: .whitespaces))
    }

    func askItem(_ q: Query) -> ResultItem {
        let words = q.text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let c = target {
            let to = c.kind == .project ? "a new thread in \(c.label)" : c.label
            return ResultItem(id: "send", kind: "ask", title: "Send to \(to)", subtitle: words, icon: .mark, section: .vyre, score: 0,
                              actions: [ResultAction(id: "send", title: "Send", symbol: "paperplane") { [weak self] _, _ in
                                  await self?.send(words, to: c) ?? .failed("The Capsule closed.")
                              }], sendsTo: c.label)
        }
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

    // MARK: memory

    /// Whether the memory box sits above the results: it has something, and the words read as a
    /// question or nothing on this Mac matches them well.
    public var showsMemory: Bool {
        guard asked == nil, let m = memory, !m.isEmpty, m.text == text.trimmingCharacters(in: .whitespacesAndNewlines) else { return false }
        return Route.asksQuestion(m.text) || !(flat.contains { $0.score >= 0.6 && $0.kind != "ask" })
    }

    /// Memory first: what the user already said, on this Mac, with no model. Asked a moment after
    /// typing stops, and only while vyred is up; an answer for older words is dropped.
    func recall(_ raw: String, token t: Int) {
        recallTask?.cancel()
        let words = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if memory?.text != words { memory = nil }
        guard words.count >= 3, vyred.isUp, vyred.has("recall.search") || vyred.has("memory.relevant") else { return }
        let scratch = URL(fileURLWithPath: home).appendingPathComponent("capsule/ask").path
        recallTask = Task { @MainActor [vyred] in
            try? await Task.sleep(nanoseconds: 180_000_000)
            if Task.isCancelled || t != self.token { return }
            let t0 = vyNowMs()
            async let facts = vyred.call("memory.relevant", ["text": words, "limit": 3], presence: false)
            async let hits = vyred.call("recall.search", ["q": words, "limit": 10, "per_session": 1], presence: false)
            let (f, h) = await (facts, hits)
            if Task.isCancelled || t != self.token { return }
            var m = Memo.fold(text: words, facts: (f.data as? [[String: Any]]) ?? [], hits: (h.data as? [[String: Any]]) ?? [], scratch: scratch)
            m.ms = max(1, vyNowMs() - t0)
            self.memory = m
        }
    }

    // MARK: asking

    func ask(_ words: String, model: String = "haiku") async -> ActionOutcome {
        guard !words.isEmpty else { return .said("Type a question first.") }
        let dir = URL(fileURLWithPath: home).appendingPathComponent("capsule/ask")
        do { try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) } catch {
            return .failed("Could not make the Capsule's folder: \(error.localizedDescription)")
        }
        asked = words
        // What memory showed for these same words goes with the question, and only that.
        askedMemory = memory?.text == words && !(memory?.isEmpty ?? true) ? memory : nil
        let append = Memo.append(askedMemory)
        pending = true
        reply = nil
        replySub?.cancel()
        // Follow before starting, so the first words are not missed.
        var early: [VyredEvent] = []
        var thread: String?
        replySub = vyred.on("thread.*") { [weak self] e in
            guard let self else { return }
            self.keeper.heard(e)
            guard let t = thread else { early.append(e); return }
            if e.thread == t, let r = self.reply { self.reply = VyState.applyReply(r, e) }
        }
        let name = "Capsule: " + String(words.split(whereSeparator: \.isWhitespace).joined(separator: " ").prefix(40))
        let r = await vyred.call("threads.start", ["prompt": words, "append": append, "lean": true, "model": model,
                                                   "cwd": dir.path, "surface": "capsule", "name": name], presence: false)
        pending = false
        if let why = Bridge.explain(r) { asked = nil; replySub?.cancel(); replySub = nil; return .failed(why) }
        guard let d = r.data as? [String: Any], let id = d["id"].map({ "\($0)" }) else { asked = nil; return .failed("vyred did not say which thread it started.") }
        thread = id
        keeper.startedQuick(id)
        var rep = VyState.reply(id)
        rep.model = model
        for e in early where e.thread == id { rep = VyState.applyReply(rep, e) }
        reply = rep
        return .said("")
    }

    // MARK: sending to an agent, a project or a thread

    /// Follow a thread's events into `reply`, from before the words go (the answer can beat the call).
    private func follow(_ thread: @escaping () -> String?) {
        replySub?.cancel()
        replySub = vyred.on("thread.*") { [weak self] e in
            guard let self else { return }
            self.keeper.heard(e)
            guard let r = self.reply else { return }
            let t = thread() ?? (r.thread.isEmpty ? nil : r.thread)
            if r.thread.isEmpty, e.type == "thread.sent", VJ.str(e.payload["surface"]) == "capsule", let et = e.thread {
                var x = r; x.thread = et; self.reply = VyState.applyReply(x, e); return
            }
            if let t, e.thread == t { self.reply = VyState.applyReply(r, e) }
        }
    }

    func send(_ words: String, to c: VyreCandidate, model: String? = nil) async -> ActionOutcome {
        guard !words.isEmpty else { return .said("Type what to send first.") }
        asked = words
        askedMemory = nil
        pending = true
        switch c.kind {
        case .thread:
            reply = VyState.reply(c.id)
            reply?.model = model
            follow { c.id }
            let r = await vyred.call("threads.send", ["thread": c.id, "text": words, "surface": "capsule"], presence: false)
            pending = false
            if let why = Bridge.explain(r) { reply = nil; asked = nil; return .failed(why) }
            let d = (r.data as? [String: Any]) ?? [:]
            // capsule-now rule 5: busy in a terminal, the words wait for its turn to end.
            if VJ.truthy(d["queued"]) {
                let name = VJ.nonEmpty(d["name"]) ?? c.label
                reply?.queued = QueuedSend(name: name, note: VJ.nonEmpty(d["note"]))
                return .said(VJ.nonEmpty(d["note"]) ?? "\(name) is busy in your terminal. I'll hand it your message when this turn ends.")
            }
            if VJ.bool(d["sent"]) == false {
                reply = nil; asked = nil
                if let h = VJ.nonEmpty(d["holder"]) { return .failed("\(h) has the keyboard in this thread.") }
                return .failed(VJ.nonEmpty(d["note"]) ?? "This thread could not be typed into.")
            }
            keeper.typed(into: c.id)
            return .said("")
        case .agent:
            reply = VyState.reply("")
            var thread: String?
            follow { thread }
            let r = await vyred.call("agents.ask", ["agent": c.id, "text": words, "surface": "capsule", "wait": false], presence: false)
            pending = false
            let d = (r.data as? [String: Any]) ?? [:]
            if let why = Bridge.explain(r) { reply = nil; asked = nil; return .failed(why) }
            if VJ.bool(d["ok"]) == false { reply = nil; asked = nil; return .failed(VJ.nonEmpty(d["note"]) ?? "\(c.label) did not get it.") }
            thread = VJ.nonEmpty(d["thread"]) ?? reply?.thread
            if let t = thread, reply?.thread.isEmpty == true { reply?.thread = t }
            if let t = thread, !t.isEmpty { keeper.typed(into: t) }
            return .said("")
        case .project:
            reply = VyState.reply("")
            var thread: String?
            follow { thread }
            let r = await vyred.call("threads.start", ["project": c.id, "prompt": words, "surface": "capsule"], presence: false)
            pending = false
            if let why = Bridge.explain(r) { reply = nil; asked = nil; return .failed(why) }
            thread = (r.data as? [String: Any]).flatMap { VJ.nonEmpty($0["id"]) }
            if let t = thread, reply?.thread.isEmpty == true { reply?.thread = t }
            if let t = thread { keeper.typed(into: t) }
            return .said("")
        }
    }

    public var replyText: String { reply.map(VyState.replyText) ?? "" }

    public func stopReply() {
        guard let r = reply, !r.finished else { return }
        reply = VyState.cancel(r)
        // A queued message has no interrupt path into a terminal session: stop following only.
        if r.queued != nil { line = "Stopped following. \(r.queued!.name) still gets the message when its turn ends."; return }
        if r.thread.isEmpty { return }
        // threads.stop takes {thread}: with {id} it was refused and the process ran on.
        keeper.stop(r.thread)
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
