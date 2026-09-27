// Mic: push-to-talk capture for Vyre's voice module.
//
// Speech recognisers want 16 kHz mono linear16. Microphones deliver whatever the hardware
// runs at, usually 44.1 or 48 kHz Float32, sometimes with more than one channel. This file
// owns the whole distance between the two, and nothing else: it does not decide when to
// listen, where the audio goes, or what to tell the person when access is missing.
//
// It is written to move unchanged into the native Capsule shell, so it has no globals and
// takes everything it needs through its initialisers. The conversion lives in its own class,
// PCMDownsampler, so the selftest in main.swift runs exactly the code the live tap runs.
//
// Audio never leaves through anything but the onChunk closure. Nothing here logs, and nothing
// here writes a sample to disk.

import AVFoundation

/// Turns buffers in any PCM format into 16 kHz mono Int16 little-endian, cut into fixed-size
/// chunks. Stateful, because a resampler carries a few samples of history across buffers;
/// feeding it each buffer independently would click at every boundary.
///
/// Not thread safe. PushToTalkMic serialises access to it.
final class PCMDownsampler {
    static let outputRate: Double = 16_000
    /// 100 ms of 16 kHz Int16: small enough that a recogniser sees words promptly, large
    /// enough that the per-chunk overhead of a pipe or a socket stays negligible.
    static let defaultChunkBytes = 3200

    let inputFormat: AVAudioFormat
    let chunkBytes: Int

    // The tap's usual format already is deinterleaved Float32, so this stays nil in practice.
    // It exists so an Int16 or interleaved device still works rather than failing.
    private let normaliser: AVAudioConverter?
    private let floatFormat: AVAudioFormat
    private let monoFormat: AVAudioFormat
    private let outFormat: AVAudioFormat
    private let resampler: AVAudioConverter
    private var normalised: AVAudioPCMBuffer?
    private var mono: AVAudioPCMBuffer?
    private var pending = Data()

    enum Failure: Error {
        case unsupportedFormat(String)
        case conversion(String)
    }

    init(inputFormat: AVAudioFormat, chunkBytes: Int = PCMDownsampler.defaultChunkBytes) throws {
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
            throw Failure.unsupportedFormat("input has no channels or no sample rate")
        }
        self.inputFormat = inputFormat
        // An odd byte count would split an Int16 across two chunks.
        self.chunkBytes = max(2, chunkBytes & ~1)

