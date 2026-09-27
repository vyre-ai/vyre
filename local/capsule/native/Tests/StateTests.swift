// State, ported from local/capsule/lib/state.test.js, plus the lesson card the gallery asked for.
import Foundation

private func ev(_ id: Int, _ type: String, _ payload: [String: Any], thread: String? = nil, project: String? = nil) -> VyredEvent {
    VyredEvent(id: id, type: type, source: "x", thread: thread, project: project, at: 1000 * id, payload: payload)
}

// capsule-suite: stateSuite
let stateSuite = Suite("state") { t in
    t.test("asks and holds wait together, oldest first, until answered") {
        var w: [Waiting] = []
        w = VyState.applyWaiting(w, ev(2, "gate.held", ["id": "g1", "kind": "send", "via": "mail", "to": ["Dana Reyes <dana@harlowlegal.com>"], "summary": "Re: Q3 report",
                                                         "agent": "juno", "project": "harlow-legal"], project: "harlow-legal"))
        w = VyState.applyWaiting(w, ev(1, "ask.raised", ["ask": "a1", "agent": "pax", "tool": "Bash", "summary": "run npm publish"], thread: "t1"))
        t.eq(w.map(\.id), ["a1", "g1"], "the one kept waiting longest comes first")
        t.eq(w[1].title, "juno drafted a message to Dana Reyes")
        t.eq(w[1].sub, "Re: Q3 report · harlow-legal")
        t.eq(w[0].title, "pax asks to run npm publish")
        let named = VyState.applyWaiting([], ev(9, "ask.raised", ["ask": "a2", "summary": "x"], project: "harlow-legal"), name: { _ in "Harlow Legal" })
        t.eq(named[0].sub, "Harlow Legal", "people read a project's name, not its slug")
        t.eq(VyState.applyWaiting(w, ev(3, "thread.text", ["text": "hi"])), w, "an unrelated event changes nothing")
        w = VyState.applyWaiting(w, ev(4, "ask.answered", ["ask": "a1"]))
        w = VyState.applyWaiting(w, ev(5, "gate.released", ["id": "g1", "edited": true]))
        t.eq(w.count, 0)
    }

    t.test("a repeated event does not add a second row") {
        let e = ev(1, "ask.raised", ["ask": "a1", "summary": "x"])
        t.eq(VyState.applyWaiting(VyState.applyWaiting([], e), e).count, 1)
    }

    t.test("a proposed lesson waits quietly, oldest first, and goes when learned or retired") {
        var w: [Waiting] = []
        w = VyState.applyWaiting(w, ev(3, "lesson.proposed", ["lesson": 7, "rule": "Never use em dashes.", "checked": true, "scope": "all", "source": ["kind": "prompt", "session": "s1"]]))
        w = VyState.applyWaiting(w, ev(1, "ask.raised", ["ask": "a1", "agent": "pax", "summary": "run npm publish"], thread: "t1"))
        w = VyState.applyWaiting(w, ev(2, "lesson.proposed", ["lesson": 8, "rule": "Update CHANGELOG.md whenever you change code.", "scope": ["project": "harlow-legal"]]), name: { _ in "Harlow Legal" })
        t.eq(w.map(\.key), ["ask:a1", "lesson:8", "lesson:7"], "oldest first, lessons among the rest")
        let l = w[2]
        t.eq(l.title, "Vyre proposes: \"Never use em dashes.\"")
        t.eq(l.sub, "from what you said", "a scope of all says nothing, so the row does not say it")
        t.eq(l.rule, "Never use em dashes.")
        t.eq(l.scope, .all)
        t.eq(l.quiet, true)
        t.eq(w[1].sub, "in Harlow Legal", "a project scope reads as its name; no source, nothing said of it")
        t.eq(VyState.fromLesson(["lesson": 9, "rule": "x"]).sub, "", "neither scope nor source: an empty line")
        t.eq(VyState.loud(w), 1, "only the ask counts toward the dot and the badge")
        t.eq(w[0].quiet, false)
        w = VyState.applyWaiting(w, ev(4, "lesson.learned", ["lesson": 7, "rule": "Never use em dashes.", "level": "block", "checked": true]))
        t.eq(w.map(\.id), ["a1", "8"])
        t.eq(VyState.applyWaiting(w, ev(5, "lesson.learned", ["lesson": 99, "rule": "added by hand"])), w, "a lesson that was never waiting changes nothing")
        w = VyState.applyWaiting(w, ev(6, "lesson.retired", ["lesson": 8]))
        t.eq(w.map(\.id), ["a1"])
    }

    t.test("a lesson card shows the rule once and drops lines that say nothing") {
        let everywhere = VyState.fromLesson(["id": 4, "rule": "Never use em dashes.", "scope": "all", "source": ["kind": "prompt"]])
        t.eq(everywhere.lesson, LessonCard(rule: "Never use em dashes.", lines: [LessonLine(label: "From", text: "from what you said")]))
        let scoped = VyState.fromLesson(["id": 5, "rule": "Cite the case number.", "scope": ["project": "harlow"]], name: { $0 == "harlow" ? "Harlow Legal" : $0 })
        t.eq(scoped.lesson?.lines, [LessonLine(label: "Where", text: "in Harlow Legal")])
        let lines = (everywhere.lesson?.lines ?? []).map(\.text).joined(separator: " ")
        t.ok(!lines.contains("Never use em dashes."), "the rule is not repeated in the lines")
        t.ok(!lines.contains("everywhere") && !lines.contains("all"), "no empty scope line")
    }

    t.test("a lesson from learn.lessons reads the same as one from its event") {
        let row = VyState.fromLesson(["id": 4, "rule": "Run the tests before every git commit.", "scope": ["agent": "juno"], "source": ["kind": "edited", "session": "s2", "draft": "g1"],
                                      "status": "proposed", "created": 500])
        t.eq(row.source, .lesson); t.eq(row.id, "4"); t.eq(row.at, 500)
        t.eq(row.title, "Vyre proposes: \"Run the tests before every git commit.\"")
        t.eq(row.sub, "for juno · from a draft you edited")
        t.eq(row.thread, "s2"); t.eq(row.quiet, true)
        let e = VyState.applyWaiting([], ev(1, "lesson.proposed", ["lesson": 4, "rule": "Run the tests before every git commit.", "scope": ["agent": "juno"], "source": ["kind": "edited", "session": "s2"]]))
        t.eq(e[0].title, row.title)
        t.eq(VyState.applyWaiting(e, ev(2, "lesson.proposed", ["lesson": 4, "rule": "Run the tests before every git commit."])).count, 1, "one row per lesson")
    }

    t.test("a hold reads as a sentence, whatever it carries") {
        t.eq(VyState.fromHeld(["id": "g2"]).title, "an agent drafted a message to someone")
        t.eq(VyState.fromHeld(["id": "g3", "agent": "kit", "kind": "spend", "to": ["a@x.example", "b@x.example"]]).title, "kit drafted a payment to a@x.example and 1 more")
    }

    t.test("Agent SDK sessions (ADR 0030): tool rows by call id, turn, state, usage, cancel") {
        let turn = "t1:3"
        var r = Reply(thread: "t1")
        r = VyState.applyReply(r, ev(1, "thread.turn", ["turn": turn, "uuid": "u", "text": "hi"], thread: "t1"))
        t.eq(r.turn, turn)
        r = VyState.applyReply(r, ev(2, "thread.state", ["turn": turn, "state": "running"], thread: "t1"))
        r = VyState.applyReply(r, ev(3, "thread.tool", ["turn": turn, "id": "c1", "call": "c1", "name": "Read", "summary": "Read menu.md", "status": "running"], thread: "t1"))
        r = VyState.applyReply(r, ev(4, "thread.tool", ["turn": turn, "id": "c2", "call": "c2", "name": "Bash", "status": "running"], thread: "t1"))
        r = VyState.applyReply(r, ev(5, "thread.tool", ["turn": turn, "id": "c1", "call": "c1", "status": "completed"], thread: "t1"))
        t.eq(r.tools.map(\.id), ["c1", "c2"], "a status update keeps the row's place")
        t.eq(r.tools.map(\.status), [.completed, .running])
        t.eq(r.tools.map(\.summary), ["Read menu.md", "Bash"])
        // Another turn of the same thread is not this reply's.
        let other = VyState.applyReply(r, ev(6, "thread.tool", ["turn": "t1:4", "id": "c9", "call": "c9", "status": "running"], thread: "t1"))
        t.eq(other.tools.count, 2)
        r = VyState.applyReply(r, ev(7, "thread.state", ["turn": turn, "state": "waiting"], thread: "t1"))
        t.eq(r.state, "waiting"); t.eq(r.finished, false)
        r = VyState.applyReply(r, ev(8, "thread.usage", ["turn": turn, "cost_usd": 0.004, "total_cost_usd": 0.03, "tokens": 900], thread: "t1"))
        t.eq(r.cost, 0.004); t.eq(r.totalCost, 0.03)
        // Esc elsewhere: the turn is canceled, a running tool with it.
        let c = VyState.applyReply(r, ev(9, "thread.finished", ["turn": turn, "canceled": true, "reason": "interrupt"], thread: "t1"))
        t.eq(c.error, "stopped"); t.eq(c.ok, false)
        t.eq(c.tools.map(\.status), [.completed, .canceled])
        // A tool canceled by status, and one that failed.
        var d = VyState.applyReply(r, ev(10, "thread.tool", ["turn": turn, "id": "c2", "call": "c2", "status": "canceled"], thread: "t1"))
        d = VyState.applyReply(d, ev(11, "thread.tool", ["turn": turn, "id": "c3", "call": "c3", "name": "Write", "status": "failed"], thread: "t1"))
        t.eq(d.tools.map(\.status), [.completed, .canceled, .failed])
        // failed carries its error, then idle follows and leaves it.
        var f = VyState.applyReply(r, ev(12, "thread.state", ["turn": turn, "state": "failed", "error": "rate limited"], thread: "t1"))
        f = VyState.applyReply(f, ev(13, "thread.state", ["turn": turn, "state": "idle"], thread: "t1"))
        t.eq(f.error, "rate limited"); t.eq(f.finished, true); t.eq(f.idle, false); t.eq(f.state, "idle")
        // A clean finish then idle: done, and marked idle.
        var g = VyState.applyReply(r, ev(14, "thread.finished", ["turn": turn, "ok": true, "cost_usd": 0.004], thread: "t1"))
        g = VyState.applyReply(g, ev(15, "thread.state", ["turn": turn, "state": "idle"], thread: "t1"))
        t.eq(g.error, nil); t.eq(g.idle, true); t.eq(g.cost, 0.004, "a turn's cost is not added twice")
        // The older shape still works: phase and error, no status.
        var o = Reply(thread: "t1")
        o = VyState.applyReply(o, ev(1, "thread.tool", ["id": "u1", "tool": "Read", "phase": "start"], thread: "t1"))
        o = VyState.applyReply(o, ev(2, "thread.tool", ["id": "u1", "phase": "done", "error": true], thread: "t1"))
        t.eq(o.tools.map(\.status), [.failed])
    }

    t.test("a reply streams in pieces and the whole message wins") {
        var r = VyState.reply("t1")
        r = VyState.applyReply(r, ev(1, "thread.text", ["message": "m1", "delta": "The Q3 "], thread: "t1"))
        r = VyState.applyReply(r, ev(2, "thread.text", ["message": "m1", "delta": "numbers"], thread: "t1"))
        t.eq(VyState.replyText(r), "The Q3 numbers")
        r = VyState.applyReply(r, ev(3, "thread.text", ["message": "m9", "text": "other thread"], thread: "t2"))
        t.eq(VyState.replyText(r), "The Q3 numbers", "another thread's words never land here")
        r = VyState.applyReply(r, ev(4, "thread.tool", ["id": "u1", "tool": "Read", "summary": "Read deck.md", "phase": "started"], thread: "t1"))
        r = VyState.applyReply(r, ev(5, "thread.tool", ["id": "u1", "phase": "done"], thread: "t1"))
        t.eq(r.tools, [ReplyTool(id: "u1", summary: "Read deck.md", done: true, error: false)])
        r = VyState.applyReply(r, ev(6, "thread.text", ["message": "m1", "text": "The Q3 numbers are in.", "done": true], thread: "t1"))
        r = VyState.applyReply(r, ev(7, "thread.finished", ["ok": true], thread: "t1"))
        t.eq(VyState.replyText(r), "The Q3 numbers are in.")
        t.eq(r.finished, true)
        r = VyState.applyReply(r, ev(8, "lease.changed", ["holder": "deck", "previous": "capsule"], thread: "t1"))
        t.eq(r.lease, "deck")
        r = VyState.applyReply(r, ev(9, "lease.changed", ["holder": NSNull(), "previous": "deck"], thread: "t1"))
        t.eq(r.lease, nil)
        var idle = VyState.applyReply(r, ev(10, "thread.stopped", ["reason": "idle"], thread: "t1"))
        t.eq(idle.error, nil); t.eq(idle.ok, true); t.eq(idle.idle, true)
        t.eq(VyState.replyText(idle), "The Q3 numbers are in.")
        idle.idle = false
        r = VyState.applyReply(r, ev(10, "thread.stopped", ["code": 0, "reason": "stopped"], thread: "t1"))
        t.eq(r.finished, true); t.eq(r.ok, false); t.eq(r.error, "the thread stopped: stopped")
        t.eq(Bridge.explain(code: "busy", message: ""), "The box is running as many sessions as it allows. Stop one, or try again when one finishes.")
        t.ok(Bridge.explain(code: "error", message: "no thread abc").contains("runs in a terminal"))
    }

    t.test("a withdrawn question is an ask.answered with decision cancelled") {
        let w = VyState.applyWaiting([], ev(1, "ask.raised", ["ask": "a1", "tool": "Write", "summary": "Write /w/a.txt", "destination": "/w/a.txt", "reason": NSNull(), "holder": NSNull()], thread: "t1"))
        t.eq(w[0].sub, "to /w/a.txt")
        t.eq(VyState.applyWaiting(w, ev(2, "ask.answered", ["ask": "a1", "decision": "cancelled", "by": "thread stopped"], thread: "t1")).count, 0)
    }

    t.test("a finished turn carries its cost and time, and Stop ends the reply for good") {
        var r = VyState.reply("t1")
        t.eq(r.cost, nil); t.eq(r.ms, nil)
        r = VyState.applyReply(r, ev(1, "thread.finished", ["ok": true, "cost_usd": 0.0021, "duration_ms": 900], thread: "t1"))
        r = VyState.applyReply(r, ev(2, "thread.finished", ["ok": true, "cost_usd": 0.001, "duration_ms": 400], thread: "t1"))
        t.near(r.cost, 0.0031, 1e-9); t.eq(r.ms, 400)
        var c = VyState.cancel(VyState.reply("t2"))
        t.eq(c.finished, true); t.eq(c.ok, false); t.eq(c.error, "stopped")
        c = VyState.applyReply(c, ev(3, "thread.text", ["message": "m", "delta": "late"], thread: "t2"))
        c = VyState.applyReply(c, ev(4, "thread.stopped", ["reason": "stopped"], thread: "t2"))
        t.eq(VyState.replyText(c), ""); t.eq(c.error, "stopped", "nothing after Stop changes it")
    }

    t.test("a DM folds a turn into one agent message, text blocks joined and tools as lines") {
        var d = VyState.dm("juno", thread: "t1")
        d = VyState.applyDm(d, ev(1, "thread.sent", ["text": "the Q3 numbers?", "surface": "deck"], thread: "t1"))
        d = VyState.applyDm(d, ev(2, "thread.text", ["message": "m1", "delta": "Look"], thread: "t1"))
        d = VyState.applyDm(d, ev(3, "thread.text", ["message": "m1", "delta": "ing."], thread: "t1"))
        d = VyState.applyDm(d, ev(4, "thread.tool", ["id": "u1", "tool": "Read", "summary": "Read q3.md", "phase": "started"], thread: "t1"))
        d = VyState.applyDm(d, ev(5, "thread.tool", ["id": "u1", "phase": "done"], thread: "t1"))
        d = VyState.applyDm(d, ev(6, "thread.text", ["message": "m1", "text": "Looking.", "done": true], thread: "t1"))
        d = VyState.applyDm(d, ev(7, "thread.text", ["message": "m2", "text": "Up 4%.", "done": true], thread: "t1"))
        t.eq(d.busy, true)
        d = VyState.applyDm(d, ev(8, "thread.finished", ["ok": true], thread: "t1"))
        d = VyState.applyDm(d, ev(9, "thread.text", ["message": "x", "text": "elsewhere", "done": true], thread: "t2"))
        let v = VyState.dmView(d)
        t.eq(v.messages, [
            DmMessage(id: "e1", role: .user, text: "the Q3 numbers?", at: 1000, surface: "deck"),
            DmMessage(id: "m1", role: .agent, text: "Looking.\n\nUp 4%.", at: 2000, tools: [ReplyTool(id: "u1", summary: "Read q3.md", done: true, error: false)], done: true, error: nil),
        ])
        t.eq(v.busy, false)
        t.eq(VyState.applyDm(d, ev(8, "thread.text", ["message": "m3", "text": "again", "done": true], thread: "t1")), d, "an event already folded is not folded twice")
    }

    t.test("a DM's pending words are reconciled by thread.sent, never duplicated, and dropped on failure") {
        var d = VyState.dmPending(VyState.dm("juno"), "p1", "hello  there", 5)
        t.eq(VyState.dmView(d).messages, [DmMessage(id: "p1", role: .user, text: "hello  there", at: 5, pending: true)])
        d = VyState.applyDm(d, ev(1, "thread.started", ["agent": "juno", "resumed": false], thread: "t9"))
        t.eq(d.thread, "t9", "the agent's new thread is followed")
        d = VyState.applyDm(d, ev(2, "thread.sent", ["text": VyState.sentText("hello  there"), "surface": "capsule"], thread: "t9"))
        t.eq(VyState.dmView(d).messages, [DmMessage(id: "e2", role: .user, text: "hello  there", at: 2000)], "one message, with the whole words")
        d = VyState.applyDm(d, ev(3, "thread.text", ["message": "m1", "delta": "hi"], thread: "t9"))
        t.eq(d.messages.map(\.role), [.user, .agent])
        d = VyState.dmPending(d, "p2", "and?", 6)
        d = VyState.applyDm(d, ev(4, "thread.text", ["message": "m1", "delta": " there"], thread: "t9"))
        t.eq(VyState.dmView(d).messages.map { "\($0.role.rawValue)|\($0.text)|\($0.pending)" }, ["user|hello  there|false", "agent|hi there|false", "user|and?|true"])
        t.eq(VyState.dmDrop(d, "p2").messages.count, 2)
        let other = VyState.applyDm(VyState.dmPending(VyState.dm("kit"), "p1", "mine", 1), ev(9, "thread.sent", ["text": "theirs", "surface": "capsule"], thread: "tx"))
        t.eq(other.thread, nil, "someone else's send is not ours")
    }

    t.test("a DM's asks come and go with the thread's ask events, and the lease is followed") {
        var d = VyState.dm("kit", thread: "t1")
        d = VyState.applyDm(d, ev(1, "ask.raised", ["ask": "a1", "agent": "kit", "tool": "Write", "summary": "Write /w/a.txt", "destination": "/w/a.txt"], thread: "t1"))
        d = VyState.applyDm(d, ev(2, "ask.raised", ["ask": "a2", "tool": "Bash", "summary": "ls"], thread: "t2"))
        t.eq(d.asks.map { "\($0.id)|\($0.title)" }, ["a1|kit asks to Write /w/a.txt"])
        d = VyState.applyDm(d, ev(3, "lease.changed", ["holder": "deck", "previous": NSNull()], thread: "t1"))
        t.eq(d.holder, "deck")
        d = VyState.applyDm(d, ev(4, "ask.answered", ["ask": "a1", "decision": "allow"], thread: "t1"))
        t.eq(d.asks.count, 0)
    }

    t.test("a DM from threads.get, trimmed to its limit, with open asks from the table") {
        let events: [[String: Any]] = [
            ["id": 1, "at": 1, "type": "thread.started", "payload": ["agent": "juno"]],
            ["id": 2, "at": 2, "type": "thread.sent", "payload": ["text": "one", "surface": "capsule"]],
            ["id": 3, "at": 3, "type": "thread.text", "payload": ["message": "m1", "text": "echo: one", "done": true]],
            ["id": 4, "at": 4, "type": "thread.finished", "payload": ["ok": true]],
            ["id": 5, "at": 5, "type": "thread.sent", "payload": ["text": "two", "surface": "cli"]],
            ["id": 6, "at": 6, "type": "ask.raised", "payload": ["ask": "old"]],
            ["id": 7, "at": 7, "type": "thread.text", "payload": ["message": "m2", "delta": "ech"]],
        ]
        let got: [String: Any] = ["thread": ["id": "t1", "status": "waiting", "holder": "cli", "project": NSNull()], "events": events,
                                  "asks": [["id": "a1", "thread": "t1", "tool": "Write", "summary": "Write x", "at": 6, "state": "open"]]]
        let askRow: ([String: Any]) -> Waiting = { x in Waiting(source: .ask, id: VJ.s(x["id"]), title: VJ.s(x["summary"]), sub: "", at: VJ.num(x["at"]) ?? 0, quiet: false) }
        let d = VyState.dmHistory(VyState.dm("juno", thread: "t1", limit: 3), got, askRow: askRow)
        t.eq(VyState.dmView(d).messages.map { "\($0.role.rawValue)|\($0.text)|\($0.surface ?? "-")" }, ["agent|echo: one|-", "user|two|cli", "agent|ech|-"])
        t.eq(d.busy, true); t.eq(d.holder, "cli"); t.eq(d.last, 7); t.eq(d.asks.map(\.id), ["a1"])
        var idleGot = got; idleGot["thread"] = ["id": "t1", "status": "idle", "holder": "cli"]
        t.eq(VyState.dmHistory(VyState.dm("juno", thread: "t1"), idleGot, askRow: askRow).messages.last?.done, true, "a thread at rest has no open turn")
        var mine = got
        mine["events"] = events.map { e -> [String: Any] in VJ.int(e["id"]) == 5 ? ["id": 5, "at": 5, "type": "thread.sent", "payload": ["text": "two", "surface": "capsule"]] : e }
        let carried = VyState.dmCarry(VyState.dmHistory(VyState.dm("juno", thread: "t1"), mine, askRow: askRow),
                                      [DmMessage(id: "p1", role: .user, text: "two", at: 9, pending: true)], after: 4)
        t.eq(carried.messages.filter { $0.role == .user }.count, 2, "not duplicated")
    }

    t.test("a lesson scoped to a project or an agent reads in words") {
        let p = VyState.fromLesson(["id": 7, "rule": "Cite the case number.", "scope": ["project": "harlow"], "source": ["kind": "prompt"], "created": 1], name: { $0 == "harlow" ? "Harlow Legal" : $0 })
        t.eq(p.where, "in Harlow Legal")
        let a = VyState.fromLesson(["id": 8, "rule": "Ask before deploying.", "scope": ["agent": "kit"], "source": ["kind": "edit"], "created": 2])
        t.eq(a.where, "for kit")
    }
}
