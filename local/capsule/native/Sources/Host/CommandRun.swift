// CommandRun: `vyre ...` typed in the box runs here, and its answer is drawn in the panel.
//
// The user, 2026-09-27: "run vyre voice" fell through to a memory answer, and the only way to use
// a command was a terminal. Now words that start with "vyre " (or "run vyre ") are a command
// before anything else: the first row runs it, and nothing asks a model about them.
//
// It runs this vyred's own CLI (GET /v1/health `cli`: node and bin/vyre), by argv, never through
// a shell, with `--view`: JSON-line frames {v:1, cmd, view:{kind, ...}, data}, the last one
// {v:1, done:true, exit} (polish-cli's contract). A CLI without --view answers with a usage exit
// (2) and no frames, and only then it runs once more without it, its text drawn as is (colour
// off). Exit codes: 0 ok, 1 failed, 2 usage, 3 needs a person, 4 vault locked, 5 vyred down.
// Esc or hiding the Capsule ends a live verb. Plain shell lines are not run from here.

import AppKit
import CoreImage
import Foundation

/// One `--view` frame's view, as the panel draws it.
public enum CLIView: Equatable {
    case table(columns: [(key: String, label: String)], rows: [[String: String]], empty: String?)
    case card(title: String, fields: [(label: String, value: String)], state: String?)
    case text([String])
    case qr(text: String, caption: String?)
    case checks([(id: String, label: String, state: String, note: String?)])
    case prompt(name: String, label: String, choices: [String], secret: Bool)
    case error(code: String, message: String, next: String?)

    public static func == (a: CLIView, b: CLIView) -> Bool { String(describing: a) == String(describing: b) }

    var kind: String {
        switch self {
        case .table: return "table"
        case .card: return "card"
        case .text: return "text"
        case .qr: return "qr"
        case .checks: return "checks"
        case .prompt: return "prompt"
        case .error: return "error"
        }
    }

    /// A frame's view object, or nil for a kind this Capsule does not know.
    static func from(_ v: [String: Any]) -> CLIView? {
        func str(_ x: Any?) -> String { x.map { ($0 as? String) ?? ($0 is NSNull ? "" : "\($0)") } ?? "" }
        switch VJ.s(v["kind"]) {
        case "table":
            let cols = ((v["columns"] as? [[String: Any]]) ?? []).map { (key: VJ.s($0["key"]), label: VJ.nonEmpty($0["label"]) ?? VJ.s($0["key"])) }
            let rows = ((v["rows"] as? [[String: Any]]) ?? []).map { r in Dictionary(uniqueKeysWithValues: cols.map { ($0.key, str(r[$0.key])) }) }
            return .table(columns: cols, rows: rows, empty: VJ.nonEmpty(v["empty"]))
        case "card":
            let fields = ((v["fields"] as? [[String: Any]]) ?? []).map { (label: VJ.s($0["label"]), value: str($0["value"])) }
            return .card(title: VJ.s(v["title"]), fields: fields, state: VJ.nonEmpty(v["state"]))
        case "text":
            return .text(((v["lines"] as? [Any]) ?? []).map { str($0) })
        case "qr":
            return .qr(text: VJ.s(v["text"]), caption: VJ.nonEmpty(v["caption"]))
        case "checks":
            return .checks(((v["items"] as? [[String: Any]]) ?? []).map { (id: VJ.s($0["id"]), label: VJ.s($0["label"]), state: VJ.nonEmpty($0["state"]) ?? "unknown", note: VJ.nonEmpty($0["note"])) })
        case "prompt":
            return .prompt(name: VJ.s(v["name"]), label: VJ.nonEmpty(v["label"]) ?? VJ.s(v["name"]), choices: ((v["choices"] as? [Any]) ?? []).map { str($0) }, secret: v["secret"] as? Bool ?? false)
        case "error":
            return .error(code: VJ.s(v["code"]), message: VJ.s(v["message"]), next: VJ.nonEmpty(v["next"]))
        default:
            return nil
        }
    }
}

public enum CLIRun {
    /// The CLI's argv for words typed in the box, or nil when they are not a vyre command:
    /// "vyre voice status" and "run vyre voice" give ["voice", "status"] and ["voice"]. Quotes
    /// keep words together ("vyre remind 'call dana' 5m").
    public static func parse(_ text: String) -> [String]? {
        var t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.lowercased().hasPrefix("run ") { t = String(t.dropFirst(4)).trimmingCharacters(in: .whitespaces) }
        guard t.lowercased().hasPrefix("vyre ") else { return nil }
        let args = words(String(t.dropFirst(5)))
        return args.isEmpty ? nil : args
    }

    /// Verbs that mean something else in the Capsule. Bare `vyre voice` is the terminal's
    /// push-to-talk: here talking is Option-Return, so it shows voice's status instead.
    public static func forCapsule(_ argv: [String]) -> [String] {
        argv == ["voice"] ? ["voice", "status"] : argv
    }

