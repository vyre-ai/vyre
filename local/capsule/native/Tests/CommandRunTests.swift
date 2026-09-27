// capsule-suite: commandRunSuite
// `vyre ...` in the box (Host/CommandRun.swift): recognised before anything else, run by argv with
// --view, frames drawn natively, the plain fallback for a CLI without --view, and Esc ending a
// live verb. A fake vyre (a small sh script in the test scratch) stands in for the CLI.

import AppKit
import SwiftUI

private let viewCLI = """
#!/bin/sh
case "$*" in
  *--view*) ;;
  *) echo "view needed"; exit 9;;
esac
case "$1" in
  voice)
    echo '{"v":1,"cmd":"voice status","view":{"kind":"card","title":"Voice","fields":[{"label":"Provider","value":"deepgram"},{"label":"Key","value":"missing"}],"state":"offline"},"data":{}}'
    echo 'not a frame, said as text'
    echo '{"v":1,"cmd":"voice status","view":{"kind":"card","title":"Voice","fields":[{"label":"Provider","value":"deepgram"},{"label":"Key","value":"saved"}]},"data":{}}'
    echo '{"v":1,"done":true,"exit":0}';;
  phone)
    echo '{"v":1,"cmd":"phone add","view":{"kind":"qr","text":"https://harlow.example/pair/abc","caption":"Scan with the phone"},"data":{}}'
    echo '{"v":1,"cmd":"phone add","view":{"kind":"checks","items":[{"id":"a","label":"Phone paired","state":"wait"}]},"data":{}}'
    echo '{"v":1,"cmd":"threads list","view":{"kind":"table","columns":[{"key":"name","label":"Name"},{"key":"state","label":"State"}],"rows":[{"name":"Northwind menu","state":"idle"},{"name":"Harlow intake","state":"running"}]},"data":[]}'
    echo '{"v":1,"done":true,"exit":0}';;
  watch) echo '{"v":1,"cmd":"watch","view":{"kind":"text","lines":["watching"]},"data":{}}'; exec sleep 30;;
  fail) echo '{"v":1,"cmd":"fail","view":{"kind":"error","code":"vyred_down","message":"vyred is not running","next":"Start it from the menu bar"},"data":{}}'; echo '{"v":1,"done":true,"exit":5}'; exit 5;;
esac
"""

/// A CLI from before --view: a usage error for the flag, colour in its plain output.
private let oldCLI = """
#!/bin/sh
echo "$*" >> "$(dirname "$0")/runs.txt"
case "$*" in
  *--view*) echo "unknown flag --view" >&2; exit 2;;
esac
printf '\\033[1mvoice\\033[0m deepgram \\033[32msaved\\033[0m\\n'
exit 0
"""

private func script(_ name: String, _ body: String) -> String {
    let dir = vyScratch("cli-\(UUID().uuidString.prefix(6))")
    let p = dir + "/" + name
    FileManager.default.createFile(atPath: p, contents: Data(body.utf8), attributes: [.posixPermissions: 0o755])
    return p
}

@MainActor private func runModel(_ cli: String) -> CapsuleModel {
    let m = CapsuleModel(home: vyScratch("cli-home"), vyred: VyredClient(socket: vyScratch("cli") + "/none.sock"), providers: [])
    m.cliOverride = [cli]
    return m
}

private func until(_ cond: @escaping @MainActor () -> Bool) async -> Bool {
    for _ in 0..<250 { if await MainActor.run(body: cond) { return true }; try? await Task.sleep(nanoseconds: 20_000_000) }
    return false
}

