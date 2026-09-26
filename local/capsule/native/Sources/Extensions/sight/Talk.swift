// Talk: push-to-talk from the Capsule, one utterance per press of the talk chord.
//
// The same protocol as local/voice/talk.js, which is the reference: the mic helper (vyre-mic) is
// spawned and its 16 kHz mono linear16 PCM goes to vyred's /v1/streams/voice/listen as binary
// frames while the chord is held down in spirit (pressed once to start, once to stop). Stopping
// closes vyre-mic's stdin, which is how it is told to stop; once its last bytes are out,
// {"type":"end"} asks for the finished words, and vyred answers partial and final lines and then
// {"type":"done","text"} or {"type":"error","code","message"}.
//
// The Capsule never touches the microphone itself: the grant belongs to vyre-mic, so no usage
// string is needed here. Audio is buffered only between the mic starting and the stream opening,
// so the first word is not lost to the handshake. Nothing is written to disk or logged.

import CryptoKit
import Foundation

// MARK: - Where vyre-mic is

enum MicPath {
    /// VYRE_MIC_BIN, else what voice.status says, else next to this app in the repo
    /// (<repo>/local/capsule/native/.build/Vyre.app -> <repo>/local/voice/bin/vyre-mic).
    static func resolve(env: [String: String], fromStatus: String?, bundle: URL) -> String {
        if let e = env["VYRE_MIC_BIN"], !e.isEmpty { return e }
        if let s = fromStatus, !s.isEmpty { return s }
        var local = bundle
        for _ in 0..<4 { local = local.deletingLastPathComponent() }
        return local.appendingPathComponent("voice/bin/vyre-mic").path
    }

    static func notBuilt(_ bin: String) -> String {
        let build = ((bin as NSString).deletingLastPathComponent as NSString).deletingLastPathComponent
        return "vyre-mic is not built. Build it with: sh \((build as NSString).appendingPathComponent("build.sh"))"
    }
}

// MARK: - The mic

protocol MicSource: AnyObject, Sendable {
    /// Start capturing. Data arrives off the main thread; exit comes once, with the helper's status
    /// and its last stderr line (a JSON line with code and error on failure).
    func start(onData: @escaping @Sendable (Data) -> Void, onExit: @escaping @Sendable (Int32, String) -> Void) -> String?
    /// Close its stdin: it stops, flushes its last bytes, and exits.
    func stop()
}

final class ProcessMic: MicSource, @unchecked Sendable {
    let bin: String
    private let proc = Process()
    private let input = Pipe(), output = Pipe(), errors = Pipe()
    private let lock = NSLock()
    private var err = Data()

    init(bin: String) { self.bin = bin }

    func start(onData: @escaping @Sendable (Data) -> Void, onExit: @escaping @Sendable (Int32, String) -> Void) -> String? {
        guard FileManager.default.isExecutableFile(atPath: bin) else { return MicPath.notBuilt(bin) }
        proc.executableURL = URL(fileURLWithPath: bin)
        proc.standardInput = input; proc.standardOutput = output; proc.standardError = errors
        let done = DispatchGroup()
        done.enter(); done.enter()
        output.fileHandleForReading.readabilityHandler = { h in
            let d = h.availableData
            if d.isEmpty { h.readabilityHandler = nil; done.leave() } else { onData(d) }
        }
        errors.fileHandleForReading.readabilityHandler = { [weak self] h in
            let d = h.availableData
            if d.isEmpty { h.readabilityHandler = nil; return }
            guard let self else { return }
            self.lock.lock(); if self.err.count < 2000 { self.err.append(d) }; self.lock.unlock()
        }
        proc.terminationHandler = { [weak self] p in
            done.leave()
            // Every byte on stdout is sent before exit is reported, so the end frame follows the audio.
            done.notify(queue: .global()) {
                guard let self else { onExit(p.terminationStatus, ""); return }
                self.lock.lock(); let e = String(decoding: self.err, as: UTF8.self); self.lock.unlock()
                onExit(p.terminationStatus, e)
            }
        }
        do { try proc.run() } catch { return "vyre-mic did not start: \(error.localizedDescription)" }
        return nil
    }

    func stop() { try? input.fileHandleForWriting.close() }
}

// MARK: - The stream

protocol TalkStream: AnyObject, Sendable {
    func sendBinary(_ d: Data)
    func sendJSON(_ obj: [String: Any])
    func close()
}