    /// Why a verb is not run from the Capsule, or nil. Only the ones that would take the terminal
    /// or this app itself.
    public static func refused(_ argv: [String]) -> String? {
        if argv.first == "capsule" { return "This is the Capsule already. Its settings are in the menu bar mark." }
        if argv.first == "voice", argv.dropFirst().first == "--send" { return "To talk to a session from here, pick it with @ and press Option-Return." }
        return nil
    }

    static func words(_ s: String) -> [String] {
        var out: [String] = [], cur = "", quote: Character?
        for ch in s {
            if let q = quote { if ch == q { quote = nil } else { cur.append(ch) }; continue }
            if ch == "\"" || ch == "'" { quote = ch; continue }
            if ch.isWhitespace { if !cur.isEmpty { out.append(cur); cur = "" }; continue }
            cur.append(ch)
        }
        if !cur.isEmpty { out.append(cur) }
        return out
    }

    /// One stdout line: a frame's view, the done frame's exit code, or neither.
    static func frame(_ line: String) -> (view: CLIView?, exit: Int32?)? {
        guard line.hasPrefix("{"), let d = VJ.decode(Data(line.utf8)) as? [String: Any], VJ.int(d["v"]) == 1 else { return nil }
        if d["done"] as? Bool == true { return (nil, Int32(VJ.int(d["exit"]) ?? 0)) }
        return ((d["view"] as? [String: Any]).flatMap(CLIView.from), nil)
    }

    /// Colour codes out of plain output.
    static func plain(_ s: String) -> String {
        s.replacingOccurrences(of: "\u{1B}\\[[0-9;?]*[A-Za-z]", with: "", options: .regularExpression)
    }

    /// A QR picture for a qr frame, drawn crisp at `points`.
    static func qrImage(_ text: String, points: CGFloat = 180) -> NSImage? {
        guard let f = CIFilter(name: "CIQRCodeGenerator") else { return nil }
        f.setValue(Data(text.utf8), forKey: "inputMessage")
        f.setValue("M", forKey: "inputCorrectionLevel")
        guard let out = f.outputImage else { return nil }
        let scale = max(1, (points * 2 / out.extent.width).rounded(.down))
        let big = out.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let rep = NSCIImageRep(ciImage: big)
        let img = NSImage(size: NSSize(width: points, height: points))
        img.addRepresentation(rep)
        return img
    }
}

/// One command on screen: its frames as they arrive (the newest of a kind replaces the last),
/// then its exit.
@MainActor public final class CommandRun: ObservableObject, Identifiable {
    public let argv: [String]
    @Published public private(set) var views: [CLIView] = []
    @Published public private(set) var running = true
    @Published public private(set) var exit: Int32?
    /// Why it could not run at all (no CLI path, vyred down).
    @Published public private(set) var failure: String?
    var process: Process?
    var stopped = false

    public init(argv: [String]) { self.argv = argv }

    public var title: String { "vyre " + argv.joined(separator: " ") }

    func add(_ v: CLIView) {
        if let i = views.firstIndex(where: { $0.kind == v.kind && v.kind != "text" }) { views[i] = v } else { views.append(v) }
    }

    func addText(_ lines: [String]) {
        guard !lines.isEmpty else { return }
        if case .text(let old)? = views.last { views[views.count - 1] = .text(old + lines) } else { views.append(.text(lines)) }
    }

    func finish(_ code: Int32?, failure f: String? = nil) {
        running = false
        exit = code
        if let f { failure = f }
        process = nil
    }

    /// Esc, or the Capsule hid: a live verb ends.
    func stop() {
        stopped = true
        process?.terminate()
    }
}

extension CapsuleModel {
    /// The row for a vyre command in the box: first, alone, and ⏎ runs it.
    func commandRunItem(_ argv: [String]) -> ResultItem {
        let title = "vyre " + argv.joined(separator: " ")
        return ResultItem(id: "cli:" + title, kind: "cli", title: "Run \(title)", subtitle: "Runs here, as the CLI would, and shows what it says",
                          icon: .symbol("terminal", .stone), section: .top, score: 2,
                          actions: [ResultAction(id: "run", title: "Run", symbol: "return", shortcut: KeyShortcut("return")) { [weak self] _, _ in
                              await MainActor.run { self?.runCommand(argv) }
                              return .said("")
                          }])
    }

