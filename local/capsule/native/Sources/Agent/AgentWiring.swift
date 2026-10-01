// Wiring: the providers that were built and tested but not in the running Capsule, put in, and
// the watches that turn a finished thread into a notification.
//
//   clipboard   ClipStore (<home>/capsule/clips.json, 0600) and ClipWatcher. The watcher is the
//               one thing that runs while the Capsule is hidden, as in the Electron Capsule: a
//               750 ms changeCount check, which reads the pasteboard only when it moved.
//   contacts    ContactsProvider; macOS is asked once, from its "Show contacts here" row, and only
//               when dialogs are allowed.
//   modules     ModuleProviders: rows and verbs from each module's shows.capsule (vault fill steps
//               aside for the front app; a one-time code is said with its seconds left).
//   glass       "Open Glass · <agent>" for an agent with a computer, when a box is paired.
//   watch       "watch the intake thread" and "tell the site thread to run the tests": watch a
//               thread (threads.watch, and a local filter), or send to it and then watch.
//
// A watched thread's report becomes a notification while the Capsule is hidden, and a line while
// it is shown.

import AppKit
import Combine
import Contacts
import Foundation

@MainActor
final class AgentWiring {
    let home: String
    let vyred: VyredClient
    let clips: ClipStore
    let clipWatcher: ClipWatcher
    let watches: Watches
    weak var model: CapsuleModel?
    private var subs: [VyredSubscription] = []
    /// capsule.requested {action: show|hide|toggle}: vyred's capsule.show, from the CLI, the
    /// assistant or a phone. The app opens or closes the panel.
    var requested: ((String) -> Void)?

    init(home: String, vyred: VyredClient) {
        self.home = home
        self.vyred = vyred
        let dir = URL(fileURLWithPath: home).appendingPathComponent("capsule")
        clips = ClipStore(file: dir.appendingPathComponent("clips.json"))
        clipWatcher = ClipWatcher(store: clips)
        watches = Watches(file: dir.appendingPathComponent("watches.json"))
    }

    /// The providers the app adds to its own.
    var providers: [ResultProvider] {
        [ClipboardProvider(store: clips, watcher: clipWatcher),
         ContactsProvider(requestAccess: {
             guard dialogsAllowed() else { return false }
             return (try? await CNContactStore().requestAccess(for: .contacts)) ?? false
         }),
         ModuleProviders(link: vyred),
         AgentRows(wiring: self)]
    }

    /// Once the model exists: start the clipboard watcher and follow watched threads.
    func attach(_ m: CapsuleModel) {
        model = m
        if dialogsAllowed() { clipWatcher.start() }
        subs = ["thread.*", "ask.raised"].map { p in vyred.on(p) { [weak self] e in self?.heard(e) } }
        subs.append(vyred.on("capsule.requested") { [weak self] e in self?.requested?(VJ.nonEmpty(e.payload["action"]) ?? "show") })
    }

    func heard(_ e: VyredEvent) {
        guard let r = watches.onEvent(e) else { return }
        let n = Watches.notice(r)
        if let m = model, m.vyred.follower.shown { m.line = "\(n.title). \(n.body)"; watches.read(r.id) }
        else { Notifier.shared.post(title: n.title, body: n.body) }
    }

    // MARK: watch and drive

    /// The thread the words name: the best label match over the catalog's threads, at 0.5 or better.
    func thread(named words: String) -> VyreThread? {
        guard let m = model else { return nil }
        var best: (VyreThread, Double)?
        for t in m.catalog.threads where !t.label.isEmpty {
            let s = Match.score(words.lowercased(), t.label)
            if s >= 0.5, s > (best?.1 ?? 0) { best = (t, s) }
        }
        return best?.0
    }

    /// Watch a thread: the switchboard's watch when it has one (it fires even with the Capsule
    /// closed), and the local filter either way.
    func watch(_ t: VyreThread) async -> ActionOutcome {
        var server: String?
        if vyred.has("threads.watch") {
            let r = await vyred.call("threads.watch", ["thread": t.id, "until": "either", "notify": "capsule", "note": t.label], presence: false)
            server = (r.data as? [String: Any]).flatMap { VJ.nonEmpty($0["watch"]) ?? VJ.nonEmpty($0["id"]) }
        }
        watches.add(t.id, label: t.label, server: server)
        return .said("Watching \(t.label). A notification says when it is done or asks.")
    }

