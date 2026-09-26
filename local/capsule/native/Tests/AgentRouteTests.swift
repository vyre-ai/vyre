// capsule-suite: agentRouteSuite
// Where Enter sends, in the running model: the destination rows come from Route.destinations and
// say where they go before anything is sent; a question about the user's own work goes to the
// assistant; an unreachable destination says why on its row; under an answer the first row
// follows up in the same thread; Deeper and Copy work on the answer.

import AppKit
import Foundation

@MainActor private func routeModel(_ v: FakeVyred) -> CapsuleModel {
    CapsuleModel(home: vyScratch("route-\(UUID().uuidString.prefix(6))"), vyred: VyredClient(socket: v.socket), providers: [])
}

private func until(_ cond: @escaping @MainActor () -> Bool) async -> Bool {
    for _ in 0..<250 { if await MainActor.run(body: cond) { return true }; try? await Task.sleep(nanoseconds: 20_000_000) }
    return false
}

private func harlow(_ v: FakeVyred, assistant: Bool = true) {
    v.tool("projects.list") { _ in ["projects": [["slug": "harlow", "name": "Harlow Legal", "people": [["name": "Dana Reyes"]]]]] }
    v.tool("projects.catalog") { _ in ["sessions": [Any]()] }
    v.tool("projects.threads") { _ in [Any]() }
    if assistant { v.tool("agents.list") { _ in [["name": "juno", "kind": "assistant", "thread": "tj"]] } }
}

@MainActor private func rows(_ m: CapsuleModel) -> [String] { m.flat.filter { $0.kind == "ask" }.map { "\($0.title) | \($0.sendsTo ?? "")" } }

