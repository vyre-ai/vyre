// Direct: `@juno` (the assistant) or `@<agent>` as a conversation. Ported from the Electron
// bridge's openDm, dm and closeDm.
//
// Opening reads the agent's current thread (agents.list) and its history (threads.get), then folds
// every event of that thread in (VyState.applyDm) until it closes. Events heard while the history
// loads are held and folded after it, so nothing is lost or shown twice. Words sent from the
// Capsule show at once, pending, until thread.sent says they arrived. Nothing is fetched or folded
// for a DM that is not open.

import Combine
import Foundation

@MainActor
public final class Direct: ObservableObject {
    @Published public private(set) var dm: Dm?
    let vyred: VyredClient
    var projectName: SlugName = { $0 }
    /// Told of every change, so the Capsule redraws and resizes.
    var changed: (() -> Void)?
    private var sink: AnyCancellable?
    private var subs: [VyredSubscription] = []
    private var buffer: [VyredEvent]?
    private var seq = 0
    private var pendingSeq = 0
    private var lastEvent = 0

    init(vyred: VyredClient) {
        self.vyred = vyred
        sink = objectWillChange.sink { [weak self] in self?.changed?() }
    }

    public var agent: String? { dm?.agent }

    /// Open the DM with an agent ("assistant" is whichever agent is the assistant).
    func open(_ agent: String, catalog: VyreCatalog) {
        if dm?.agent == agent { return }
        close()
        seq += 1
        let mine = seq
        let known = catalog.agents?.first { $0.name == agent } ?? (agent == "assistant" ? catalog.assistant : nil)
        var d = VyState.dm(known?.name ?? agent, thread: known?.thread)
        d.loading = true
        dm = d
        buffer = []
        let after = lastEvent
        subs = ["thread.*", "ask.*", "lease.changed"].map { p in vyred.on(p) { [weak self] e in self?.heard(e) } }
        Task { @MainActor in
            let loaded = await self.load(agent)
            guard mine == self.seq, let cur = self.dm else { return }
            let heard = self.buffer ?? []
            self.buffer = nil
            switch loaded {
            case .failure(let why):
                self.dm = nil; self.subs.forEach { $0.cancel() }; self.subs = []
                self.error = why
                self.onError?(why)
            case .success(var d):
                d = VyState.dmCarry(d, cur.messages.filter(\.pending), after: after)
                for e in heard { d = VyState.applyDm(d, e, name: self.projectName) }
                self.dm = d
            }
        }
    }

    /// Why the last open failed, for the line under the box.
    @Published public var error: String?
    var onError: ((String) -> Void)?

    func close() {
        seq += 1
        subs.forEach { $0.cancel() }; subs = []
        buffer = nil
        if dm != nil { dm = nil }
        error = nil
    }

    func heard(_ e: VyredEvent) {
        if e.id > lastEvent { lastEvent = e.id }
        guard let d = dm else { return }
        if buffer != nil { buffer?.append(e); return }
        var ev = e
        if e.type == "ask.raised", VJ.nonEmpty(e.payload["agent"]) == nil { ev.payload["agent"] = d.agent }
        let next = VyState.applyDm(d, ev, name: projectName)
        if next.visiblyDiffers(from: d) { dm = next } else { dm?.last = next.last }
    }

    enum Loaded { case success(Dm), failure(String) }

    /// The DM's state from vyred: the agent's current thread, then its events.
    func load(_ agent: String) async -> Loaded {
        guard vyred.has("agents.list") else { return .failure(Bridge.explain(code: "no_such_tool", message: "no tool agents.list")) }
        let list = await vyred.call("agents.list", [:], presence: false)
        if let why = Bridge.explain(list) { return .failure(why) }
        let rows = (list.data as? [[String: Any]]) ?? ((list.data as? [String: Any])?["agents"] as? [[String: Any]]) ?? []
        guard let a = rows.first(where: { VJ.s($0["name"]) == agent }) ?? (agent == "assistant" ? rows.first { VJ.s($0["kind"]) == "assistant" } : nil) else {
            return .failure(agent == "assistant" ? "There is no assistant on this vyred yet." : "There is no agent called \(agent).")
        }
        let name = VJ.s(a["name"])
        let d = VyState.dm(name, thread: VJ.nonEmpty(a["thread"]))
        guard let thread = d.thread else { return .success(d) }
        let r = await vyred.call("threads.get", ["thread": thread, "limit": 1000], presence: false)
        if let why = Bridge.explain(r) { return .failure(why) }
        let got = (r.data as? [String: Any]) ?? [:]
        let project = VJ.nonEmpty((got["thread"] as? [String: Any])?["project"])
        return .success(VyState.dmHistory(d, got, askRow: { [projectName] x in
            var p = x; p["agent"] = name; if p["ask"] == nil { p["ask"] = x["id"] }
            return VyState.fromAsk(VyredEvent(id: 0, type: "ask.raised", source: "load", thread: thread, project: project,
                                              at: Int(VJ.num(x["at"]) ?? 0), payload: p), name: projectName)
        }, name: projectName))
    }

    /// Send words into the open DM: they show at once, pending, and go with agents.ask (wait:false);
    /// the reply follows on the stream. A refusal takes the pending words back out and says why.
    func send(_ text: String) async -> ActionOutcome {
        guard let d = dm else { return .failed("No conversation is open.") }
        pendingSeq += 1
        let key = "p\(pendingSeq)"
        dm = VyState.dmPending(d, key, text, vyNowMs())
        let r = await vyred.call("agents.ask", ["agent": d.agent, "text": text, "surface": "capsule", "wait": false], presence: false)
        let x = (r.data as? [String: Any]) ?? [:]
        if let why = Bridge.explain(r) { if let cur = dm { dm = VyState.dmDrop(cur, key) }; return .failed(why) }
        if VJ.bool(x["ok"]) == false {
            if let cur = dm { dm = VyState.dmDrop(cur, key) }
            return .failed(VJ.nonEmpty(x["note"]) ?? "\(d.agent) did not get it.")
        }
        if let t = VJ.nonEmpty(x["thread"]), dm?.thread == nil, buffer == nil { dm?.thread = t }
        return .replaceQuery("")
    }
}
