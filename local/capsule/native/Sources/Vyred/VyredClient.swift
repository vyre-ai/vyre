// VyredClient: how the Capsule reaches vyred. One request over the unix socket, and the live
// event stream. Ported from lib/vyred.js and the follow() loop in app/main.js.
//
// The same shape as core/daemon/client.js ({data} or {error}, never a throw), written again here
// because the Capsule carries only itself: the prototype lost twelve days to an import that
// reached up into core/ from a packaged app and died silently before a window existed.
//
// HTTP/1.1 over AF_UNIX by hand, not URLSession: URLSession cannot speak to a unix socket, and a
// socket, a request line and a small parser (Content-Length and chunked, which Node uses for the
// event stream) are less code than any bridge to it. Every call says `x-vyre-caller: capsule`.
//
// The stream is followed by one thread blocked in poll(2) on the socket and a wake pipe. It costs
// nothing while nothing happens (vyred writes a comment every 15 s to keep it warm), and it runs
// while the Capsule is hidden on purpose: the events that must arrive (a held draft, a request
// to show the Capsule) are exactly the ones that arrive while it is hidden. When vyred is down,
// the follower looks for it again soon at first, then less often: 3 s doubling to a minute while
// hidden, every 3 s while shown, and at once when the Capsule opens. perf measured a steady 3 s
// retry in the Electron Capsule at about 0.8% CPU hidden, four times the budget.

import Foundation

/// A VyredLink that can also read a route and set a timeout: what the bridge and the module
/// providers need beyond Kit's seam.
public protocol VyredTransport: VyredLink {
    func get(_ route: String, timeout: TimeInterval) async -> VyredResult
    func call(_ tool: String, _ input: [String: Any], timeout: TimeInterval) async -> VyredResult
    /// A route's `data` with object keys in the order vyred wrote them (a module's shows.capsule
    /// lists its actions in key order), or the error's words.
    func getOrdered(_ route: String, timeout: TimeInterval) async -> (data: OJ?, error: String?)
}

public extension VyredTransport {
    func get(_ route: String) async -> VyredResult { await get(route, timeout: 10) }
    func getOrdered(_ route: String, timeout: TimeInterval) async -> (data: OJ?, error: String?) {
        switch await get(route, timeout: timeout) {
        case .success(let d): return (OJ(any: d), nil)
        case .failure(_, let m): return (nil, m)
        }
    }
}

/// Where vyred listens. `vyre capsule` and the capsule module always pass VYRE_SOCKET.
public func vyredSocketPath(_ env: [String: String] = ProcessInfo.processInfo.environment) -> String {
    if let s = env["VYRE_SOCKET"], !s.isEmpty { return s }
    let home = env["VYRE_HOME"].flatMap { $0.isEmpty ? nil : $0 } ?? (NSHomeDirectory() as NSString).appendingPathComponent(".vyre")
    return (home as NSString).appendingPathComponent("vyred.sock")
}

/// The words a call fails with when the Capsule would need to prove a person is at the Mac.

// MARK: - Time, injectable so backoff is tested without waiting

public protocol VyTimer: AnyObject { func cancel() }

public protocol VyClock: AnyObject {
    /// Run `fn` on the main actor after `seconds`.
    func schedule(after seconds: TimeInterval, _ fn: @escaping @MainActor () -> Void) -> VyTimer
}

public final class SystemClock: VyClock {
    private final class Item: VyTimer { let work: DispatchWorkItem; init(_ w: DispatchWorkItem) { work = w }; func cancel() { work.cancel() } }
    public init() {}
    public func schedule(after seconds: TimeInterval, _ fn: @escaping @MainActor () -> Void) -> VyTimer {
        let w = DispatchWorkItem { MainActor.assumeIsolated { fn() } }
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: w)
        return Item(w)
    }
}

// MARK: - The socket

enum VySock {
    /// Connect to a unix socket, or -1. A path longer than sun_path (104 bytes) is reached from its
    /// folder, with this thread's own working directory, so no other thread is affected.
    static func connect(_ path: String) -> Int32 {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        if fd < 0 { return -1 }
        var one: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
        let ok = withShortPath(path) { name in
            var addr = sockaddr_un()
            guard fill(&addr, name) else { return false }
            let r = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
            return r == 0
        }
        if !ok { close(fd); return -1 }
        return fd
    }

