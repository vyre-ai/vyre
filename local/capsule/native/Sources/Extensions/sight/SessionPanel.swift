// SessionPanel: a session beside the user's work, in the side view's left column (ADR 0015).
//
// The window is the Capsule's (host.sessionWindow), so it can slide in at the display's own
// refresh rate, which AX cannot do for another app's window. This file draws what goes in it and
// keeps it current: a tab per session (the assistant first), the conversation folded from the
// thread's events with the Capsule's own DM reducer (VyState.applyDm), a prompt box that sends,
// a mic, and a status line. Nothing polls: history is read once per tab, then events only, and
// the subscription ends when the panel closes. A terminal tab follows its transcript through
// recall.watch while it is the one shown: session.turn rows keyed on their id, session.state for
// the working dot, and one renewal a minute (a watch nobody renews ends by itself).

import AppKit
import SwiftUI

/// One session the panel can show.
struct PanelSession: Equatable, Identifiable {
    /// A terminal session is one vyred does not run (a Claude Code session in a terminal): its
    /// history comes from the recall index, and words to it go through threads.send, which queues.
    enum Kind: Equatable { case assistant(String), thread, terminal }
    var id: String
    var label: String
    var kind: Kind
    /// The thread when known. The assistant's may be nil until its first words start one.
    var thread: String?
    var status: String?
    /// The agent running a switchboard thread (threads.list's agent), when one does.
    var runBy: String? = nil
    /// The project a switchboard thread belongs to (threads.list's project), when it says.
    var project: String? = nil

    var isAssistant: Bool { if case .assistant = kind { return true }; return false }
    var isTerminal: Bool { kind == .terminal }
    var agent: String { if case .assistant(let a) = kind { return a }; return label }

    /// A session active this recently that vyred does not run is live in a terminal (the same
    /// rule the Capsule's `@` uses to put live terminal sessions first).
    static let liveWindowMs: Double = 15 * 60_000

    /// The assistant from agents.list, then live terminal sessions from projects.catalog (the
    /// source `@` reads), then the switchboard's threads from threads.list, newest first.
    static func load(agents: Any?, threads: Any?, catalog: Any? = nil, now: Double = vyNowMs()) -> [PanelSession] {
        var out: [PanelSession] = []
        let agentRows = (agents as? [[String: Any]]) ?? ((agents as? [String: Any])?["agents"] as? [[String: Any]]) ?? []
        if let a = agentRows.first(where: { VJ.str($0["kind"]) == "assistant" }) {
            let name = VJ.s(a["name"])
            out.append(PanelSession(id: "agent:\(name)", label: name, kind: .assistant(name), thread: VJ.nonEmpty(a["thread"]),
                                    status: VJ.nonEmpty(a["doing"]) ?? VJ.nonEmpty(a["status"])))
        }
        func folder(_ x: [String: Any]) -> String? { VJ.str(x["cwd"]).flatMap { $0.split(separator: "/").last.map(String.init) } }
        var seen = Set(out.compactMap(\.thread))
        var run: [PanelSession] = []
        for x in (threads as? [[String: Any]]) ?? [] {
            let id = VJ.s(x["id"])
            guard !id.isEmpty, seen.insert(id).inserted else { continue }
            let label = VJ.nonEmpty(x["name"]) ?? folder(x) ?? String(id.prefix(8))
            run.append(PanelSession(id: "thread:\(id)", label: label, kind: .thread, thread: id, status: VJ.nonEmpty(x["status"]), runBy: VJ.nonEmpty(x["agent"]),
                                    project: VJ.nonEmpty(x["project"])))
        }
        let recent = ((catalog as? [String: Any])?["sessions"] as? [[String: Any]]) ?? []
        for x in recent {
            let id = VJ.s(x["id"])
            guard !id.isEmpty, let last = VJ.num(x["last"]), now - last < liveWindowMs, seen.insert(id).inserted else { continue }
            let label = VJ.nonEmpty(x["label"]) ?? VJ.nonEmpty(x["name"]) ?? VJ.nonEmpty(x["title"]) ?? folder(x) ?? String(id.prefix(8))
            out.append(PanelSession(id: "terminal:\(id)", label: label, kind: .terminal, thread: id, status: "live in terminal"))
        }
        return out + run
    }
}