/// RFC 6455 framing, just enough: the client masks, the server does not, fragments are joined.
enum WSFrame {
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

/// The listen stream over vyred's unix socket, as the "capsule" caller. One reader thread blocked
/// in read(2) while an utterance is live; nothing exists between utterances.
final class ListenSocket: TalkStream, @unchecked Sendable {
    private let fd: Int32
    private let lock = NSLock()
    private var closed = false

    private init(fd: Int32) { self.fd = fd }

    /// Connect and upgrade. Blocking; call off the main thread. The failure is words to show.
    static func open(socket: String, path: String = "/v1/streams/voice/listen", timeout: TimeInterval = 5,
                     onMessage: @escaping @Sendable ([String: Any]) -> Void, onClose: @escaping @Sendable () -> Void) -> Result<ListenSocket, TalkFailure> {
        let fd = VySock.connect(socket)
        guard fd >= 0 else { return .failure(TalkFailure(code: "unreachable", message: "vyred is not running; vyre up to start it")) }
        let deadline = Date().addingTimeInterval(timeout)
        var raw = [UInt8](repeating: 0, count: 16)
        _ = SecRandomCopyBytes(kSecRandomDefault, 16, &raw)
        let key = Data(raw).base64EncodedString()
        let req = "GET \(path) HTTP/1.1\r\nHost: vyred\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: \(key)\r\nSec-WebSocket-Version: 13\r\nx-vyre-caller: capsule\r\n\r\n"
        guard VySock.writeAll(fd, Data(req.utf8), deadline: deadline) else { Darwin.close(fd); return .failure(TalkFailure(code: "unreachable", message: "vyred did not take the stream")) }
        var got = Data()
        let sep = Data("\r\n\r\n".utf8)
        var chunk = [UInt8](repeating: 0, count: 4096)
        while got.range(of: sep) == nil {
            guard VySock.waitFor(fd, Int16(POLLIN), deadline: deadline) else { Darwin.close(fd); return .failure(TalkFailure(code: "timeout", message: "vyred did not answer the stream in time")) }
            let n = Darwin.read(fd, &chunk, chunk.count)
            if n <= 0 { Darwin.close(fd); return .failure(TalkFailure(code: "refused", message: "vyred closed the stream before it opened")) }
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
            return .failure(TalkFailure(code: status == 404 ? "no_voice" : "refused", message: status == 404 ? "vyred has no voice module; it needs a vyred with local/voice" : message))
        }
        let accept = lines.dropFirst().first { $0.lowercased().hasPrefix("sec-websocket-accept:") }
            .map { String($0.split(separator: ":", maxSplits: 1)[1]).trimmingCharacters(in: .whitespaces) }
        guard accept == WSFrame.acceptKey(key) else { Darwin.close(fd); return .failure(TalkFailure(code: "refused", message: "the stream did not answer as a WebSocket")) }
        let s = ListenSocket(fd: fd)
        s.read(first: rest, onMessage: onMessage, onClose: onClose)
        return .success(s)
    }

