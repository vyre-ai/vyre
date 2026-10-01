// Destinations: where Enter sends the words, shown before anything is sent (floor rule 2).
//
// The rows at the end of the list are Route.destinations, in its order: for a question about the
// user's own work, the assistant first (it has their memory); for any other question, a fast
// model, then the assistant, then the deeper model; for a command, the assistant; with no
// assistant and no switchboard, memory alone. An @agent picks the thread its words match, an
// @project a new thread or the matching one, an @thread that thread. The first row is where Enter
// goes; ↓ reaches the others; the bar says "to <who>" for the row selected, so what is drawn is
// what is sent. A destination this vyred cannot reach says why on its row, before Enter.
//
// With an answer on screen, the first row is "Follow up": the same thread, so the model has the
// conversation (a quick answer's thread resumes from its transcript).

import AppKit
import Foundation

/// The threads each agent has (agents.threads), read once per agent while the Capsule runs.
@MainActor final class RouteCache {
    private(set) var agentThreads: [String: [VyreThread]] = [:]
    private var asking: Set<String> = []

    func threads(_ agent: String) -> [VyreThread] { agentThreads[agent] ?? [] }

    /// Read an agent's threads if not read yet; `then` runs when they land.
    func load(_ agent: String, _ vyred: VyredClient, projectName: @escaping (String) -> String, then: @escaping () -> Void) {
        guard agentThreads[agent] == nil, !asking.contains(agent), vyred.has("agents.threads") else { return }
        asking.insert(agent)
        Task { @MainActor in
            let r = await vyred.call("agents.threads", ["agent": agent], presence: false)
            self.asking.remove(agent)
            let rows = (r.data as? [[String: Any]]) ?? ((r.data as? [String: Any])?["threads"] as? [[String: Any]]) ?? []
            self.agentThreads[agent] = rows.compactMap { x in
                guard let id = VJ.nonEmpty(x["id"]) ?? VJ.nonEmpty(x["thread"]) else { return nil }
                let project = VJ.nonEmpty(x["project"])
                return VyreThread(id: id, label: VJ.nonEmpty(x["name"]) ?? VJ.nonEmpty(x["label"]) ?? VJ.nonEmpty(x["title"]) ?? String(id.prefix(8)),
                                  last: VJ.num(x["last"]) ?? VJ.num(x["started"]), project: project, projectName: project.map(projectName), agent: agent)
            }
            then()
        }
    }
}

extension CapsuleModel {
    /// The destination rows for these words, first is where Enter sends.
    func askItems(_ q: Query) -> [ResultItem] {
        let words = q.text.trimmingCharacters(in: .whitespacesAndNewlines)
        // An extension's @ target (an app, a service) sends through the extension, not vyred.
        if let t = target, t.kind == .app { return [appSendItem(q, t)] }
        var options: [VyreDestination] = []
        if let t = target, t.kind == .agent {
            routes.load(t.id, vyred, projectName: { [weak self] s in self?.catalog.projectName(s) ?? s }) { [weak self] in self?.search() }
        }
        let agentThreads = target.flatMap { $0.kind == .agent ? routes.threads($0.id) : nil } ?? []
        var r = Route.destinations(target, words, catalog, agentThreads: agentThreads, quick: vyred.has("threads.start"),
                                     models: (models.quick, models.deeper))
        // With no chip, a question answers itself and ⏎ / ⌘⏎ ask (AutoAsk.swift): no Quick or
        // Deeper answer rows.
        if target == nil { r.options.removeAll { $0.kind == .quick } }
        options += r.options
        return options.enumerated().map { i, d in destinationItem(d, words: words, why: i == options.count - r.options.count ? r.why : nil) }
    }