let commandRunSuite = Suite("command run") { t in
    t.test("vyre words are a command first: argv, quotes, and not a question") {
        t.eq(CLIRun.parse("run vyre voice"), ["voice"])
        t.eq(CLIRun.parse("vyre voice status"), ["voice", "status"])
        t.eq(CLIRun.parse("vyre remind 'call dana' 5m"), ["remind", "call dana", "5m"])
        t.eq(CLIRun.parse("vyre"), nil)
        t.eq(CLIRun.parse("what is vyre"), nil)
        t.eq(CLIRun.parse("vyred status"), nil)
        t.eq(CapsuleModel.wantsAnswer("run vyre voice", topKind: nil, topScore: 0), false)
        t.eq(CLIRun.forCapsule(["voice"]), ["voice", "status"], "the terminal's push-to-talk is Option-Return here")
        t.ok(CLIRun.refused(["capsule"]) != nil && CLIRun.refused(["voice", "--send", "t1"]) != nil && CLIRun.refused(["voice", "status"]) == nil)
        let rows = MainActor.assumeIsolated { () -> [String] in
            let m = runModel("/nonexistent")
            m.text = "run vyre voice"
            return m.groups.flatMap(\.items).map { "\($0.kind) \($0.title)" }
        }
        t.eq(rows, ["cli Run vyre voice"], "one row, nothing else and no memory answer")
    }

    t.test("frames: a card replaced by its newer frame, text between, the exit") {
        let cli = script("vyre", viewCLI)
        let r: [String]? = t.wait {
            let m = await MainActor.run { runModel(cli) }
            await MainActor.run { m.text = "vyre voice status"; m.run() }
            _ = await until { m.commandRun?.running == false }
            return await MainActor.run {
                guard let run = m.commandRun else { return ["no run"] }
                return run.views.map(\.kind) + ["exit \(run.exit.map(String.init) ?? "nil")", String(describing: run.views.first).contains("saved") ? "newest card" : "old card"]
            }
        }
        t.eq(r, ["card", "text", "exit 0", "newest card"])
    }

    t.test("qr, checks and a table draw; an error frame says what to do next") {
        let cli = script("vyre", viewCLI)
        let r: [String]? = t.wait {
            let m = await MainActor.run { runModel(cli) }
            await MainActor.run { m.runCommand(["phone", "add"]) }
            _ = await until { m.commandRun?.running == false }
            let kinds = await MainActor.run { m.commandRun?.views.map(\.kind) ?? [] }
            let drew: Bool = await MainActor.run {
                let host = NSHostingView(rootView: CapsuleView(model: m, focus: FocusTicket(), snapshot: true))
                host.frame = NSRect(x: 0, y: 0, width: Theme.width, height: CapsuleLayout.panelHeight(m))
                host.layoutSubtreeIfNeeded()
                guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return false }
                host.cacheDisplay(in: host.bounds, to: rep)
                if let dir = ProcessInfo.processInfo.environment["VYRE_CAPSULE_SNAP"], let png = rep.representation(using: .png, properties: [:]) {
                    try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("9-command.png"))
                }
                return rep.pixelsWide > 0 && CLIRun.qrImage("https://harlow.example/pair/abc") != nil
            }
            await MainActor.run { m.runCommand(["fail"]) }
            _ = await until { m.commandRun?.running == false }
            let err = await MainActor.run { [m.commandRun?.views.map(\.kind).joined() ?? "", "\(m.commandRun?.exit ?? -1)"] }
            return kinds + ["\(drew)"] + err
        }
        t.eq(r, ["qr", "checks", "table", "true", "error", "5"])
    }

    t.test("a CLI without --view: one usage exit, then once more plainly, colour out") {
        let cli = script("vyre", oldCLI)
        let r: [String]? = t.wait {
            let m = await MainActor.run { runModel(cli) }
            await MainActor.run { m.runCommand(["voice"]) }
            _ = await until { m.commandRun?.running == false }
            let runs = (try? String(contentsOfFile: (cli as NSString).deletingLastPathComponent + "/runs.txt", encoding: .utf8)) ?? ""
            return await MainActor.run { [String(describing: m.commandRun?.views ?? []), "exit \(m.commandRun?.exit ?? -1)"] } + runs.split(separator: "\n").map(String.init)
        }
        t.ok(r?[0].contains("voice deepgram saved") == true && r?[0].contains("\u{1B}") == false, r?[0] ?? "")
        t.eq(Array(r?.dropFirst() ?? []), ["exit 0", "voice status --view", "voice status"])
    }

    t.test("Esc ends a live verb, and a second Esc clears it") {
        let cli = script("vyre", viewCLI)
        let r: [String]? = t.wait {
            let m = await MainActor.run { runModel(cli) }
            await MainActor.run { m.runCommand(["watch"]) }
            _ = await until { !(m.commandRun?.views.isEmpty ?? true) }
            let live = await MainActor.run { "\(m.commandRun?.running == true)" }
            _ = await MainActor.run { m.escCommand() }
            let ended = await until { m.commandRun?.running == false }
            _ = await MainActor.run { m.escCommand() }
            return [live, "\(ended)", await MainActor.run { m.commandRun == nil ? "cleared" : "kept" }]
        }
        t.eq(r, ["true", "true", "cleared"])
    }
}
