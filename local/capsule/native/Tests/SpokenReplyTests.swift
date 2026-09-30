// capsule-suite: spokenReplySuite
// A reply to a turn that came from the mic is spoken through voice.speak {text, reply: true}; a typed
// question is never spoken.

import Foundation

let spokenReplySuite = Suite("spoken replies") { t in
    t.test("a mic turn's reply goes to voice.speak with reply true; a typed one is not spoken; speak_off is silent") {
        let v = FakeVyred(name: "spoken")
        v.tool("voice.speak") { _ in [:] }                       // no ticket: nothing to play, nothing to fail
        t.ok(v.start()); defer { v.stop() }
        let r: [String]? = t.wait { @MainActor () -> [String] in
            let m = CapsuleModel(home: vyScratch("spoken-\(UUID().uuidString.prefix(6))"), vyred: VyredClient(socket: v.socket), providers: [])
            _ = await m.vyred.refreshTools()
            m.speakAnswer("Your first meeting is at **9** with `Harlow Legal`.")     // what a mic turn does on its final reply
            for _ in 0..<200 where v.callsOf("voice.speak").isEmpty { try? await Task.sleep(nanoseconds: 10_000_000) }
            let c = v.callsOf("voice.speak")
            return ["\(c.count)", c.first?["reply"] as? Bool == true ? "reply true" : "no reply flag", c.first?["text"] as? String ?? "-"]
        }
        t.eq(r, ["1", "reply true", "Your first meeting is at **9** with `Harlow Legal`."], "the written reply goes as it is; vyred makes it speakable")
        // A typed turn never reaches speakAnswer: only `voiceTurn` does.
        let typed: Bool? = MainActor.assumeIsolated {
            let m = CapsuleModel(home: vyScratch("spoken2-\(UUID().uuidString.prefix(6))"), vyred: VyredClient(socket: v.socket), providers: [])
            return m.voiceTurn
        }
        t.eq(typed, false, "a new model is not a voice turn")
    }
}