/// Who a reply is from, by chat's rule (deck/chat/lib/names.js labelFor): the agent's own name
/// when the tab is an agent's, else the assistant's name from system.info, else "Vyre". A name
/// that says Claude never shows.
enum ReplyLabel {
    static func of(agent: String?, assistant: String?) -> String {
        func clean(_ v: String?) -> String? {
            guard let t = v?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty,
                  t.range(of: "claude", options: .caseInsensitive) == nil else { return nil }
            return t
        }
        return clean(agent) ?? clean(assistant) ?? "Vyre"
    }
}

/// Where the side view puts things, from the display's visible frame (menu bar and Dock out).
enum SideGeometry {
    static let ratio: CGFloat = 0.29
    static let duration: TimeInterval = 0.25

    /// The panel's frame in AppKit coordinates (bottom-left origin): the left `ratio` of the
    /// visible frame, full height.
    static func panel(_ visible: NSRect, ratio: CGFloat = ratio) -> NSRect {
        NSRect(x: visible.minX, y: visible.minY, width: (visible.width * ratio).rounded(), height: visible.height)
    }

    /// Where it slides in from and out to: the same frame, just past the display's left edge.
    static func offscreen(_ f: NSRect) -> NSRect { f.offsetBy(dx: -f.width, dy: 0) }

    /// A frame in accessibility points (top-left origin of the main display, y down), which is
    /// what sideview.open takes. `primaryMaxY` is the main display's frame.maxY.
    static func axFrame(_ f: NSRect, primaryMaxY: CGFloat) -> [String: Any] {
        ["x": Int(f.minX.rounded()), "y": Int((primaryMaxY - f.maxY).rounded()), "w": Int(f.width.rounded()), "h": Int(f.height.rounded())]
    }
}

@MainActor
final class SessionPanelModel: ObservableObject {
    @Published var sessions: [PanelSession] = []
    @Published var shown: PanelSession?
    @Published var dm: Dm = VyState.dm("")
    @Published var draft = ""
    @Published var line: String?
    /// A quiet note under the tabs, such as where a terminal session's history came from.
    @Published var note: String?
    @Published var talking = false
    @Published var sending = false
    /// Screen context for the words in the box, shown as a chip above it until removed or sent.
    @Published var chip: ScreenChip?
    /// The user removed the chip; it stays away until the box is sent or emptied.
    @Published var chipRemoved = false
    var attacher: ScreenAttacher?
    private var chipTask: Task<Void, Never>?

    private let vyred: VyredLink
    private var sub: VyredSubscription?
    private var buffered: [VyredEvent] = []
    private var loading = false
    private var sendCount = 0
    /// The terminal tab's live watch: its id, the session.* subscription, the renewal, and every
    /// row id already drawn, so a replayed or doubled turn never shows twice.
    private var watchID: String?
    private var watchSub: VyredSubscription?
    private var renewTask: Task<Void, Never>?
    private var seen = Set<String>()
    private var lastTurn: String?
    /// How often a shown terminal tab renews its watch (vyred ends one unrenewed for 3 minutes).
    var renewEvery: Duration = .seconds(60)
    /// system.info's assistant.name, read once per show of the panel; nil until read or unset.
    @Published var assistantName: String?
    /// system.info's owner and assistant, for the marks beside the lines (read with the name).
    @Published var identities = Identities()
    private var namesRead = false
    /// Told the session now shown (nil when the panel stops): the Capsule's current project.
    var onShown: (PanelSession?) -> Void = { _ in }
    /// Voice from the panel's mic button or Option-Return in its box.
    var onTalk: () -> Void = {}

    init(vyred: VyredLink) { self.vyred = vyred }

    var view: DmView { VyState.dmView(dm) }

    /// When the current turn began: the newest words the user sent, while the session works.
    var busySince: Date? {
        guard dm.busy, let m = dm.messages.last(where: { $0.role == .user }) else { return nil }
        return Date(timeIntervalSince1970: m.at / 1000)
    }