    /// One destination as a row: who it goes to, and why (or why it cannot).
    func destinationItem(_ d: VyreDestination, words: String, why: String?) -> ResultItem {
        let show = d.show
        let to = ([show.who] + show.where.filter { !$0.isEmpty }).joined(separator: " › ")
        let title: String
        switch d.kind {
        // A quick answer comes from a fast model with no tools; the assistant's own row is "Ask juno".
        case .quick: title = d.deep ? "Deeper answer" : "Quick answer"
        case .assistant, .agent: title = "Ask \(show.who)"
        case .newThread: title = "Start a thread in \(show.who)"
        case .thread: title = d.meta == "follow up" ? "Follow up" : "Send to \(to)"
        case .recall: title = "Memory only"
        }
        let unavailable = Bridge.needs(d).flatMap { vyred.has($0) || !vyred.isUp ? nil : Bridge.explain(code: "no_such_tool", message: "no tool \($0.split(separator: ".")[0]).") }
        let sub = unavailable ?? why ?? (d.kind == .recall ? (showsMemory ? "Memory answered above. There is no assistant on this Vyre to ask further." : "Nothing in memory answers that yet, and there is no assistant on this Vyre to ask.") : d.meta)
        let id = "dest:\(d.kind.rawValue):\(d.agent ?? ""):\(d.project ?? ""):\(d.thread ?? ""):\(d.model ?? "")"
        let symbol = d.kind == .quick ? "sparkle" : d.kind == .thread ? "arrowshape.turn.up.right" : "paperplane"
        return ResultItem(id: id, kind: "ask", title: title, subtitle: sub, icon: .mark, section: .vyre, score: 0,
                          actions: [ResultAction(id: "go", title: d.kind == .quick ? "Ask" : "Send", symbol: symbol) { [weak self] _, _ in
                              if let u = unavailable { return .failed(u) }
                              return await self?.go(d, words) ?? .failed("Lumen closed.")
                          }], sendsTo: d.kind == .quick ? (d.deep ? "\(assistantName), deeper" : assistantName) : to)
    }

    /// Send the words to exactly this destination.
    func go(_ d: VyreDestination, _ words: String) async -> ActionOutcome {
        switch d.kind {
        case .quick: return await ask(words, model: d.model ?? models.quick)
        case .recall: return .said("Nothing to send to: there is no assistant on this Vyre yet. Memory has answered what it can.")
        case .assistant, .agent:
            let a = d.agent ?? ""
            // With the conversation open, the words go into it and the reply streams there.
            if let open = direct.agent, open == a || (d.kind == .assistant && catalog.assistant?.name == open) { return await direct.send(words) }
            return await send(words, to: VyreCandidate(kind: .agent, id: a, label: a))
        case .thread:
            guard let t = d.thread else { return .failed("That thread has no id.") }
            return await send(words, to: VyreCandidate(kind: .thread, id: t, label: d.threadLabel ?? d.agent ?? "the thread"), model: d.model)
        case .newThread:
            guard let p = d.project else { return .failed("That project has no id.") }
            return await send(words, to: VyreCandidate(kind: .project, id: p, label: d.projectName ?? p))
        }
    }

    /// Whether the destination rows go first: the words read as a question and nothing on this Mac
    /// matches them strongly (Route.intent), or a chip or an answer on screen says where they go.
    func asksFirst(_ q: Query, top: ResultItem?) -> Bool {
        if target != nil { return true }
        return Route.intent(q.text, topKind: top?.kind, topScore: top?.score ?? 0) == .ask && Route.asksQuestion(q.text)
    }

    /// The chip changed: @agent opens the conversation with it; anything else closes it.
    func targetChanged() {
        if let t = target, t.kind == .agent, vyred.isUp { direct.open(t.id, catalog: catalog) } else { direct.close() }
    }

    // MARK: the answer's own actions

    /// Deeper: the same question again, to the deeper model. Only after a fast answer finished.
    var canGoDeeper: Bool { reply.map { $0.finished && $0.model == models.quick && $0.queued == nil } == true && asked != nil }

    func deeper() {
        guard canGoDeeper, let words = asked else { return }
        deeper(words)
    }

    /// Where Copy writes: the general pasteboard, or a private one under tests.
    static var replyBoard: NSPasteboard = .general

    /// Copy the answer as it reads.
    @discardableResult
    func copyReply() -> Bool {
        let t = replyText
        guard !t.isEmpty else { return false }
        Self.replyBoard.clearContents()
        Self.replyBoard.setString(t, forType: .string)
        flash("Copied.")
        return true
    }

    func handleOutcome(_ out: ActionOutcome) { if case .failed(let s) = out { line = s } else if case .said(let s) = out, !s.isEmpty { line = s } }
}