        guard let f = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: inputFormat.sampleRate,
                                    channels: inputFormat.channelCount, interleaved: false),
              let m = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: inputFormat.sampleRate,
                                    channels: 1, interleaved: false),
              let o = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: PCMDownsampler.outputRate,
                                    channels: 1, interleaved: true)
        else { throw Failure.unsupportedFormat("could not describe the working formats") }
        floatFormat = f
        monoFormat = m
        outFormat = o

        if inputFormat.commonFormat == .pcmFormatFloat32 && !inputFormat.isInterleaved {
            normaliser = nil
        } else {
            guard let n = AVAudioConverter(from: inputFormat, to: f) else {
                throw Failure.unsupportedFormat("cannot read \(inputFormat)")
            }
            normaliser = n
        }
        guard let r = AVAudioConverter(from: m, to: o) else {
            throw Failure.unsupportedFormat("cannot resample \(inputFormat.sampleRate) Hz to 16 kHz")
        }
        // Speech sits well below 8 kHz, but aliasing from a cheap filter still smears
        // consonants, and the extra quality costs little at these rates.
        r.sampleRateConverterQuality = AVAudioQuality.high.rawValue
        resampler = r
    }

    /// Feed one buffer. Returns every chunk it completed, in order; a remainder waits for the
    /// next buffer or for flush().
    func convert(_ buffer: AVAudioPCMBuffer) throws -> [Data] {
        let frames = buffer.frameLength
        if frames == 0 { return [] }
        let floats = try normalise(buffer)
        let monoBuf = try downmix(floats, frames: frames)
        try resample(monoBuf, endOfStream: false)
        return takeChunks()
    }

    /// Drain the resampler's tail and hand back everything left, full chunks first and the
    /// short last one at the end. The downsampler is reset afterwards and can be fed again.
    func flush() throws -> [Data] {
        try resample(nil, endOfStream: true)
        var out = takeChunks()
        if !pending.isEmpty {
            out.append(pending)
            pending = Data()
        }
        resampler.reset()
        return out
    }

    // ------------------------------------------------------------ stages

    private func normalise(_ buffer: AVAudioPCMBuffer) throws -> AVAudioPCMBuffer {
        guard let normaliser else { return buffer }
        let frames = buffer.frameLength
        if normalised == nil || normalised!.frameCapacity < frames {
            normalised = AVAudioPCMBuffer(pcmFormat: floatFormat, frameCapacity: frames)
        }
        guard let dst = normalised else { throw Failure.conversion("out of memory") }
        do { try normaliser.convert(to: dst, from: buffer) } catch {
            throw Failure.conversion("could not read the input buffer: \(error.localizedDescription)")
        }
        return dst
    }

    /// Averaging rather than summing, so two channels carrying the same signal come out at the
    /// same level instead of clipping; and rather than taking channel 0, because a headset may
    /// put the voice on either side.
    private func downmix(_ src: AVAudioPCMBuffer, frames: AVAudioFrameCount) throws -> AVAudioPCMBuffer {
        if mono == nil || mono!.frameCapacity < frames {
            mono = AVAudioPCMBuffer(pcmFormat: monoFormat, frameCapacity: frames)
        }
        guard let dst = mono, let out = dst.floatChannelData?[0], let chans = src.floatChannelData else {
            throw Failure.conversion("no float buffer to downmix")
        }
        let n = Int(frames)
        let count = Int(src.format.channelCount)
        if count == 1 {
            out.update(from: chans[0], count: n)
        } else {
            let scale = 1 / Float(count)
            for i in 0..<n {
                var s: Float = 0
                for c in 0..<count { s += chans[c][i] }
                out[i] = s * scale
            }
        }
        dst.frameLength = frames
        return dst
    }

    private func resample(_ input: AVAudioPCMBuffer?, endOfStream: Bool) throws {
        let ratio = PCMDownsampler.outputRate / monoFormat.sampleRate
        let inFrames = Double(input?.frameLength ?? 0)
        // Room for this buffer's share plus the converter's held-back history.
        let capacity = AVAudioFrameCount((inFrames * ratio).rounded(.up)) + 512
        var supplied = false
        while true {
            guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: capacity) else {
                throw Failure.conversion("out of memory")
            }
            var err: NSError?
            let status = resampler.convert(to: out, error: &err) { _, outStatus in
                if let input, !supplied {
                    supplied = true
                    outStatus.pointee = .haveData
                    return input
                }
                // noDataNow keeps the converter's history for the next buffer; endOfStream
                // tells it to push that history out.
                outStatus.pointee = endOfStream ? .endOfStream : .noDataNow
                return nil
            }
            if status == .error {
                throw Failure.conversion(err?.localizedDescription ?? "resampler failed")
            }
            append(out)
            // haveData means the output filled up and more may be waiting. Anything else means
            // this input is spent.
            if status != .haveData { break }
        }
    }

    private func append(_ buf: AVAudioPCMBuffer) {
        let n = Int(buf.frameLength)
        guard n > 0, let p = buf.int16ChannelData?[0] else { return }
        // Every Mac Vyre runs on is little-endian, so the native Int16 bytes are already
        // linear16 as recognisers expect it.
        pending.append(UnsafeBufferPointer(start: p, count: n))
    }

    private func takeChunks() -> [Data] {
        guard pending.count >= chunkBytes else { return [] }
        var out: [Data] = []
        var start = pending.startIndex
        while pending.endIndex - start >= chunkBytes {
            out.append(pending.subdata(in: start..<(start + chunkBytes)))
            start += chunkBytes
        }
        pending = pending.subdata(in: start..<pending.endIndex)
        return out
    }
}

/// The microphone, started and stopped by whoever owns the talk key.
///
/// onChunk runs on the audio thread for live chunks and on the caller's thread for the final
/// flush in stop(). It should hand the data off and return; blocking it drops audio.
final class PushToTalkMic {
    enum Failure: Error {
        case noInput
        case engine(String)