    /// Follow this session's thread events from now until stop().
    func start() {
        guard sub == nil else { return }
        sub = vyred.on("thread.*") { [weak self] e in self?.fold(e) }
        readNames()
    }

    func stop() {
        if shown != nil { onShown(nil) }
        sub?.cancel(); sub = nil
        endWatch()
        buffered = []
        loading = false
        namesRead = false
    }

    /// The assistant's name for reply labels, once per show.
    private func readNames() {
        guard !namesRead else { return }
        namesRead = true
        Task { @MainActor [weak self] in
            guard let self else { return }
            let r = await vyred.call("system.info", [:], presence: false)
            if r.error != nil { namesRead = false; return }
            let d = (r.data as? [String: Any]) ?? [:]
            assistantName = VJ.nonEmpty((d["assistant"] as? [String: Any])?["name"])
            let who = Identities.from(d)
            if who != identities { identities = who }
        }
    }

    /// The label over a reply in the shown tab.
    var replyLabel: String {
        ReplyLabel.of(agent: shown.flatMap { $0.isAssistant ? $0.agent : $0.runBy }, assistant: assistantName)
    }

    /// The mark beside a reply: the blob of the agent running the tab's thread, else the
    /// assistant's creature (the assistant's own tab, a terminal session, a thread no agent runs).
    var replyAvatar: AvatarKind {
        if let s = shown, !s.isAssistant, let a = s.runBy, ReplyLabel.of(agent: a, assistant: nil) == a, a != assistantName {
            return .agent(a)
        }
        return identities.assistant(assistantName ?? shown.flatMap { $0.isAssistant ? $0.agent : nil })
    }

    var isWatching: Bool { watchID != nil }

    var isFollowing: Bool { sub != nil }

    func fold(_ e: VyredEvent) {
        if loading { buffered.append(e); return }
        let next = VyState.applyDm(dm, e)
        if next != dm { dm = next }
    }

    nonisolated static let lagNote = "History from the index, may be a few seconds behind"

    /// Show a session: its history once, then its events.
    func show(_ s: PanelSession) async {
        endWatch()
        shown = s
        onShown(s)
        line = nil
        note = nil
        if s.isTerminal { await showIndexed(s); return }
        var d = VyState.dm(s.agent, thread: s.thread, limit: 60)
        d.loading = s.thread != nil
        dm = d
        guard let thread = s.thread else { return }
        loading = true
        buffered = []
        let r = await vyred.call("threads.get", ["thread": thread, "limit": 200], presence: false)
        guard shown == s else { return }
        loading = false
        if let why = Bridge.explain(r) { dm.loading = false; line = why; buffered = []; return }
        var x = VyState.dmHistory(VyState.dm(s.agent, thread: thread, limit: 60), (r.data as? [String: Any]) ?? [:], askRow: { a in
            Waiting(source: .ask, id: VJ.s(a["id"]), title: VJ.nonEmpty(a["summary"]) ?? "A question", sub: "", at: VJ.num(a["at"]) ?? 0, quiet: false)
        })
        for e in buffered { x = VyState.applyDm(x, e) }
        buffered = []
        x.loading = false
        dm = x
    }

