// StartVyre: with vyred down, the Capsule starts it itself.
//
// The user, 2026-09-28: the Offline line said "Start it with vyre up", and typing `vyre up` in the
// Capsule said "vyred is not running, so its commands cannot run", because `vyre ...` lines run
// through vyred's own CLI path from /v1/health. A dead end. Now the Offline line is an action
// ("Start Vyre", on Return), `vyre up` typed while offline is that action, and any other `vyre ...`
// says "Start Vyre first" with the same action.
//
// The CLI is found without vyred: VYRE_CLI, then the one `vyre capsule` recorded in
// <home>/capsule/cli.json ({"cli": [node, bin/vyre]}), then `vyre` on PATH (plus the two usual
// install folders, since an app started by launchd has a short PATH). It runs by argv, never a
// shell string, and nothing from the box is ever part of it: the argv is fixed. Its lines are
// drawn as they come (CommandRun), and the panel turns online when the follower hears /v1/health.

import Foundation

public enum VyreCLI {
    /// The argv prefix that runs the vyre CLI, or nil when none is found.
    public static func locate(home: String, env: [String: String] = ProcessInfo.processInfo.environment) -> [String]? {
        // Under the Swift tests only the scratch home's record counts: a test never finds, and so
        // never starts, the person's real vyre.
        if env["VYRE_CAPSULE_TEST"] == "1" { return recorded(home: home) }
        if let e = env["VYRE_CLI"], !e.isEmpty, runnable([e]) { return [e] }
        if let r = recorded(home: home) { return r }
        return onPath(env)
    }

    /// What `vyre capsule` wrote in <home>/capsule/cli.json, if it still points at real files.
    public static func recorded(home: String) -> [String]? {
        let f = URL(fileURLWithPath: home).appendingPathComponent("capsule/cli.json")
        guard let d = try? Data(contentsOf: f), let o = VJ.decode(d) as? [String: Any],
              let cli = o["cli"] as? [String], runnable(cli) else { return nil }
        return cli
    }

    /// Where npm and Homebrew put `vyre` when launchd's PATH does not say.
    public static let usualDirs = ["/opt/homebrew/bin", "/usr/local/bin"]

    /// `vyre` on PATH, then in the usual folders.
    public static func onPath(_ env: [String: String], extra: [String] = usualDirs) -> [String]? {
        let dirs = (env["PATH"] ?? "").split(separator: ":").map(String.init) + extra
        for d in dirs where d.hasPrefix("/") {
            let p = (d as NSString).appendingPathComponent("vyre")
            if FileManager.default.isExecutableFile(atPath: p) { return [p] }
        }
        return nil
    }

    /// Absolute paths only; the first one executable, the rest (bin/vyre for node) existing files.
    static func runnable(_ cli: [String]) -> Bool {
        guard let first = cli.first, cli.count <= 2, cli.allSatisfy({ $0.hasPrefix("/") }),
              FileManager.default.isExecutableFile(atPath: first) else { return false }
        return cli.dropFirst().allSatisfy { FileManager.default.fileExists(atPath: $0) }
    }
}

extension CapsuleModel {
    /// `vyre up`, run from here: the argv is fixed. --no-capsule, since this is the Capsule.
    static let startArgv = ["up", "--no-capsule"]

    /// vyred is being started from this Capsule.
    var startingVyre: Bool { commandRun.map { $0.argv == Self.startArgv && $0.running } ?? false }

    /// Return on an empty box while offline starts Vyre.
    func returnStartsVyre() -> Bool {
        guard offline, target == nil, text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              desk.mode == .none, !actionMenu.isOpen else { return false }
        startVyre()
        return true
    }

    /// Run `vyre up` with the CLI found on this Mac, show what it says, then look for vyred at once.
    func startVyre() {
        guard !startingVyre else { return }
        commandRun?.stop()
        let run = CommandRun(argv: Self.startArgv)
        commandRun = run
        autoTask?.cancel()
        guard let cli = cliOverride ?? VyreCLI.locate(home: home) else {
            run.finish(nil, failure: "The Capsule could not find the vyre command. Run vyre capsule once in Terminal, so it knows where Vyre is.")
            return
        }
        Task { @MainActor in
            // Plain frames when the CLI has --view; `up` is never run twice, whatever it exits with.
            let code = await self.exec(run, cli: cli, args: Self.startArgv + ["--view"], frames: true, errorsAlways: true)
            run.finish(code)
            if code == 0 { self.vyred.follower.lookNow() }
        }
    }

    /// The row a `vyre ...` line gets while vyred is down: start it, since nothing else can run.
    func startFirstItem(_ argv: [String]) -> ResultItem {
        let up = argv.first == "up"
        return ResultItem(id: "cli:start", kind: "cli", title: up ? "Start Vyre" : "Start Vyre first",
                          subtitle: up ? "vyred is not running on this Mac. Return starts it." : "vyre \(argv.joined(separator: " ")) needs vyred, which is not running. Return starts it.",
                          icon: .symbol("power", .stone), section: .top, score: 2,
                          actions: [ResultAction(id: "start", title: "Start Vyre", symbol: "return", shortcut: KeyShortcut("return")) { [weak self] _, _ in
                              await MainActor.run { self?.startVyre() }
                              return .said("")
                          }])
    }
}
