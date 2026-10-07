// capsule-suite: startVyreSuite
// Offline, the Capsule starts vyred itself (Host/StartVyre.swift): the CLI found without vyred,
// Return on the Offline line runs `vyre up`, a `vyre ...` line says "Start Vyre first", and the
// panel turns online once /v1/health answers. A FakeVyred and a fake vyre stand in; the fake CLI
// only writes to the test scratch, and the person's real vyred is never started.

import AppKit

/// A vyre that records its argv, says one card, and exits with `code`.
private func fakeUp(_ code: Int32) -> (cli: String, runs: String) {
    let dir = vyScratch("start-\(UUID().uuidString.prefix(6))")
    let runs = dir + "/runs.txt"
    let body = """
    #!/bin/sh
    echo "$*" >> "\(runs)"
    echo '{"v":1,"cmd":"up","view":{"kind":"text","lines":["starting vyred"]},"data":{}}'
    sleep 0.3
    [ \(code) = 0 ] || { echo "vyred did not start: port in use" >&2; exit \(code); }
    echo '{"v":1,"cmd":"up","view":{"kind":"card","title":"vyred","fields":[{"label":"State","value":"running"}]},"data":{}}'
    echo '{"v":1,"done":true,"exit":0}'
    """
    let p = dir + "/vyre"
    FileManager.default.createFile(atPath: p, contents: Data(body.utf8), attributes: [.posixPermissions: 0o755])
    return (p, runs)
}

private func executable(_ path: String) {
    try? FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    FileManager.default.createFile(atPath: path, contents: Data("#!/bin/sh\n".utf8), attributes: [.posixPermissions: 0o755])
}

/// A Capsule whose vyred is down and known to be: the follower looked once and is waiting.
@MainActor private func offlineModel(_ v: FakeVyred, cli: String?) -> CapsuleModel {
    let c = VyredClient(socket: v.socket)
    c.useClock(ManualClock())
    let m = CapsuleModel(home: vyScratch("start-home-\(UUID().uuidString.prefix(6))"), vyred: c, providers: [])
    m.cliOverride = cli.map { [$0] }
    c.follower.start()
    return m
}

private func lines(_ f: String) -> [String] {
    ((try? String(contentsOfFile: f, encoding: .utf8)) ?? "").split(separator: "\n").map(String.init)
}