    static func fill(_ addr: inout sockaddr_un, _ name: String) -> Bool {
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(name.utf8)
        let cap = MemoryLayout.size(ofValue: addr.sun_path)
        guard bytes.count < cap else { return false }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            for (i, b) in bytes.enumerated() { raw[i] = b }
            raw[bytes.count] = 0
        }
        return true
    }

    private typealias FchdirFn = @convention(c) (Int32) -> Int32
    private static let fchdir: FchdirFn? = {
        guard let h = dlopen(nil, RTLD_NOW), let f = dlsym(h, "pthread_fchdir_np") else { return nil }
        return unsafeBitCast(f, to: FchdirFn.self)
    }()

    /// Run `body` with a name for `path` that fits in sun_path.
    static func withShortPath(_ path: String, _ body: (String) -> Bool) -> Bool {
        if path.utf8.count < 100 { return body(path) }
        let dir = (path as NSString).deletingLastPathComponent, name = (path as NSString).lastPathComponent
        guard let fchdir else { return false }
        let dfd = open(dir, O_RDONLY | O_DIRECTORY)
        if dfd < 0 { return false }
        defer { _ = fchdir(-1); close(dfd) }
        guard fchdir(dfd) == 0 else { return false }
        return body(name)
    }

    /// Write everything, or false.
    static func writeAll(_ fd: Int32, _ data: Data, deadline: Date) -> Bool {
        var off = 0
        return data.withUnsafeBytes { raw -> Bool in
            guard let base = raw.baseAddress else { return true }
            while off < data.count {
                guard waitFor(fd, Int16(POLLOUT), deadline: deadline) else { return false }
                let n = write(fd, base + off, data.count - off)
                if n < 0 { if errno == EINTR || errno == EAGAIN { continue }; return false }
                off += n
            }
            return true
        }
    }

    /// Wait until fd is ready, or false at the deadline.
    static func waitFor(_ fd: Int32, _ events: Int16, deadline: Date) -> Bool {
        while true {
            let ms = Int32(max(0, min(Double(Int32.max), deadline.timeIntervalSinceNow * 1000)))
            var p = pollfd(fd: fd, events: events, revents: 0)
            let r = poll(&p, 1, ms)
            if r > 0 { return true }
            if r == 0 { return false }
            if errno != EINTR { return false }
        }
    }
}

// MARK: - HTTP/1.1, just enough

/// Transfer-Encoding: chunked, decoded as bytes arrive.
struct ChunkDecoder {
    private var buf = Data()
    private var need: Int?      // bytes of the current chunk still to come, nil while reading a size line
    private(set) var finished = false

    mutating func feed(_ d: Data) -> Data {
        buf.append(d)
        var out = Data()
        while !finished {
            if let n = need {
                guard buf.count >= n + 2 else { break }
                out.append(buf.prefix(n))
                buf.removeFirst(n + 2)
                need = nil
            } else {
                guard let r = buf.range(of: Data("\r\n".utf8)) else { break }
                let line = String(decoding: buf[buf.startIndex..<r.lowerBound], as: UTF8.self)
                buf.removeSubrange(buf.startIndex..<r.upperBound)
                let hex = line.split(separator: ";").first.map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
                guard let size = Int(hex, radix: 16) else { finished = true; break }
                if size == 0 { finished = true; break }
                need = size
            }
        }
        if buf.count > 8 << 20 { buf.removeAll(); finished = true }   // a stream that never frames is not a stream
        return out
    }
}

/// Splits an ndjson body arriving in pieces into whole lines.
final class NDJSONState: @unchecked Sendable {
    /// A line no longer than this; more with no newline means a broken or hostile stream.
    static let limit = 2 << 20
    var isNDJSON = false
    private(set) var overflowed = false
    private var buf = Data()
    func feed(_ d: Data) -> [Data] {
        if overflowed { return [] }
        buf.append(d)
        if buf.count > Self.limit && buf.firstIndex(of: 0x0A) == nil { overflowed = true; buf = Data(); return [] }
        var out: [Data] = []
        while let i = buf.firstIndex(of: 0x0A) {
            let line = Data(buf[buf.startIndex..<i])
            buf.removeSubrange(buf.startIndex...i)
            if !line.isEmpty { out.append(line) }
        }
        return out
    }
}