    /// A terminal session vyred does not run: its newest turns from the recall index (which lags by
    /// the index pass), then whatever thread events vyred sees for it, such as queued words.
    func showIndexed(_ s: PanelSession) async {
        let id = s.thread ?? ""
        var d = VyState.dm(s.label, thread: id, limit: 60)
        d.loading = true
        dm = d
        loading = true
        buffered = []
        note = Self.lagNote
        // The session's turn count first, so the second read starts at its newest turns.
        let head = await vyred.call("recall.thread", ["session": id, "limit": 1], presence: false)
        guard shown == s else { return }
        let count = VJ.int(((head.data as? [String: Any])?["session"] as? [String: Any])?["turns"]) ?? 0
        let r = head.error == nil
            ? await vyred.call("recall.thread", ["session": id, "from": max(0, count - 60), "limit": 60], presence: false)
            : head
        guard shown == s else { return }
        loading = false
        var x = VyState.dm(s.label, thread: id, limit: 60)
        var last: String?
        if r.error != nil {
            note = "Not in the index yet; new words show here as they come"
        } else {
            let turns = ((r.data as? [String: Any])?["turns"] as? [[String: Any]]) ?? []
            last = turns.last.map(Self.rowID)
            x.messages = turns.compactMap { t in
                let text = VJ.s(t["text"])
                guard !text.isEmpty else { return nil }
                let user = VJ.s(t["role"]) == "user"
                return DmMessage(id: Self.rowID(t), role: user ? .user : .agent, text: text,
                                 at: VJ.num(t["at"]) ?? VJ.num(t["ts"]) ?? 0, surface: user ? "terminal" : nil, done: user ? nil : true)
            }
        }
        for e in buffered { x = VyState.applyDm(x, e) }
        buffered = []
        x.loading = false
        dm = x
        seen = Set(x.messages.map(\.id))
        lastTurn = last
        await watch(s)
    }

    /// A turn's row id: its own id (a text turn's is its number as a string, a tool's "tool:<id>").
    nonisolated static func rowID(_ t: [String: Any]) -> String {
        VJ.nonEmpty(t["id"]) ?? VJ.int(t["seq"]).map(String.init) ?? ""
    }

