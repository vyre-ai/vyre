// capsule-suite: capsuleModelsSuite
// The Capsule's own two speeds (quick: memory.ask / a lean thread; deeper: think-deeper's
// session) read from sessions.models.get on open (ADR 0036): purposes.capsule and purposes.agent.
// A vyred with no such tool, or one that errors, leaves today's fallback (CapsuleModel.quickModel,
// AutoAsk.deeperModel) so the Capsule still asks something sensible.

import Foundation

@MainActor private func modelsModel(_ v: FakeVyred) -> CapsuleModel {
    CapsuleModel(home: vyScratch("models-\(UUID().uuidString.prefix(6))"), vyred: VyredClient(socket: v.socket), providers: [])
}

private func until(_ cond: @escaping @MainActor () -> Bool) async -> Bool {
    for _ in 0..<250 { if await MainActor.run(body: cond) { return true }; try? await Task.sleep(nanoseconds: 20_000_000) }
    return false
}

let capsuleModelsSuite = Suite("capsule models") { t in
    t.test("today's fallback before any fetch") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        let m = MainActor.assumeIsolated { modelsModel(v) }
        MainActor.assumeIsolated {
            t.eq(m.models.quick, CapsuleModel.quickModel)
            t.eq(m.models.deeper, CapsuleModel.deeperModel)
        }
    }

    t.test("sessions.models.get overrides the quick and deeper models") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        v.tool("sessions.models.get") { _ in ["purposes": ["capsule": ["model": "haiku-mini"], "agent": ["model": "opus-max"]]] }
        let m = MainActor.assumeIsolated { modelsModel(v) }
        let r: (String, String)? = t.wait {
            _ = await m.vyred.refreshTools(); await m.loadModels()
            return await MainActor.run { (m.models.quick, m.models.deeper) }
        }
        t.eq(r?.0, "haiku-mini")
        t.eq(r?.1, "opus-max")
    }

    t.test("a purpose missing from the answer keeps its own fallback") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        v.tool("sessions.models.get") { _ in ["purposes": ["capsule": ["model": "haiku-mini"]]] }
        let m = MainActor.assumeIsolated { modelsModel(v) }
        let r: (String, String)? = t.wait {
            _ = await m.vyred.refreshTools(); await m.loadModels()
            return await MainActor.run { (m.models.quick, m.models.deeper) }
        }
        t.eq(r?.0, "haiku-mini")
        t.eq(r?.1, CapsuleModel.deeperModel, "no purposes.agent in the answer: deeper stays today's fallback")
    }

    t.test("no sessions.models.get on this vyred: today's fallback stays") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        let m = MainActor.assumeIsolated { modelsModel(v) }
        let r: (String, String)? = t.wait {
            _ = await m.vyred.refreshTools(); await m.loadModels()
            return await MainActor.run { (m.models.quick, m.models.deeper) }
        }
        t.eq(r?.0, CapsuleModel.quickModel)
        t.eq(r?.1, CapsuleModel.deeperModel)
    }

    t.test("willShow fetches the models once vyred answers") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        v.tool("threads.start") { _ in ["id": "t1"] }
        v.tool("projects.list") { _ in ["projects": [Any]()] }
        v.tool("sessions.models.get") { _ in ["purposes": ["capsule": ["model": "fast-x"], "agent": ["model": "big-y"]]] }
        let m = MainActor.assumeIsolated { () -> CapsuleModel in let m = modelsModel(v); m.willShow(front: nil); return m }
        let ok = t.wait { await until { m.models.quick == "fast-x" && m.models.deeper == "big-y" } }
        t.ok(ok == true, "models loaded on open")
        MainActor.assumeIsolated { m.didHide() }
    }

    t.test("a quick answer's reply is tagged with the loaded quick model") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        v.tool("sessions.models.get") { _ in ["purposes": ["capsule": ["model": "haiku-mini"]]] }
        v.tool("memory.ask") { _ in ["answer": "Yes.", "confidence": 0.9, "abstained": false, "known": [Any](), "sources": [Any]()] }
        let m = MainActor.assumeIsolated { modelsModel(v) }
        _ = t.wait { _ = await m.vyred.refreshTools(); await m.loadModels() }
        let model: String?? = t.wait {
            _ = await m.askIQ("does this work")
            return await MainActor.run { m.reply?.model }
        }
        t.eq(model.flatMap { $0 }, "haiku-mini")
    }
}