    /// Run `vyre <argv>` with --view and draw its frames. One command at a time.
    func runCommand(_ typed: [String]) {
        commandRun?.stop()
        let argv = CLIRun.forCapsule(typed)
        let run = CommandRun(argv: argv)
        commandRun = run
        autoTask?.cancel()
        if let why = CLIRun.refused(argv) { run.finish(nil, failure: why); return }
        Task { @MainActor [vyred] in
            var cli = self.cliOverride
            if cli == nil { cli = await Self.cliPath(vyred) }
            guard let cli else { run.finish(nil, failure: vyred.isUp ? "This vyred does not say where its CLI is (it needs a newer vyred)." : "Start Vyre first: vyred is not running, so its commands cannot run."); return }
            let code = await self.exec(run, cli: cli, args: argv + ["--view"], frames: true)
            // A CLI without --view: a usage exit and no frames. Only then, once more, plainly.
            if code == 2, run.views.isEmpty, !run.stopped {
                let again = await self.exec(run, cli: cli, args: argv, frames: false)
                run.finish(again)
            } else {
                run.finish(code)
            }
        }
    }

    /// [node, bin/vyre] from vyred's health, or VYRE_CLI (a path to a vyre executable).
    static func cliPath(_ vyred: VyredClient) async -> [String]? {
        if let e = ProcessInfo.processInfo.environment["VYRE_CLI"], !e.isEmpty { return [e] }
        let h = await vyred.get("/v1/health", timeout: 3)
        guard let cli = (h.data as? [String: Any])?["cli"] as? [String], !cli.isEmpty, cli.allSatisfy({ FileManager.default.isExecutableFile(atPath: $0) || $0.hasSuffix("/bin/vyre") }) else { return nil }
        return cli
    }

    /// One run of the CLI; lines are handed over as they come. The exit code, or nil if it could
    /// not start.
    func exec(_ run: CommandRun, cli: [String], args: [String], frames: Bool, errorsAlways: Bool = false) async -> Int32? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: cli[0])
        p.arguments = Array(cli.dropFirst()) + args
        var env = ProcessInfo.processInfo.environment
        env["NO_COLOR"] = "1"; env["FORCE_COLOR"] = "0"; env["VYRE_NO_DIALOGS"] = env["VYRE_ALLOW_DIALOGS"] == "1" ? nil : "1"
        p.environment = env
        p.standardInput = FileHandle.nullDevice
        let out = Pipe(), err = Pipe()
        p.standardOutput = out; p.standardError = err
        let buffer = LineBuffer()
        let doneCode = CodeBox()
        out.fileHandleForReading.readabilityHandler = { h in
            let lines = buffer.take(h.availableData)
            guard !lines.isEmpty else { return }
            Task { @MainActor in
                var text: [String] = []
                for l in lines {
                    if frames, let f = CLIRun.frame(l) {
                        if let v = f.view { run.add(v) }
                        if let c = f.exit { doneCode.value = c }
                    } else {
                        let t = CLIRun.plain(l)
                        if !t.trimmingCharacters(in: .whitespaces).isEmpty || !text.isEmpty { text.append(t) }
                    }
                }
                run.addText(text)
            }
        }
        run.process = p
        let code: Int32? = await withCheckedContinuation { k in
            p.terminationHandler = { proc in k.resume(returning: proc.terminationStatus) }
            do { try p.run() } catch { k.resume(returning: nil) }
        }
        out.fileHandleForReading.readabilityHandler = nil
        let rest = buffer.flush(out.fileHandleForReading.readDataToEndOfFile())
        let errText = CLIRun.plain(String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? "")
        // Let the last handed-over lines land first.
        await Task.yield()
        var tail: [String] = []
        for l in rest { if frames, let f = CLIRun.frame(l) { if let v = f.view { run.add(v) }; if let c = f.exit { doneCode.value = c } } else { tail.append(CLIRun.plain(l)) } }
        run.addText(tail)
        // Its error words, when there is nothing else to show (or always, for `vyre up`, whose
        // failure is the one thing to see); not for the --view usage exit, which runs once more plainly.
        if run.views.isEmpty || errorsAlways, code != 0, !(frames && code == 2 && !errorsAlways) {
            let e = errText.split(separator: "\n").map(String.init).filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
            run.addText(e)
        }
        return doneCode.value ?? code
    }

    /// Esc on a command: stop a live one, else clear it.
    func escCommand() -> Bool {
        guard let r = commandRun else { return false }
        if r.running { r.stop(); return true }
        commandRun = nil
        return true
    }
}

/// Bytes to whole lines, across reads.
final class LineBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private var pending = Data()
    func take(_ d: Data) -> [String] {
        lock.lock(); defer { lock.unlock() }
        pending.append(d)
        var out: [String] = []
        while let i = pending.firstIndex(of: 0x0A) {
            out.append(String(decoding: pending[pending.startIndex..<i], as: UTF8.self))
            pending.removeSubrange(pending.startIndex...i)
        }
        return out
    }
    func flush(_ d: Data) -> [String] {
        var out = take(d)
        lock.lock(); defer { lock.unlock() }
        if !pending.isEmpty { out.append(String(decoding: pending, as: UTF8.self)); pending = Data() }
        return out
    }
}

final class CodeBox: @unchecked Sendable { var value: Int32? }