    private func read(first: Data, onMessage: @escaping @Sendable ([String: Any]) -> Void, onClose: @escaping @Sendable () -> Void) {
        let t = Thread { [self] in
            var parser = WSFrame.Parser()
            var pending = first
            var buf = [UInt8](repeating: 0, count: 8192)
            loop: while true {
                for m in parser.feed(pending) {
                    switch m {
                    case .text(let s):
                        if let obj = try? JSONSerialization.jsonObject(with: Data(s.utf8)) as? [String: Any] { onMessage(obj) }
                    case .ping(let p): write(WSFrame.encode(p, opcode: 0xA, mask: true))
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
        t.name = "vyre.capsule.sight.listen"
        t.start()
    }

    private func write(_ d: Data) {
        lock.lock(); defer { lock.unlock() }
        if closed { return }
        _ = VySock.writeAll(fd, d, deadline: Date().addingTimeInterval(5))
    }

    func sendBinary(_ d: Data) { write(WSFrame.encode(d, opcode: 0x2, mask: true)) }

    func sendJSON(_ obj: [String: Any]) {
        guard let d = try? JSONSerialization.data(withJSONObject: obj) else { return }
        write(WSFrame.encode(d, opcode: 0x1, mask: true))
    }

    func close() {
        lock.lock()
        if closed { lock.unlock(); return }
        _ = VySock.writeAll(fd, WSFrame.encode(Data([0x03, 0xE8]), opcode: 0x8, mask: true), deadline: Date().addingTimeInterval(1))
        closed = true
        lock.unlock()
        // Wakes the reader thread, which closes the descriptor on its way out.
        shutdown(fd, SHUT_RDWR)
    }
}

struct TalkFailure: Error, Equatable { var code: String; var message: String }

// MARK: - One utterance at a time

/// The talk chord's state machine. All state lives on one serial queue; what the Capsule shows is
/// handed to the main actor. Pressing while starting is remembered, not a second utterance.
final class Talker: @unchecked Sendable {
    enum Event: Equatable { case listening, heard(String), done(String), failed(String) }

    typealias Opener = @Sendable (_ onMessage: @escaping @Sendable ([String: Any]) -> Void, _ onClose: @escaping @Sendable () -> Void) -> Result<TalkStream, TalkFailure>

    private let q = DispatchQueue(label: "vyre.capsule.sight.talk")
    private let makeMic: @Sendable () -> MicSource
    private let open: Opener
    private let emit: @Sendable (Event) -> Void

    private var mic: MicSource?
    private var stream: TalkStream?
    private var early: [Data] = []
    private var live = false, micDone = false, stopped = false, ended = false, settled = true, quiet = false

    init(makeMic: @escaping @Sendable () -> MicSource, open: @escaping Opener, emit: @escaping @Sendable (Event) -> Void) {
        self.makeMic = makeMic; self.open = open; self.emit = emit
    }

    var isLive: Bool { q.sync { live } }

    func toggle() { q.async { self.live ? self.stopLocked() : self.startLocked() } }

    /// The Capsule hid: stop the mic, drop the stream, say nothing.
    func cancel() {
        q.async {
            guard self.live else { return }
            self.quiet = true
            self.finish(.failed("stopped"))
        }
    }

    private func startLocked() {
        live = true; settled = false; micDone = false; stopped = false; ended = false; quiet = false; early = []
        emit(.listening)
        let m = makeMic()
        mic = m
        if let why = m.start(onData: { [weak self] d in self?.q.async { self?.audio(d) } },
                             onExit: { [weak self] code, err in self?.q.async { self?.micExited(code, err) } }) {
            finish(.failed(why)); return
        }
        let open = self.open
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let me = self else { return }
            let r = open({ [weak me] msg in me?.q.async { me?.message(msg) } }, { [weak me] in me?.q.async { me?.streamClosed() } })
            me.q.async { me.opened(r) }
        }
    }

    private func stopLocked() {
        guard !stopped else { return }
        stopped = true
        mic?.stop()
    }

    private func audio(_ d: Data) {
        guard !settled else { return }
        if let s = stream { s.sendBinary(d) } else { early.append(d) }
    }

    private func opened(_ r: Result<TalkStream, TalkFailure>) {
        switch r {
        case .failure(let f): finish(.failed(f.message))
        case .success(let s):
            if settled { s.close(); return }
            stream = s
            for d in early { s.sendBinary(d) }
            early = []
            sendEnd()
        }
    }

    private func micExited(_ code: Int32, _ err: String) {
        micDone = true
        if code != 0 && !stopped && !settled {
            var why = "vyre-mic exited with \(code)"
            if let last = err.split(separator: "\n").last,
               let obj = try? JSONSerialization.jsonObject(with: Data(last.utf8)) as? [String: Any],
               let e = obj["error"] as? String { why = e }
            finish(.failed(why)); return
        }
        sendEnd()
    }

    private func sendEnd() {
        guard !ended, micDone, let s = stream, !settled else { return }
        ended = true
        s.sendJSON(["type": "end"])
    }

    private func message(_ m: [String: Any]) {
        guard !settled else { return }
        let text = m["text"] as? String ?? ""
        switch m["type"] as? String {
        case "done": finish(.done(text))
        case "error": finish(.failed(m["message"] as? String ?? "the stream failed"))
        case "partial", "final": if !text.isEmpty { emit(.heard(text)) }
        default: break
        }
    }

    private func streamClosed() { if !settled { finish(.failed("vyred closed the stream")) } }

    private func finish(_ e: Event) {
        guard !settled else { return }
        settled = true; live = false; early = []
        mic?.stop(); mic = nil
        stream?.close(); stream = nil
        if !quiet { emit(e) }
    }
}