    /// Follow the shown terminal session live from its newest drawn turn, until another tab or
    /// the panel's close ends it.
    private func watch(_ s: PanelSession) async {
        guard let id = s.thread, !id.isEmpty, shown == s else { return }
        watchSub = vyred.on("session.*") { [weak self] e in self?.live(e, session: id) }
        var input: [String: Any] = ["session": id]
        if let from = lastTurn { input["from"] = from }
        let r = await vyred.call("recall.watch", input, presence: false)
        guard shown == s, watchSub != nil else {
            if let w = VJ.nonEmpty((r.data as? [String: Any])?["watch"]) { unwatch(w) }
            return
        }
        guard r.error == nil, let d = r.data as? [String: Any], let w = VJ.nonEmpty(d["watch"]) else {
            // Nothing to follow (no transcript for it here): the history stays, still marked.
            watchSub?.cancel(); watchSub = nil
            return
        }
        watchID = w
        if let busy = VJ.bool(d["busy"]), busy != dm.busy { dm.busy = busy }
        renewTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                guard let every = self?.renewEvery else { return }
                try? await Task.sleep(for: every)
                guard !Task.isCancelled, let self else { return }
                await self.renew(id)
            }
        }
    }

    /// Keep the watch alive; one that lapsed anyway starts again from the newest drawn turn.
    private func renew(_ session: String) async {
        guard let w = watchID else { return }
        let r = await vyred.call("recall.watch", ["session": session, "watch": w], presence: false)
        guard watchID == w else { return }
        if case .failure(let code, _) = r, code == "not_found" {
            var input: [String: Any] = ["session": session]
            if let from = lastTurn { input["from"] = from }
            let again = await vyred.call("recall.watch", input, presence: false)
            guard watchID == w else { if let n = VJ.nonEmpty((again.data as? [String: Any])?["watch"]) { unwatch(n) }; return }
            watchID = VJ.nonEmpty((again.data as? [String: Any])?["watch"]) ?? w
        }
    }

    private func endWatch() {
        renewTask?.cancel(); renewTask = nil
        watchSub?.cancel(); watchSub = nil
        if let w = watchID { unwatch(w) }
        watchID = nil
        seen = []
        lastTurn = nil
    }

    private func unwatch(_ w: String) {
        let link = vyred
        Task { _ = await link.call("recall.unwatch", ["watch": w], presence: false) }
    }

    /// A session.turn or session.state for the shown terminal session.
    func live(_ e: VyredEvent, session: String) {
        guard watchSub != nil, (e.thread ?? VJ.str(e.payload["session"])) == session,
              VJ.str(e.payload["session"]).map({ $0 == session }) ?? true else { return }
        var d = dm
        switch e.type {
        case "session.state":
            guard let busy = VJ.bool(e.payload["busy"]) else { return }
            d.busy = busy
            if !busy { d.messages = Self.settleTools(d.messages) }
        case "session.turn":
            let id = Self.rowID(e.payload)
            guard !id.isEmpty, seen.insert(id).inserted else { return }
            let role = VJ.s(e.payload["role"])
            let text = VJ.s(e.payload["text"])
            let at = VJ.num(e.payload["at"]) ?? vyNowMs()
            if role == "tool" {
                let summary = VJ.nonEmpty((e.payload["tool"] as? [String: Any])?["summary"]) ?? text
                let tool = ReplyTool(id: id, summary: summary, done: false, error: false)
                if let i = d.messages.indices.last, d.messages[i].role == .agent {
                    d.messages[i].tools = (d.messages[i].tools ?? []) + [tool]
                } else {
                    d.messages.append(DmMessage(id: id, role: .agent, text: "", at: at, tools: [tool], done: false))
                }
            } else {
                guard !text.isEmpty else { return }
                d.messages = Self.settleTools(d.messages)
                let user = role == "user"
                // The words this panel sent come back from the transcript: they replace the pending row.
                if user, let i = d.messages.lastIndex(where: { $0.pending && $0.role == .user && $0.text == text }) {
                    d.messages.remove(at: i)
                }
                d.messages.append(DmMessage(id: id, role: user ? .user : .agent, text: text, at: at,
                                            surface: user ? "terminal" : nil, done: user ? nil : true))
                lastTurn = id
            }
            if d.messages.count > d.limit { d.messages.removeFirst(d.messages.count - d.limit) }
        default: return
        }
        if d != dm { dm = d }
    }

    /// A tool line is done once anything came after it.
    nonisolated static func settleTools(_ m: [DmMessage]) -> [DmMessage] {
        m.map { x in
            guard let t = x.tools, t.contains(where: { !$0.done }) else { return x }
            var y = x; y.tools = t.map { var u = $0; if u.status == .running { u.status = .completed }; return u }; return y
        }
    }

    /// The words changed: work out the chip again after a short pause in typing.
    func draftChanged() {
        chipTask?.cancel()
        chipTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(150))
            guard !Task.isCancelled else { return }
            await self?.refreshChip()
        }
    }

    /// The chip for the words in the box now. An empty box forgets the screen, so the next words
    /// read it fresh.
    func refreshChip() async {
        let words = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let a = attacher else { chip = nil; return }
        if words.isEmpty { chip = nil; chipRemoved = false; a.reset(); return }
        if chipRemoved { return }
        let c = await a.attachment(for: words)
        if draft.trimmingCharacters(in: .whitespacesAndNewlines) == words, !chipRemoved { chip = c }
    }

    /// Take the chip off this message (its x, or Command-Backspace with the caret at the start).
    func removeChip() {
        guard chip != nil else { return }
        chip = nil
        chipRemoved = true
    }

    /// Send the box's words to the shown session.
    func send() async {
        let words = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty, let s = shown, !sending else { return }
        sendCount += 1
        let key = "p\(sendCount)"
        draft = ""
        line = nil
        sending = true
        dm = VyState.dmPending(dm, key, words, vyNowMs())
        // The screen goes only with a chip the user saw and left in place.
        let text = words + (chipRemoved ? "" : chip?.body ?? "")
        chipTask?.cancel()
        chip = nil; chipRemoved = false
        attacher?.reset()
        let r: VyredResult
        if s.isAssistant {
            r = await vyred.call("agents.ask", ["agent": s.agent, "text": text, "surface": "capsule", "wait": false], presence: false)
        } else {
            r = await vyred.call("threads.send", ["thread": s.thread ?? "", "text": text, "surface": "capsule"], presence: false)
        }
        sending = false
        let d = (r.data as? [String: Any]) ?? [:]
        if let why = Bridge.explain(r) { fail(key, words, why); return }
        if s.isAssistant {
            if VJ.bool(d["ok"]) == false { fail(key, words, VJ.nonEmpty(d["note"]) ?? "\(s.label) did not get it."); return }
            if dm.thread == nil, let t = VJ.nonEmpty(d["thread"]) { dm.thread = t }
            return
        }
        if VJ.truthy(d["queued"]) { line = VJ.nonEmpty(d["note"]) ?? "\(s.label) is busy in your terminal. Your words go in when this turn ends."; return }
        if VJ.bool(d["sent"]) == false {
            fail(key, words, VJ.nonEmpty(d["holder"]).map { "\($0) has the keyboard in this thread." } ?? VJ.nonEmpty(d["note"]) ?? "This thread could not be typed into.")
        }
    }

    private func fail(_ key: String, _ words: String, _ why: String) {
        dm = VyState.dmDrop(dm, key)
        if draft.isEmpty { draft = words }
        line = why
    }
}

