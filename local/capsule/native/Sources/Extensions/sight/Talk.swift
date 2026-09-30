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

/// The listen stream is the Capsule's own VyredLink.stream: the socket and the framing are
/// capsule-pro's (Sources/Vyred/Stream.swift).
typealias TalkStream = VyredStream

struct TalkFailure: Error, Equatable { var code: String; var message: String }

enum Listen {
    static let path = "/v1/streams/voice/listen"

    /// The opener a Talker uses in the Capsule: vyred's listen stream through the host's link.
    static func opener(_ link: VyredLink) -> Talker.Opener {
        { onMessage, onClose in
            switch await link.stream(path, onMessage: onMessage, onClose: onClose) {
            case .success(let s): return .success(s)
            case .failure(let f): return .failure(failure(f))
            }
        }
    }

    /// A 404 means the vyred running has no voice module; the rest pass on as the link said them.
    static func failure(_ f: VyredStreamFailure) -> TalkFailure {
        f.code == "not_found"
            ? TalkFailure(code: "no_voice", message: "vyred has no voice module; it needs a vyred with local/voice")
            : TalkFailure(code: f.code, message: f.message)
    }
}

// MARK: - One utterance at a time

/// The talk chord's state machine. All state lives on one serial queue; what the Capsule shows is
/// handed to the main actor. Pressing while starting is remembered, not a second utterance.
final class Talker: @unchecked Sendable {
    /// `heard`'s `final` distinguishes a live partial (shows as it comes, asks nothing) from a
    /// settled phrase (where a command word -- "send it", "new line", "scratch that" -- is looked
    /// for); local/voice/listen.js's own "final" text is cumulative, not just this phrase.
    enum Event: Equatable { case listening, heard(String, final: Bool), done(String), failed(String) }

    typealias Opener = @Sendable (_ onMessage: @escaping @Sendable ([String: Any]) -> Void, _ onClose: @escaping @Sendable () -> Void) async -> Result<TalkStream, TalkFailure>

    private let q = DispatchQueue(label: "vyre.capsule.sight.talk")
    private let makeMic: @Sendable () -> MicSource
    private let open: Opener
    private let emit: @Sendable (Event) -> Void
    /// The real mic level, 0 to 1, throttled to about 10 Hz -- for a live ring, not per frame.
    private let onLevel: (@Sendable (Double) -> Void)?
    private var lastLevel = Date.distantPast

    private var mic: MicSource?
    private var stream: TalkStream?
    private var early: [Data] = []
    private var live = false, micDone = false, stopped = false, ended = false, settled = true, quiet = false

    init(makeMic: @escaping @Sendable () -> MicSource, open: @escaping Opener, emit: @escaping @Sendable (Event) -> Void, onLevel: (@Sendable (Double) -> Void)? = nil) {
        self.makeMic = makeMic; self.open = open; self.emit = emit; self.onLevel = onLevel
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
        Task.detached(priority: .userInitiated) { [weak self] in
            guard let me = self else { return }
            let r = await open({ [weak me] msg in me?.q.async { me?.message(msg) } }, { [weak me] in me?.q.async { me?.streamClosed() } })
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
        reportLevel(d)
    }

    /// RMS of this linear16 frame, 0 to 1, throttled to about 10 Hz -- matches local/voice's own
    /// browser client (deck/chat/core/voice.js), which scales sqrt(meanSquare) by 4 for a livelier
    /// ring than a raw RMS gives on ordinary speech.
    private func reportLevel(_ d: Data) {
        guard let onLevel else { return }
        let now = Date()
        guard now.timeIntervalSince(lastLevel) > 0.09 else { return }
        lastLevel = now
        let n = d.count / 2
        guard n > 0 else { onLevel(0); return }
        var sumSq = 0.0
        // Read as raw bytes, never bound to Int16 directly: linear16 frames are not guaranteed
        // 2-byte aligned in Data's own storage.
        d.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            for i in 0..<n {
                let lo = UInt16(raw[2 * i]), hi = UInt16(raw[2 * i + 1])
                let sample = Int16(bitPattern: lo | (hi << 8))
                let s = Double(sample) / 32768.0
                sumSq += s * s
            }
        }
        onLevel(min(1, (sumSq / Double(n)).squareRoot() * 4))
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
        case "partial": if !text.isEmpty { emit(.heard(text, final: false)) }
        case "final": if !text.isEmpty { emit(.heard(text, final: true)) }
        default: break
        }
    }

    private func streamClosed() { if !settled { finish(.failed("vyred closed the stream")) } }

    private func finish(_ e: Event) {
        guard !settled else { return }
        settled = true; live = false; early = []
        mic?.stop(); mic = nil
        stream?.close(); stream = nil
        onLevel?(0)
        if !quiet { emit(e) }
    }
}
