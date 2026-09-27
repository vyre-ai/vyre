// Stream: a WebSocket to one of vyred's streams (/v1/streams/<module>/<name>) over the unix
// socket, as the "capsule" caller. What VyredLink.stream(_:) hands an extension, so none needs
// the socket or the framing of its own. Adapted from capsule-sight's ListenSocket (Talk.swift).
//
// One reader thread, blocked in read(2), while the stream is open; nothing exists before or
// after. Messages are JSON text frames; binary goes out with sendBinary (audio, for voice).

import CryptoKit
import Foundation

/// RFC 6455 framing, just enough: the client masks, the server does not, fragments are joined.
enum VyWS {
    static func encode(_ payload: Data, opcode: UInt8, mask: Bool) -> Data {
        var out = Data([0x80 | opcode])
        let bit: UInt8 = mask ? 0x80 : 0
        let n = payload.count
        if n < 126 { out.append(bit | UInt8(n)) }
        else if n < 65536 { out.append(bit | 126); out.append(UInt8(n >> 8)); out.append(UInt8(n & 0xff)) }
        else { out.append(bit | 127); for s in stride(from: 56, through: 0, by: -8) { out.append(UInt8((UInt64(n) >> UInt64(s)) & 0xff)) } }
        guard mask else { out.append(payload); return out }
        var key = [UInt8](repeating: 0, count: 4)
        _ = SecRandomCopyBytes(kSecRandomDefault, 4, &key)
        out.append(contentsOf: key)
        var i = 0
        for b in payload { out.append(b ^ key[i & 3]); i += 1 }
        return out
    }

    enum Message: Equatable { case text(String), binary(Data), close, ping(Data), pong }

    /// Cuts bytes into whole messages as they arrive.
    struct Parser {
        private var buf = Data()
        private var frag = Data()
        private var fragOp: UInt8 = 0

        mutating func feed(_ d: Data) -> [Message] {
            buf.append(d)
            var out: [Message] = []
            while true {
                let b = [UInt8](buf.prefix(14))
                guard b.count >= 2 else { break }
                let fin = b[0] & 0x80 != 0, op = b[0] & 0x0f, masked = b[1] & 0x80 != 0
                var len = Int(b[1] & 0x7f), off = 2
                if len == 126 { guard b.count >= 4 else { break }; len = Int(b[2]) << 8 | Int(b[3]); off = 4 }
                else if len == 127 {
                    guard b.count >= 10 else { break }
                    len = 0; for i in 2..<10 { len = len << 8 | Int(b[i]) }; off = 10
                }
                var key: [UInt8] = []
                if masked { guard b.count >= off + 4 else { break }; key = Array(b[off..<off + 4]); off += 4 }
                guard buf.count >= off + len else { break }
                var payload = Data(buf[buf.startIndex + off ..< buf.startIndex + off + len])
                if masked { payload = Data(payload.enumerated().map { $0.element ^ key[$0.offset & 3] }) }
                buf = Data(buf.dropFirst(off + len))
                switch op {
                case 0x8: out.append(.close)
                case 0x9: out.append(.ping(payload))
                case 0xA: out.append(.pong)
                case 0x0, 0x1, 0x2:
                    if op != 0 { fragOp = op; frag = Data() }
                    frag.append(payload)
                    if fin { out.append(fragOp == 1 ? .text(String(decoding: frag, as: UTF8.self)) : .binary(frag)); frag = Data() }
                default: out.append(.close)
                }
            }
            return out
        }
    }

    static func acceptKey(_ key: String) -> String {
        Data(Insecure.SHA1.hash(data: Data((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8))).base64EncodedString()
    }
}

final class VyredSocketStream: VyredStream, @unchecked Sendable {
    private let fd: Int32
    private let lock = NSLock()
    private var closed = false

    private init(fd: Int32) { self.fd = fd }