let startVyreSuite = Suite("start vyre") { t in
    t.test("the CLI is found without vyred: VYRE_CLI, the record vyre capsule wrote, then PATH") {
        let home = vyScratch("start-find-\(UUID().uuidString.prefix(6))")
        let node = home + "/bin/node", bin = home + "/pkg/bin/vyre", own = home + "/own/vyre", onPath = home + "/path/vyre"
        [node, bin, own, onPath].forEach(executable)
        let env = ["PATH": home + "/path"]
        t.eq(VyreCLI.locate(home: home, env: env), [onPath], "no record: PATH")
        try? FileManager.default.createDirectory(atPath: home + "/capsule", withIntermediateDirectories: true)
        try? Data(#"{"cli":["\#(node)","\#(bin)"]}"#.utf8).write(to: URL(fileURLWithPath: home + "/capsule/cli.json"))
        t.eq(VyreCLI.locate(home: home, env: env), [node, bin], "the record beats PATH")
        t.eq(VyreCLI.locate(home: home, env: env.merging(["VYRE_CLI": own]) { $1 }), [own], "VYRE_CLI first")
        t.eq(VyreCLI.locate(home: home, env: ["VYRE_CAPSULE_TEST": "1", "VYRE_CLI": own, "PATH": home + "/path"]), [node, bin],
             "under the tests only the scratch home's record counts")
        try? Data(#"{"cli":["node","bin/vyre"]}"#.utf8).write(to: URL(fileURLWithPath: home + "/capsule/cli.json"))
        t.eq(VyreCLI.recorded(home: home), nil, "relative paths are refused")
        try? Data(#"{"cli":["\#(node)","\#(home)/gone/vyre"]}"#.utf8).write(to: URL(fileURLWithPath: home + "/capsule/cli.json"))
        t.eq(VyreCLI.recorded(home: home), nil, "a record pointing at a missing file is refused")
        t.eq(VyreCLI.onPath(["PATH": home + "/nothing"], extra: []), nil)
    }

    t.test("offline: Return on the empty box runs vyre up, and the panel turns online when health answers") {
        let v = FakeVyred()   // down until the fake vyre "starts" it
        defer { v.stop() }
        let fake = fakeUp(0)
        MainActor.assumeIsolated {
            let m = offlineModel(v, cli: fake.cli)
            t.ok(until { m.offline }, "offline once the follower looked")
            t.ok(m.returnStartsVyre(), "Return on the empty box is the Offline line's action")
            t.ok(m.startingVyre, "starting, shown in the Offline line")
            t.ok(!m.returnStartsVyre() || m.startingVyre, "a second Return while starting starts nothing new")
            t.ok(until { !lines(fake.runs).isEmpty })
            v.start()   // what `vyre up` does
            t.ok(until(8) { !m.offline && m.vyred.isUp }, "online after vyre up")
            t.ok(until { m.commandRun?.running == false })
            t.eq(lines(fake.runs), ["up --no-capsule --view"], "once, by argv, with --view")
            t.eq(m.commandRun?.exit, 0)
            t.ok(m.commandRun?.views.contains { String(describing: $0).contains("running") } == true, "its card is shown")
            m.vyred.follower.stop()
        }
    }

    t.test("offline: a vyre command says Start Vyre first, and vyre up is Start Vyre") {
        let v = FakeVyred()
        defer { v.stop() }
        let fake = fakeUp(0)
        MainActor.assumeIsolated {
            let m = offlineModel(v, cli: fake.cli)
            t.ok(until { m.offline })
            m.text = "vyre voice status"
            t.eq(m.flat.map(\.title), ["Start Vyre first"])
            t.ok(m.flat.first?.subtitle.contains("vyre voice status needs Vyre") == true)
            m.text = "vyre up"
            t.eq(m.flat.map(\.title), ["Start Vyre"])
            m.text = "   "
            t.ok(m.flat.isEmpty)
            m.text = "vyre voice status"
            m.run()
            t.ok(until { m.startingVyre || m.commandRun?.argv == CapsuleModel.startArgv }, "the row's Return starts Vyre, not the command")
            t.ok(until { m.commandRun?.running == false })
            t.eq(lines(fake.runs), ["up --no-capsule --view"])
            m.vyred.follower.stop()
        }
    }

    t.test("a failed start shows why and stays offline; no CLI found says how to fix it") {
        let v = FakeVyred()
        defer { v.stop() }
        let fake = fakeUp(1)
        MainActor.assumeIsolated {
            let m = offlineModel(v, cli: fake.cli)
            t.ok(until { m.offline })
            m.startVyre()
            t.ok(until { m.commandRun?.running == false })
            t.eq(m.commandRun?.exit, 1)
            t.ok(m.commandRun?.views.contains { String(describing: $0).contains("port in use") } == true, "its error words are shown")
            t.ok(m.offline && !m.startingVyre, "still offline, and Start Vyre is back")
            m.vyred.follower.stop()

            let none = offlineModel(v, cli: nil)   // scratch home, no record: nothing is found
            t.ok(until { none.offline })
            none.startVyre()
            t.ok(none.commandRun?.failure?.contains("vyre capsule") == true, "\(none.commandRun?.failure ?? "nil")")
            t.ok(!none.startingVyre)
            none.vyred.follower.stop()
        }
    }

    t.test("online: vyre commands run as before, and Return on the empty box starts nothing") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        MainActor.assumeIsolated {
            let m = offlineModel(v, cli: "/nonexistent")
            t.ok(until { m.vyred.follower.isStreaming })
            t.ok(!m.offline)
            t.ok(!m.returnStartsVyre())
            m.text = "vyre voice status"
            t.eq(m.flat.map(\.title), ["Run vyre voice status"])
            m.vyred.follower.stop()
        }
    }

    t.test("the app's bundled setup is found by its files, and setup.json can change the installer's arguments") {
        let dir = vyScratch("setup-find-\(UUID().uuidString.prefix(6))")
        t.eq(BundledSetup.locate(env: ["VYRE_CAPSULE_SETUP_DIR": dir], resources: nil), nil, "no installer, no setup")
        executable(dir + "/install-mac-server.sh")
        t.eq(BundledSetup.locate(env: ["VYRE_CAPSULE_SETUP_DIR": dir], resources: nil), BundledSetup(dir: dir, nodeTgz: nil, args: ["--yes"]), "the installer alone: --yes")
        FileManager.default.createFile(atPath: dir + "/node-v22.0.0-darwin-arm64.tar.gz", contents: Data("x".utf8))
        try? Data(#"{"args":["--yes","--login-only"]}"#.utf8).write(to: URL(fileURLWithPath: dir + "/setup.json"))
        let s = BundledSetup.locate(env: ["VYRE_CAPSULE_SETUP_DIR": dir], resources: nil)
        t.eq(s?.nodeTgz, dir + "/node-v22.0.0-darwin-arm64.tar.gz")
        t.eq(s?.args, ["--yes", "--login-only"])
        t.eq(s?.environment, ["VYRE_SUDO": dir + "/vyre-sudo", "VYRE_NODE_URL": "file://" + dir + "/node-v22.0.0-darwin-arm64.tar.gz"])
        t.eq(BundledSetup.locate(env: [:], resources: dir + "/nothing-here"), nil, "an app without the folder has no setup")
        t.eq(BundledSetup.locate(env: ["VYRE_CAPSULE_SETUP_DIR": "relative/dir"], resources: nil), nil, "a relative folder is refused")
    }

    t.test("offline with no vyre on this Mac: Start Vyre runs the bundled setup with its own sudo and Node, and says what it prints") {
        let v = FakeVyred()
        defer { v.stop() }
        let dir = vyScratch("setup-run-\(UUID().uuidString.prefix(6))")
        let body = """
        #!/bin/sh
        echo "  ok  args: $*"
        echo "  ok  sudo: $VYRE_SUDO"
        echo "  ok  node: $VYRE_NODE_URL"
        echo "  ok  box: ${VYRE_BOX_URL:-unset}"
        echo "  ok  path: $PATH"
        echo "vyre: pretend failure" >&2
        exit 0
        """
        FileManager.default.createFile(atPath: dir + "/install-mac-server.sh", contents: Data(body.utf8), attributes: [.posixPermissions: 0o755])
        FileManager.default.createFile(atPath: dir + "/node-v22.0.0-darwin-arm64.tar.gz", contents: Data("x".utf8))
        setenv("VYRE_BOX_URL", "https://evil.example/", 1)
        defer { unsetenv("VYRE_BOX_URL") }
        MainActor.assumeIsolated {
            let m = offlineModel(v, cli: nil)
            m.setupOverride = BundledSetup.locate(env: ["VYRE_CAPSULE_SETUP_DIR": dir], resources: nil)
            t.ok(until { m.offline })
            t.ok(m.returnStartsVyre())
            t.ok(until { m.commandRun?.running == false })
            let text = String(describing: m.commandRun?.views ?? [])
            t.ok(text.contains("args: --yes"), text)
            t.ok(text.contains("sudo: \(dir)/vyre-sudo"), "the dialog sudo is the one used")
            t.ok(text.contains("node: file://\(dir)/node-v22.0.0-darwin-arm64.tar.gz"), "the bundled Node, not a download")
            t.ok(text.contains("box: unset"), "a variable the person's session set (VYRE_BOX_URL) does not reach the installer")
            t.ok(text.contains("path: /usr/bin:/bin:/usr/sbin:/sbin"), "the installer's PATH is the system's")
            t.eq(m.commandRun?.exit, 0)
            m.vyred.follower.stop()
        }
    }

    t.test("the installer's environment is built from nothing: the system PATH, the person's HOME USER LANG, and the two setup variables") {
        let s = BundledSetup(dir: "/x/setup", nodeTgz: "/x/setup/node-v1-darwin-arm64.tar.gz", args: ["--yes"])
        let e = s.scrubbedEnvironment(["HOME": "/Users/a", "USER": "a", "LANG": "en_US.UTF-8", "VYRE_BOX_URL": "evil", "PATH": "/evil", "VYRE_INSTALL_MAIN": "/evil"])
        t.eq(e, ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": "/Users/a", "USER": "a", "LANG": "en_US.UTF-8", "VYRE_SUDO": "/x/setup/vyre-sudo",
                 "VYRE_NODE_URL": "file:///x/setup/node-v1-darwin-arm64.tar.gz"])
    }

    t.test("offline with no vyre and no bundled setup: the old words, nothing is run") {
        let v = FakeVyred()
        defer { v.stop() }
        MainActor.assumeIsolated {
            let m = offlineModel(v, cli: nil)
            m.setupOverride = nil
            t.ok(until { m.offline })
            // The app under test has no Resources/setup, so locate finds none either.
            t.ok(m.returnStartsVyre())
            t.ok(until { m.commandRun?.running == false })
            t.ok((m.commandRun?.failure ?? "").contains("Run vyre capsule once in Terminal"), m.commandRun?.failure ?? "no failure")
            m.vyred.follower.stop()
        }
    }

    t.test("the bundled setup refuses to run when a file is a link, is writable by others, or the app's signature no longer verifies") {
        let dir = vyScratch("setup-safe-\(UUID().uuidString.prefix(6))")
        for n in ["install-mac-server.sh", "vyre-sudo", "vyre-sudo-check", "askpass"] {
            FileManager.default.createFile(atPath: dir + "/" + n, contents: Data("#!/bin/sh\n".utf8), attributes: [.posixPermissions: 0o755])
        }
        let s = BundledSetup(dir: dir, nodeTgz: nil, args: ["--yes"])
        t.eq(s.problem(bundle: nil), nil, "ordinary files, outside an app: fine")
        try? FileManager.default.setAttributes([.posixPermissions: 0o775], ofItemAtPath: dir + "/vyre-sudo")
        t.ok(s.problem(bundle: nil)?.contains("vyre-sudo can be changed") == true, "group-writable is refused")
        try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: dir + "/vyre-sudo")
        try? FileManager.default.removeItem(atPath: dir + "/askpass")
        try? FileManager.default.createSymbolicLink(atPath: dir + "/askpass", withDestinationPath: "/bin/echo")
        t.ok(s.problem(bundle: nil)?.contains("askpass is not an ordinary file") == true, "a link is refused")
        try? FileManager.default.removeItem(atPath: dir + "/askpass")
        FileManager.default.createFile(atPath: dir + "/askpass", contents: Data("#!/bin/sh\n".utf8), attributes: [.posixPermissions: 0o755])
        let app = (dir as NSString).deletingLastPathComponent
        t.eq(s.problem(bundle: app, runner: { _ in true }), nil, "inside an app whose signature verifies")
        t.ok(s.problem(bundle: app, runner: { _ in false })?.contains("signature no longer verifies") == true, "inside an app that no longer verifies: refused")
        t.ok(s.problem(bundle: "/somewhere/else", runner: { _ in false }) == nil, "not inside that app: the signature is not asked about")
    }

    t.test("the button says Set up Vyre on this Mac only while the app has setup to do, and Start Vyre when Vyre is set up and not running") {
        let v = FakeVyred()
        defer { v.stop() }
        let dir = vyScratch("setup-words-\(UUID().uuidString.prefix(6))")
        executable(dir + "/install-mac-server.sh")
        let fake = fakeUp(0)
        MainActor.assumeIsolated {
            let m = offlineModel(v, cli: nil)
            m.setupOverride = BundledSetup.locate(env: ["VYRE_CAPSULE_SETUP_DIR": dir], resources: nil)
            t.ok(m.setupNeeded)
            t.eq(m.startWords, "Set up Vyre on this Mac")
            t.eq(m.startingWords, "Setting up Vyre on this Mac…")
            t.eq(m.startFirstItem(["up"]).title, "Set up Vyre on this Mac")
            t.eq(m.startFirstItem(["voice", "status"]).title, "Set up Vyre first")
            t.ok(m.startFirstItem(["up"]).subtitle.contains("with your Mac password once"))
            m.cliOverride = [fake.cli]
            t.ok(!m.setupNeeded, "a vyre is on this Mac")
            t.eq(m.startWords, "Start Vyre")
            t.eq(m.startFirstItem(["up"]).title, "Start Vyre")
            m.cliOverride = nil; m.setupOverride = nil
            t.eq(m.startWords, "Start Vyre", "no bundled setup either: the old words")
        }
    }
}
