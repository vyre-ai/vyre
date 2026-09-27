import XCTest
@testable import Vyre

/// A signer that records each batch it signs (one batch is one Face ID) and holds a session.
final class BatchSigner: PresenceSigner, @unchecked Sendable {
    private let lock = NSLock()
    private var batches: [[String]] = []
    private var session: String?
    private var openedWith: JSON?

    init(session: String? = nil) { self.session = session }

    var signed: [[String]] { lock.withLock { batches } }
    var opened: JSON? { lock.withLock { openedWith } }

    func deviceHeader(tool: String, input: JSON, reason: String) async throws -> String {
        try await deviceHeaders([SignedCall(tool: tool, input: input)], reason: reason)[0]
    }
    func deviceHeaders(_ calls: [SignedCall], reason: String) async throws -> [String] {
        lock.withLock { batches.append(calls.map(\.tool)) }
        return calls.map { "device key=k ts=1 nonce=\($0.tool) sig=s" }
    }
    func sessionHeader() async -> String? { lock.withLock { session } }
    func opened(_ s: JSON) async {
        lock.withLock {
            openedWith = s
            session = "session id=\(s["session"].text) secret=\(s["secret"].text)"
        }
    }
}

final class PresenceFlowTests: XCTestCase {
    private let required = Stub.json(#"{"error":{"code":"presence_required","message":"gate.approve needs you","methods":["device"]}}"#, status: 403)
    private let sessionOpened = Stub.json(#"{"data":{"session":"s1","secret":"shh","expires":1790001800000,"idle":300000}}"#)
    private let approve = SignedCall(tool: "gate.approve", input: ["id": "g1"])

    private func client(_ signer: BatchSigner) -> VyreClient {
        VyreClient(address: BoxAddress("https://alex.vyre.run")!, signer: signer, session: Stub.session())
    }
    private func header(_ i: Int) -> String? { Stub.requests[i].value(forHTTPHeaderField: "x-vyre-presence") }
    private func path(_ i: Int) -> String { Stub.requests[i].url?.path ?? "" }

    func testNoHintAndNoRefusalMeansNoFaceID() async throws {
        Stub.reset([Stub.json(#"{"data":{"state":"sent"}}"#)])
        let signer = BatchSigner()
        let out = try await client(signer).present([approve], reason: "Send email to Dana")
        XCTAssertEqual(out.first?["state"].string, "sent")
        XCTAssertTrue(signer.signed.isEmpty)
        XCTAssertNil(header(0))
    }

    func testARefusalSignsOnceRetriesOnceAndOpensASession() async throws {
        Stub.reset([required, Stub.json(#"{"data":{"state":"sent"}}"#), sessionOpened])
        let signer = BatchSigner()
        _ = try await client(signer).present([approve], reason: "Send email to Dana")
        XCTAssertEqual(signer.signed, [["gate.approve", "presence.session.open"]], "one Face ID signs the retry and the session")
        XCTAssertEqual(Stub.requests.count, 3)
        XCTAssertNil(header(0))
        XCTAssertEqual(header(1), "device key=k ts=1 nonce=gate.approve sig=s")
        XCTAssertEqual(path(2), "/v1/tools/presence.session.open")
        XCTAssertEqual(header(2), "device key=k ts=1 nonce=presence.session.open sig=s")
        XCTAssertEqual(Stub.bodies[0], Stub.bodies[1], "the retry is byte-identical")
        XCTAssertEqual(signer.opened?["session"].string, "s1")
    }

    func testALiveSessionSkipsFaceID() async throws {
        Stub.reset([Stub.json(#"{"data":{"answered":true}}"#)])
        let signer = BatchSigner(session: "session id=s1 secret=shh")
        _ = try await client(signer).present([SignedCall(tool: "threads.answer", input: ["ask": "k1", "decision": "allow"])],
                                            reason: "Approve", required: true)
        XCTAssertTrue(signer.signed.isEmpty)
        XCTAssertEqual(header(0), "session id=s1 secret=shh")
    }

    func testRequiredAndUncoveredSignsFirst() async throws {
        Stub.reset([Stub.json(#"{"data":{"state":"sent"}}"#), sessionOpened])
        let signer = BatchSigner()
        _ = try await client(signer).present([approve], reason: "Send", required: true)
        XCTAssertEqual(signer.signed.count, 1)
        XCTAssertEqual(Stub.requests.count, 2, "no plain attempt first")
        XCTAssertEqual(header(0), "device key=k ts=1 nonce=gate.approve sig=s")
    }

    func testAnEditedSendIsReviseThenApproveUnderOneFaceID() async throws {
        let g: JSON = ["id": "g1", "kind": "send", "via": "mail", "to": ["dana@harlowlegal.com"], "at": 1,
                       "draft": ["subject": "Intake form", "body": "Hi Dana"]]
        var d = HeldDraft(get: g)
        d.fields[2].value = "Hi Dana, the form is attached."
        XCTAssertEqual(d.sendLabel, "Send edited")
        let calls = try d.sendCalls()
        XCTAssertEqual(calls.map(\.tool), ["gate.revise", "gate.approve"])
        XCTAssertEqual(calls[0].input.canonical, #"{"edited":{"body":"Hi Dana, the form is attached."},"id":"g1"}"#)
        XCTAssertEqual(calls[1].input.canonical, #"{"id":"g1"}"#)
        XCTAssertEqual(try HeldDraft(get: g).sendCalls().map(\.tool), ["gate.approve"], "unedited: approve only")
        XCTAssertEqual(HeldDraft(get: g).sendLabel, "Send")

        Stub.reset([required, Stub.json(#"{"data":{"state":"held"}}"#), Stub.json(#"{"data":{"state":"sent"}}"#), sessionOpened])
        let signer = BatchSigner()
        let out = try await client(signer).present(calls, reason: d.reason)
        XCTAssertEqual(signer.signed, [["gate.revise", "gate.approve", "presence.session.open"]])
        XCTAssertEqual(out.map { $0["state"].string }, ["held", "sent"])
        XCTAssertEqual((0..<Stub.requests.count).map(path),
                       ["/v1/tools/gate.revise", "/v1/tools/gate.revise", "/v1/tools/gate.approve", "/v1/tools/presence.session.open"])
    }
}

final class DetailTests: XCTestCase {
    func testDecisionInputs() {
        XCTAssertEqual(AskDecision.allow.input(ask: "k1").canonical, #"{"ask":"k1","decision":"allow","surface":"ios"}"#)
        XCTAssertEqual(AskDecision.deny.input(ask: "k1").canonical, #"{"ask":"k1","decision":"deny","surface":"ios"}"#)
        XCTAssertEqual(AskDecision.alwaysInProject.input(ask: "k1").canonical, #"{"ask":"k1","decision":"always","scope":"project","surface":"ios"}"#)
        XCTAssertEqual(AskDecision.answers(["Which file?": "q3.pdf"]).input(ask: "q1").canonical,
                       #"{"answers":{"Which file?":"q3.pdf"},"ask":"q1","decision":"allow","surface":"ios"}"#)
        XCTAssertFalse(AskDecision.deny.allows)
        XCTAssertTrue(AskDecision.alwaysInProject.allows)
    }

    func testQuestionPicks() {
        let single = AskQuestion(question: "Which bakery list?", options: [.init(label: "Northwind", note: nil), .init(label: "Harlow", note: nil)])
        let multi = AskQuestion(question: "Which reports?", multi: true, options: [.init(label: "Q1", note: nil), .init(label: "Q2", note: nil), .init(label: "Q3", note: nil)])
        var a = QuestionPick()
        XCTAssertEqual(a.answer(single), "")
        a.choose("Harlow", multi: false)
        XCTAssertEqual(a.answer(single), "Harlow")
        a.type("the new one", multi: false)
        XCTAssertEqual(a.answer(single), "the new one", "typing picks Something else")
        XCTAssertTrue(a.chosen.isEmpty)
        a.choose("Northwind", multi: false)
        XCTAssertEqual(a.answer(single), "Northwind")

        var b = QuestionPick()
        b.choose("Q3", multi: true)
        b.choose("Q1", multi: true)
        b.choose("Q2", multi: true)
        b.choose("Q2", multi: true)
        b.type("the draft", multi: true)
        XCTAssertEqual(b.answer(multi), "Q1, Q3, the draft", "the question's order, typed text last")

        XCTAssertNil(QuestionPick.answers([single, multi], [a, QuestionPick()]))
        XCTAssertEqual(QuestionPick.answers([single, multi], [a, b]), ["Which bakery list?": "Northwind", "Which reports?": "Q1, Q3, the draft"])
    }

    func testPresenceHintRules() {
        XCTAssertNil(PresenceHint(.null), "absent: no glyph")
        XCTAssertEqual(PresenceHint(["required": true, "covered": false])?.faceID, true)
        XCTAssertEqual(PresenceHint(["required": true, "covered": true])?.faceID, false)
        XCTAssertEqual(PresenceHint(["required": false])?.faceID, false)
        let plain = AskItem(["id": "k1", "thread": "t1", "tool": "Bash", "summary": "git push origin q3-report", "at": 1])
        XCTAssertFalse(NeedItem.ask(plain).faceID, "never guessed from the tool name")
        let needs = AskItem(["id": "k2", "thread": "t1", "tool": "Read", "summary": "Read notes.md", "at": 1,
                             "presence": ["required": true, "covered": false]])
        XCTAssertTrue(NeedItem.ask(needs).faceID)
    }

    func testQuestionAsksDecodeTolerantly() {
        let q = AskItem(["id": "q1", "thread": "t1", "tool": "AskUserQuestion", "summary": "Which list?", "at": 5, "kind": "question",
                         "agent": "juno", "thread_name": "northwind-orders",
                         "questions": [["question": "Which list?", "header": "List", "multiSelect": false,
                                        "options": [["label": "Northwind Bakery", "description": "the Friday order"], ["label": "Harlow Legal"]]]],
                         "anchor": ["tool_use_id": nil, "event": 42], "always": false, "always_project": nil])
        let item = NeedItem.of(q)
        XCTAssertTrue(item.isQuestion)
        XCTAssertEqual(item.id, "q-q1")
        XCTAssertEqual(item.title, "juno has a question")
        XCTAssertEqual(item.line2, "Which list?")
        XCTAssertEqual(item.approveVerb, "Answer")
        XCTAssertEqual(item.denyVerb, "Later")
        XCTAssertTrue(item.swipeOpensSheet)
        XCTAssertEqual(q.questions.first?.options.map(\.label), ["Northwind Bakery", "Harlow Legal"])
        XCTAssertEqual(q.questions.first?.options.first?.note, "the Friday order")
        XCTAssertEqual(q.anchor, Anchor(toolUseId: nil, event: 42, thread: "t1", at: 5))
        XCTAssertNil(q.alwaysProject)

        let old = AskItem(["id": "k1", "thread": "t2", "tool": "Bash", "summary": "npm test", "at": 9])
        XCTAssertEqual(old.kind, "permission")
        XCTAssertEqual(old.anchor, Anchor(thread: "t2", at: 9))
        XCTAssertFalse(NeedItem.of(old).swipeOpensSheet, "an ask approves on the swipe")
        let always = AskItem(["id": "k3", "thread": "t2", "tool": "Bash", "summary": "npm test", "at": 9, "always_project": "Harlow Legal"])
        XCTAssertEqual(always.alwaysProject, "Harlow Legal")
        XCTAssertTrue(NeedItem.held(HeldDraft(get: ["id": "g1", "kind": "send", "via": "mail", "to": ["dana@harlowlegal.com"], "at": 1])).swipeOpensSheet,
                      "a draft shows its final words before it sends")
    }

    func testAnchorResolution() {
        var t = Transcript()
        func ev(_ id: Int, _ at: Double, _ type: String, _ p: JSON) -> VyreEvent { VyreEvent(id: id, at: at, type: type, thread: "t1", payload: p) }
        t.apply(ev(10, 1000, "thread.sent", ["text": "Render the Q3 report", "surface": "deck"]))
        t.apply(ev(11, 2000, "thread.tool", ["id": "toolu_1", "tool": "Bash", "phase": "started", "summary": "npm run render"]))
        t.apply(ev(12, 2500, "thread.tool", ["id": "toolu_2", "tool": "Bash", "phase": "started", "summary": "git push origin q3-report"]))
        t.apply(ev(13, 3000, "ask.raised", ["ask": "k1", "tool": "Bash"]))
        t.apply(ev(14, 4000, "gate.held", ["id": "g1"]))
        let tools = t.entries[1].id
        XCTAssertEqual(t.resolve(Anchor(toolUseId: "toolu_2", event: 13)), Transcript.Target(entry: tools, line: "toolu_2"), "tool_use_id first")
        XCTAssertEqual(t.resolve(Anchor(event: 13, thread: "t1", at: 1)), Transcript.Target(entry: "a-k1"), "then the event")
        XCTAssertEqual(t.resolve(Anchor(event: 99, thread: "t1", at: 3500)), Transcript.Target(entry: "g-g1"), "then the first item at or after at")
        XCTAssertEqual(t.resolve(Anchor(toolUseId: "toolu_gone", thread: "t1", at: 2400))?.entry, tools)
        XCTAssertNil(t.resolve(Anchor(event: 99, thread: "t1", at: 9000)))
    }

    func testChangeSetSummary() {
        XCTAssertNil(ChangeSet(changes: .null, totals: .null), "neither: the row is left out")
        let summed = ChangeSet(changes: [["file": "reports/q3.tsx", "added": 400, "removed": 30], ["file": "reports/q3.css", "added": 12, "removed": 8]], totals: .null)
        XCTAssertEqual(summed?.summary, "2 files +412 -38")
        let totals = ChangeSet(changes: .null, totals: ["files": 6, "added": 412, "removed": 38])
        XCTAssertEqual(totals?.summary, "6 files +412 -38")
        XCTAssertEqual(ChangeSet(changes: [["file": "a.md", "added": 1, "removed": 0]], totals: .null)?.summary, "1 file +1 -0")
        let a = AskItem(["id": "k1", "thread": "t", "tool": "Bash", "summary": "git push origin q3-report", "destination": "harlow-legal/reports", "at": 1,
                         "detail": ["remote": "origin", "branch": "q3-report", "held_by": "Your rule: pushes ask first"]])
        XCTAssertEqual(askFacts(a).map { $0.0 }, ["Remote", "Branch", "Where", "Held by"])
    }
}
