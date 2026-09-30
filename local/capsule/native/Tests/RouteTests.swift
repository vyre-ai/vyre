// Route, ported from local/capsule/lib/route.test.js, with the same catalog of made-up things.
import Foundation

private let NOW: Double = 1_790_000_000_000
private let DAY: Double = 86_400_000
private let CAT = VyreCatalog(
    agents: [VyreAgent(name: "juno", kind: "assistant"), VyreAgent(name: "kit", kind: "agent", doing: "ads audit"), VyreAgent(name: "pax", kind: "agent")],
    projects: [
        VyreProject(slug: "harlow-legal", name: "Harlow Legal", org: "Rivera Studio", home: "/w/harlow", threads: 4, last: NOW - 2 * 3_600_000, people: [VyrePerson(name: "Dana Reyes")]),
        VyreProject(slug: "northwind-bakery", name: "Northwind Bakery", home: "/w/northwind", threads: 3, last: NOW - DAY),
    ],
    threads: [
        VyreThread(id: "aaaa1111", label: "Q3 report", cwd: "/w/harlow/q3", last: NOW - 4 * DAY, project: "harlow-legal", projectName: "Harlow Legal"),
        VyreThread(id: "bbbb2222", label: "Intake form rebuild", last: NOW - 2 * 3_600_000, project: "harlow-legal", projectName: "Harlow Legal"),
        VyreThread(id: "cccc3333", label: "Northwind invoices", last: NOW - DAY, project: "northwind-bakery", projectName: "Northwind Bakery"),
        VyreThread(id: "dddd4444", label: "Weekly planning", cwd: "/w", last: NOW - 3 * DAY),
    ])

private func kinds(_ d: (options: [VyreDestination], why: String?)) -> [String] {
    d.options.map { "\($0.kind.rawValue):\($0.agent ?? $0.model ?? "-")" }
}

