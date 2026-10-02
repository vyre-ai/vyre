// BoxLink: on a Mac paired to a server, the assistant, memory and agents live on that server (#36).
//
// The Mac's own vyred knows none of them: its agents.list has no assistant, so Lumen said "there is no assistant on this Vyre"
// while the person's assistant was on their server. A paired Mac's vyred offers `link.call {tool, input}` (a tool on the box)
// and proxies the box's events at /v1/link/events (docs/concepts/box-and-mac.md). This file uses both:
//
//   - The asks that belong to the server (agents.*, memory.*, learn.lessons) go through link.call when link.status says the Mac
//     is linked. So do the thread calls for a thread the server owns (one an agents.ask started, one its lists named).
//   - The server's thread, ask and memory events are followed on /v1/link/events and handed to the same subscribers as the Mac's
//     own, so a reply from the server draws as it arrives.
//   - Everything else stays on this Mac: apps, files, clipboard, the Mac's own sessions, the vault, presence, the Gate.
//   - When the server cannot be reached the call says so in words; nothing falls back to the Mac's empty answer.
//
// Not linked, or link.status missing: nothing changes, and every call goes to this vyred as before.

import Foundation

public final class BoxLink: @unchecked Sendable {
    /// Tools that are the server's whatever their input.
    static let serverTools: Set<String> = [
        "agents.list", "agents.ask", "agents.threads", "memory.ask", "memory.answer", "memory.correct", "memory.uncorrect", "learn.lessons",
    ]
    /// Tools on one thread: the server's when that thread is the server's.
    static let threadTools: Set<String> = [
        "threads.get", "threads.send", "threads.watch", "threads.stop", "threads.interrupt", "threads.release", "threads.unqueue",
        "threads.thinking", "threads.model", "threads.answer", "threads.asks",
    ]
    /// The server's events Lumen follows, as the Mac's own are.
    static let eventTypes = ["thread.*", "ask.*", "memory.*"]

    private let lock = NSLock()
    private var isLinked = false
    private var isReachable: Bool?
    private var name: String?
    private var threads = Set<String>()
    private var streams: [SSEConnection] = []
    private var generation = 0

    public var linked: Bool { lock.lock(); defer { lock.unlock() }; return isLinked }
    public var reachable: Bool? { lock.lock(); defer { lock.unlock() }; return isReachable }
    public var boxName: String? { lock.lock(); defer { lock.unlock() }; return name }

    /// Does this call go to the server?
    func routes(_ tool: String, _ input: [String: Any]) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard isLinked else { return false }
        if Self.serverTools.contains(tool) { return true }
        if Self.threadTools.contains(tool), let t = input["thread"] as? String { return threads.contains(t) }
        return false
    }

    /// Tools this client offers because the server has them (has() says yes while linked).
    func offers(_ tool: String) -> Bool { linked && Self.serverTools.contains(tool) }

    func adopt(thread: String?) {
        guard let thread, !thread.isEmpty else { return }
        lock.lock(); threads.insert(thread); lock.unlock()
    }

    /// Thread ids the server named in an answer ({thread}, {id}, a list of rows), so later calls on them go there too.
    func learn(from data: Any?) {
        if let o = data as? [String: Any] {
            adopt(thread: o["thread"] as? String)
            if let rows = o["threads"] as? [[String: Any]] { rows.forEach { adopt(thread: $0["id"] as? String) } }
        } else if let rows = data as? [[String: Any]] {
            rows.forEach { adopt(thread: $0["id"] as? String) ; adopt(thread: $0["thread"] as? String) }
        }
    }

    /// `base` (what to say when this Mac simply has no assistant), or the away words when the Mac is paired and its server cannot be reached.
    func said(_ base: String) -> String { linked && reachable == false ? Self.away("") : base }

    /// Words for the server being away: the Mac's own empty answer would read as "no assistant".
    static func away(_ message: String) -> String {
        "Your server is not reachable right now, so there is no assistant, memory or agent to ask. Apps, files and your clipboard still work here.\(message.isEmpty ? "" : " (\(message))")"
    }

    /// Run a routed call on the server. Never falls back to this Mac.
    func call(_ client: VyredClient, _ tool: String, _ input: [String: Any], timeout: TimeInterval) async -> VyredResult {
        let r = await client.callLocal("link.call", ["tool": tool, "input": input], timeout: max(timeout, 30))
        switch r {
        case .success(let d):
            learn(from: d)
            return r
        case .failure(let code, let message):
            if code == "box_unreachable" || code == "no_link" || code == "unpaired" || code == "timeout" {
                lock.lock(); isReachable = false; lock.unlock()
                return .failure(code: "box_unreachable", message: Self.away(code == "timeout" ? "" : message))
            }
            return r
        }
    }

    /// link.status, then the server's events while linked. Called when this vyred is found and when the panel shows.
    @MainActor func refresh(_ client: VyredClient) async {
        guard client.has("link.status") else { setLinked(false, client); return }
        let r = await client.callLocal("link.status", [:], timeout: 5)
        guard case .success(let d) = r, let o = d as? [String: Any] else { return }
        let on = VJ.truthy(o["linked"])
        lock.lock()
        name = VJ.nonEmpty((o["box"] as? [String: Any])?["name"])
        isReachable = on ? (o["reachable"] as? Bool ?? true) : nil
        lock.unlock()
        setLinked(on, client)
    }

    @MainActor private func setLinked(_ on: Bool, _ client: VyredClient) {
        lock.lock()
        let changed = isLinked != on
        isLinked = on
        if !on { threads.removeAll() }
        lock.unlock()
        if on, changed || streams.isEmpty { startStreams(client) }
        if !on { stopStreams() }
    }

    @MainActor func stopStreams() {
        lock.lock(); generation += 1; let s = streams; streams = []; lock.unlock()
        s.forEach { $0.stop() }
    }

    @MainActor private func startStreams(_ client: VyredClient) {
        stopStreams()
        lock.lock(); let gen = generation; lock.unlock()
        let made = Self.eventTypes.map { type in
            SSEConnection(socket: client.socket, path: "/v1/link/events?type=\(type)&since=latest",
                onOpen: {},
                onEvent: { [weak self, weak client] json in
                    guard let e = VyredEvent(json: json) else { return }
                    onMain {
                        guard let self, let client else { return }
                        self.lock.lock(); let ok = gen == self.generation; self.lock.unlock()
                        guard ok else { return }
                        // The server's thread is the server's: its follow-ups go there. Its ids never touch the Mac's own resume point.
                        self.adopt(thread: e.thread)
                        client.dispatch(e)
                    }
                },
                onEnd: {})
        }
        lock.lock(); streams = made; lock.unlock()
        made.forEach { $0.start() }
    }
}
