// FakeVyred: a vyred stand-in for the Capsule's tests, in this process, under the scratch dir.
//
// A real unix-socket HTTP server, so the client's socket, parser and stream reader are what is
// tested, not a mock of them: /v1/health, /v1/tools, /v1/modules, /v1/events, tool calls, and
// /v1/events/stream written chunked, the way Node writes it. Tools are closures; emit() pushes an
// event to every open stream. It records each call and the caller header it came with.
//
// Also here: FakeLink (a VyredTransport from one closure, for code that needs no socket),
// ManualClock (time that moves only when a test says), and vyScratch (where test files go).

import Foundation

/// A folder for this test run's files: VYRE_CAPSULE_SCRATCH when set, else the system temp dir.
func vyScratch(_ name: String) -> String {
    let base = ProcessInfo.processInfo.environment["VYRE_CAPSULE_SCRATCH"].flatMap { $0.isEmpty ? nil : $0 }
        ?? (NSTemporaryDirectory() as NSString).appendingPathComponent("vyre-capsule-tests-\(getpid())")
    let dir = (base as NSString).appendingPathComponent(name)
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    return dir
}

struct FakeError: Error { var code: String; var message: String }

final class FakeVyred: @unchecked Sendable {
    typealias Tool = ([String: Any]) -> Any
    let socket: String
    private let lock = NSLock()
    private var tools: [String: Tool] = [:]
    private var toolOrder: [String] = []
    /// Tools listed by GET /v1/tools without a handler (a call answers no_such_tool).
    var listed: [String] = []
    var modules: [Any] = []
    var eventsLog: [[String: Any]] = []
    private(set) var calls: [(tool: String, input: [String: Any])] = []
    private(set) var callers: Set<String> = []
    private(set) var streamsOpened = 0
    private(set) var healthChecks = 0
    private var lastId = 0
    private var listenFd: Int32 = -1
    private var wake: [Int32] = [-1, -1]
    private var streams: [Int32] = []
    private var stopped = false

    init(name: String = "vyred-\(UUID().uuidString.prefix(8))") {
        socket = (vyScratch("sock") as NSString).appendingPathComponent("\(name).sock")
    }

    func tool(_ name: String, _ fn: @escaping Tool) {
        lock.lock(); if tools[name] == nil { toolOrder.append(name) }; tools[name] = fn; lock.unlock()
    }

    func callsOf(_ tool: String) -> [[String: Any]] { lock.lock(); defer { lock.unlock() }; return calls.filter { $0.tool == tool }.map(\.input) }
    var callNames: [String] { lock.lock(); defer { lock.unlock() }; return calls.map(\.tool) }
    var openStreams: Int { lock.lock(); defer { lock.unlock() }; return streams.count }

    // MARK: lifecycle