        var code: String {
            switch self {
            case .noInput: return "no_input"
            case .engine: return "engine_failed"
            }
        }
        var message: String {
            switch self {
            case .noInput: return "no microphone input is available"
            case .engine(let m): return m
            }
        }
    }

    private let onChunk: (Data) -> Void
    private let onError: (String, String) -> Void
    private let lock = NSLock()
    private var engine: AVAudioEngine?
    private var downsampler: PCMDownsampler?
    private var configObserver: NSObjectProtocol?

    init(onChunk: @escaping (Data) -> Void, onError: @escaping (_ code: String, _ message: String) -> Void) {
        self.onChunk = onChunk
        self.onError = onError
    }

    deinit { stop() }

    var isRunning: Bool {
        lock.lock(); defer { lock.unlock() }
        return engine != nil
    }

    /// Begin capture from the current default input. A fresh engine each time, so a headset
    /// plugged in between presses is the one that listens.
    func start() throws {
        lock.lock(); defer { lock.unlock() }
        if engine != nil { return }

        let eng = AVAudioEngine()
        let input = eng.inputNode
        let format = input.outputFormat(forBus: 0)
        if format.sampleRate == 0 || format.channelCount == 0 { throw Failure.noInput }

        let ds: PCMDownsampler
        do { ds = try PCMDownsampler(inputFormat: format) } catch {
            throw Failure.engine("cannot convert the microphone format: \(error)")
        }

        // Ask for about 100 ms per callback to match the chunk size; the engine treats this
        // as a hint and may deliver other sizes, which the downsampler absorbs.
        let hint = AVAudioFrameCount(format.sampleRate / 10)
        input.installTap(onBus: 0, bufferSize: hint, format: format) { [weak self] buffer, _ in
            self?.deliver(buffer)
        }
        eng.prepare()
        do { try eng.start() } catch {
            input.removeTap(onBus: 0)
            throw Failure.engine("the audio engine did not start: \(error.localizedDescription)")
        }

        // A device change stops the engine silently. Saying so beats a recording that simply
        // goes quiet halfway through a sentence.
        configObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: eng, queue: nil
        ) { [weak self] _ in
            self?.onError("device_changed", "the audio input changed during capture")
        }
        engine = eng
        downsampler = ds
    }

    /// Stop capture and deliver whatever partial chunk was still waiting, so the last word
    /// before the key came up is not lost.
    func stop() {
        lock.lock()
        guard let eng = engine else { lock.unlock(); return }
        eng.inputNode.removeTap(onBus: 0)
        eng.stop()
        if let obs = configObserver { NotificationCenter.default.removeObserver(obs) }
        configObserver = nil
        engine = nil
        let ds = downsampler
        downsampler = nil
        var tail: [Data] = []
        var failure: String?
        if let ds {
            do { tail = try ds.flush() } catch { failure = "\(error)" }
        }
        lock.unlock()
        for chunk in tail { onChunk(chunk) }
        if let failure { onError("convert_failed", failure) }
    }

    private func deliver(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        guard let ds = downsampler else { lock.unlock(); return }
        var chunks: [Data] = []
        var failure: String?
        do { chunks = try ds.convert(buffer) } catch { failure = "\(error)" }
        lock.unlock()
        for chunk in chunks { onChunk(chunk) }
        if let failure { onError("convert_failed", failure) }
    }

    // ------------------------------------------------------------ permission

    /// The Microphone grant as TCC sees it for this process. Never prompts.
    static func authorization() -> String {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return "granted"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "not_determined"
        @unknown default: return "not_determined"
        }
    }

    /// Ask for access only when macOS has never been asked and a person may be there to
    /// answer. In every other case report the grant as it stands; a denied grant can only be
    /// changed in System Settings, and a dialog nobody sees is worse than none.
    static func requestIfAllowed(dialogsAllowed: Bool, completion: @escaping (Bool) -> Void) {
        let status = AVCaptureDevice.authorizationStatus(for: .audio)
        if status == .notDetermined && dialogsAllowed {
            AVCaptureDevice.requestAccess(for: .audio, completionHandler: completion)
            return
        }
        completion(status == .authorized)
    }
}