// MARK: - The view

/// The window's material: the dark sidebar vibrancy of a first-party Mac app.
struct Vibrancy: NSViewRepresentable {
    var material: NSVisualEffectView.Material = .sidebar
    func makeNSView(context: Context) -> NSVisualEffectView {
        let v = NSVisualEffectView()
        v.material = material
        v.blendingMode = .behindWindow
        v.state = .active
        v.appearance = NSAppearance(named: .darkAqua)
        return v
    }
    func updateNSView(_ v: NSVisualEffectView, context: Context) { v.material = material }
}

struct SessionPanelView: View {
    @ObservedObject var model: SessionPanelModel
    var close: () -> Void
    @State private var atBottom = true
    @FocusState private var boxFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            tabs
            if let n = model.note {
                Text(n).font(Theme.label).foregroundColor(Theme.ash).lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 14).padding(.bottom, 6)
            }
            Divider().overlay(Theme.rule)
            conversation
            Divider().overlay(Theme.rule)
            if let c = model.chip { chipView(c) }
            prompt
            status
        }
        .background(Vibrancy())
        .environment(\.colorScheme, .dark)
    }

    private var tabs: some View {
        HStack(spacing: 4) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 4) {
                    ForEach(model.sessions) { s in
                        Button { Task { await model.show(s) } } label: {
                            HStack(spacing: 5) {
                                Image(systemName: s.isAssistant ? "sparkle" : s.isTerminal ? "apple.terminal" : "terminal").font(.system(size: 10))
                                Text(s.label).font(Theme.subtitle).lineLimit(1)
                            }
                            .padding(.horizontal, 9).padding(.vertical, 5)
                            .foregroundColor(model.shown == s ? Theme.bone : Theme.stone)
                            .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(model.shown == s ? Theme.raised : .clear))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            Button(action: close) { Image(systemName: "xmark").font(.system(size: 11, weight: .medium)).foregroundColor(Theme.ash) }
                .buttonStyle(.plain).help("Close side view")
        }
        .padding(.horizontal, 10).padding(.top, 10).padding(.bottom, 8)
    }

    private var conversation: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if model.view.loading { Text("Reading the conversation").font(Theme.subtitle).foregroundColor(Theme.ash) }
                    let rows = model.view.messages
                    ForEach(Array(rows.enumerated()), id: \.element.id) { i, m in
                        // A reply says who it is from, once per run of replies.
                        if m.role == .agent, i == 0 || rows[i - 1].role != .agent {
                            HStack(spacing: 6) {
                                AvatarView(model.replyAvatar, size: 16)
                                Text(model.replyLabel).font(Theme.label).foregroundColor(Theme.ash)
                            }
                        }
                        message(m)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                        .onAppear { atBottom = true }
                        .onDisappear { atBottom = false }
                }
                .padding(14)
            }
            .onChange(of: model.view.messages) { _, _ in
                // Pinned to the newest words, unless the user scrolled up to read.
                if atBottom { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onChange(of: model.shown) { _, _ in atBottom = true; proxy.scrollTo("bottom", anchor: .bottom) }
        }
    }

    @ViewBuilder private func message(_ m: DmMessage) -> some View {
        if m.role == .user {
            HStack(alignment: .bottom, spacing: 6) {
                Spacer(minLength: 24)
                Text(m.text).font(Theme.reply).foregroundColor(m.pending ? Theme.stone : Theme.bone)
                    .textSelection(.enabled)
                    .padding(.horizontal, 10).padding(.vertical, 7)
                    .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Theme.raised))
                AvatarView(model.identities.person, size: 16)
            }
        } else {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(m.tools ?? [], id: \.id) { t in
                    Label(t.summary, systemImage: t.error ? "xmark.circle" : t.done ? "checkmark" : "circle.dotted")
                        .font(Theme.subtitle).foregroundColor(Theme.ash).lineLimit(1)
                }
                if !m.text.isEmpty { Text(m.text).font(Theme.reply).foregroundColor(Theme.bone).textSelection(.enabled) }
                if let e = m.error { Label("Failed. \(e)", systemImage: "xmark.circle").font(Theme.subtitle).foregroundColor(Theme.stone) }
            }
        }
    }

    private func chipView(_ c: ScreenChip) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "text.viewfinder").font(.system(size: 10)).foregroundColor(Theme.recall)
            Text(c.chip).font(Theme.label).foregroundColor(Theme.stone).lineLimit(1).truncationMode(.middle)
            Button { model.removeChip() } label: {
                Image(systemName: "xmark").font(.system(size: 9, weight: .semibold)).foregroundColor(Theme.ash)
            }
            .buttonStyle(.plain).help("Send without your screen (Command-Backspace at the start of the box)")
        }
        .padding(.horizontal, 8).padding(.vertical, 4)
        .background(Capsule().fill(Theme.raised))
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12).padding(.top, 8)
    }

    /// True when the box's caret sits at the very start, so Command-Backspace has nothing of the
    /// words to delete and removes the chip instead.
    private func caretAtStart() -> Bool {
        guard let tv = NSApp.keyWindow?.firstResponder as? NSTextView else { return model.draft.isEmpty }
        let r = tv.selectedRange()
        return r.location == 0 && r.length == 0
    }

    private var prompt: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField(model.talking ? "Listening" : "Message \(model.shown?.label ?? "the session")", text: $model.draft, axis: .vertical)
                .textFieldStyle(.plain)
                .font(Theme.title)
                .foregroundColor(Theme.bone)
                .lineLimit(1...6)
                .focused($boxFocused)
                .onSubmit { Task { await model.send() } }
                .onKeyPress(.return, phases: .down) { press in
                    guard press.modifiers.contains(.option) else { return .ignored }
                    model.onTalk()
                    return .handled
                }
                .onKeyPress(.delete, phases: .down) { press in
                    guard press.modifiers.contains(.command), model.chip != nil, caretAtStart() else { return .ignored }
                    model.removeChip()
                    return .handled
                }
                .onChange(of: model.draft) { _, _ in model.draftChanged() }
            Button { model.onTalk() } label: {
                Image(systemName: model.talking ? "mic.fill" : "mic").font(.system(size: 13))
                    .foregroundColor(model.talking ? Theme.signal : Theme.stone)
            }
            .buttonStyle(.plain).help("Talk (Option-Return)")
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Theme.raised.opacity(0.7)))
        .padding(.horizontal, 10).padding(.top, 10)
    }

    private var status: some View {
        HStack(spacing: 6) {
            Circle().fill(model.dm.busy ? Theme.signal : Theme.ash).frame(width: 6, height: 6)
            Text(model.shown?.label ?? "No session").font(Theme.label).foregroundColor(Theme.stone)
            if let since = model.busySince {
                Text("working").font(Theme.label).foregroundColor(Theme.ash)
                // Drawn by the system's own clock, so nothing here ticks a timer of ours.
                Text(since, style: .timer).font(Theme.label).foregroundColor(Theme.ash).monospacedDigit()
            } else {
                Text(model.dm.holder.map { "\($0) has the keyboard" } ?? "idle").font(Theme.label).foregroundColor(Theme.ash)
            }
            Spacer(minLength: 0)
            if let l = model.line { Text(l).font(Theme.label).foregroundColor(Theme.stone).lineLimit(1).truncationMode(.tail) }
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
    }
}