    /// Send words to a thread as the user, then watch it.
    func drive(_ t: VyreThread, _ words: String) async -> ActionOutcome {
        let r = await vyred.call("threads.send", ["thread": t.id, "text": words, "surface": "capsule"], presence: false)
        if let why = Bridge.explain(r) { return .failed(why) }
        let d = (r.data as? [String: Any]) ?? [:]
        if VJ.bool(d["sent"]) == false, !VJ.truthy(d["queued"]) {
            if let h = VJ.nonEmpty(d["holder"]) { return .failed("\(h) has the keyboard in this thread.") }
            return .failed(VJ.nonEmpty(d["note"]) ?? "This thread could not be typed into.")
        }
        _ = await watch(t)
        return .said(VJ.truthy(d["queued"]) ? (VJ.nonEmpty(d["note"]) ?? "Queued for \(t.label).") : "Sent to \(t.label). A notification says when it is done or asks.")
    }
}

/// Glass, watch and drive rows, from the catalog the Capsule already has.
final class AgentRows: ResultProvider, @unchecked Sendable {
    let id = "agent-rows"
    let speed = Speed.quick
    weak var wiring: AgentWiring?
    init(wiring: AgentWiring) { self.wiring = wiring }

    func results(for query: Query) async -> [ResultItem] {
        await MainActor.run { () -> [ResultItem] in
            guard let w = wiring, let m = w.model else { return [] }
            var out: [ResultItem] = []
            let box = m.catalog.box
            for g in Glass.results(query.text, m.catalog) {
                out.append(ResultItem(id: g.id, kind: "glass", title: g.label, subtitle: g.sub, icon: .symbol("display", .bone), section: .vyre,
                                      score: g.score, actions: [ResultAction(id: "open", title: "Open", symbol: "safari") { _, _ in
                                          await MainActor.run { Glass.open(box: box, target: g.target) }
                                      }], sendsTo: "the browser"))
            }
            if let name = Watches.watchWords(query.text), let t = w.thread(named: name) {
                out.append(ResultItem(id: "watch:\(t.id)", kind: "watch", title: "Watch \(t.label)", subtitle: "a notification when it is done or asks",
                                      icon: .symbol("eye", .bone), section: .vyre, score: 1.8, actions: [ResultAction(id: "watch", title: "Watch", symbol: "eye") { [weak w] _, _ in
                                          await w?.watch(t) ?? .failed("Lumen closed.")
                                      }]))
            }
            if let g = VyRx.groups("^(?:tell|ask)\\s+(?:the\\s+)?(.+?)(?:\\s+thread)?\\s+to\\s+(.+)$", query.text.trimmingCharacters(in: .whitespacesAndNewlines)),
               let t = w.thread(named: g[1]) {
                let words = g[2]
                out.append(ResultItem(id: "drive:\(t.id)", kind: "drive", title: "Tell \(t.label): \(words)", subtitle: "sent as you, then watched",
                                      icon: .symbol("arrowshape.turn.up.right", .signal), section: .vyre, score: 1.85,
                                      actions: [ResultAction(id: "send", title: "Send and watch", symbol: "paperplane") { [weak w] _, _ in
                                          await w?.drive(t, words) ?? .failed("Lumen closed.")
                                      }], sendsTo: t.label))
            }
            return out
        }
    }
}

extension CapsuleModel {
    /// The paired box's address, for Glass: from link.status and nothing else, never a guess.
    func loadBox() async {
        catalog.box = await Glass.address(vyred, has: vyred.has("link.status"))
    }
}

/// ⌘K: every verb of the highlighted row, to pick one. Enter runs the first without it.
@MainActor final class ActionMenu: ObservableObject {
    @Published var item: ResultItem?
    @Published var index = 0
    var changed: (() -> Void)?
    private var sink: Any?
    init() { sink = objectWillChange.sink { [weak self] in self?.changed?() } }
    var isOpen: Bool { item != nil }
    func open(_ r: ResultItem) { item = r; index = 0 }
    func close() { item = nil; index = 0 }
    func move(_ by: Int) { guard let n = item?.actions.count, n > 0 else { return }; index = (index + by + n) % n }
}
