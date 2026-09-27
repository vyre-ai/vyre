// vyre-mic: the microphone helper behind Vyre's voice module on macOS.
//
// A separate process rather than code inside vyred, because macOS grants the Microphone to a
// code signature. A small helper built on this machine is one stable thing to grant, and the
// grant does not widen to everything else vyred can do.
//
// Modes:
//   (none)             capture. Raw 16 kHz mono linear16 on stdout until stdin closes.
//   --status           the grant and whether a dialog may be raised, as one JSON line.
//   --selftest [secs]  run a synthetic tone through the same conversion the tap uses.
//
// In capture mode stdout carries audio and nothing else, so errors go to stderr as one JSON
// line with a machine-readable code. A reader that got bytes on stdout got sound.
//
// The talk key is the owner's stdin: closing it is how the caller says "stop", which also
// means a caller that dies takes the capture with it instead of leaving a live microphone.

import AVFoundation
import Foundation

// ---------------------------------------------------------------- plumbing

func jsonLine(_ obj: [String: Any]) -> Data {
    var d = (try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])) ?? Data("{}".utf8)
    d.append(0x0A)
    return d
}

/// Plain write(2) rather than FileHandle, which raises an Objective-C exception on a closed
/// pipe instead of returning an error we can act on.
@discardableResult
func writeAll(_ fd: Int32, _ data: Data) -> Bool {
    data.withUnsafeBytes { raw -> Bool in
        guard var p = raw.baseAddress else { return true }
        var left = raw.count
        while left > 0 {
            let n = write(fd, p, left)
            if n < 0 {
                if errno == EINTR { continue }
                return false
            }
            left -= n
            p += n
        }
        return true
    }
}

func fail(_ code: String, _ msg: String) -> Never {
    writeAll(STDERR_FILENO, jsonLine(["error": msg, "code": code]))
    exit(2)
}

/// The same rule as core/vault/mac/dialogs.js, so the helper and vyred never disagree about
/// whether a person is assumed to be at the machine.
func dialogsAllowed() -> Bool {
    let env = ProcessInfo.processInfo.environment
    if env["VYRE_NO_DIALOGS"] == "1" { return false }
    if let t = env["NODE_TEST_CONTEXT"], !t.isEmpty, env["VYRE_TEST_DIALOGS"] != "1" { return false }
    return true
}

// ---------------------------------------------------------------- status

func runStatus() -> Never {
    writeAll(STDOUT_FILENO, jsonLine(["authorization": PushToTalkMic.authorization(), "dialogs": dialogsAllowed()]))
    exit(0)
}

// ---------------------------------------------------------------- selftest

/// A tone with known level and length through PCMDownsampler, fed in tap-sized buffers. Two
/// deinterleaved 48 kHz channels, because that is the shape a real input node usually hands
/// over and it exercises the downmix. No microphone is touched.
func runSelftest(seconds: Int) -> Never {
    let rate = 48_000.0
    let framesPerBuffer: AVAudioFrameCount = 4800
    guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 2, interleaved: false),
          let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: framesPerBuffer)
    else { fail("selftest_failed", "could not build the test format") }

    let ds: PCMDownsampler
    do { ds = try PCMDownsampler(inputFormat: format) } catch { fail("selftest_failed", "\(error)") }

    let total = Int(rate) * seconds
    let step = 2 * Double.pi * 440 / rate
    var produced = 0
    var chunks: [Data] = []
    var convertNanos: UInt64 = 0

    func timed(_ body: () throws -> [Data]) {
        let t0 = DispatchTime.now().uptimeNanoseconds
        do { chunks += try body() } catch { fail("selftest_failed", "\(error)") }
        convertNanos += DispatchTime.now().uptimeNanoseconds - t0
    }

    while produced < total {
        let n = min(Int(framesPerBuffer), total - produced)
        let l = buf.floatChannelData![0], r = buf.floatChannelData![1]
        for i in 0..<n {
            let s = Float(0.5 * sin(step * Double(produced + i)))
            l[i] = s
            r[i] = s
        }
        buf.frameLength = AVAudioFrameCount(n)
        produced += n
        timed { try ds.convert(buf) }
    }
    timed { try ds.flush() }

    var samples = 0
    var peak = 0
    for c in chunks {
        samples += c.count / 2
        c.withUnsafeBytes { raw in
            for v in raw.bindMemory(to: Int16.self) {
                let a = abs(Int(Int16(littleEndian: v)))
                if a > peak { peak = a }
            }
        }
    }
    let expected = seconds * 16_000
    let sizesOk = chunks.dropLast().allSatisfy { $0.count == PCMDownsampler.defaultChunkBytes }
        && (chunks.last.map { $0.count > 0 && $0.count <= PCMDownsampler.defaultChunkBytes } ?? false)
    let countOk = abs(Double(samples - expected)) <= Double(expected) * 0.01
    let peakOk = Double(peak) >= 0.45 * 32767 && Double(peak) <= 0.55 * 32767
    let ok = sizesOk && countOk && peakOk

    let ms = Double(convertNanos) / 1_000_000
    let realtime = ms > 0 ? (Double(seconds) * 1000) / ms : 0
    writeAll(STDOUT_FILENO, jsonLine([
        "ok": ok,
        "samples": samples,
        "expected": expected,
        "peak": peak,
        "chunks": chunks.count,
        "seconds": seconds,
        "convert_ms": NSDecimalNumber(string: String(format: "%.2f", ms)),
        "realtime_x": Int(realtime.rounded()),
    ]))
    exit(ok ? 0 : 1)
}

