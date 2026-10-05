// BoxSocket: a WebSocket from the Mac app's window to vyred. A custom URL scheme (vyreapp://) cannot carry a WebSocket, so the chat and terminal streams, which the
// page opens on vyred's ticketed /v1/streams/<module>/<name>, never connected in this window. The page's WebSocket is replaced (VyreAppWindow.wsShimSource) by one that
// asks the app to open the stream; the app opens it on vyred's unix socket as the "capsule" caller, speaks the WebSocket protocol there (RFC 6455: the upgrade, masked
// client frames, unmasked server frames, ping and close), and hands each message back to the page.
//
// The frame codec (`WS`, `WSDecoder`) is pure so the Swift tests run it with the RFC's own examples; BoxSocket is one blocking thread in poll(2), as SSEConnection is.

import CryptoKit
import Foundation

enum WSMessage: Equatable {
    case text(String)
    case binary(Data)
    case ping(Data)
    case pong(Data)
    case close(code: Int, reason: String)
}

enum WS {
    static let guid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
    /// The Sec-WebSocket-Accept a server must answer for this Sec-WebSocket-Key.
    static func acceptKey(_ key: String) -> String {
        Data(Insecure.SHA1.hash(data: Data((key + guid).utf8))).base64EncodedString()
    }

    /// One client frame (FIN set, masked with `mask`, four bytes).
    static func frame(opcode: UInt8, payload: Data, mask: [UInt8]) -> Data {
        precondition(mask.count == 4)
        var out = Data([0x80 | opcode])
        let n = payload.count
        if n < 126 { out.append(UInt8(0x80 | n)) }
        else if n <= 0xFFFF { out.append(0x80 | 126); out.append(UInt8(n >> 8)); out.append(UInt8(n & 0xFF)) }
        else { out.append(0x80 | 127); for s in stride(from: 56, through: 0, by: -8) { out.append(UInt8((UInt64(n) >> UInt64(s)) & 0xFF)) } }
        out.append(contentsOf: mask)
        var i = 0
        for b in payload { out.append(b ^ mask[i & 3]); i += 1 }
        return out
    }

    static func closePayload(code: Int, reason: String) -> Data {
        var d = Data([UInt8((code >> 8) & 0xFF), UInt8(code & 0xFF)])
        d.append(Data(reason.utf8.prefix(120)))
        return d
    }

    static func randomMask() -> [UInt8] { (0..<4).map { _ in UInt8.random(in: 0...255) } }
}

/// Reads server frames (and tolerates masked ones) into whole messages. A protocol error sets `failed` and the connection ends.
struct WSDecoder {
    private var buf = [UInt8]()
    private var fragOpcode: UInt8?
    private var frag = [UInt8]()
    private(set) var failed = false
    /// The largest message taken: a stream message is a few KB; this is only a bound.
    static let maxMessage = 16 * 1024 * 1024

    mutating func feed(_ data: Data) -> [WSMessage] {
        guard !failed else { return [] }
        buf.append(contentsOf: data)
        var out = [WSMessage]()
        while true {
            switch step() {
            case .need: return out
            case .part: continue
            case .message(let m): out.append(m)
            }
            if failed { return out }
        }
    }

    private enum Step { case need, part, message(WSMessage) }