    @discardableResult
    func start() -> Bool {
        unlink(socket)
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        let ok = VySock.withShortPath(socket) { name in
            var addr = sockaddr_un()
            guard VySock.fill(&addr, name) else { return false }
            return withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } } == 0
        }
        guard ok, listen(fd, 16) == 0 else { close(fd); return false }
        lock.lock(); listenFd = fd; stopped = false; pipe(&wake); lock.unlock()
        let t = Thread { [self] in acceptLoop(fd) }
        t.start()
        return true
    }

    /// vyred went away: the socket closes, every stream ends, the file goes.
    func stop() {
        lock.lock()
        let was = stopped
        stopped = true
        if !was { var b: UInt8 = 1; _ = write(wake[1], &b, 1) }
        for s in streams { shutdown(s, SHUT_RDWR) }
        streams = []
        lock.unlock()
        unlink(socket)
        // Let the accept loop close its fds.
        usleep(20_000)
    }

    private func acceptLoop(_ fd: Int32) {
        let w = wake[0]
        defer { lock.lock(); close(fd); close(wake[0]); close(wake[1]); lock.unlock() }
        while true {
            var fds = [pollfd(fd: fd, events: Int16(POLLIN), revents: 0), pollfd(fd: w, events: Int16(POLLIN), revents: 0)]
            if poll(&fds, 2, -1) < 0 { if errno == EINTR { continue }; return }
            if fds[1].revents != 0 { return }
            let c = accept(fd, nil, nil)
            if c < 0 { continue }
            var one: Int32 = 1
            setsockopt(c, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
            Thread { [self] in serve(c) }.start()
        }
    }

    // MARK: one connection

    private func serve(_ c: Int32) {
        var raw = Data()
        var buf = [UInt8](repeating: 0, count: 16 * 1024)
        var head: HTTPHead?, body = Data(), line = ""
        while true {
            let n = read(c, &buf, buf.count)
            if n <= 0 { close(c); return }
            raw.append(contentsOf: buf[0..<n])
            if head == nil, let (h, rest) = HTTPHead.parse(raw) {
                head = h; body = rest
                line = String(decoding: raw.prefix(while: { $0 != 13 }), as: UTF8.self)
            } else if head != nil { body.append(contentsOf: buf[0..<n]) }
            if let h = head, body.count >= (h.length ?? 0) { break }
        }
        let parts = line.split(separator: " ")
        let method = parts.count > 0 ? String(parts[0]) : "", target = parts.count > 1 ? String(parts[1]) : "/"
        lock.lock(); if let who = head?.headers["x-vyre-caller"] { callers.insert(who) }; lock.unlock()
        let path = String(target.split(separator: "?", maxSplits: 1).first ?? "")
        let query = target.contains("?") ? String(target.split(separator: "?", maxSplits: 1)[1]) : ""
        if method == "GET" && path == "/v1/events/stream" { return stream(c, query) }
        let answer = route(method, path, query, body)
        respond(c, answer)
        close(c)
    }

    private func route(_ method: String, _ path: String, _ query: String, _ body: Data) -> Any {
        if method == "GET" && path == "/v1/health" {
            lock.lock(); healthChecks += 1; let last = lastId; lock.unlock()
            return ["data": ["version": "test", "last_event": last]]
        }
        if method == "GET" && path == "/v1/tools" {
            lock.lock(); let names = toolOrder + listed; lock.unlock()
            return ["data": names.map { ["name": $0] }]
        }
        if method == "GET" && path == "/v1/modules" { lock.lock(); defer { lock.unlock() }; return ["data": modules] }
        if method == "GET" && path == "/v1/events" {
            lock.lock(); defer { lock.unlock() }
            let type = query.split(separator: "&").first { $0.hasPrefix("type=") }.map { String($0.dropFirst(5)) }
            return ["data": eventsLog.filter { type == nil || VJ.str($0["type"]) == type }]
        }
        if method == "POST" && path.hasPrefix("/v1/tools/") {
            let name = String(path.dropFirst("/v1/tools/".count)).removingPercentEncoding ?? ""
            let input = (VJ.decode(body) as? [String: Any]) ?? [:]
            lock.lock(); calls.append((name, input)); let fn = tools[name]; lock.unlock()
            guard let fn else { return ["error": ["code": "no_such_tool", "message": "no tool \(name)."]] }
            let out = fn(input)
            if let e = out as? FakeError { return ["error": ["code": e.code, "message": e.message]] }
            return ["data": out]
        }
        return ["error": ["code": "not_found", "message": "no route \(path)"]]
    }

    private func respond(_ c: Int32, _ json: Any) {
        let body = VJ.encode(json) ?? Data("{}".utf8)
        var d = Data("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n".utf8)
        d.append(body)
        _ = VySock.writeAll(c, d, deadline: Date().addingTimeInterval(5))
    }

    // MARK: the stream

    private func chunk(_ s: String) -> Data {
        let b = Data(s.utf8)
        var d = Data(String(b.count, radix: 16).utf8); d.append(Data("\r\n".utf8)); d.append(b); d.append(Data("\r\n".utf8))
        return d
    }

    private func frame(_ e: [String: Any]) -> Data {
        chunk("id: \(VJ.s(e["id"]))\nevent: \(VJ.s(e["type"]))\ndata: \(String(decoding: VJ.encode(e) ?? Data(), as: UTF8.self))\n\n")
    }

    private func stream(_ c: Int32, _ query: String) {
        let since = query.split(separator: "&").first { $0.hasPrefix("since=") }.flatMap { Int($0.dropFirst(6)) } ?? 0
        lock.lock()
        if stopped { lock.unlock(); close(c); return }
        streamsOpened += 1
        var d = Data("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n".utf8)
        for e in eventsLog where (VJ.int(e["id"]) ?? 0) > since { d.append(frame(e)) }
        streams.append(c)
        _ = VySock.writeAll(c, d, deadline: Date().addingTimeInterval(5))
        lock.unlock()
        // Hold it open until the client or stop() closes it.
        var buf = [UInt8](repeating: 0, count: 256)
        while read(c, &buf, buf.count) > 0 {}
        lock.lock(); streams.removeAll { $0 == c }; lock.unlock()
        close(c)
    }

    /// Log an event and send it to every open stream. Returns its id.
    @discardableResult
    func emit(_ type: String, thread: String? = nil, project: String? = nil, _ payload: [String: Any] = [:]) -> Int {
        lock.lock(); defer { lock.unlock() }
        lastId += 1
        let e: [String: Any] = ["id": lastId, "type": type, "source": "test", "thread": thread ?? NSNull(), "project": project ?? NSNull(),
                                "at": 1000 * lastId, "payload": payload]
        eventsLog.append(e)
        let f = frame(e)
        for s in streams { _ = VySock.writeAll(s, f, deadline: Date().addingTimeInterval(2)) }
        return lastId
    }

    /// A heartbeat comment, as vyred writes every 15 s.
    func beat() {
        lock.lock(); defer { lock.unlock() }
        for s in streams { _ = VySock.writeAll(s, chunk(": beat\n\n"), deadline: Date().addingTimeInterval(2)) }
    }
}