struct HTTPHead {
    var status: Int
    var headers: [String: String]
    var chunked: Bool { headers["transfer-encoding"]?.lowercased().contains("chunked") ?? false }
    var length: Int? { headers["content-length"].flatMap { Int($0.trimmingCharacters(in: .whitespaces)) } }

    /// The head, and whatever body bytes came with it; nil until the head is whole.
    static func parse(_ d: Data) -> (HTTPHead, Data)? {
        guard let r = d.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        let text = String(decoding: d[d.startIndex..<r.lowerBound], as: UTF8.self)
        var lines = text.components(separatedBy: "\r\n")
        let first = lines.removeFirst().split(separator: " ")
        let status = first.count > 1 ? Int(first[1]) ?? 0 : 0
        var h: [String: String] = [:]
        for l in lines { if let i = l.firstIndex(of: ":") { h[l[..<i].lowercased()] = String(l[l.index(after: i)...]).trimmingCharacters(in: .whitespaces) } }
        return (HTTPHead(status: status, headers: h), Data(d[r.upperBound...]))
    }
}

enum VyHTTP {
    static func requestBytes(_ method: String, _ path: String, body: Data?, accept: String = "application/json", headers: [String: String] = [:]) -> Data {
        // Every call says which zone this Mac is in (the IANA name, read each time so a trip is followed), so vyred reads times in it and hands it to a model call's time line (lib/time).
        let zone = TimeZone.autoupdatingCurrent.identifier.filter { $0.isLetter || $0.isNumber || "/_+-".contains($0) }
        var s = "\(method) \(path) HTTP/1.1\r\nHost: localhost\r\nAccept: \(accept)\r\nx-vyre-caller: capsule\r\nx-vyre-zone: \(zone)\r\n"
        // Extra headers (x-vyre-presence), with anything that could end a header line taken out.
        for (k, v) in headers.sorted(by: { $0.key < $1.key }) {
            s += "\(k.filter { $0.isLetter || $0.isNumber || $0 == "-" }): \(v.filter { $0 != "\r" && $0 != "\n" })\r\n"
        }
        if let body { s += "Content-Type: application/json\r\nContent-Length: \(body.count)\r\n" }
        s += method == "GET" && accept == "text/event-stream" ? "Connection: keep-alive\r\n\r\n" : "Connection: close\r\n\r\n"
        var d = Data(s.utf8)
        if let body { d.append(body) }
        return d
    }

    enum Failure: Error { case unreachable, timeout, broken }

    /// One request, blocking. The body as sent, or why not.
    static func exchange(socket: String, method: String, path: String, body: Data?, timeout: TimeInterval, headers: [String: String] = [:],
                         accept: String = "application/json", onHead: ((HTTPHead) -> Void)? = nil,
                         onBody: ((Data) -> Void)? = nil) -> Result<(Int, Data), Failure> {
        let deadline = Date().addingTimeInterval(timeout)
        let fd = VySock.connect(socket)
        if fd < 0 { return .failure(.unreachable) }
        defer { close(fd) }
        guard VySock.writeAll(fd, requestBytes(method, path, body: body, accept: accept, headers: headers), deadline: deadline) else { return .failure(.broken) }
        var raw = Data(), head: HTTPHead?, bodyBytes = Data(), chunks = ChunkDecoder()
        var buf = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            if let h = head {
                if h.chunked && chunks.finished { break }
                if !h.chunked, let n = h.length, bodyBytes.count >= n { bodyBytes = bodyBytes.prefix(n); break }
            }
            guard VySock.waitFor(fd, Int16(POLLIN), deadline: deadline) else { return .failure(.timeout) }
            let n = read(fd, &buf, buf.count)
            if n < 0 { if errno == EINTR || errno == EAGAIN { continue }; return .failure(.broken) }
            if n == 0 { break }
            let got = Data(buf[0..<n])
            if let h = head {
                let more = h.chunked ? chunks.feed(got) : got
                bodyBytes.append(more)
                if !more.isEmpty { onBody?(more) }
                continue
            }
            raw.append(got)
            if let (h, rest) = HTTPHead.parse(raw) { head = h; bodyBytes = h.chunked ? chunks.feed(rest) : rest; raw = Data()
                onHead?(h)
                if !bodyBytes.isEmpty { onBody?(bodyBytes) }
            }
        }
        guard let h = head else { return .failure(.broken) }
        return .success((h.status, bodyBytes))
    }

    /// {data} or {error}, as vyred answers, never a throw.
    static func result(_ r: Result<(Int, Data), Failure>, timeout: TimeInterval) -> VyredResult {
        switch r {
        case .failure(.unreachable): return .failure(code: "unreachable", message: "Vyre is not running")
        case .failure(.timeout): return .failure(code: "timeout", message: "Vyre did not answer within \(Int(timeout * 1000))ms")
        case .failure(.broken): return .failure(code: "unreachable", message: "Vyre closed the connection")
        case .success(let (_, body)):
            guard let j = VJ.decode(body) as? [String: Any] else {
                return .failure(code: "bad_response", message: String(String(decoding: body, as: UTF8.self).prefix(200)))
            }
            if let e = j["error"] {
                let o = e as? [String: Any]
                return .failure(code: VJ.nonEmpty(o?["code"]) ?? "error", message: VJ.nonEmpty(o?["message"]) ?? VJ.nonEmpty(e) ?? "It did not work.")
            }
            return .success(j["data"] ?? NSNull())
        }
    }
}