let agentRouteSuite = Suite("agent route") { t in
    t.test("no assistant: a question goes to Claude first, deeper second, and the rows lead the list") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        harlow(v, assistant: false)
        v.tool("threads.start") { _ in ["id": "q1"] }
        let got: ([String], String?)? = t.wait {
            let m = await MainActor.run { () -> CapsuleModel in let m = routeModel(v); m.willShow(front: nil); return m }
            _ = await until { m.vyred.isUp && !m.catalog.projects.isEmpty }
            await MainActor.run { m.text = "what is the capital of France?" }
            _ = await until { !m.flat.isEmpty }
            let r = await MainActor.run { (rows(m), m.current?.title) }
            await MainActor.run { m.didHide() }
            return r
        }
        t.eq(got?.0, ["Ask Claude | Claude (haiku)", "Ask Claude, deeper | Claude, deeper (sonnet)"])
        t.eq(got?.1, "Ask Claude", "Enter sends to the first row")
    }

    t.test("with an assistant: the user's own work goes to it first, and says why; a command goes to it alone") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        harlow(v)
        v.tool("threads.start") { _ in ["id": "q1"] }
        v.tool("agents.ask") { _ in ["ok": true, "thread": "tj"] }
        let got: ([String], String?, [String], [String: Any]?)? = t.wait {
            let m = await MainActor.run { () -> CapsuleModel in let m = routeModel(v); m.willShow(front: nil); return m }
            _ = await until { m.vyred.isUp && m.catalog.assistant != nil }
            await MainActor.run { m.text = "what did Dana want?" }
            _ = await until { !m.flat.isEmpty }
            let own = await MainActor.run { rows(m) }
            let why = await MainActor.run { m.flat.first { $0.kind == "ask" }?.subtitle }
            await MainActor.run { m.text = "send the intake summary to Dana" }
            _ = await until { m.flat.first?.title == "Ask juno" }
            let cmd = await MainActor.run { rows(m) }
            await MainActor.run { m.selected = 0; m.run() }
            _ = await until { !v.callsOf("agents.ask").isEmpty }
            await MainActor.run { m.didHide() }
            return (own, why, cmd, v.callsOf("agents.ask").first)
        }
        t.eq(got?.0, ["Ask juno | juno", "Ask Claude | Claude (haiku)", "Ask Claude, deeper | Claude, deeper (sonnet)"])
        t.eq(got?.1, "Dana is in Harlow Legal, so juno answers with your memory.")
        t.eq(got?.2, ["Ask juno | juno"])
        t.eq(VJ.s(got?.3?["agent"]), "juno")
        t.eq(VJ.s(got?.3?["text"]), "send the intake summary to Dana")
    }

    t.test("@agent sends to the thread its words match") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        harlow(v)
        v.tool("agents.threads") { _ in [["id": "t-site", "name": "Harlow site rebuild", "project": "harlow", "last": 1000], ["id": "tj", "name": "Inbox"]] }
        v.tool("threads.send") { _ in ["sent": true, "thread": "t-site"] }
        v.listed = ["agents.ask"]
        let got: ([String], [String: Any]?)? = t.wait {
            let m = await MainActor.run { () -> CapsuleModel in let m = routeModel(v); m.willShow(front: nil); return m }
            _ = await until { m.vyred.isUp && m.catalog.assistant != nil }
            await MainActor.run { m.target = VyreCandidate(kind: .agent, id: "juno", label: "juno"); m.text = "move the site intake form" }
            _ = await until { rows(m).count == 2 }
            let r = await MainActor.run { rows(m) }
            await MainActor.run { m.selected = 0; m.run() }
            _ = await until { !v.callsOf("threads.send").isEmpty }
            await MainActor.run { m.didHide() }
            return (r, v.callsOf("threads.send").first)
        }
        t.eq(got?.0, ["Send to juno › Harlow Legal › Harlow site rebuild | juno › Harlow Legal › Harlow site rebuild", "Ask juno | juno › current thread"])
        t.eq(VJ.s(got?.1?["thread"]), "t-site")
    }

    t.test("a destination this vyred cannot reach says why on its row, before Enter") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        harlow(v)                                        // an assistant, and no agents.ask
        let got: String?? = t.wait {
            let m = await MainActor.run { () -> CapsuleModel in let m = routeModel(v); m.willShow(front: nil); return m }
            _ = await until { m.vyred.isUp && m.catalog.assistant != nil }
            await MainActor.run { m.text = "send the invoice" }
            _ = await until { !m.flat.isEmpty }
            let sub = await MainActor.run { m.flat.first { $0.kind == "ask" }?.subtitle }
            await MainActor.run { m.didHide() }
            return sub
        }
        t.eq(got ?? nil, "The assistant and agents come with the switchboard, which this vyred is not running yet.")
    }

    t.test("under an answer: Follow up types into the same thread; Deeper asks sonnet; Copy copies the answer") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        harlow(v, assistant: false)
        var n = 0
        v.tool("threads.start") { _ in n += 1; return ["id": "q\(n)"] }
        v.tool("threads.send") { _ in ["sent": true, "thread": "q1"] }
        let got: (first: String?, send: [String: Any]?, model: String?, deep: [String: Any]?, copied: String?)? = t.wait {
            let m = await MainActor.run { () -> CapsuleModel in let m = routeModel(v); m.willShow(front: nil); return m }
            _ = await until { m.vyred.isUp && m.vyred.follower.isStreaming }
            await MainActor.run { m.text = "what is 2+2?"; m.selected = 0; m.run() }
            _ = await until { m.reply?.thread == "q1" }
            _ = v.emit("thread.text", thread: "q1", ["message": "m1", "text": "4", "done": true])
            _ = v.emit("thread.finished", thread: "q1", ["ok": true])
            _ = await until { m.reply?.finished == true }
            // A private pasteboard: a test never touches the user's clipboard.
            let copied = await MainActor.run { () -> String? in
                CapsuleModel.replyBoard = NSPasteboard.withUniqueName()
                defer { CapsuleModel.replyBoard.releaseGlobally(); CapsuleModel.replyBoard = .general }
                return m.copyReply() ? CapsuleModel.replyBoard.string(forType: .string) : nil
            }
            await MainActor.run { m.text = "and 3+3?" }
            _ = await until { !m.flat.isEmpty }
            let first = await MainActor.run { m.flat.first?.title }
            await MainActor.run { m.selected = 0; m.run() }
            _ = await until { !v.callsOf("threads.send").isEmpty }
            let model = await MainActor.run { m.reply?.model }
            _ = v.emit("thread.text", thread: "q1", ["message": "m2", "text": "6", "done": true])
            _ = v.emit("thread.finished", thread: "q1", ["ok": true])
            _ = await until { m.reply?.finished == true && m.canGoDeeper }
            await MainActor.run { m.deeper() }
            _ = await until { v.callsOf("threads.start").count == 2 }
            await MainActor.run { m.didHide() }
            return (first, v.callsOf("threads.send").first, model, v.callsOf("threads.start").last, copied)
        }
        t.eq(got?.first, "Follow up")
        t.eq(VJ.s(got?.send?["thread"]), "q1")
        t.eq(VJ.s(got?.send?["text"]), "and 3+3?")
        t.eq(got?.model, "haiku", "a follow-up of a quick answer is still that model")
        t.eq(VJ.s(got?.deep?["model"]), "sonnet")
        t.eq(VJ.s(got?.deep?["prompt"]), "and 3+3?")
        t.eq(got?.copied, "4")
    }
}
