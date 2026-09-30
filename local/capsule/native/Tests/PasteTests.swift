// capsule-suite: pasteSuite
// Return pastes text rows into the app in front: the first-time Accessibility ask, the setting,
// and what each outcome says. The key press and the Accessibility check are fakes.

import AppKit
import Foundation

private final class Count: @unchecked Sendable {
    private let lock = NSLock(); private var n = 0
    var value: Int { lock.withLock { n } }
    func bump() { lock.withLock { n += 1 } }
}

private func withPaster<T>(trusted: Bool, front: Bool = true, _ body: (_ posts: Count, _ prompts: Count, _ board: NSPasteboard) async -> T) async -> T {
    let posts = Count(), prompts = Count()
    let board = NSPasteboard(name: .init("vyre-test-paste-\(UUID().uuidString.prefix(6))"))
    let dir = vyScratch("paste-\(UUID().uuidString.prefix(6))")
    await MainActor.run {
        CapsuleModel.replyBoard = board
        Paster.prefsPath = dir + "/capsule/prefs.json"
        Paster.trusted = { trusted }
        Paster.promptAccessibility = { prompts.bump() }
        Paster.post = { posts.bump() }
        Paster.settle = 1_000_000
    }
    let r = await body(posts, prompts, board)
    board.releaseGlobally()
    return r
}

private let ROW = ResultItem(id: "x", kind: "x", title: "x")
private func ctx(_ front: Bool) -> ActionContext { ActionContext(query: Query("x"), frontIsBack: front) }

let pasteSuite = Suite("paste") { t in
    t.test("Return pastes when Accessibility is on and the front app is back: text on the board, one Command-V") {
        let r: [String]? = t.wait { () -> [String] in
            await withPaster(trusted: true) { posts, prompts, board in
                let a = Paster.actions(text: "hello")
                let out = await a[0].run(ROW, ctx(true))
                return ["\(a.map(\.id))", "\(out)", "\(posts.value)", "\(prompts.value)", board.string(forType: .string) ?? "-",
                        "\(board.data(forType: ClipRead.ownType) != nil)"]
            }
        }
        t.eq(r, ["[\"paste\", \"copy\"]", "close(nil)", "1", "0", "hello", "true"])
    }

    t.test("the first paste without Accessibility asks once and copies; later ones only copy") {
        let r: [String]? = t.wait { () -> [String] in
            await withPaster(trusted: false) { posts, prompts, board in
                let a = Paster.actions(text: "hello")
                let o1 = await a[0].run(ROW, ctx(true))
                let o2 = await a[0].run(ROW, ctx(true))
                return ["\(o1 == .close(Paster.needAccess))", "\(o2 == .close(Paster.needAccess))", "\(prompts.value)", "\(posts.value)", board.string(forType: .string) ?? "-"]
            }
        }
        t.eq(r, ["true", "true", "1", "0", "hello"])
    }

    t.test("when the front app did not come back, it copies and says so; nothing is sent") {
        let r: [String]? = t.wait { () -> [String] in
            await withPaster(trusted: true) { posts, _, board in
                let a = Paster.actions(text: "hello")
                let o = await a[0].run(ROW, ctx(false))
                return ["\(o == .close(Paster.copiedNote))", "\(posts.value)", board.string(forType: .string) ?? "-"]
            }
        }
        t.eq(r, ["true", "0", "hello"])
    }

    t.test("the setting: Copy comes first, Paste stays one step away; the row that flips it says what it does now") {
        let r: [String]? = t.wait { () -> [String] in
            await withPaster(trusted: true) { posts, _, _ in
                var log: [String] = []
                log.append(Paster.settingRow(Query("paste"))?.title ?? "-")
                let flip = Paster.settingRow(Query("paste"))!
                _ = await flip.actions[0].run(flip, ctx(false))
                log.append("\(Paster.mode)")
                let a = Paster.actions(text: "hello")
                log.append("\(a.map(\.id))")
                let o = await a[0].run(ROW, ctx(true))
                log.append("\(o == .close(Paster.copiedNote))"); log.append("\(posts.value)")
                log.append(Paster.settingRow(Query("copy setting"))?.title ?? "-")
                let back = Paster.settingRow(Query("paste"))!
                _ = await back.actions[0].run(back, ctx(false))
                log.append("\(Paster.mode)")
                log.append("\(Paster.settingRow(Query("zzz")) == nil)")
                log.append("\(Paster.settingRow(Query("pa")) == nil)")
                return log
            }
        }
        t.eq(r, ["Make Return copy instead of paste", "copy", "[\"copy\", \"paste\"]", "true", "0",
                 "Make Return paste into the app in front", "paste", "true", "true"])
    }

    t.test("emoji and snippets paste; a colour, a time and a sum still copy") {
        let r: [String]? = t.wait { () -> [String] in
            await withPaster(trusted: true) { _, _, _ in
                let p = LocalAnswersProvider(home: vyScratch("paste-local-\(UUID().uuidString.prefix(6))"), fetch: RatesFetch { nil })
                let emoji = p.resultsNow(for: Query(":tada")).first { $0.kind == "emoji" }
                let colour = p.resultsNow(for: Query("#ff6347")).first
                let time = p.resultsNow(for: Query("time in tokyo")).first
                return [emoji?.actions.first?.id ?? "-", colour?.actions.first?.id ?? "-", time?.actions.first?.id ?? "-"]
            }
        }
        t.eq(r, ["paste", "copy", "copy"])
    }
}