// MARK: - The event stream

/// One open /v1/events/stream, read by one thread blocked in poll(2). Frames go to `onEvent`;
/// `onOpen` fires once the head says 200, `onEnd` once when it stops for any reason.
final class SSEConnection: @unchecked Sendable {
    private let socket: String, path: String
    private var wake: [Int32] = [-1, -1]
    private let lock = NSLock()
    private var stopped = false
    let onOpen: @Sendable () -> Void
    let onEvent: @Sendable ([String: Any]) -> Void
    let onEnd: @Sendable () -> Void

    init(socket: String, path: String, onOpen: @escaping @Sendable () -> Void, onEvent: @escaping @Sendable ([String: Any]) -> Void, onEnd: @escaping @Sendable () -> Void) {
        self.socket = socket; self.path = path; self.onOpen = onOpen; self.onEvent = onEvent; self.onEnd = onEnd
        pipe(&wake)
    }

    func start() {
        let t = Thread { [self] in run(); onEnd() }
        t.name = "vyred events"
        t.qualityOfService = .utility
        t.stackSize = 256 * 1024
        t.start()
    }

    private var closed = false

    /// Stop reading. The thread wakes from poll at once and ends.
    func stop() {
        lock.lock(); defer { lock.unlock() }
        // Written under the lock, and only while the pipe is open: a closed fd's number may already
        // belong to someone else.
        if !stopped && !closed { var b: UInt8 = 1; _ = write(wake[1], &b, 1) }
        stopped = true
    }

    private var isStopped: Bool { lock.lock(); defer { lock.unlock() }; return stopped }

    private func run() {
        defer { lock.lock(); closed = true; close(wake[0]); close(wake[1]); lock.unlock() }
        let fd = VySock.connect(socket)
        if fd < 0 { return }
        defer { close(fd) }
        guard VySock.writeAll(fd, VyHTTP.requestBytes("GET", path, body: nil, accept: "text/event-stream"), deadline: Date().addingTimeInterval(5)) else { return }
        var raw = Data(), head: HTTPHead?, chunks = ChunkDecoder(), text = Data()
        var buf = [UInt8](repeating: 0, count: 32 * 1024)
        let sep = Data("\n\n".utf8)
        while !isStopped {
            var fds = [pollfd(fd: fd, events: Int16(POLLIN), revents: 0), pollfd(fd: wake[0], events: Int16(POLLIN), revents: 0)]
            // No timeout: vyred's heartbeat and every event wake it; stop() wakes it through the pipe.
            let r = poll(&fds, 2, -1)
            if r < 0 { if errno == EINTR { continue }; return }
            if fds[1].revents != 0 { return }
            let n = read(fd, &buf, buf.count)
            if n < 0 { if errno == EINTR || errno == EAGAIN { continue }; return }
            if n == 0 { return }
            var got = Data(buf[0..<n])
            if head == nil {
                raw.append(got)
                guard let (h, rest) = HTTPHead.parse(raw) else { if raw.count > 64 << 10 { return }; continue }
                if h.status != 200 { return }
                head = h; raw = Data(); got = rest
                onOpen()
            }
            text.append(head!.chunked ? chunks.feed(got) : got)
            if head!.chunked && chunks.finished { return }
            while let r = text.range(of: sep) {
                let frame = String(decoding: text[text.startIndex..<r.lowerBound], as: UTF8.self)
                text.removeSubrange(text.startIndex..<r.upperBound)
                let data = frame.split(separator: "\n", omittingEmptySubsequences: false)
                    .filter { $0.hasPrefix("data:") }.map { $0.dropFirst(5).trimmingCharacters(in: .whitespaces) }.joined(separator: "\n")
                if data.isEmpty { continue }              // a ": beat" comment keeps the socket warm, nothing more
                if let e = VJ.decode(Data(data.utf8)) as? [String: Any] { onEvent(e) }
            }
            if text.count > 1 << 20 { text.removeAll() }
        }
    }
}