/// A VyredTransport from one closure: for code that needs vyred's answers and no socket.
final class FakeLink: VyredTransport, @unchecked Sendable {
    let answer: (String, [String: Any]) async -> VyredResult
    var getAnswer: (String) async -> VyredResult = { _ in .failure(code: "not_found", message: "no") }
    var tools: Set<String> = []
    private let lock = NSLock()
    private var log: [(String, [String: Any], TimeInterval)] = []
    init(_ answer: @escaping (String, [String: Any]) async -> VyredResult) { self.answer = answer }
    var isUp: Bool { true }
    func has(_ tool: String) -> Bool { tools.contains(tool) }
    func on(_ pattern: String, _ handler: @escaping @MainActor (VyredEvent) -> Void) -> VyredSubscription { NoSub() }
    func call(_ tool: String, _ input: [String: Any], presence: Bool) async -> VyredResult { await call(tool, input, timeout: 10) }
    func call(_ tool: String, _ input: [String: Any], timeout: TimeInterval) async -> VyredResult {
        record(tool, input, timeout)
        return await answer(tool, input)
    }
    private func record(_ tool: String, _ input: [String: Any], _ timeout: TimeInterval) { lock.lock(); log.append((tool, input, timeout)); lock.unlock() }
    func get(_ route: String, timeout: TimeInterval) async -> VyredResult { await getAnswer(route) }
    var calls: [(tool: String, input: [String: Any], timeout: TimeInterval)] { lock.lock(); defer { lock.unlock() }; return log.map { ($0.0, $0.1, $0.2) } }
    private final class NoSub: VyredSubscription { func cancel() {} }
}

/// Time that moves only when the test says. Timers fire on advance(), on the main actor.
final class ManualClock: VyClock, @unchecked Sendable {
    final class T: VyTimer { let due: TimeInterval; let fn: @MainActor () -> Void; var cancelled = false
        init(_ d: TimeInterval, _ f: @escaping @MainActor () -> Void) { due = d; fn = f }
        func cancel() { cancelled = true } }
    private(set) var now: TimeInterval = 0
    private var timers: [T] = []
    func schedule(after seconds: TimeInterval, _ fn: @escaping @MainActor () -> Void) -> VyTimer {
        let t = T(now + seconds, fn); timers.append(t); return t
    }
    var pending: [TimeInterval] { timers.filter { !$0.cancelled }.map { $0.due - now } }
    @MainActor func advance(_ s: TimeInterval) {
        now += s
        let due = timers.filter { !$0.cancelled && $0.due <= now }
        timers.removeAll { $0.cancelled || $0.due <= now }
        for t in due { t.fn() }
    }
}

/// Spin the main run loop until `cond` holds or `timeout` passes. True if it held.
@MainActor func until(_ timeout: TimeInterval = 5, _ cond: () -> Bool) -> Bool {
    let end = Date().addingTimeInterval(timeout)
    while !cond() {
        if Date() > end { return false }
        RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.005))
    }
    return true
}