    /// Connect and upgrade. Blocking: call off the main thread.
    static func open(socket: String, path: String, timeout: TimeInterval = 5,
                     onMessage: @escaping @Sendable ([String: Any]) -> Void, onClose: @escaping @Sendable () -> Void) -> Result<VyredStream, VyredStreamFailure> {
        let fd = VySock.connect(socket)
        guard fd >= 0 else { return .failure(VyredStreamFailure(code: "unreachable", message: "vyred is not running. Start it with vyre up.")) }
        let deadline = Date().addingTimeInterval(timeout)
        var raw = [UInt8](repeating: 0, count: 16)
        _ = SecRandomCopyBytes(kSecRandomDefault, 16, &raw)
        let key = Data(raw).base64EncodedString()
        let req = "GET \(path) HTTP/1.1\r\nHost: vyred\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: \(key)\r\nSec-WebSocket-Version: 13\r\nx-vyre-caller: capsule\r\n\r\n"
        guard VySock.writeAll(fd, Data(req.utf8), deadline: deadline) else { Darwin.close(fd); return .failure(VyredStreamFailure(code: "unreachable", message: "vyred did not take the stream")) }
        var got = Data()
        let sep = Data("\r\n\r\n".utf8)
        var chunk = [UInt8](repeating: 0, count: 4096)
        while got.range(of: sep) == nil {
            guard VySock.waitFor(fd, Int16(POLLIN), deadline: deadline) else { Darwin.close(fd); return .failure(VyredStreamFailure(code: "timeout", message: "vyred did not answer the stream in time")) }
            let n = Darwin.read(fd, &chunk, chunk.count)
            if n <= 0 { Darwin.close(fd); return .failure(VyredStreamFailure(code: "refused", message: "vyred closed the stream before it opened")) }
            got.append(contentsOf: chunk[0..<n])
        }
        let r = got.range(of: sep)!
        let head = String(decoding: got[..<r.lowerBound], as: UTF8.self)
        let rest = Data(got[r.upperBound...])
        let lines = head.components(separatedBy: "\r\n")
        let status = lines.first.flatMap { $0.split(separator: " ").dropFirst().first }.flatMap { Int($0) } ?? 0
        guard status == 101 else {
            Darwin.close(fd)
            var message = "vyred refused the stream (\(status))"
            if let obj = try? JSONSerialization.jsonObject(with: rest) as? [String: Any],
               let e = obj["error"] as? [String: Any], let m = e["message"] as? String { message = m }
            if status == 404 { return .failure(VyredStreamFailure(code: "not_found", message: "vyred has no stream at \(path)")) }
            return .failure(VyredStreamFailure(code: "refused", message: message))
        }
        let accept = lines.dropFirst().first { $0.lowercased().hasPrefix("sec-websocket-accept:") }
            .map { String($0.split(separator: ":", maxSplits: 1)[1]).trimmingCharacters(in: .whitespaces) }
        guard accept == VyWS.acceptKey(key) else { Darwin.close(fd); return .failure(VyredStreamFailure(code: "refused", message: "the stream did not answer as a WebSocket")) }
        let s = VyredSocketStream(fd: fd)
        s.read(first: rest, onMessage: onMessage, onClose: onClose)
        return .success(s)
    }

    private func read(first: Data, onMessage: @escaping @Sendable ([String: Any]) -> Void, onClose: @escaping @Sendable () -> Void) {
        let t = Thread { [self] in
            var parser = VyWS.Parser()
            var pending = first
            var buf = [UInt8](repeating: 0, count: 8192)
            loop: while true {
                for m in parser.feed(pending) {
                    switch m {
                    case .text(let s):
                        if let obj = try? JSONSerialization.jsonObject(with: Data(s.utf8)) as? [String: Any] { onMessage(obj) }
                    case .ping(let p): write(VyWS.encode(p, opcode: 0xA, mask: true))
                    case .close: break loop
                    default: break
                    }
                }
                let n = Darwin.read(fd, &buf, buf.count)
                if n <= 0 { break }
                pending = Data(buf[0..<n])
            }
            close()
            // Only this thread closes the descriptor, so it is never reused under a read.
            Darwin.close(fd)
            onClose()
        }
        t.name = "vyre.capsule.stream"
        t.start()
    }

    private func write(_ d: Data) {
        lock.lock(); defer { lock.unlock() }
        if closed { return }
        _ = VySock.writeAll(fd, d, deadline: Date().addingTimeInterval(5))
    }

    func sendBinary(_ d: Data) { write(VyWS.encode(d, opcode: 0x2, mask: true)) }

    func sendJSON(_ obj: [String: Any]) {
        guard let d = try? JSONSerialization.data(withJSONObject: obj) else { return }
        write(VyWS.encode(d, opcode: 0x1, mask: true))
    }

    func close() {
        lock.lock()
        if closed { lock.unlock(); return }
        _ = VySock.writeAll(fd, VyWS.encode(Data([0x03, 0xE8]), opcode: 0x8, mask: true), deadline: Date().addingTimeInterval(1))
        closed = true
        lock.unlock()
        // Wakes the reader thread, which closes the descriptor on its way out.
        shutdown(fd, SHUT_RDWR)
    }
}

extension VyredClient {
    public func stream(_ path: String, onMessage: @escaping @Sendable ([String: Any]) -> Void,
                       onClose: @escaping @Sendable () -> Void) async -> Result<VyredStream, VyredStreamFailure> {
        let socket = self.socket
        return await withCheckedContinuation { k in
            DispatchQueue.global(qos: .userInitiated).async {
                k.resume(returning: VyredSocketStream.open(socket: socket, path: path, onMessage: onMessage, onClose: onClose))
            }
        }
    }
}