/// Run on the main queue, in the order asked, as the main actor.
func onMain(_ fn: @escaping @MainActor () -> Void) {
    DispatchQueue.main.async { MainActor.assumeIsolated { fn() } }
}

// MARK: - The client

public final class VyredClient: VyredTransport, @unchecked Sendable {
    public enum StreamState: Sendable { case open, down }

    public let socket: String
    private let lock = NSLock()
    private var tools: Set<String> = []
    private var up = false

    public init(socket: String = vyredSocketPath()) { self.socket = socket }

    public var isUp: Bool { lock.lock(); defer { lock.unlock() }; return up }
    /// The server this Mac is paired to, when it is (BoxLink.swift): its asks and its events come through here.
    public let box = BoxLink()
    public func has(_ tool: String) -> Bool {
        lock.lock()
        let local = tools.contains(tool), linkCall = tools.contains(WinkServer.call) || tools.contains(WinkServer.legacyCall)
        lock.unlock()
        return local || (linkCall && box.offers(tool))
    }
    public var toolNames: Set<String> { lock.lock(); defer { lock.unlock() }; return tools }

    func setUp(_ v: Bool) { lock.lock(); up = v; if !v { tools = [] }; lock.unlock() }
    private func setTools(_ t: Set<String>) { lock.lock(); tools = t; up = true; lock.unlock() }

    public func get(_ route: String, timeout: TimeInterval = 10) async -> VyredResult {
        await send("GET", route, nil, timeout: timeout)
    }

    public func getOrdered(_ route: String, timeout: TimeInterval) async -> (data: OJ?, error: String?) {
        let socket = self.socket
        let r = await withCheckedContinuation { (k: CheckedContinuation<Result<(Int, Data), VyHTTP.Failure>, Never>) in
            DispatchQueue.global(qos: .userInitiated).async { k.resume(returning: VyHTTP.exchange(socket: socket, method: "GET", path: route, body: nil, timeout: timeout)) }
        }
        guard case .success(let (_, body)) = r else { return (nil, VyHTTP.result(r, timeout: timeout).error) }
        guard let j = OJ.parse(body) else { return (nil, "Vyre's answer was not JSON") }
        if let e = j["error"] { return (nil, e["message"]?.string ?? e.string ?? "It did not work.") }
        return (j["data"] ?? .null, nil)
    }

    public var now: @Sendable () -> Double = { Date().timeIntervalSince1970 * 1000 }
    /// How long a card waits for the owner's phone, and how often it is looked at (a test shortens both).
    public var yesWaitMs: Double = 300_000
    public var yesPollNanos: UInt64 = 1_500_000_000
    /// A reveal, a copy or a code asks for the five-minute reuse (core lib/one-yes.js REUSE_OPS).
    static let reuseTools: Set<String> = ["vault.reveal", "vault.copy", "vault.totp"]

    public func call(_ tool: String, _ input: [String: Any], presence: Bool) async -> VyredResult {
        await call(tool, input, presence: presence, summary: nil)
    }