// ---------------------------------------------------------------- capture

/// Audio goes out through one serial queue so a slow reader backs up here, off the audio
/// thread, and chunks keep their order.
let writer = DispatchQueue(label: "vyre-mic.stdout")
var mic: PushToTalkMic?
var finishing = false
/// Held for the life of the process; a released signal source stops delivering.
var signalSources: [DispatchSourceSignal] = []

/// Only ever called on the main queue, so finishing needs no lock.
func finish(_ status: Int32) -> Never {
    if !finishing {
        finishing = true
        mic?.stop()
    }
    writer.sync {}
    exit(status)
}

func beginCapture() {
    let m = PushToTalkMic(
        onChunk: { chunk in
            writer.async {
                // The reader went away. There is nobody left to hear, so stop listening.
                if !writeAll(STDOUT_FILENO, chunk) {
                    DispatchQueue.main.async { finish(0) }
                }
            }
        },
        onError: { code, message in
            writeAll(STDERR_FILENO, jsonLine(["error": message, "code": code]))
            DispatchQueue.main.async { finish(2) }
        }
    )
    mic = m
    do { try m.start() } catch let e as PushToTalkMic.Failure {
        fail(e.code, e.message)
    } catch {
        fail("engine_failed", "\(error)")
    }

    // A blocking read on its own thread: no timer, no polling, and EOF arrives the moment the
    // owner closes its end or exits.
    Thread.detachNewThread {
        var scratch = [UInt8](repeating: 0, count: 256)
        while true {
            let n = read(STDIN_FILENO, &scratch, scratch.count)
            if n > 0 { continue }
            if n < 0 && errno == EINTR { continue }
            break
        }
        DispatchQueue.main.async { finish(0) }
    }
}

func runCapture() -> Never {
    // A closed stdout must come back as EPIPE from write(2), not kill the process before the
    // microphone is released.
    signal(SIGPIPE, SIG_IGN)
    signal(SIGTERM, SIG_IGN)
    signal(SIGINT, SIG_IGN)
    for sig in [SIGTERM, SIGINT] {
        let s = DispatchSource.makeSignalSource(signal: sig, queue: .main)
        s.setEventHandler { finish(0) }
        s.resume()
        signalSources.append(s)
    }
    PushToTalkMic.requestIfAllowed(dialogsAllowed: dialogsAllowed()) { granted in
        DispatchQueue.main.async {
            if granted { beginCapture() } else {
                fail("not_granted", "microphone access is not granted to vyre-mic")
            }
        }
    }
    dispatchMain()
}

// ---------------------------------------------------------------- entry

let args = Array(CommandLine.arguments.dropFirst())
switch args.first {
case nil:
    runCapture()
case "--status":
    runStatus()
case "--selftest":
    var seconds = 5
    if args.count > 1 {
        guard let s = Int(args[1]), s > 0, s <= 3600 else { fail("bad_args", "--selftest takes whole seconds from 1 to 3600") }
        seconds = s
    }
    runSelftest(seconds: seconds)
default:
    fail("bad_args", "usage: vyre-mic [--status | --selftest [seconds]]")
}
