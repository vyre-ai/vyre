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

/// What the app carries to set Vyre up on a Mac with no terminal and no Node (Contents/Resources/setup, put there by
/// scripts/mac-app-package.sh): the installer script, the pinned Node tarball for this architecture, and the sudo helper that asks
/// for the Mac password in a dialog. setup.json can name extra installer arguments ("args"), so the flags change without the app.
public struct BundledSetup: Equatable {
    public let dir: String
    public var script: String { dir + "/install-mac-server.sh" }
    public var sudo: String { dir + "/vyre-sudo" }
    /// The Node tarball, or nil when the app was built without one.
    public let nodeTgz: String?
    public let args: [String]

    /// The environment the installer runs with: the dialog sudo, and the bundled Node instead of a download. The installer still
    /// checks the tarball against the checksum pinned inside itself.
    public var environment: [String: String] {
        var e = ["VYRE_SUDO": sudo]
        if let nodeTgz { e["VYRE_NODE_URL"] = "file://" + nodeTgz }
        return e
    }

    /// The whole environment the installer runs with, and nothing inherited: a same-user process can `launchctl setenv` VYRE_BOX_URL,
    /// VYRE_CORE_BASE, VYRE_NODE_SHA256, VYRE_INSTALL_MAIN, PATH and the like before Lumen starts, and the installer honours them.
    public func scrubbedEnvironment(_ from: [String: String] = ProcessInfo.processInfo.environment) -> [String: String] {
        var e = environment
        e["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin"
        for k in ["HOME", "USER", "LANG"] { if let v = from[k], !v.isEmpty { e[k] = v } }
        return e
    }

    /// Nil when this setup is safe to run as the person's install (it ends with one sudo), else the reason it is not. The files must be
    /// ordinary (no links) and writable by nobody but the person. Inside the app, the app's own signature must still verify, so a file
    /// changed after the build refuses to run. This catches a damaged or half-changed app, not a deliberate swap: 0.2.x is self-signed, and an
    /// ad hoc signature can be redone by whoever changed the file. Nothing inside a bundle the person's own user can write can anchor trust;
    /// a root-owned copy or a Developer ID requirement (0.2.5) would. vyre-sudo's pins limit what that file can ask sudo to run.
    public func problem(bundle: String? = Bundle.main.bundlePath, runner: (String) -> Bool = BundledSetup.codesignOK) -> String? {
        let fm = FileManager.default
        for name in ["install-mac-server.sh", "vyre-sudo", "vyre-sudo-check", "askpass"] + (nodeTgz.map { [($0 as NSString).lastPathComponent] } ?? []) {
            let path = dir + "/" + name
            guard let a = try? fm.attributesOfItem(atPath: path) else { return "\(name) is missing from the setup" }
            if a[.type] as? FileAttributeType != .typeRegular { return "\(name) is not an ordinary file" }
            if let perm = a[.posixPermissions] as? NSNumber, perm.intValue & 0o022 != 0 { return "\(name) can be changed by others" }
        }
        if let bundle, dir.hasPrefix(bundle + "/"), !runner(bundle) { return "this app's signature no longer verifies, so the setup inside it will not run. Download Lumen again." }
        return nil
    }

    /// `codesign --verify --deep --strict` on the app: true when it passes.
    public static func codesignOK(_ bundle: String) -> Bool {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
        p.arguments = ["--verify", "--deep", "--strict", bundle]
        p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return false }
        p.waitUntilExit()
        return p.terminationStatus == 0
    }

    /// The setup folder inside this app, or VYRE_CAPSULE_SETUP_DIR (tests, and a hand-run check). Nil when there is none.
    public static func locate(env: [String: String] = ProcessInfo.processInfo.environment, resources: String? = Bundle.main.resourcePath) -> BundledSetup? {
        let dir = env["VYRE_CAPSULE_SETUP_DIR"].flatMap { $0.isEmpty ? nil : $0 } ?? resources.map { $0 + "/setup" }
        guard let dir, dir.hasPrefix("/"), FileManager.default.isExecutableFile(atPath: dir + "/install-mac-server.sh") else { return nil }
        var tgz: String?
        var args = ["--yes"]
        if let names = try? FileManager.default.contentsOfDirectory(atPath: dir) {
            tgz = names.first { $0.hasPrefix("node-") && $0.hasSuffix(".tar.gz") }.map { dir + "/" + $0 }
        }
        if let d = try? Data(contentsOf: URL(fileURLWithPath: dir + "/setup.json")), let o = VJ.decode(d) as? [String: Any],
           let a = o["args"] as? [String], a.allSatisfy({ !$0.isEmpty }) { args = a }
        return BundledSetup(dir: dir, nodeTgz: tgz, args: args)
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
            // No vyre on this Mac: the app's own setup, with its own Node. Its lines are drawn as they come, and it asks for the
            // Mac password in a dialog (not a terminal). Only when the app was built with it; otherwise the old words.
            guard let setup = setupOverride ?? BundledSetup.locate() else {
                run.finish(nil, failure: "Lumen could not find the vyre command. Run vyre capsule once in Terminal, so it knows where Vyre is.")
                return
            }
            if let why = setupOverride == nil ? setup.problem() : nil {
                run.finish(nil, failure: "Lumen will not run its setup: \(why)")
                return
            }
            Task { @MainActor in
                let code = await self.exec(run, cli: ["/bin/sh", setup.script], args: setup.args, frames: false, errorsAlways: true, environment: setup.scrubbedEnvironment(), replaceEnvironment: true)
                run.finish(code)
                if code == 0 { self.vyred.follower.lookNow() }
            }
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
                          subtitle: up ? "Vyre is not running on this Mac. Return starts it." : "vyre \(argv.joined(separator: " ")) needs Vyre, which is not running. Return starts it.",
                          icon: .symbol("power", .stone), section: .top, score: 2,
                          actions: [ResultAction(id: "start", title: "Start Vyre", symbol: "return", shortcut: KeyShortcut("return")) { [weak self] _, _ in
                              await MainActor.run { self?.startVyre() }
                              return .said("")
                          }])
    }
}