    /// A call that may need the person's yes (ADR 0004; one-yes, 0.3.1). vyred answers presence_required with the moment and the exact request it needs approved; the yes then goes the one way: ask a
    /// card (approvals.ask), let Touch ID on this Mac give it (approvals.local-yes, vyred's own dialog), or, when this vyred has no screen of its own, wait while the owner's phone answers
    /// (approvals.status), then call again with the approved card (x-vyre-approval). The old device-key header and the 30-minute session are gone. `summary` is the words the card line now carries.
    public func call(_ tool: String, _ input: [String: Any], presence: Bool, summary: String?) async -> VyredResult {
        guard presence else { return await call(tool, input, timeout: 10) }
        let first = await callDetailed(tool, input, timeout: 30)
        guard first.result.errorCode == "presence_required", let moment = first.error?["moment"] as? String, let request = first.error?["request"] as? [String: Any] else { return first.result }
        var ask: [String: Any] = ["moment": moment, "request": request]
        if Self.reuseTools.contains(tool) { ask["reuse"] = true }
        let asked = await callLocal("approvals.ask", ask, timeout: 10)
        guard let id = (asked.data as? [String: Any])?["id"] as? String else { return asked.error != nil ? asked : .failure(code: "presence", message: "Vyre could not ask for your yes.") }
        let again: () async -> VyredResult = { [self] in await call(tool, input, timeout: 30, headers: ["x-vyre-approval": id]) }
        // On this Mac Touch ID gives the yes at once; anywhere else vyred refuses and the card waits for the phone.
        let here = await callLocal("approvals.local-yes", ["id": id], timeout: 75)
        if let a = (here.data as? [String: Any])?["answered"] as? String, a == "approved" { return await again() }
        let end = now() + yesWaitMs
        while now() < end {
            try? await Task.sleep(nanoseconds: yesPollNanos)
            let st = await callLocal("approvals.status", ["id": id], timeout: 10)
            guard let d = st.data as? [String: Any] else { return st }
            switch d["state"] as? String {
            case "approved": return await again()
            case "waiting": continue
            default: return .failure(code: "presence", message: "That was not approved. Nothing was done.")
            }
        }
        return .failure(code: "presence", message: "Nobody approved it in time. Ask again.")
    }

    /// One tool call to this Mac's own vyred, answered as the result AND the error object when there is one (presence_required names the moment and the request in it).
    private func callDetailed(_ tool: String, _ input: [String: Any], timeout: TimeInterval, headers: [String: String] = [:]) async -> (result: VyredResult, error: [String: Any]?) {
        guard let body = VJ.encode(input) else { return (.failure(code: "bad_input", message: "The input to \(tool) is not JSON."), nil) }
        let socket = self.socket
        return await withCheckedContinuation { (k: CheckedContinuation<(result: VyredResult, error: [String: Any]?), Never>) in
            DispatchQueue.global(qos: .userInitiated).async {
                let r = VyHTTP.exchange(socket: socket, method: "POST", path: "/v1/tools/" + Glass.encode(tool), body: body, timeout: timeout, headers: headers, onHead: { _ in })
                var err: [String: Any]? = nil
                if case .success(let (_, data)) = r, let j = VJ.decode(data) as? [String: Any] { err = j["error"] as? [String: Any] }
                k.resume(returning: (VyHTTP.result(r, timeout: timeout), err))
            }
        }
    }

    public func call(_ tool: String, _ input: [String: Any], timeout: TimeInterval, headers: [String: String],
                     onHeaders: (@Sendable ([String: String]) -> Void)? = nil) async -> VyredResult {
        guard let body = VJ.encode(input) else { return .failure(code: "bad_input", message: "The input to \(tool) is not JSON.") }
        let socket = self.socket
        return await withCheckedContinuation { (k: CheckedContinuation<VyredResult, Never>) in
            DispatchQueue.global(qos: .userInitiated).async {
                k.resume(returning: VyHTTP.result(VyHTTP.exchange(socket: socket, method: "POST", path: "/v1/tools/" + Glass.encode(tool), body: body,
                                                                  timeout: timeout, headers: headers, onHead: { onHeaders?($0.headers) }), timeout: timeout))
            }
        }
    }