    /// One frame off the front of the buffer: `.need` when it is not whole yet (or the stream failed), `.part` for a frame of a longer message.
    private mutating func step() -> Step {
        guard buf.count >= 2 else { return .need }
        let fin = buf[0] & 0x80 != 0, opcode = buf[0] & 0x0F
        if buf[0] & 0x70 != 0 { failed = true; return .need } // reserved bits: no extension was asked for
        let masked = buf[1] & 0x80 != 0
        var len = Int(buf[1] & 0x7F), at = 2
        if len == 126 {
            guard buf.count >= 4 else { return .need }
            len = Int(buf[2]) << 8 | Int(buf[3]); at = 4
        } else if len == 127 {
            guard buf.count >= 10 else { return .need }
            var v: UInt64 = 0
            for i in 2..<10 { v = v << 8 | UInt64(buf[i]) }
            guard v <= UInt64(Self.maxMessage) else { failed = true; return .need }
            len = Int(v); at = 10
        }
        if opcode >= 8 && (!fin || len > 125) { failed = true; return .need }
        if len > Self.maxMessage { failed = true; return .need }
        let maskLen = masked ? 4 : 0
        guard buf.count >= at + maskLen + len else { return .need }
        var payload = Array(buf[(at + maskLen)..<(at + maskLen + len)])
        if masked { let k = Array(buf[at..<(at + 4)]); for i in payload.indices { payload[i] ^= k[i & 3] } }
        buf.removeFirst(at + maskLen + len)
        switch opcode {
        case 0x8:
            let code = payload.count >= 2 ? Int(payload[0]) << 8 | Int(payload[1]) : 1005
            return .message(.close(code: code, reason: payload.count > 2 ? String(decoding: payload[2...], as: UTF8.self) : ""))
        case 0x9: return .message(.ping(Data(payload)))
        case 0xA: return .message(.pong(Data(payload)))
        case 0x1, 0x2:
            if fragOpcode != nil { failed = true; return .need }
            if fin { return .message(opcode == 0x1 ? .text(String(decoding: payload, as: UTF8.self)) : .binary(Data(payload))) }
            fragOpcode = opcode; frag = payload
            return .part
        case 0x0:
            guard let first = fragOpcode else { failed = true; return .need }
            frag.append(contentsOf: payload)
            if frag.count > Self.maxMessage { failed = true; return .need }
            guard fin else { return .part }
            let all = frag; fragOpcode = nil; frag = []
            return .message(first == 0x1 ? .text(String(decoding: all, as: UTF8.self)) : .binary(Data(all)))
        default:
            failed = true; return .need
        }
    }
}

/// One WebSocket to vyred, on its own thread. Callbacks come from that thread. `onClose` fires exactly once, with the close code (1006 when the connection just ended).
final class BoxSocket: @unchecked Sendable {
    private let socket: String, path: String
    private let onOpen: @Sendable () -> Void
    private let onMessage: @Sendable (WSMessage) -> Void
    private let onClose: @Sendable (Int, String) -> Void
    private let lock = NSLock()
    private var fd: Int32 = -1
    private var wake: [Int32] = [-1, -1]
    private var stopping = false
    private var closeSent = false
    private var closeCode = 1005, closeReason = ""

    init(socket: String, path: String, onOpen: @escaping @Sendable () -> Void, onMessage: @escaping @Sendable (WSMessage) -> Void, onClose: @escaping @Sendable (Int, String) -> Void) {
        self.socket = socket; self.path = path; self.onOpen = onOpen; self.onMessage = onMessage; self.onClose = onClose
        pipe(&wake)
    }

    func start() {
        let t = Thread { [self] in
            let (code, reason) = run()
            if wake[0] >= 0 { Darwin.close(wake[0]); Darwin.close(wake[1]) }
            onClose(code, reason)
        }
        t.name = "stream socket"
        t.qualityOfService = .userInitiated
        t.stackSize = 512 * 1024
        t.start()
    }

    /// Send a text or binary message. False when the socket is not open.
    @discardableResult func send(_ m: WSMessage) -> Bool {
        let (op, payload): (UInt8, Data)
        switch m {
        case .text(let s): (op, payload) = (0x1, Data(s.utf8))
        case .binary(let d): (op, payload) = (0x2, d)
        case .ping(let d): (op, payload) = (0x9, d)
        case .pong(let d): (op, payload) = (0xA, d)
        case .close(let c, let r): (op, payload) = (0x8, WS.closePayload(code: c, reason: r))
        }
        return write(WS.frame(opcode: op, payload: payload, mask: WS.randomMask()))
    }

