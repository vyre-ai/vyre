// capsule-suite: saidSuite
// The memory box: which past turns answer the question, the one line about the user, the lines a
// quick question is sent with, and notices and queued sends on a reply (capsule-now rules 1-5, 7).
// Cases are said.test.js's, so the two Capsules rank the same.

import Foundation

private let Q = "which car do I own"
private let HITS: [SaidHit] = [
    SaidHit(session: "c1", role: "user", text: "which car do I own", name: "Capsule: which car do I own", cwd: "/home/alex/.vyre/capsule/ask"),
    SaidHit(session: "e1", role: "user", text: "which car do I own?", name: "Errands", cwd: "/home/alex/Work"),
    SaidHit(session: "d1", role: "assistant", text: "Asking which car do I own should answer blue Volvo XC40 from the insurance note.", name: "Capsule memory test", cwd: "/home/alex/Work/vyre"),
    SaidHit(session: "u1", role: "user", text: "The car park at the office closes at 10.", name: "Office", cwd: "/home/alex/Work"),
    SaidHit(session: "a1", role: "user", text: "I own a blue Volvo XC40, bought in 2022. Renew the insurance before March.", name: "Insurance renewal", cwd: "/home/alex/Work"),
]

private func ev(_ type: String, _ payload: [String: Any], thread: String = "t1") -> VyredEvent {
    VyredEvent(id: 1, type: type, source: "x", thread: thread, project: nil, at: 1000, payload: payload)
}

let saidSuite = Suite("said") { t in
    t.test("the question echoed back, the Capsule's own threads and talk about the question are out; the statement is first") {
        t.eq(Said.rank(HITS, query: Q, scratch: "/home/alex/.vyre/capsule/ask").map(\.session), ["a1", "u1"])
    }
    t.test("a Capsule thread is known by its name even outside the scratch folder") {
        t.eq(Said.rank([SaidHit(session: "x", role: "assistant", text: "I can't see your files.", name: "Capsule: which car do I own")], query: Q).count, 0)
    }
    t.test("questions and Claude's words go below the user's own statements") {
        let got = Said.rank([
            SaidHit(session: "q", role: "user", text: "do I need a new car battery?"),
            SaidHit(session: "c", role: "assistant", text: "Your car insurance renews in March."),
            SaidHit(session: "s", role: "user", text: "My car is the blue Volvo."),
        ], query: Q)
        t.eq(got.map(\.session), ["s", "c"])
    }
    t.test("a clear first-person statement becomes one line about the user; anything else is not an answer") {
        t.eq(Said.yourAnswer(HITS[4], query: Q), "You own a blue Volvo XC40, bought in 2022.")
        t.eq(Said.yourAnswer(SaidHit(session: "s", role: "user", text: "My car is the blue Volvo."), query: Q), "Your car is the blue Volvo.")
        t.eq(Said.yourAnswer(SaidHit(session: "s", role: "user", text: "I'm driving my car to Harlow."), query: Q), "You're driving your car to Harlow.")
        t.eq(Said.yourAnswer(HITS[3], query: Q), nil, "not about the user")
        t.eq(Said.yourAnswer(SaidHit(session: "s", role: "assistant", text: "I own nothing."), query: Q), nil)
        t.eq(Said.yourAnswer(SaidHit(session: "s", role: "user", text: "I wonder which car do I own?"), query: Q), nil)
        t.eq(Said.yourAnswer(SaidHit(session: "s", role: "user", text: "I like tea."), query: Q), nil)
        t.eq(Said.yourAnswer(nil, query: Q), nil)
        t.ok(Said.isQuestion("do I own it") && !Said.isQuestion("I own it."))
    }
    t.test("with no fact the user's own line tops the box, labelled From your sessions, and only the quote is sent") {
        let now = 1_800_000_000_000.0
        let hits: [[String: Any]] = [
            ["session": "a1", "seq": 4, "role": "user", "text": "I own a blue Volvo XC40, bought in 2022.", "name": "Insurance renewal", "ts": now - 14 * 86_400_000],
        ]
        let m = Memo.fold(text: Q, facts: [], hits: hits, scratch: nil, now: now)
        t.eq(m.answer, "You own a blue Volvo XC40, bought in 2022.")
        t.eq(m.answerKind, .said)
        t.eq(m.label, "From your sessions")
        t.eq(Memo.items(m).map(\.kind), [.fact, .quote])
        t.eq(Memo.lines(m), ["The user said, 2 weeks ago: \"I own a blue Volvo XC40, bought in 2022.\""])
        t.ok(Memo.append(m).hasPrefix(Memo.quickAppend + "\n\nWhat the user's own notes say:\n- The user said, 2 weeks ago:"))
        t.eq(Memo.append(nil), Memo.quickAppend, "no memory on screen: the plain append")
    }
    t.test("a fact from memory comes first with its age, and says From memory") {
        let facts: [[String: Any]] = [
            ["text": "Dana's email is dana@harlowlegal.example", "score": 0.9, "confidence": 0.8, "age": "3 weeks", "matched": "Dana",
             "ref": ["session": "f1", "seq": 2, "name": "Harlow intake"]],
            ["text": "Low score fact", "score": 0.2],
        ]
        let m = Memo.fold(text: "what is Dana's email", facts: facts, hits: [], scratch: nil)
        t.eq(m.answer, "Dana's email is dana@harlowlegal.example")
        t.eq(m.answerKind, .memory)
        t.eq(m.answerAge, "3 weeks")
        t.eq(m.label, "From memory")
        t.eq(Memo.lines(m), ["Dana's email is dana@harlowlegal.example (noted 3 weeks ago)"])
    }
    t.test("a notice is status, never the answer; a queued send is marked handed over") {
        var r = VyState.reply("t1")
        r = VyState.applyReply(r, ev("thread.text", ["message": "vyre", "text": "You are at 85% of your limit.", "done": true, "notice": true]))
        t.eq(VyState.replyText(r), "")
        t.eq(r.notice, "You are at 85% of your limit.")
        r.queued = QueuedSend(name: "juno", note: "juno is busy in your terminal.")
        r = VyState.applyReply(r, ev("thread.sent", ["text": "hi", "queued": true, "via": "harness"]))
        t.eq(r.queued?.delivered, true)
        r = VyState.applyReply(r, ev("thread.text", ["message": "m1", "text": "Done.", "done": true]))
        t.eq(VyState.replyText(r), "Done.")
    }
}