    /// A tool call that asks for its live draft (Accept: application/x-ndjson): `onDraft` gets each
    /// {"draft": {id, text}} line as it arrives, then the result comes from the final {"result"} line.
    /// A tool with no draft answers plain JSON, which reads as any other call.
    public func call(_ tool: String, _ input: [String: Any], timeout: TimeInterval,
                     onDraft: @escaping @Sendable (_ id: String, _ text: String) -> Void) async -> VyredResult {
        // A paired Mac's memory is the server's: wink.server.call carries no live draft, so it asks plain (the server's memory.thinking events
        // still draw the stage line, on the same id).
        if box.routes(tool, input) {
            var plain = input
            plain["stream"] = nil
            return await box.call(self, tool, plain, timeout: timeout)
        }
        guard let body = VJ.encode(input) else { return .failure(code: "bad_input", message: "The input to \(tool) is not JSON.") }
        let socket = self.socket
        return await withCheckedContinuation { (k: CheckedContinuation<VyredResult, Never>) in
            DispatchQueue.global(qos: .userInitiated).async {
                let state = NDJSONState()
                let r = VyHTTP.exchange(socket: socket, method: "POST", path: "/v1/tools/" + Glass.encode(tool), body: body, timeout: timeout,
                                        accept: "application/x-ndjson",
                                        onHead: { state.isNDJSON = ($0.headers["content-type"] ?? "").contains("x-ndjson") },
                                        onBody: { d in
                                            guard state.isNDJSON else { return }
                                            for line in state.feed(d) {
                                                guard let j = VJ.decode(line) as? [String: Any], let dr = j["draft"] as? [String: Any] else { continue }
                                                onDraft(VJ.s(dr["id"]), VJ.s(dr["text"]))
                                            }
                                        })
                if state.isNDJSON, case .success(let (status, all)) = r {
                    // The last line is {"result": {data|error}}; the result is what the plain call would have said.
                    let lines = all.split(separator: 0x0A).map { Data($0) }
                    let last = lines.last.flatMap { VJ.decode($0) as? [String: Any] }
                    if let res = last?["result"], let one = VJ.encode(res as? [String: Any] ?? [:]) {
                        k.resume(returning: VyHTTP.result(.success((status, one)), timeout: timeout)); return
                    }
                }
                k.resume(returning: VyHTTP.result(r, timeout: timeout))
            }
        }
    }

    public func call(_ tool: String, _ input: [String: Any], timeout: TimeInterval) async -> VyredResult {
        if box.routes(tool, input) { return await box.call(self, tool, input, timeout: timeout) }
        return await callLocal(tool, input, timeout: timeout)
    }

    /// The same call to this Mac's own vyred, never to the server.
    func callLocal(_ tool: String, _ input: [String: Any], timeout: TimeInterval) async -> VyredResult {
        guard let body = VJ.encode(input) else { return .failure(code: "bad_input", message: "The input to \(tool) is not JSON.") }
        return await send("POST", "/v1/tools/" + Glass.encode(tool), body, timeout: timeout)
    }

    private func send(_ method: String, _ route: String, _ body: Data?, timeout: TimeInterval) async -> VyredResult {
        let socket = self.socket
        return await withCheckedContinuation { (k: CheckedContinuation<VyredResult, Never>) in
            DispatchQueue.global(qos: .userInitiated).async {
                k.resume(returning: VyHTTP.result(VyHTTP.exchange(socket: socket, method: method, path: route, body: body, timeout: timeout), timeout: timeout))
            }
        }
    }

    /// GET /v1/tools: what this caller may use. Refreshes has(). An error means vyred is not there.
    @discardableResult
    public func refreshTools() async -> VyredResult {
        let r = await get("/v1/tools", timeout: 5)
        if case .success(let d) = r {
            let names = ((d as? [Any]) ?? []).compactMap { ($0 as? String) ?? VJ.str(($0 as? [String: Any])?["name"]) }
            setTools(Set(names))
        } else {
            setUp(false)
        }
        return r
    }

    // MARK: events

    private final class Sub: VyredSubscription, @unchecked Sendable {
        let pattern: String
        let handler: @MainActor (VyredEvent) -> Void
        weak var owner: VyredClient?
        init(_ p: String, _ h: @escaping @MainActor (VyredEvent) -> Void, _ o: VyredClient) { pattern = p; handler = h; owner = o }
        func cancel() { owner?.remove(self) }
        func matches(_ type: String) -> Bool {
            pattern == "*" || pattern == type || (pattern.hasSuffix(".*") && type.hasPrefix(String(pattern.dropLast(1))))
        }
    }

    private var subs: [Sub] = []

    public func on(_ pattern: String, _ handler: @escaping @MainActor (VyredEvent) -> Void) -> VyredSubscription {
        let s = Sub(pattern, handler, self)
        lock.lock(); subs.append(s); lock.unlock()
        return s
    }

    private func remove(_ s: Sub) { lock.lock(); subs.removeAll { $0 === s }; lock.unlock() }

    /// Hand one event to everyone following its type, on the main actor.
    @MainActor func dispatch(_ e: VyredEvent) {
        lock.lock(); let now = subs.filter { $0.matches(e.type) }; lock.unlock()
        for s in now { s.handler(e) }
    }