// capsule-suite: routeSuite
let routeSuite = Suite("route") { t in
    t.test("ages read the way the boards write them") {
        t.eq(Route.age(NOW - 30_000, now: NOW), "now")
        t.eq(Route.age(NOW - 18 * 60_000, now: NOW), "18 min")
        t.eq(Route.age(NOW - 4 * DAY, now: NOW), "4 days")
        t.eq(Route.age(NOW - DAY, now: NOW), "1 day")
        t.eq(Route.age(0, now: NOW), "")
        t.eq(Route.age(1000, now: NOW), "", "a test's small number is no time, not 691 months")
    }

    t.test("an @ is being completed only while the caret is inside it") {
        t.eq(Route.mention("@ha"), MentionState(completing: "ha", start: 0, end: 3))
        t.eq(Route.mention("ask @").completing, "")
        t.eq(Route.mention("@kit the deck").completing, nil, "a finished word is not being completed")
        t.eq(Route.mention("mail dana@harlow").completing, nil, "an address is not a mention")
        t.eq(Route.mention("@kit the deck", caret: 3).completing, "ki")
    }

    t.test("@ completes agents, projects and threads, best match first") {
        t.eq(Route.complete("har", CAT, now: NOW).map(\.label), ["Harlow Legal"])
        t.eq(Route.complete("k", CAT, now: NOW).first?.label, "kit")
        t.eq(Route.complete("north", CAT, now: NOW).first?.kind, .project, "a project outranks its thread on the same match")
        t.eq(Route.complete("rebuild", CAT, now: NOW).map(\.id), ["bbbb2222"])
        t.eq(Array(Route.complete("", CAT, now: NOW).map(\.kind).prefix(3)), [.agent, .agent, .agent], "right after @, agents come first")
        t.eq(Route.complete("", CAT, limit: 50, now: NOW).first { $0.kind == .thread }?.label, "Intake form rebuild", "then the most recent")
        t.eq(Route.complete("zzz", CAT, now: NOW).count, 0)
        t.eq(Route.complete("har", CAT, now: NOW).first?.sub, "Rivera Studio · 4 threads · 2 h")
    }

    t.test("a thread is chosen from words, never guessed from none") {
        let hit = Route.bestThread("the Q3 report numbers for Dana", CAT.threads)
        t.eq(hit?.thread.id, "aaaa1111")
        t.eq(hit?.matched, ["report"])
        t.ok(Route.bestThread("hello there", CAT.threads) == nil)
        t.eq(Route.bestThread("rebuilding the intake", CAT.threads)?.thread.id, "bbbb2222", "rebuilding agrees with rebuild")
    }

    t.test("with no @ it goes to the assistant, or to memory when there is none") {
        t.eq(kinds(Route.destinations(nil, "what is left", CAT)), ["assistant:juno"])
        var none = CAT; none.agents = nil
        t.eq(Route.destinations(nil, "x", none).options.first?.kind, .recall)
    }

    t.test("@agent goes to the thread its words match, with its current thread as the other choice") {
        let kit = Route.complete("kit", CAT)[0]
        let threads = CAT.threads.prefix(2).map { th -> VyreThread in var x = th; x.agent = "kit"; return x }
        let d = Route.destinations(kit, "the Harlow deck needs the Q3 report numbers", CAT, agentThreads: threads, now: NOW)
        t.eq(d.options[0].kind, .thread)
        t.eq(d.options[0].thread, "aaaa1111")
        t.eq(d.options[0].meta, "thread · 4 days")
        t.eq(d.options[1].kind, .agent, "the other choice is its current thread")
        t.eq(Route.describe(d.options[1]), DestinationShow(who: "kit", where: ["current thread"]))
        var onCurrent = CAT
        onCurrent.agents = CAT.agents!.map { a in var x = a; if x.name == "kit" { x.thread = "aaaa1111" }; return x }
        t.eq(Route.destinations(kit, "the Q3 report numbers", onCurrent, agentThreads: threads).options.count, 1, "the match is its current thread: one choice")
        t.ok((d.why ?? "").contains("\"report\" matched Q3 report"), d.why ?? "nil")
        t.eq(Route.describe(d.options[0]), DestinationShow(who: "kit", where: ["Harlow Legal", "Q3 report"]))
        t.eq(Route.destinations(kit, "hello", CAT, agentThreads: threads).options[0].kind, .agent, "no match: the agent's current thread")
    }

    t.test("@project starts a new thread there, or joins the thread its words match") {
        let harlow = Route.complete("harlow", CAT)[0]
        let fresh = Route.destinations(harlow, "draft a welcome note", CAT, now: NOW)
        t.eq(fresh.options.map(\.kind), [.newThread, .thread])
        t.eq(fresh.options[0].cwd, "/w/harlow")
        t.eq(fresh.options[1].thread, "bbbb2222", "the other choice is its latest thread")
        t.eq(Route.destinations(harlow, "fix the intake form", CAT, now: NOW).options[0].thread, "bbbb2222")
    }

    t.test("@thread types into that thread") {
        let th = Route.complete("weekly", CAT)[0]
        let d = Route.destinations(th, "anything", CAT, now: NOW)
        t.eq(d.options.map { "\($0.kind.rawValue):\($0.thread ?? "")" }, ["thread:dddd4444"])
    }

    t.test("a general question goes to a fast model first, then the assistant, then deeper") {
        let d = Route.destinations(nil, "What is the capital of Peru?", CAT, quick: true)
        t.eq(kinds(d), ["quick:haiku", "assistant:juno", "quick:sonnet"])
        t.eq(d.options[0].meta, "fast model · haiku")
        t.eq(d.options[2].deep, true)
        t.eq(d.options[2].meta, "deeper · sonnet")
        t.eq(Route.describe(d.options[0]), DestinationShow(who: "Claude", where: [], meta: "fast model · haiku"))
        t.eq(Route.describe(d.options[2]), DestinationShow(who: "Claude · deeper", where: [], meta: "deeper · sonnet"))
        t.eq(d.why, nil)
    }

    t.test("a question about the user's own things goes to the assistant first") {
        for q in ["what did Dana say about the retainer?", "Where is the Harlow Legal deck?", "what is kit doing?",
                  "what's on my calendar tomorrow?", "did I email the Q3 report?", "how many clients do we have?", "what is left this week"] {
            let d = Route.destinations(nil, q, CAT, quick: true)
            t.eq(kinds(d), ["assistant:juno", "quick:haiku", "quick:sonnet"], q)
            t.ok((d.why ?? "").contains("juno answers with your memory"), q)
        }
        t.eq(Route.ownThings("how do I center a div?", CAT), nil, "I without a work noun is a general question")
        t.eq(Route.ownThings("what is weekly inflation in Peru?", CAT), nil, "one word of a thread's name does not name it")
        t.ok((Route.ownThings("any news on Weekly planning?", CAT) ?? "").contains("Weekly planning"))
    }

    t.test("a question with no assistant goes to the model, and with no switchboard to memory") {
        var none = CAT; none.agents = nil
        var empty = CAT; empty.agents = []
        t.eq(kinds(Route.destinations(nil, "what did Dana say?", none, quick: true)), ["quick:haiku", "quick:sonnet"])
        t.eq(kinds(Route.destinations(nil, "why is the sky blue?", empty, quick: true)), ["quick:haiku", "quick:sonnet"])
        t.eq(kinds(Route.destinations(nil, "why is the sky blue?", none)), ["recall:-"], "no switchboard: memory, as before")
        t.eq(kinds(Route.destinations(nil, "why is the sky blue?", CAT)), ["assistant:juno"], "no threads.start: as before")
    }

    t.test("commands keep the assistant, however they read") {
        for c in ["send the invoice to the printer", "draft a welcome note for new clients", "harlow"] {
            t.eq(kinds(Route.destinations(nil, c, CAT, quick: true)), ["assistant:juno"], c)
            t.eq(Route.asksQuestion(c), false, c)
        }
        t.eq(Route.asksQuestion("can you send the invoice?"), true)
    }

    t.test("rank: files are tasted and capped, more when the box reads as a filename, three from the box") {
        let home = "/Users/alex"
        func f(_ label: String, _ dir: String, repo: Bool = false, used: Double = 0) -> RankRow {
            RankRow(kind: "file", id: "file:\(dir)/\(label)", label: label, target: "\(dir)/\(label)", used: used, repo: repo)
        }
        let files = [f("invoice.ts", "\(home)/code/app/src", repo: true)] + (0..<9).map { f("Invoice \($0).pdf", "\(home)/Documents") } + [f("reinvoiced.pdf", "\(home)/Documents")]
        let plain = Route.rank("invoice", files: files, home: home)
        t.eq(plain.count, 4, "about four file rows")
        t.ok(plain.allSatisfy { $0.label.hasPrefix("Invoice ") }, "documents before the repo file and the substring")
        t.eq(Route.rank("invoice pdf", files: files, home: home).count, 8, "a filename-looking query shows up to eight")
        let box = (0..<5).map { RankRow(kind: "boxfile", id: "box:/srv/invoice\($0).pdf", label: "invoice\($0).pdf", sub: "box · /srv", target: "/srv/invoice\($0).pdf", source: "box") }
        t.eq(Route.rank("invoice", files: Array(files.prefix(2)), box: box, home: home).filter { $0.kind == "boxfile" }.count, 3)
        let app = [RankRow(kind: "app", id: "app:/A/Calculator.app", label: "Calculator", target: "/A/Calculator.app", score: 0.9)]
        let calc = Route.rank("calcu", local: app, files: [f("Calculations.xlsx", "\(home)/Documents", used: vyNowMs())], home: home)
        t.eq(calc.first?.label, "Calculator", "an app matched as well beats a file")
    }

    t.test("rank puts catalog candidates in, and intent opens only a strong local match") {
        let r = Route.rank("northwind", cat: CAT, now: NOW)
        t.eq(r.first?.kind, "project")
        t.eq(Route.intent("northwind", r), .open)
        t.eq(Route.intent("what is northwind doing?", r), .ask, "a question is sent, not opened")
        t.eq(Route.intent("anything", []), .ask)
        t.eq(Route.intent("watch the intake thread", topKind: "watch", topScore: 1.8), .open)
        t.ok(Route.questionLike("one two three four five"))
        t.ok(!Route.questionLike("harlow"))
    }
}
