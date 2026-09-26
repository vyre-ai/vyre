// Asks the person at this Mac to prove they are here: Touch ID, Apple Watch or the login password.
// Usage: vyre-touchid <reason> [timeout seconds]   or   vyre-touchid --check
// Prints one word and exits 0 (ok), 1 (denied, cancelled or timed out) or 2 (unavailable).
import Foundation
import LocalAuthentication

func finish(_ word: String, _ code: Int32) -> Never {
    print(word)
    fflush(stdout)
    exit(code)
}

final class Reply: @unchecked Sendable {
    var ok = false
}

let args = CommandLine.arguments
let context = LAContext()
var error: NSError?
if !context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) {
    finish("unavailable", 2)
}
if args.count > 1 && args[1] == "--check" {
    finish("ok", 0)
}

let reason = args.count > 1 && !args[1].isEmpty ? args[1] : "Vyre needs to confirm it is you."
var timeout = 60.0
if args.count > 2, let t = Double(args[2]), t > 0 {
    timeout = t
}

let reply = Reply()
let done = DispatchSemaphore(value: 0)
context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, _ in
    reply.ok = success
    done.signal()
}
if done.wait(timeout: .now() + timeout) == .timedOut {
    context.invalidate()
    finish("denied", 1)
}
finish(reply.ok ? "ok" : "denied", reply.ok ? 0 : 1)