    // MARK: following

    /// Follows vyred: health, then the stream, then backoff when it is gone. Created on first use.
    @MainActor public private(set) lazy var follower = VyredFollower(client: self, clock: SystemClock())

    /// Use a clock of your own (tests) before anything starts following.
    @MainActor public func useClock(_ clock: VyClock) { follower = VyredFollower(client: self, clock: clock) }
}

/// main.js follow(), on the main actor: GET /v1/health; if it fails, try again after 3 s shown or
/// a doubling wait (3 s to 60 s) hidden; if it answers, follow the stream from where the last one
/// left off, and when the stream ends, start over.
@MainActor
public final class VyredFollower {
    weak var client: VyredClient?
    let clock: VyClock
    public private(set) var shown = false
    public private(set) var started = false
    /// The next wait while hidden and down, in seconds.
    public private(set) var wait: TimeInterval = 3
    /// Seconds each retry was scheduled for, newest last (for tests and the perf check).
    public private(set) var retries: [TimeInterval] = []
    private var timer: VyTimer?
    private var stream: SSEConnection?
    private var generation = 0
    /// The newest event id heard.
    public private(set) var lastEvent = 0
    /// Told when the stream opens (after has() is refreshed) or goes down.
    public var onState: ((VyredClient.StreamState) -> Void)?
    public var isStreaming: Bool { stream != nil }
    public var isWaiting: Bool { timer != nil }

    init(client: VyredClient, clock: VyClock) { self.client = client; self.clock = clock }

    public func start() {
        guard !started else { return }
        started = true
        Task { await follow() }
    }

    /// Stop following: no stream, no timer.
    public func stop() {
        started = false
        generation += 1
        timer?.cancel(); timer = nil
        stream?.stop(); stream = nil
    }

    /// Look for vyred now rather than at the next retry (the Capsule just started it).
    public func lookNow() {
        if started, stream == nil { Task { await follow() } }
    }

    /// The Capsule showed or hid. Showing looks for a missing vyred at once.
    public func setShown(_ on: Bool) {
        shown = on
        if on, started, stream == nil, timer != nil { Task { await follow() } }
    }

    func follow() async {
        guard started else { return }
        timer?.cancel(); timer = nil
        let gen = generation
        guard let client else { return }
        let h = await client.get("/v1/health", timeout: 3)
        guard started, gen == generation, stream == nil else { return }
        guard case .success(let data) = h else {
            client.setUp(false)
            onState?(.down)
            retry()
            return
        }
        wait = 3
        let last = VJ.int((data as? [String: Any])?["last_event"]) ?? 0
        // Resume where the last stream stopped, so nothing is missed; from now when this vyred's
        // log is newer than anything heard (a fresh home), since the waiting list is read whole.
        let since = lastEvent > 0 && lastEvent <= last ? lastEvent : last
        if lastEvent == 0 || lastEvent > last { lastEvent = last }
        open(since: since)
    }

    private func retry() {
        let s = shown ? 3 : wait
        retries.append(s)
        timer = clock.schedule(after: s) { [weak self] in Task { await self?.follow() } }
        if !shown { wait = min(wait * 2, 60) }
    }

    private func open(since: Int) {
        let gen = generation
        guard let socket = client?.socket else { return }
        let conn = SSEConnection(socket: socket, path: "/v1/events/stream?type=*&since=\(since)",
            onOpen: { [weak self] in
                onMain {
                    guard let self, gen == self.generation else { return }
                    Task { await self.client?.refreshTools(); if let c = self.client { await c.box.refresh(c) }; if gen == self.generation { self.onState?(.open) } }
                }
            },
            onEvent: { [weak self] json in
                guard let e = VyredEvent(json: json) else { return }
                // In order, on the main queue: a Task per event would not promise the order.
                onMain {
                    guard let self, gen == self.generation else { return }
                    if e.id > 0 && e.id <= self.lastEvent { return }
                    if e.id > 0 { self.lastEvent = e.id }
                    self.client?.dispatch(e)
                }
            },
            onEnd: { [weak self] in
                onMain {
                    guard let self, gen == self.generation else { return }
                    self.stream = nil
                    self.client?.setUp(false)
                    self.onState?(.down)
                    // Not at once: a vyred that accepts and drops would make this a busy loop.
                    self.retry()
                }
            })
        stream = conn
        conn.start()
    }
}