    /// Ask the server to close (the page's close()); the thread ends when it answers, or at once if it does not within two seconds.
    func close(code: Int = 1000, reason: String = "") {
        lock.lock()
        let first = !closeSent
        closeSent = true; closeCode = code; closeReason = reason
        lock.unlock()
        if first { _ = send(.close(code: code, reason: reason)) }
        DispatchQueue.global().asyncAfter(deadline: .now() + 2) { [weak self] in self?.stop() }
    }

    /// End the thread now.
    func stop() {
        lock.lock(); defer { lock.unlock() }
        if !stopping, wake[1] >= 0 { stopping = true; var b: UInt8 = 1; _ = Darwin.write(wake[1], &b, 1) }
    }

    private func write(_ d: Data) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard fd >= 0, !stopping else { return false }
        return VySock.writeAll(fd, d, deadline: Date().addingTimeInterval(10))
    }

    private func run() -> (Int, String) {
        let f = VySock.connect(socket)
        if f < 0 { return (1006, "") }
        defer { lock.lock(); fd = -1; lock.unlock(); Darwin.close(f) }
        let key = Data((0..<16).map { _ in UInt8.random(in: 0...255) }).base64EncodedString()
        let req = "GET \(path) HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: \(key)\r\nSec-WebSocket-Version: 13\r\nx-vyre-caller: capsule\r\n\r\n"
        guard VySock.writeAll(f, Data(req.utf8), deadline: Date().addingTimeInterval(10)) else { return (1006, "") }
        var raw = Data(), head: HTTPHead?, rest = Data()
        let headDeadline = Date().addingTimeInterval(10)
        var buf = [UInt8](repeating: 0, count: 64 * 1024)
        while head == nil {
            guard VySock.waitFor(f, Int16(POLLIN), deadline: headDeadline) else { return (1006, "") }
            let n = read(f, &buf, buf.count)
            if n < 0 { if errno == EINTR || errno == EAGAIN { continue }; return (1006, "") }
            if n == 0 { return (1006, "") }
            raw.append(contentsOf: buf[0..<n])
            if let (h, r) = HTTPHead.parse(raw) { head = h; rest = r }
        }
        guard let h = head, h.status == 101, h.headers["sec-websocket-accept"] == WS.acceptKey(key) else { return (1006, "") }
        lock.lock(); fd = f; lock.unlock()
        onOpen()
        var decoder = WSDecoder()
        func handle(_ msgs: [WSMessage]) -> (Int, String)? {
            for m in msgs {
                switch m {
                case .ping(let d): send(.pong(d))
                case .pong: break
                case .close(let c, let r):
                    lock.lock(); let already = closeSent; closeSent = true; lock.unlock()
                    if !already { _ = send(.close(code: c == 1005 ? 1000 : c, reason: "")) }
                    return (c, r)
                default: onMessage(m)
                }
            }
            return nil
        }
        if !rest.isEmpty, let done = handle(decoder.feed(rest)) { return done }
        while true {
            if decoder.failed { return (1002, "") }
            var fds = [pollfd(fd: f, events: Int16(POLLIN), revents: 0), pollfd(fd: wake[0], events: Int16(POLLIN), revents: 0)]
            let r = poll(&fds, 2, -1)
            if r < 0 { if errno == EINTR { continue }; return (1006, "") }
            if fds[1].revents != 0 { lock.lock(); let c = (closeCode, closeReason); lock.unlock(); return c }
            if fds[0].revents & Int16(POLLIN | POLLHUP) != 0 {
                let n = read(f, &buf, buf.count)
                if n < 0 { if errno == EINTR || errno == EAGAIN { continue }; return (1006, "") }
                if n == 0 { return (1006, "") }
                if let done = handle(decoder.feed(Data(buf[0..<n]))) { return done }
            }
        }
    }
}
