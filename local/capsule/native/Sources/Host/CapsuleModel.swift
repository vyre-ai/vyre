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

    @Published public var text = "" { didSet { if text != oldValue { userMoved = false; extensionBoxChanged?(); search() } } }
    /// After an answer, the box is the follow-up box: ⏎ continues the same thread (AutoAsk.swift).
    @Published public internal(set) var followUp = false
    /// How long typing rests before a question is answered on its own (AutoAsk.swift).
    var autoDelay: Double = 0.6
    var autoTask: Task<Void, Never>?
    /// The words the answer on screen was asked for, normalised; nil when none is.
    var autoKey: String?
    /// The last few finished answers, by their words, so asking again shows at once.
    var answerCache: [(key: String, reply: Reply, memory: MemoryAnswer?)] = []
    /// What was asked and answered in this conversation, for ⌘⏎ on the deeper model.
    var convo: [(q: String, a: String)] = []
    /// The user moved into the results with ↑↓: ⏎ opens that row instead of asking.
    var userMoved = false
    /// Words are being spoken into the box: nothing asks on its own until they are final.
    var dictating = false
    /// The question on screen came by voice: its answer is spoken if spoken replies are on.
    var voiceTurn = false
    /// The answer on screen is computer use (an agent session with hands and screen): Esc also
    /// calls hands.stop.
    var doing = false
    var speaker: AnyObject?
    /// Rows by section. A group always has rows: an empty one is dropped, never drawn as a bare heading.
    @Published public internal(set) var groups: [Group] = [] { didSet { if groups.contains(where: { $0.items.isEmpty }) { groups.removeAll { $0.items.isEmpty } } } }
    /// Scrolls the answer card (UI/AnswerScroll.swift); the panel's keys drive it.
    let answerScroll = AnswerScroller()
    @Published public var selected = 0
    /// One line under the bar ("Copied", an error), cleared on the next keystroke.
    @Published public var line: String?
    @Published public internal(set) var reply: Reply? {
        didSet {
            // An answer that lands while the Capsule is hidden is a banner, top right.
            if let r = reply, r.finished, oldValue?.finished == false, oldValue?.thread == r.thread, !r.cancelled, !isShown() {
                let who = self.replyWho
                let text = VyState.replyText(r).split(separator: "\n").first.map(String.init) ?? ""
                Notifier.shared.post(title: r.ok == false ? "\(who) stopped" : "\(who) answered",
                                     body: text.isEmpty ? (asked ?? "") : String(text.prefix(180)))
            }
            // A new answer, or a new turn in the same thread (a follow-up, ⌘⏎), reveals from the start.
            if reply?.thread != oldValue?.thread || reply.map({ VyState.replyText($0).isEmpty }) ?? true { revealed = 0 }
            if let r = reply, r.finished, oldValue?.finished == false, r.ok != false, !r.cancelled, let q = asked {
                remember(q, r)
                if voiceTurn { voiceTurn = false; speakAnswer(VyState.replyText(r)) }
            }
            pace()
        }
    }
    /// Characters of the answer on screen. The stream arrives in bursts; the screen reveals it at
    /// a steady rate that drains any backlog in about a quarter second (Paseo's paced reveal,
    /// native-core budget 4). The frame timer runs only while there is a backlog and the panel
    /// is shown; hidden, or stopped, everything is shown at once.
    @Published public private(set) var revealed = 0
    private var revealTimer: Timer?
    public var visibleReplyCount: Int { min(revealed, replyText.count) }
    public var shownReplyText: String { let t = replyText; return revealed >= t.count ? t : String(t.prefix(revealed)) }

    private func pace() {
        let total = replyText.count
        guard revealed < total else { revealTimer?.invalidate(); revealTimer = nil; return }
        if !isShown() || reply?.cancelled == true || (reply?.finished == true && reply?.ok == false) {
            revealed = total; revealTimer?.invalidate(); revealTimer = nil; return
        }
        guard revealTimer == nil else { return }
        let t = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.revealFrame() }
        }
        RunLoop.main.add(t, forMode: .common)
        revealTimer = t
    }

    func revealFrame() {
        let total = replyText.count
        let backlog = total - revealed
        guard backlog > 0 else { revealTimer?.invalidate(); revealTimer = nil; return }
        revealed += max(2, Int((Double(backlog) / 15).rounded(.up)))
        if revealed >= total { revealed = total; revealTimer?.invalidate(); revealTimer = nil }
    }
    @Published public internal(set) var asked: String?
    @Published public internal(set) var pending = false
    /// What memory says about the words in the box (memory.answer), or nil.
    @Published public internal(set) var memory: MemoryAnswer?
    /// What memory showed for the question that was asked, kept beside its reply.
    @Published public internal(set) var askedMemory: MemoryAnswer?
    /// The inline "Are you sure?" for a destructive action, until Enter again or Escape.
    @Published public var confirming: (item: ResultItem, action: ResultAction)?
    /// The agent, project or thread picked with `@`: a chip before the box, where Enter sends.
    @Published public var target: VyreCandidate? {
        didSet {
            // The outer chip stays only while `target` is its child; any other change (nil, an
            // agent, another app) makes the chip one level again, so the two never disagree.
            if let p = targetParent, target.map({ $0.id.hasPrefix(Self.childID(p.id, "")) }) != true { targetParent = nil }
            if target != oldValue { extensionBoxChanged?(); targetChanged(); search() }
        }
    }
    /// The outer chip when `target` was picked inside it: WhatsApp for "WhatsApp › juno". Set
    /// before `target`, so the search that follows sees both. Nil for a one-level chip.
    @Published public internal(set) var targetParent: VyreCandidate?
    public internal(set) var catalog = VyreCatalog.empty
    /// What extensions add (ExtensionHost.load): rows, named commands, and side panels.
    var extensionProviders: [ResultProvider] = []
    var extensionCommands: [CapsuleCommand] = []
    var panelFor: ((ResultItem?) -> AnyView?)?
    /// Extension `@` targets for the words (inside a nesting chip when one is given), their slower
    /// second answer, the pick, and the send to one with its chip (ExtensionHost).
    var extensionMentions: ((String, VyreCandidate?) -> [ExtensionMention])?
    var extensionRefreshers: ((String, VyreCandidate?) -> [@MainActor () async -> (String, [ExtensionMention])?])?
    var extensionPicked: ((VyreCandidate, VyreCandidate?) -> Void)?
    /// The words or the chip changed: extensions forget a preview waiting for a second Enter.
    var extensionBoxChanged: (() -> Void)?
    var sendToExtension: ((String, VyreCandidate, VyreCandidate?, Query) async -> ActionOutcome)?
    private var appTargets: [String: MentionTarget] = [:]
    /// Rows a refreshMentions brought, per extension, for one `@` query (`key`). Used while the box
    /// still says those words; forgotten on the next different words.
    private var refreshed: (key: String, rows: [String: [ExtensionMention]])?
    private var mentionRefresh: Task<Void, Never>?
    /// Between willShow and didHide. Nothing slow is asked for `@` outside it.
    private(set) var shown = false

    /// A child target's id under its chip's: joined with NUL, which no label or id carries, so no
    /// pair of ids can make the same child id ("a:b" + "c" and "a" + "b:c" stay apart).
    nonisolated static func childID(_ parent: String, _ child: String) -> String { parent + "\u{0}" + child }

    /// Chips for what extensions attach to this send ("sees: Safari · Northwind Bakery"), and the ones the user
    /// removed for it.
    @Published var attachments: [SendAttachment] = []
    private var removedAttachments = Set<String>()
    var attachers: [SendAttaching] = []
    var attachTask: Task<Void, Never>?
    /// The memory line's sources, shown (a click or ⌘→) or folded.
    @Published var memoryExpanded = false
    /// A human-only call waiting for the person to prove they are here (Presence.swift).
    @Published var presenceAsk: PresenceAsk?
    /// "Add your Deepgram key": a module's missing key, asked for in the panel (Credentials.swift).
    @Published var credentialAsk: CredentialAsk?
    /// `vyre ...` run from the box, and what it said (CommandRun.swift).
    @Published var commandRun: CommandRun?
    /// The CLI to run instead of vyred's own (tests: a fake vyre).
    var cliOverride: [String]?
    /// Bumped when an extension shows or hides its panel, so the view draws it again.
    @Published var panelTick = 0

    public var front: FrontApp?
    public let icons = IconCache()
    let providers: [ResultProvider]
    let frecency: Frecency
    let vyred: VyredClient
    let home: String
    /// The threads the Capsule holds, released and stopped on hide (Agent/AgentKeeper.swift).
    lazy var keeper = Keeper(vyred: vyred)
    /// The conversation with the agent in the chip (Agent/AgentDirect.swift).
    public lazy var direct: Direct = {
        let d = Direct(vyred: vyred)
        d.changed = { [weak self] in self?.objectWillChange.send() }
        d.projectName = { [weak self] s in self?.catalog.projectName(s) ?? s }
        d.onError = { [weak self] why in self?.line = why }
        return d
    }()
    /// ⌘K: the highlighted row's verbs (Agent/AgentWiring.swift).
    lazy var actionMenu: ActionMenu = { let a = ActionMenu(); a.changed = { [weak self] in self?.objectWillChange.send() }; return a }()
    /// Each agent's threads, for where @agent sends (Agent/AgentDestinations.swift).
    lazy var routes = RouteCache()
    /// What waits on the user and the card that answers it (Agent/AgentDesk.swift).
    public lazy var desk: Desk = {
        let d = Desk(vyred: vyred)
        d.changed = { [weak self] in self?.objectWillChange.send() }
        d.who = { [weak self] t in self?.catalog.who(t) }
        d.projectName = { [weak self] s in self?.catalog.projectName(s) ?? s }
        return d
    }()
    var token = 0
    private var partial: [String: [ResultItem]] = [:]
    var replySub: VyredSubscription?
    var recallTask: Task<Void, Never>?
    /// Slow providers whose rows are still from the previous keystroke.
    private var stale = Set<String>()
    private var staleTimer: Timer?
    /// Asked to close the panel (an action finished with .close).
    public var onClose: ((String?) -> Void)?
    /// Whether the panel is on screen (a reply that finishes while it is not gets a banner).
    var isShown: () -> Bool = { false }
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
        shown = true
        (providers + extensionProviders).forEach { $0.warm() }
        keeper.shown()
        vyred.follower.setShown(true)
        if !vyred.follower.started { vyred.follower.start() }
        Task { @MainActor [vyred] in
            _ = await vyred.refreshTools()
            guard vyred.isUp else { return }
            self.catalog = await CatalogLoader.load(vyred)
            if self.mentionQuery != nil { self.search() }
            self.targetChanged()
            await self.loadBox()
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
        attachTask?.cancel(); attachments = []; removedAttachments = []
        // A live command ends with the Capsule; what it said stays for the next show.
        if commandRun?.running == true { commandRun?.stop() }
        keeper.hidden(busy: reply.flatMap { $0.finished ? nil : $0.thread })
        desk.hidden()
        direct.close()
        actionMenu.close()
        token += 1
        shown = false
        cancelMentionRefresh()
        sessionSearch?.cancel(); sessionSearch = nil
        confirming = nil
    }

    /// A fresh open starts with an empty box, unless a reply is still streaming.
    public func reset() {
        if let r = reply, !r.finished { return }
        followUp = false; autoKey = nil; autoTask?.cancel(); convo = []
        text = ""; groups = []; selected = 0; line = nil; reply = nil; asked = nil; memory = nil; askedMemory = nil; targetParent = nil; target = nil
        cancelMentionRefresh()
        replySub?.cancel(); replySub = nil
    }

    // MARK: searching

    // MARK: attachments

    func refreshAttachments(_ words: String, to kind: SendTargetKind) {
        attachTask?.cancel()
        let w = words.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !attachers.isEmpty, !w.isEmpty else { if !attachments.isEmpty { attachments = [] }; return }
        let t = token
        attachTask = Task { @MainActor in
            var got: [SendAttachment] = []
            for a in self.attachers {
                if let x = await a.attachment(for: w, to: kind), !self.removedAttachments.contains(x.id) { got.append(x) }
            }
            guard !Task.isCancelled, t == self.token else { return }
            if got != self.attachments { self.attachments = got }
        }
    }

    /// Take a chip off this send (its x, or ⌘⌫). It stays off until the Capsule closes.
    func removeAttachment(_ id: String? = nil) {
        guard let x = id.flatMap({ i in attachments.first { $0.id == i } }) ?? attachments.last else { return }
        removedAttachments.insert(x.id)
        attachments.removeAll { $0.id == x.id }
    }

    /// The words with every chip still on screen appended, as they go.
    func withAttachments(_ words: String) -> String {
        attachments.isEmpty ? words : ([words] + attachments.map(\.body)).joined(separator: "\n\n")
    }

    /// Show "Confirm it's you" and wait for Touch ID (or the Mac's password), or a cancel.
    func askPresence(_ a: PresenceAsk) async -> Bool {
        presenceAsk?.done?(false)
        presenceAsk = a
        // The view starts the evaluation once Touch ID's glyph is on screen (PresenceView), so
        // macOS draws the prompt in the panel rather than as a dialog.
        let ok: Bool = await withCheckedContinuation { k in
            var once = false
            a.done = { v in if !once { once = true; k.resume(returning: v) } }
        }
        if presenceAsk === a { presenceAsk = nil }
        return ok
    }

    /// Esc while "Confirm it's you" shows.
    func cancelPresence() {
        guard let a = presenceAsk else { return }
        a.context.invalidate()
        a.done?(false)
        presenceAsk = nil
        line = "Not approved. Nothing was done."
    }

    /// A passing status with no row of its own ("Copied", "Taken back"): one line above the
    /// footer for 2 s (capsule.md rule 3), unless something else was said meanwhile.
    func flash(_ s: String, for seconds: Double = 2) {
        line = s
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in
            MainActor.assumeIsolated { if self?.line == s { self?.line = nil } }
        }
    }

    /// Search again for the same words (an extension's commands changed).
    func refresh() { search() }

    func search() {
        token += 1
        let t = token
        line = nil
        confirming = nil
        // Rows of slow providers stay until replaced; the instant ones are recomputed below.
        partial["calc"] = nil; partial["commands"] = nil; partial["ext-commands"] = nil
        let q = Query(text, front: front)
        // `@` being typed: the list is what it can name, nothing else, and memory stays quiet.
        // Inside a nesting chip it is only what that chip holds (mentionQuery says when).
        if let m = mentionQuery {
            recallTask?.cancel(); memory = nil
            if refreshed?.key != mentionKey(m) { refreshed = nil }
            listMentions(m, keep: false)
            if nestingChip == nil { searchSessions(m, token: t) }
            refreshMentions(m, token: t)
            return
        }
        cancelMentionRefresh()
        // The follow-up box: its words go to the answer's thread on ⏎; nothing is searched.
        if followUp && target == nil {
            autoTask?.cancel(); recallTask?.cancel(); memory = nil
            partial = [:]; groups = []; selected = 0
            return
        }
        if let c = target {
            recallTask?.cancel(); memory = nil
            groups = q.normalized.isEmpty ? [] : [Group(section: .vyre, items: askItems(q))]
            selected = 0
            if c.kind == .app { attachments = [] } else { refreshAttachments(q.text, to: c.kind == .agent ? .agent : c.kind == .project ? .project : .thread) }
            return
        }
        // A vyre command comes before anything else: one row, and nothing is asked about it.
        if let argv = CLIRun.parse(q.text) {
            autoTask?.cancel(); recallTask?.cancel(); memory = nil; attachments = []
            partial = [:]
            groups = [Group(section: .top, items: [commandRunItem(argv)])]
            selected = 0
            return
        }
        if commandRun?.running == false { commandRun = nil }
        refreshAttachments(q.text, to: .ask)
        recall(q.text, token: t)
        if q.normalized.isEmpty { autoTask?.cancel(); if autoKey != nil { dropAuto() }; partial = [:]; groups = []; selected = 0; return }
        if let c = calcResult(q) { partial["calc"] = [withCopy(c)] }
        partial["commands"] = SystemCommands.match(q.normalized).prefix(3).map { commandItem($0.command, score: $0.score) }
        partial["ext-commands"] = extensionCommands.compactMap { c in
            let s = Match.score(q.normalized, c.title, synonyms: c.keywords)
            guard s >= 0.5 else { return nil }
            return ResultItem(id: "ext:" + c.id, kind: "command", title: c.title, subtitle: c.subtitle, icon: c.icon,
                              section: .commands, score: s, actions: c.actions)
        }
        // Quick providers answer in this frame. The rest keep their rows from the last key until
        // their new ones land (or 300 ms pass), so nothing blinks out and back while typing.
        for p in providers + extensionProviders {
            if let now = p as? ImmediateResults { partial[p.id] = now.resultsNow(for: q) }
        }
        publish()
        for p in providers + extensionProviders where !(p is ImmediateResults) {
            Task { @MainActor in
                let rows = await p.results(for: q)
                guard t == self.token else { return }
                self.partial[p.id] = rows
                self.stale.remove(p.id)
                self.publish()
            }
        }
        let pending = Set((providers + extensionProviders).filter { !($0 is ImmediateResults) }.map(\.id))
        stale = pending
        scheduleAuto(q, token: t)
        staleTimer?.invalidate()
        staleTimer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, t == self.token, !self.stale.isEmpty else { return }
                for id in self.stale { self.partial[id] = nil }
                self.stale = []
                self.publish()
            }
        }
    }

    func publish() {
        let q = Query(text, front: front)
        var all = partial.values.flatMap { $0 }
        let canSend = vyred.has("files.send")
        for i in all.indices {
            all[i].score += frecency.boost(all[i].id, query: q.normalized)
            if canSend, all[i].kind == "file", let url = all[i].fileURL, !all[i].actions.contains(where: { $0.id == "send-box" }) {
                all[i].actions.append(sendToBox(url))
            }
        }
        all.sort { $0.score > $1.score }
        let best = all.first { $0.section != .answer }
        var out: [Group] = []
        if let top = all.first, top.score >= 0.6, top.section != .answer {
            out.append(Group(section: .top, items: [top]))
            all.removeFirst()
        }
        var by: [Section: [ResultItem]] = [:]
        for r in all { by[r.section, default: []].append(r) }
        for s in Self.groupOrder {
            if let rows = by[s], !rows.isEmpty { out.append(Group(section: s, items: Array(rows.prefix(s == .files ? 6 : 4)))) }
        }
        // Answers (calc) sit first: they are what the user typed, worked out.
        if let i = out.firstIndex(where: { $0.section == .answer }), i != 0 { out.insert(out.remove(at: i), at: 0) }
        // Where the words go (Agent/AgentDestinations.swift): first for a question nothing here answers,
        // or with a chip or an answer on screen; last otherwise.
        var asks = Group(section: .vyre, items: askItems(q))
        // One Vyre group: rows from Vyre's own providers (Glass, watch) join the destinations.
        if let i = out.firstIndex(where: { $0.section == .vyre }) { asks.items += out.remove(at: i).items }
        if asksFirst(q, top: best) { out.insert(asks, at: out.first?.section == .answer ? 1 : 0) } else { out.append(asks) }
        let keep = current?.id
        groups = out
        if let keep, let i = flat.firstIndex(where: { $0.id == keep }) { selected = i } else { selected = 0 }
        // An answer at the top is what ⏎ acts on until the user moves into the results.
        if answerOnTop && !userMoved { selected = -1 }
    }

    /// The order groups draw in (docs/design/system/capsule.md, "Search"): after the top hit and
    /// the worked-out answers, Vyre's own, Files, Apps, Commands, then every other section (the
    /// extensions' and providers') in the order Kit lists them. Only the draw order changes: the
    /// Section cases and their names are the Kit contract and stay as they are. Where the words go
    /// (the ask rows, AgentDestinations.swift) keeps its own place, first or last, below.
    nonisolated static let groupOrder: [Section] = {
        let lead: [Section] = [.answer, .vyre, .files, .documents, .apps, .commands]
        return lead + Section.allCases.filter { $0 != .top && !lead.contains($0) }
    }()

    /// Taildrop a file to the paired box (files.send). vyred's guard decides whether it may
    /// leave (secrets and dotfiles are refused), and its words are shown as they are.
    func sendToBox(_ url: URL) -> ResultAction {
        ResultAction(id: "send-box", title: "Send to box", symbol: "paperplane", shortcut: KeyShortcut("s", command: true)) { [vyred] _, _ in
            let r = await vyred.call("files.send", ["path": url.path], timeout: 120)
            if let d = r.data as? [String: Any], let sent = VJ.nonEmpty(d["sent"]) {
                return .said("Sent \(sent) to \(VJ.nonEmpty(d["to"]) ?? "your box"). It is in the box's inbox.")
            }
            return .failed("Could not send it: \(Bridge.explain(r) ?? "nothing came back").")
        }
    }

    func commandItem(_ c: SystemCommand, score: Double) -> ResultItem {
        var r = systemCommandResult(c, score: score)
        r.actions = [ResultAction(id: "run", title: c.title, symbol: c.symbol, confirm: c.dangerous) { _, _ in
            await SystemCommandRunner.run(c)
        }]
        return r
    }

    // MARK: @ names

    /// What follows a leading `@`, spaces and all ("@computer use settings"), or an `@` being
    /// typed mid-text; nil when no `@` is being typed or a destination is already picked. The one
    /// exception is a one-level chip that nests (an app): an `@` after it names what is inside.
    var mentionQuery: String? {
        guard target == nil || nestingChip != nil else { return nil }
        if text.hasPrefix("@") { return String(text.dropFirst()) }
        return Route.mention(text).completing
    }

    /// The chip, when it is an extension's target that holds others and nothing is picked inside
    /// it yet. A second `@` then asks only its extension.
    var nestingChip: VyreCandidate? {
        guard let c = target, targetParent == nil, c.kind == .app, appTargets[c.id]?.nests == true else { return nil }
        return c
    }

    /// The icon an extension gave its target (the chip draws it), or nil for Vyre's own.
    func mentionIcon(_ c: VyreCandidate) -> IconSpec? { c.kind == .app ? appTargets[c.id]?.icon : nil }

    /// The `@` list for the words: the rows, then a line when there are none. `keep` holds the
    /// selected row when the list is drawn again for the same words (a refresh landed).
    func listMentions(_ m: String, keep: Bool) {
        let was = keep ? current?.id : nil
        let (found, _) = mentionCandidates(m)
        let rows = found.map(candidateItem)
        groups = rows.isEmpty ? [] : [Group(section: .vyre, items: rows)]
        selected = was.flatMap { id in flat.firstIndex { $0.id == id } } ?? 0
        if !rows.isEmpty { line = nil }
        else if let chip = nestingChip { line = "Nothing called that in \(chip.label)." }
        else { line = vyred.isUp ? "Nothing called that in Vyre yet." : "vyred is not running. Start it with vyre up." }
    }

    /// Candidates for the `@` words, and the words left over as the message. The whole text is
    /// tried first; then fewer words, so "@juno rebuild the menu" finds juno with a message.
    func mentionCandidates(_ q: String) -> ([VyreCandidate], String) {
        let all = named(q)
        if !all.isEmpty || !q.contains(" ") { return (liveFirst(all), "") }
        let words = q.split(separator: " ", omittingEmptySubsequences: true)
        for n in stride(from: words.count - 1, through: 1, by: -1) {
            let sub = words[0..<n].joined(separator: " ")
            let found = named(sub)
            if !found.isEmpty { return (liveFirst(found), words[n...].joined(separator: " ")) }
        }
        return ([], "")
    }

    /// Everything the words can name: Vyre's own and the extensions', or inside a nesting chip
    /// only what its extension holds.
    private func named(_ q: String) -> [VyreCandidate] {
        nestingChip == nil ? withApps(Route.complete(q, catalog), q) : withApps([], q)
    }

    /// Vyre's own candidates, then what extensions name for the same words (apps come after
    /// agents, projects and sessions, and never push them out of the list). An extension whose
    /// refreshMentions answered for these same words shows that answer instead of its first one.
    func withApps(_ found: [VyreCandidate], _ q: String) -> [VyreCandidate] {
        let parent = nestingChip
        guard var ext = extensionMentions?(q, parent) else { return found }
        if let r = refreshed, r.key == mentionKey(q) {
            var order: [String] = []
            for e in ext.map(\.ext) + r.rows.keys.sorted() where !order.contains(e) { order.append(e) }
            ext = order.flatMap { e in r.rows[e] ?? ext.filter { $0.ext == e } }
        }
        if ext.isEmpty { return found }
        for x in ext { appTargets[x.candidate.id] = x.target }
        return found + ext.map(\.candidate).prefix(max(0, 9 - found.count))
    }

    /// Which `@` question the words are: the same words inside another chip are another question.
    private func mentionKey(_ q: String) -> String { (nestingChip?.id ?? "") + "\u{0}" + q }

    /// Ask the extensions again, slower, once the typing pauses (about 120 ms): refreshMentions.
    /// Only while shown, and only extensions that said they have a second answer; they run side by
    /// side and each answer is applied as it lands, if the words, the chip and the search are
    /// still the ones it was asked for. The next keystroke and hide cancel it. Never repeated
    /// unless the user types.
    func refreshMentions(_ m: String, token t: Int) {
        cancelMentionRefresh(forget: false)
        guard shown, let calls = extensionRefreshers?(m, nestingChip), !calls.isEmpty else { return }
        let key = mentionKey(m)
        mentionRefresh = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 120_000_000)
            if Task.isCancelled { return }
            await withTaskGroup(of: Void.self) { g in
                for call in calls {
                    g.addTask { @MainActor [weak self] in
                        let got = await call()
                        // Re-bound after the wait: the model may have gone, or moved on.
                        guard let self, let (ext, rows) = got, !Task.isCancelled, self.shown, t == self.token,
                              self.mentionQuery == m, self.mentionKey(m) == key else { return }
                        var now = self.refreshed?.key == key ? self.refreshed!.rows : [:]
                        now[ext] = rows
                        self.refreshed = (key, now)
                        self.listMentions(m, keep: true)
                    }
                }
            }
        }
    }

    /// A refresh is waiting or in flight (for tests: none is made when no extension has one).
    var refreshScheduled: Bool { mentionRefresh != nil }

    /// Stop a refresh waiting or in flight; `forget` also drops the rows an earlier one brought.
    func cancelMentionRefresh(forget: Bool = true) {
        mentionRefresh?.cancel(); mentionRefresh = nil
        if forget { refreshed = nil }
    }

    /// A session active in the last 15 minutes that vyred does not run is live in a terminal.
    func isLive(_ c: VyreCandidate) -> Bool {
        guard c.kind == .thread, let t = catalog.thread(c.id), t.agent == nil, let last = t.last else { return false }
        return vyNowMs() - last < 15 * 60_000
    }

    func liveFirst(_ list: [VyreCandidate]) -> [VyreCandidate] {
        list.enumerated().sorted { a, b in
            let la = isLive(a.element), lb = isLive(b.element)
            return la != lb ? la : a.offset < b.offset
        }.map(\.element)
    }

    private var sessionSearch: Task<Void, Never>?

    /// Ask vyred for sessions by name as well (projects.catalog q), for the ones older than the
    /// recent list read on show. Merged into the catalog; the list redraws if still on the words.
    func searchSessions(_ q: String, token t: Int) {
        sessionSearch?.cancel()
        let words = q.trimmingCharacters(in: .whitespaces)
        guard shown, words.count >= 2, vyred.isUp else { return }
        sessionSearch = Task { @MainActor [vyred] in
            try? await Task.sleep(nanoseconds: 120_000_000)
            if Task.isCancelled || t != self.token { return }
            let r = await vyred.call("projects.catalog", ["q": words, "limit": 10, "human": true], presence: false)
            guard t == self.token, let rows = (r.data as? [String: Any])?["sessions"] as? [[String: Any]] else { return }
            let known = Set(self.catalog.threads.map(\.id))
            let add = rows.compactMap { x -> VyreThread? in
                let id = VJ.s(x["id"])
                guard !id.isEmpty, !known.contains(id) else { return nil }
                return VyreThread(id: id, label: VJ.nonEmpty(x["label"]) ?? VJ.nonEmpty(x["name"]) ?? VJ.nonEmpty(x["title"]) ?? String(id.prefix(8)),
                                  cwd: VJ.str(x["cwd"]), last: VJ.num(x["last"]))
            }
            if add.isEmpty { return }
            self.catalog.threads += add
            self.search()
        }
    }

    func candidateItem(_ c: VyreCandidate) -> ResultItem {
        let symbol = c.kind == .agent ? "person.crop.circle" : c.kind == .project ? "folder" : "text.bubble"
        let sub = isLive(c) ? (c.sub.isEmpty ? "live in terminal" : "live in terminal · " + c.sub) : c.sub
        let icon: IconSpec = c.kind == .app ? (appTargets[c.id]?.icon ?? .symbol("app")) : .symbol(symbol, isLive(c) ? .signal : .bone)
        return ResultItem(id: "at:\(c.kind.rawValue):\(c.id)", kind: "mention", title: c.label, subtitle: sub, icon: icon,
                          section: .vyre, score: 1, actions: [ResultAction(id: "pick", title: "Pick", symbol: "at") { [weak self] _, _ in
                              await self?.pick(c) ?? .failed("The Capsule closed.")
                          }])
    }

    /// The `@` row was picked: it becomes the chip, and the `@...` leaves the box. Picked inside a
    /// nesting chip, it is the chip's child ("WhatsApp › juno"). An extension hears of its pick.
    func pick(_ c: VyreCandidate) -> ActionOutcome {
        let parent = nestingChip
        var rest: String
        if text.hasPrefix("@") {
            // The words after the name, if the name was only the first words ("@juno rebuild ...").
            let (_, left) = mentionCandidates(String(text.dropFirst()))
            rest = left
        } else {
            let m = Route.mention(text)
            var chars = Array(text)
            if m.start >= 0 { chars.removeSubrange(m.start..<m.end) }
            rest = String(chars)
        }
        if c.kind == .app { extensionPicked?(c, parent) }
        targetParent = parent
        target = c
        return .replaceQuery(rest.trimmingCharacters(in: .whitespaces))
    }

    /// Delete on an empty box: the child of a two-level chip goes first, then the chip.
    func dropChip() {
        if let p = targetParent { targetParent = nil; target = p } else { target = nil }
    }

    /// The one row for an extension's @ target: "Send to Notes", through the extension. A child
    /// target ("WhatsApp › juno") sends through its chip's extension.
    func appSendItem(_ q: Query, _ c: VyreCandidate) -> ResultItem {
        let words = q.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let p = targetParent
        let via = appTargets[c.id]?.sendsTo ?? p.flatMap { appTargets[$0.id]?.sendsTo } ?? c.label
        return ResultItem(id: "send:\(c.id)", kind: "ask", title: "Send to \(c.label)", subtitle: words, icon: appTargets[c.id]?.icon ?? .mark,
                          section: .vyre, score: 0,
                          actions: [ResultAction(id: "send", title: "Send", symbol: "paperplane") { [weak self] _, _ in
                              await self?.send(words, to: c, in: p) ?? .failed("The Capsule closed.")
                          }], sendsTo: via)
    }

    // MARK: moving and picking

    public func move(_ by: Int) {
        let n = flat.count
        confirming = nil
        // Above the first row is the answer at the top.
        if answerOnTop && (selected == 0 && by < 0 || n == 0) { selected = -1; userMoved = false; return }
        guard n > 0 else { return }
        selected = selected < 0 ? 0 : (selected + by + n) % n
        userMoved = true
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
        flash("Copied")
        return true
    }

    // MARK: who answers

    /// The assistant's name from onboarding (agents.list, kind assistant), else "Vyre". Never a
    /// model's brand: the model is small metadata beside it.
    public var assistantName: String { catalog.assistant?.name ?? "Vyre" }

    /// Who the reply on screen is from: the session or agent it went to, else the assistant.
    public var replyWho: String {
        if let q = reply?.queued { return q.name }
        if let c = target, c.kind != .app { return c.label }
        return assistantName
    }

    /// An answer is on screen and the only rows are where the next words would go: the answer
    /// takes the whole area, and Enter follows up.
    public var answerAlone: Bool {
        asked != nil && reply != nil && groups.allSatisfy { $0.items.allSatisfy { $0.kind == "ask" } }
    }

    // MARK: memory

    /// Whether the memory box sits above the results: it has something, and the words read as a
    /// question or nothing on this Mac matches them well.
    public var showsMemory: Bool {
        // One confident answer or nothing: a wall of loosely matching quotes is not shown.
        guard asked == nil, let m = memory, m.answer != nil, m.text == text.trimmingCharacters(in: .whitespacesAndNewlines) else { return false }
        return Route.asksQuestion(m.text) || !(flat.contains { $0.score >= 0.6 && $0.kind != "ask" })
    }

    /// Memory first: what memory.answer says about the words, a moment after typing stops, and
    /// only while vyred is up. It is the one source of personal facts here; with no memory.answer
    /// on this vyred there is no memory box at all. An answer for older words is dropped.
    func recall(_ raw: String, token t: Int) {
        recallTask?.cancel()
        let words = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if memory?.text != words { memory = nil }
        guard words.count >= 3, vyred.isUp, vyred.has("memory.answer") else { return }
        recallTask = Task { @MainActor [vyred] in
            try? await Task.sleep(nanoseconds: 180_000_000)
            if Task.isCancelled || t != self.token { return }
            let t0 = vyNowMs()
            let r = await vyred.call("memory.answer", ["q": words], presence: false)
            if Task.isCancelled || t != self.token { return }
            guard r.error == nil else { return }
            var m = Memo.fromAnswer(text: words, r.data)
            m.ms = max(1, vyNowMs() - t0)
            if m != self.memory { self.memoryExpanded = false }
            self.memory = m.isEmpty ? nil : m
        }
    }

    // MARK: asking

    func ask(_ words: String, model: String = "haiku", context: String? = nil, computerUse: Bool = false) async -> ActionOutcome {
        guard !words.isEmpty else { return .said("Type a question first.") }
        // Vyre IQ (IQAsk.swift): a plain quick question is memory.ask's, grounded or "Not sure yet."
        if !computerUse, context == nil, model == "haiku", let out = await askIQ(words) { return out }
        let dir = URL(fileURLWithPath: home).appendingPathComponent("capsule/ask")
        do { try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) } catch {
            return .failed("Could not make the Capsule's folder: \(error.localizedDescription)")
        }
        asked = words
        // What memory showed for these same words goes with the question, and only that.
        askedMemory = memory?.text == words && !(memory?.isEmpty ?? true) ? memory : nil
        // The prompt stays the user's words (capsule-now rule 1); what a chip attaches goes with
        // the instructions, after memory.
        let append = ([context, Memo.append(askedMemory)].compactMap { $0 } + attachments.map(\.body)).filter { !$0.isEmpty }.joined(separator: "\n\n")
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
        let name = (computerUse ? "Capsule, doing: " : "Capsule: ") + String(words.split(whereSeparator: \.isWhitespace).joined(separator: " ").prefix(40))
        doing = computerUse
        // Computer use is a full session: the Vyre plugin brings hands.* and screen.*, the floor
        // and the Gate. A question is a lean one on the fast model.
        let input: [String: Any] = computerUse
            ? ["prompt": words, "append": ([Self.computerUseBrief, append].filter { !$0.isEmpty }).joined(separator: "\n\n"), "purpose": "agent",
               "cwd": dir.path, "surface": "capsule", "name": name]
            : ["prompt": words, "append": append, "lean": true, "model": model, "purpose": "capsule", "cwd": dir.path, "surface": "capsule", "name": name]
        let r = await vyred.call("threads.start", input, presence: false)
        pending = false
        if let why = Bridge.explain(r) { asked = nil; replySub?.cancel(); replySub = nil; return .failed(why) }
        guard let d = r.data as? [String: Any], let id = d["id"].map({ "\($0)" }) else { asked = nil; return .failed("vyred did not say which thread it started.") }
        thread = id
        keeper.startedQuick(id)
        var rep = VyState.reply(id)
        rep.model = computerUse ? nil : model
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

    /// `parent` is the outer chip of a two-level one (only extensions' targets have one).
    func send(_ words: String, to c: VyreCandidate, in parent: VyreCandidate? = nil, model: String? = nil) async -> ActionOutcome {
        guard !words.isEmpty else { return .said("Type what to send first.") }
        asked = words
        askedMemory = nil
        pending = true
        switch c.kind {
        case .app:
            // An extension's target: it does the sending and says what happened. No reply view.
            asked = nil; pending = false
            guard let send = sendToExtension else { return .failed("\(c.label) is not there any more.") }
            return await send(words, c, parent, Query(words, front: front))
        case .thread:
            reply = VyState.reply(c.id)
            reply?.model = model
            follow { c.id }
            let r = await vyred.call("threads.send", ["thread": c.id, "text": withAttachments(words), "surface": "capsule"], presence: false)
            pending = false
            if let why = Bridge.explain(r) { reply = nil; asked = nil; return .failed(why) }
            let d = (r.data as? [String: Any]) ?? [:]
            // capsule-now rule 5: busy in a terminal, the words wait for its turn to end.
            if VJ.truthy(d["queued"]) {
                let name = VJ.nonEmpty(d["name"]) ?? c.label
                reply?.queued = QueuedSend(name: name, note: VJ.nonEmpty(d["note"]), id: (d["queued_id"] as? NSNumber)?.intValue)
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
            let r = await vyred.call("agents.ask", ["agent": c.id, "text": withAttachments(words), "surface": "capsule", "wait": false], presence: false)
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
            let r = await vyred.call("threads.start", ["project": c.id, "prompt": withAttachments(words), "surface": "capsule"], presence: false)
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
        // Computer use: every hand stops now, whatever the turn is doing.
        if doing, vyred.has("hands.stop") { Task { [vyred] in _ = await vyred.call("hands.stop", [:], presence: false) } }
        stopSpeaking()
        // capsule-now rule 8: words still queued for a terminal session are taken back; once
        // handed over there is no interrupt path into it, so the Capsule stops following only.
        if let q = r.queued, VyState.replyText(r).isEmpty {
            if !q.delivered { Task { @MainActor in await takeBack(r, q) }; return }
            reply = VyState.cancel(r)
            line = "Stopped following. \(q.name) already has your message; its reply lands in its thread."
            return
        }
        reply = VyState.cancel(r)
        if r.thread.isEmpty { return }
        // A Vyre-owned session (ADR 0030): interrupt the running turn and keep the session, so a
        // follow-up resumes it. An older switchboard has only threads.stop, which takes {thread}.
        if vyred.has("threads.interrupt") {
            Task { [vyred] in _ = await vyred.call("threads.interrupt", ["thread": r.thread], presence: false) }
            return
        }
        keeper.stop(r.thread)
    }
}

extension CapsuleModel {
    /// threads.unqueue for words not handed over yet. Empty means the Harness handed them over
    /// between the key and the call: say so once, and the next Esc stops following.
    func takeBack(_ r: Reply, _ q: QueuedSend) async {
        var input: [String: Any] = ["thread": r.thread, "surface": "capsule"]
        if let id = q.id { input["queued"] = id }
        let u = await vyred.call("threads.unqueue", input, presence: false)
        if let why = Bridge.explain(u) { line = "Could not take it back: \(why)"; return }
        let ids = ((u.data as? [String: Any])?["unqueued"] as? [Any]) ?? []
        guard reply?.thread == r.thread else { return }
        if !ids.isEmpty {
            if var x = reply { x = VyState.cancel(x); x.queued?.withdrawn = true; reply = x }
            flash("Taken back. \(q.name) never got it.")
        } else {
            reply?.queued?.delivered = true
            line = "Too late: \(q.name) already has it. Its reply shows here when its turn ends."
        }
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
