// SessionPanel: a session beside the user's work, in the side view's left column (ADR 0015).
//
// The window is the Capsule's (host.sessionWindow), so it can slide in at the display's own
// refresh rate, which AX cannot do for another app's window. This file draws what goes in it and
// keeps it current: a tab per session (the assistant first), the conversation folded from the
// thread's events with the Capsule's own DM reducer (VyState.applyDm), a prompt box that sends,
// a mic, and a status line. Nothing polls: history is read once per tab, then events only, and
// the subscription ends when the panel closes.

import AppKit
import SwiftUI

/// One session the panel can show.
struct PanelSession: Equatable, Identifiable {
    enum Kind: Equatable { case assistant(String), thread }
    var id: String
    var label: String
    var kind: Kind
    /// The thread when known. The assistant's may be nil until its first words start one.
    var thread: String?
    var status: String?

    var isAssistant: Bool { if case .assistant = kind { return true }; return false }
    var agent: String { if case .assistant(let a) = kind { return a }; return label }

    /// The assistant from agents.list, then the switchboard's threads from threads.list, newest first.
    static func load(agents: Any?, threads: Any?) -> [PanelSession] {
        var out: [PanelSession] = []
        let agentRows = (agents as? [[String: Any]]) ?? ((agents as? [String: Any])?["agents"] as? [[String: Any]]) ?? []
        if let a = agentRows.first(where: { VJ.str($0["kind"]) == "assistant" }) {
            let name = VJ.s(a["name"])
            out.append(PanelSession(id: "agent:\(name)", label: name, kind: .assistant(name), thread: VJ.nonEmpty(a["thread"]),
                                    status: VJ.nonEmpty(a["doing"]) ?? VJ.nonEmpty(a["status"])))
        }
        let assistantThread = out.first?.thread
        for x in (threads as? [[String: Any]]) ?? [] {
            let id = VJ.s(x["id"])
            guard !id.isEmpty, id != assistantThread else { continue }
            let label = VJ.nonEmpty(x["name"]) ?? VJ.str(x["cwd"]).flatMap { $0.split(separator: "/").last.map(String.init) } ?? String(id.prefix(8))
            out.append(PanelSession(id: "thread:\(id)", label: label, kind: .thread, thread: id, status: VJ.nonEmpty(x["status"])))
        }
        return out
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
    }

    func stop() {
        sub?.cancel(); sub = nil
        buffered = []
        loading = false
    }

    var isFollowing: Bool { sub != nil }

    func fold(_ e: VyredEvent) {
        if loading { buffered.append(e); return }
        let next = VyState.applyDm(dm, e)
        if next != dm { dm = next }
    }

    /// Show a session: its history once, then its events.
    func show(_ s: PanelSession) async {
        shown = s
        line = nil
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
                                Image(systemName: s.isAssistant ? "sparkle" : "terminal").font(.system(size: 10))
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
                    ForEach(model.view.messages) { m in message(m) }
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
            HStack {
                Spacer(minLength: 24)
                Text(m.text).font(Theme.reply).foregroundColor(m.pending ? Theme.stone : Theme.bone)
                    .textSelection(.enabled)
                    .padding(.horizontal, 10).padding(.vertical, 7)
                    .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Theme.raised))
            }
        } else {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(m.tools ?? [], id: \.id) { t in
                    Label(t.summary, systemImage: t.error ? "exclamationmark.triangle" : t.done ? "checkmark" : "circle.dotted")
                        .font(Theme.subtitle).foregroundColor(t.error ? Theme.beacon : Theme.ash).lineLimit(1)
                }
                if !m.text.isEmpty { Text(m.text).font(Theme.reply).foregroundColor(Theme.bone).textSelection(.enabled) }
                if let e = m.error { Text(e).font(Theme.subtitle).foregroundColor(Theme.beacon) }
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
            if let l = model.line { Text(l).font(Theme.label).foregroundColor(Theme.beacon).lineLimit(1).truncationMode(.tail) }
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
    }
}
