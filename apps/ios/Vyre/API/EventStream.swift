import Foundation
import Observation

/// One record from vyred's event log: `{id, at, type, source, project, thread, payload}`.
/// `threads.get` returns the same records without source/project/thread; both flatten the same way.
struct VyreEvent: Sendable, Hashable, Identifiable {
    let id: Int
    let at: Double
    let type: String
    let source: String?
    let project: String?
    let thread: String?
    let payload: JSON

    init(id: Int, at: Double, type: String, source: String? = nil, project: String? = nil, thread: String? = nil, payload: JSON) {
        self.id = id; self.at = at; self.type = type; self.source = source; self.project = project
        self.thread = thread; self.payload = payload
    }

    init?(_ j: JSON) {
        guard let type = j["type"].string else { return nil }
        self.init(id: j["id"].int ?? 0, at: j["at"].double ?? 0, type: type, source: j["source"].string,
                  project: j["project"].string, thread: j["thread"].string ?? j["payload"]["thread"].string,
                  payload: j["payload"].object.map(JSON.object) ?? [:])
    }

    /// The payload's fields with `thread` filled in. History events carry their fields under
    /// `payload` (the Deck's backlog bug in CONTRACT.md 3.4); this is the one place that flattens.
    subscript(key: String) -> JSON {
        if key == "thread", payload["thread"].isNull, let thread { return .string(thread) }
        return payload[key]
    }
}

/// A Server-Sent Events parser: `id`, `event`, `data` (several lines join with "\n"), `:` comments
/// ignored, a blank line dispatches. Pure, so it is tested without a network.
struct SSEParser: Sendable {
    struct Frame: Sendable, Equatable {
        var id: String?
        var event: String
        var data: String
    }

    private(set) var lastEventId: String?
    private var event = ""
    private var data: [String] = []
    private var sawData = false
    private var pendingCR = false
    private var line: [UInt8] = []

    /// Feed raw bytes; returns the frames completed by them.
    mutating func feed<S: Sequence>(_ bytes: S) -> [Frame] where S.Element == UInt8 {
        var out: [Frame] = []
        for b in bytes {
            if pendingCR {
                pendingCR = false
                if b == 0x0A { continue } // CRLF: the CR already ended the line.
            }
            if b == 0x0A || b == 0x0D {
                if b == 0x0D { pendingCR = true }
                if let f = take(String(decoding: line, as: UTF8.self)) { out.append(f) }
                line.removeAll(keepingCapacity: true)
            } else {
                line.append(b)
            }
        }
        return out
    }

    /// Feed one complete line (no terminator).
    mutating func take(_ line: String) -> Frame? {
        if line.isEmpty {
            defer { event = ""; data = []; sawData = false }
            guard sawData else { return nil }
            return Frame(id: lastEventId, event: event.isEmpty ? "message" : event, data: data.joined(separator: "\n"))
        }
        if line.hasPrefix(":") { return nil }
        let field: Substring
        var value: Substring
        if let colon = line.firstIndex(of: ":") {
            field = line[..<colon]
            value = line[line.index(after: colon)...]
            if value.hasPrefix(" ") { value = value.dropFirst() }
        } else {
            field = Substring(line)
            value = ""
        }
        switch field {
        case "id": if !value.contains("\u{0}") { lastEventId = String(value) }
        case "event": event = String(value)
        case "data": data.append(String(value)); sawData = true
        default: break
        }
        return nil
    }
}

/// The one live connection to `GET /v1/events/stream`, open only while the app is in front
/// (ADR 0018 section 5). It resumes from the last id it saw with Last-Event-ID, and backs off
/// 1, 2, 4 ... 30 seconds between attempts. Views subscribe with `on(_:)`.
@MainActor
@Observable
final class EventHub {
    enum State: Equatable { case stopped, connecting, live, waiting(Int) }

    private(set) var state: State = .stopped
    private(set) var lastEventId: Int?
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var handlers: [UUID: @MainActor (VyreEvent) -> Void] = [:]
    @ObservationIgnored var delay: @Sendable (Int) async throws -> Void = { secs in try await Task.sleep(for: .seconds(secs)) }

    nonisolated init() {}

    /// Call `handler` for every event until the token is dropped by `off`.
    @discardableResult
    func on(_ handler: @escaping @MainActor (VyreEvent) -> Void) -> UUID {
        let id = UUID()
        handlers[id] = handler
        return id
    }

    func off(_ id: UUID?) { if let id { handlers[id] = nil } }

    /// Open the stream. `since` is where to start when this hub has no id of its own yet
    /// (`/v1/health`'s last_event, or nil for "latest").
    func start(client: VyreClient, since: Int?) {
        guard task == nil else { return }
        if lastEventId == nil { lastEventId = since }
        task = Task { [weak self] in await self?.run(client: client) }
    }

    func stop() {
        task?.cancel()
        task = nil
        state = .stopped
    }

    var running: Bool { task != nil }

    private func run(client: VyreClient) async {
        var backoff = 1
        while !Task.isCancelled {
            state = .connecting
            let from = lastEventId
            let stream = EventHub.connect(client: client, lastEventId: from)
            var gotAny = false
            do {
                for try await item in stream {
                    switch item {
                    case .open:
                        state = .live
                        backoff = 1
                    case .event(let e):
                        gotAny = true
                        if e.id > 0 { lastEventId = e.id }
                        for h in handlers.values { h(e) }
                    }
                }
            } catch {}
            if Task.isCancelled { break }
            if gotAny { backoff = 1 }
            state = .waiting(backoff)
            do { try await delay(backoff) } catch { break }
            // Only a connection that brought nothing doubles the next wait.
            backoff = gotAny ? 1 : min(backoff * 2, 30)
        }
        if !Task.isCancelled { state = .stopped }
    }

    enum Item: Sendable { case open, event(VyreEvent) }

    /// One connection, as a stream of frames. Ends when the server closes or the network drops.
    nonisolated static func connect(client: VyreClient, lastEventId: Int?) -> AsyncThrowingStream<Item, Error> {
        AsyncThrowingStream { continuation in
            let t = Task {
                var comps = URLComponents(url: client.url("/v1/events/stream"), resolvingAgainstBaseURL: false)!
                if lastEventId == nil { comps.queryItems = [URLQueryItem(name: "since", value: "latest")] }
                var req = URLRequest(url: comps.url!)
                req.setValue("text/event-stream", forHTTPHeaderField: "accept")
                req.timeoutInterval = 60 // the box sends a heartbeat every 15 s
                if let lastEventId { req.setValue(String(lastEventId), forHTTPHeaderField: "Last-Event-ID") }
                do {
                    let (bytes, response) = try await client.session.bytes(for: req)
                    guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                        throw VyreError.offline("The event stream is not available.")
                    }
                    continuation.yield(.open)
                    var parser = SSEParser()
                    var chunk: [UInt8] = []
                    chunk.reserveCapacity(4096)
                    for try await b in bytes {
                        chunk.append(b)
                        if b == 0x0A {
                            for f in parser.feed(chunk) {
                                if let data = f.data.data(using: .utf8), let j = try? JSON.parse(data), let e = VyreEvent(j) {
                                    continuation.yield(.event(e))
                                }
                            }
                            chunk.removeAll(keepingCapacity: true)
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in t.cancel() }
        }
    }
}
