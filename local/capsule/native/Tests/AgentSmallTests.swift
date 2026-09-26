// capsule-suite: agentSmallSuite
// Enter on a sum copies it and closes; with vyred gone the Capsule says it is offline; the
// menu-bar mark has a Beacon version for when something waits.

import AppKit
import Foundation

private func until(_ cond: @escaping @MainActor () -> Bool) async -> Bool {
    for _ in 0..<250 { if await MainActor.run(body: cond) { return true }; try? await Task.sleep(nanoseconds: 20_000_000) }
    return false
}

let agentSmallSuite = Suite("agent small") { t in
    t.test("Enter on a sum copies the answer and closes the Capsule") {
        let got: (String?, Bool)? = t.wait {
            await MainActor.run { CapsuleModel.replyBoard = NSPasteboard.withUniqueName() }
            let m = await MainActor.run { CapsuleModel(home: vyScratch("calc-\(UUID().uuidString.prefix(6))"), vyred: VyredClient(socket: vyScratch("nosock") + "/none.sock"), providers: []) }
            var closed = false
            await MainActor.run { m.onClose = { _ in closed = true }; m.text = "200 + 10%"; m.selected = 0; m.run() }
            _ = await until { closed }
            let s = await MainActor.run { () -> String? in
                defer { CapsuleModel.replyBoard.releaseGlobally(); CapsuleModel.replyBoard = .general }
                return CapsuleModel.replyBoard.string(forType: .string)
            }
            return (s, closed)
        }
        t.eq(got?.0, "220")
        t.ok(got?.1 == true)
    }

    t.test("vyred not running: offline, once it has been looked for") {
        let got: (Bool, Bool)? = t.wait {
            let m = await MainActor.run { CapsuleModel(home: vyScratch("off-\(UUID().uuidString.prefix(6))"), vyred: VyredClient(socket: vyScratch("nosock") + "/gone.sock"), providers: []) }
            let before = await MainActor.run { m.offline }
            await MainActor.run { m.willShow(front: nil) }
            let after = await until { m.offline }
            await MainActor.run { m.didHide(); m.vyred.follower.stop() }
            return (before, after)
        }
        t.eq(got?.0, false, "not before it has looked")
        t.eq(got?.1, true)
    }

    t.test("the menu-bar mark with the Beacon dot draws") {
        let img = MainActor.assumeIsolated { CapsuleApp.menuBarMarkWaiting() }
        t.ok(img.size.width == 18 && !img.isTemplate)
    }
}
