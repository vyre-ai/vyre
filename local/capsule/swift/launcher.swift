// launcher — one macOS identity for vyred, so Accessibility can be granted to Vyre alone.
//
//   vyre-launcher [--repo <path>]     run vyred under this binary, and exit with its status
//
// macOS grants Accessibility and Input Monitoring to a process identity, and a launchd job's
// identity is whatever launchd executes. Pointing launchd at a shell would grant EVERY shell on
// the Mac the permission hands-mac needs. A binary of its own gives vyred one identity that can
// be granted, revoked and seen in the list under its own name.
//
// It does not exec vyred. It starts it and waits, as its parent, because macOS follows the
// responsible process and the responsible process has to still be alive. Exiting with the
// child's status is what lets launchd supervise: a crash propagates, a clean stop is respected.
//
// Changing this file costs the user a manual re-grant. The binary is ad-hoc signed, and macOS
// keys the grant for an ad-hoc signature to the binary's hash, which moves with every rebuild.
// No script can restore it; the user re-ticks it in System Settings. So nothing that can live in
// vyred lives here: node is found once, PATH is set once, and everything else is vyred's job.
//
// build: local/capsule/build.sh

import Foundation

func log(_ s: String) { FileHandle.standardError.write(("vyre-launcher: " + s + "\n").data(using: .utf8)!) }

var argv = Array(CommandLine.arguments.dropFirst())
var repo = ProcessInfo.processInfo.environment["VYRE_REPO"] ?? ""
if let i = argv.firstIndex(of: "--repo"), i + 1 < argv.count { repo = argv[i + 1]; argv.removeSubrange(i...(i + 1)) }
if repo.isEmpty {
    // Built into <repo>/local/capsule/bin/, so the repo is three folders up.
    repo = ((CommandLine.arguments[0] as NSString).resolvingSymlinksInPath as NSString)
        .deletingLastPathComponent.appending("/../../..")
}
repo = (repo as NSString).standardizingPath

/// node, found without assuming a login shell: launchd starts from a bare environment, where
/// nvm's node is not on PATH and `/usr/bin/env node` exits 127 with nothing said.
func findNode() -> String? {
    let fm = FileManager.default
    var candidates: [String] = []
    if let n = ProcessInfo.processInfo.environment["VYRE_NODE"] { candidates.append(n) }
    let nvm = NSHomeDirectory() + "/.nvm/versions/node"
    if let versions = try? fm.contentsOfDirectory(atPath: nvm) {
        for v in versions.sorted(by: { $0.compare($1, options: .numeric) == .orderedDescending }) { candidates.append(nvm + "/" + v + "/bin/node") }
    }
    candidates.append(contentsOf: ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"])
    return candidates.first { fm.isExecutableFile(atPath: $0) }
}

guard let node = findNode() else { log("no node found in VYRE_NODE, ~/.nvm, /opt/homebrew/bin or /usr/local/bin"); exit(127) }
let main = repo + "/core/daemon/main.js"
guard FileManager.default.fileExists(atPath: main) else { log("no vyred at \(main); pass --repo <path to vyre>"); exit(127) }

let p = Process()
p.executableURL = URL(fileURLWithPath: node)
p.arguments = [main] + argv
var env = ProcessInfo.processInfo.environment
// PATH is replaced, not added to, so this and not the plist decides what vyred can run.
// Homebrew's folders are included because launchd's default PATH has neither.
let brew = ["/opt/homebrew/bin", "/usr/local/bin"].filter { FileManager.default.fileExists(atPath: $0) }
env["PATH"] = ([(node as NSString).deletingLastPathComponent] + brew + ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]).joined(separator: ":")
// launchd hands over no TZ, so every log line would be stamped in UTC and a healthy daemon's
// last line would look hours old.
if env["TZ"] == nil { env["TZ"] = TimeZone.current.identifier }
p.environment = env

for sig in [SIGTERM, SIGINT] {
    signal(sig, SIG_IGN)
    let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    src.setEventHandler { if p.isRunning { p.terminate() } }
    src.resume()
    _ = src
}

do { try p.run() } catch { log("could not start \(node) \(main): \(error)"); exit(126) }
log("vyred started (pid \(p.processIdentifier)) via \(node)")
p.waitUntilExit()
exit(p.terminationStatus)
