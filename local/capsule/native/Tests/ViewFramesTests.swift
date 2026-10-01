// capsule-suite: viewFramesSuite
// The platform's capsule view contract as plain values: commands, frames and act results. Words only,
// no vyred.

import Foundation

let viewFramesSuite = Suite("view frames") { t in
    t.test("commands: the fields that matter, and anything without a module, id and title is dropped") {
        let data: [String: Any] = ["commands": [
            ["module": "google", "id": "mail", "title": "Search mail", "keywords": ["gmail", "inbox"], "alias": "mail", "icon": "envelope",
             "root": true, "arg": ["name": "q", "placeholder": "from, subject or words"], "firstParty": true, "hash": "h1"],
            ["module": "kit", "id": "todo", "title": "To do"],
            ["module": "x", "title": "No id"], ["id": "y", "title": "No module"],
        ]]
        let c = ViewCommand.parse(data)
        t.eq(c.map(\.key), ["google/mail", "kit/todo"])
        t.eq(c[0].argName, "q"); t.eq(c[0].argPlaceholder, "from, subject or words"); t.eq(c[0].alias, "mail")
        t.ok(c[0].root && c[0].firstParty && c[0].takesArg)
        t.ok(!c[1].root && !c[1].firstParty && !c[1].takesArg)
        t.eq(ViewCommand.parse(nil).count, 0)
    }

    t.test("a list: rows with actions, the from mark only when given, at most 50 rows, strings cut") {
        let long = String(repeating: "x", count: 900)
        var rows: [[String: Any]] = (0..<60).map { ["id": "r\($0)", "title": "Row \($0)"] }
        rows[0] = ["id": "r0", "title": long, "subtitle": "alex", "icon": "envelope", "accessory": "Tue",
                   "actions": [["id": "open", "title": "Open in Gmail"], ["id": "draft", "title": "Draft a reply", "shortcut": "cmd+r", "confirm": true],
                               ["id": "send", "title": "Send", "outward": true, "confirm": "Send it?"], ["id": "bad", "title": "Bad chord", "shortcut": "option+r"]]]
        let f = ViewFrame.parse(["v": 1, "kind": "list", "title": "Mail", "rows": rows, "more": true, "from": "acme-crm"])
        guard case .list(let l) = f else { t.ok(false, "not a list"); return }
        t.eq(l.rows.count, 50); t.eq(l.more, true); t.eq(l.from, "acme-crm")
        t.eq(l.rows[0].title.count, 500)
        t.eq(l.rows[0].actions.map(\.id), ["open", "draft", "send", "bad"])
        t.eq(l.rows[0].actions[1].shortcut, KeyShortcut("r", command: true)); t.eq(l.rows[0].actions[1].confirm, "Draft a reply?")
        t.eq(l.rows[0].actions[2].outward, true); t.eq(l.rows[0].actions[2].confirm, "Send it?")
        t.ok(l.rows[0].actions[3].shortcut == nil, "Option chords belong to extensions")
        guard case .list(let plain) = ViewFrame.parse(["v": 1, "kind": "list", "rows": [] as [Any], "empty": "No mail matches that."]) else { return }
        t.eq(plain.from, nil); t.eq(plain.empty, "No mail matches that.")
    }

    t.test("a detail and a form") {
        let d = ViewFrame.parse(["v": 1, "kind": "detail", "title": "Menu", "body": "Line one\nLine two",
                                 "fields": [["label": "From", "value": "alex"], ["label": "", "value": "dropped"]], "actions": [["id": "open", "title": "Open"]]])
        guard case .detail(let det) = d else { t.ok(false, "not a detail"); return }
        t.eq(det.body, "Line one\nLine two"); t.eq(det.fields.count, 1); t.eq(det.actions.map(\.id), ["open"])
        let f = ViewFrame.parse(["v": 1, "kind": "form", "id": "reply", "title": "Reply", "submit": ["title": "Save as draft", "outward": false],
                                 "fields": [["name": "body", "label": "Your reply", "type": "multiline", "required": true],
                                            ["name": "size", "type": "choice", "choices": ["S", "M"], "default": "M"],
                                            ["name": "cc", "type": "bool", "default": true], ["name": "n", "type": "wat"]]])
        guard case .form(let form) = f else { t.ok(false, "not a form"); return }
        t.eq(form.id, "reply"); t.eq(form.submitTitle, "Save as draft")
        t.eq(form.fields.map(\.kind), [.multiline, .choice, .bool, .text], "an unknown type is text")
        t.eq(form.fields[1].value, "M"); t.eq(form.fields[2].value, "true"); t.eq(form.fields[0].required, true)
        t.eq(form.fields[1].label, "size", "the name stands in for a missing label")
        if case .error = ViewFrame.parse(["v": 1, "kind": "form", "fields": [] as [Any]]) {} else { t.ok(false, "an empty form is refused") }
    }

    t.test("errors, needs, held, and a frame this Lumen cannot draw are words") {
        t.eq(ViewFrame.parse(["v": 1, "kind": "error", "code": "not_found", "message": "No such thread."]), .error(code: "not_found", message: "No such thread."))
        t.eq(ViewFrame.parse(["v": 1, "kind": "needs", "message": "Connect Google first."]), .needs(code: "needs", message: "Connect Google first.", need: nil))
        t.eq(ViewFrame.parse(["v": 1, "kind": "needs", "message": "Add your key.", "need": ["kind": "credential", "item": "ghl-api", "vendor": "GoHighLevel"]]),
             .needs(code: "needs", message: "Add your key.", need: ViewNeed(module: nil, need: "ghl-api", label: "GoHighLevel")))
        t.eq(ViewFrame.parse(["v": 1, "kind": "needs", "message": "x", "need": "deepgram-key"]), .needs(code: "needs", message: "x", need: ViewNeed(module: nil, need: "deepgram-key", label: nil)))
        t.eq(ViewFrame.parse(["v": 1, "kind": "needs", "message": "x", "need": ["kind": "connection", "url": "https://example.com"]]), .needs(code: "needs", message: "x", need: nil), "only a credential is added here")
        t.eq(ViewFrame.parse(["v": 1, "kind": "held", "message": "Waiting for your OK."]), .held(message: "Waiting for your OK."))
        if case .error(let code, _) = ViewFrame.parse(["v": 2, "kind": "list"]) { t.eq(code, "old_capsule") } else { t.ok(false, "v2") }
        if case .error(let code, _) = ViewFrame.parse(["v": 1, "kind": "carousel"]) { t.eq(code, "bad_frame") } else { t.ok(false, "carousel") }
        if case .error(let code, _) = ViewFrame.parse("nope") { t.eq(code, "bad_frame") } else { t.ok(false, "string") }
    }

    t.test("act results: done with each effect, push, a form, a preview, held, needs, error") {
        t.eq(ViewActResult.parse(["v": 1, "kind": "done", "said": "Saved."]), .done(said: "Saved.", effect: nil))
        t.eq(ViewActResult.parse(["v": 1, "kind": "done", "effect": ["open": "https://example.com"]]), .done(said: nil, effect: .open("https://example.com")))
        t.eq(ViewActResult.parse(["v": 1, "kind": "done", "effect": ["copy": "abc"]]), .done(said: nil, effect: .copy("abc")))
        t.eq(ViewActResult.parse(["v": 1, "kind": "done", "effect": ["ask": "reply to alex about "]]), .done(said: nil, effect: .ask("reply to alex about ")), "the trailing space is kept")
        t.eq(ViewActResult.parse(["v": 1, "kind": "push", "command": "next"]), .push(command: "next"))
        let form: [String: Any] = ["v": 1, "kind": "form", "id": "f", "fields": [["name": "a"]]]
        if case .view(.form(let f)) = ViewActResult.parse(["v": 1, "kind": "view", "frame": form]) { t.eq(f.id, "f") } else { t.ok(false, "view form") }
        if case .error = ViewActResult.parse(["v": 1, "kind": "view", "frame": ["v": 1, "kind": "list", "rows": [] as [Any]]]) {} else { t.ok(false, "only a form may open from an action") }
        let p = ViewActResult.parse(["v": 1, "kind": "preview", "title": "Send this email", "hash": "abc123", "token": "tok-abc",
                                     "words": [["label": "To", "value": "dana@harlowlegal.example"], ["label": "Body", "value": "Hello\nthere"]]])
        if case .preview(let pv) = p { t.eq(pv.hash, "abc123"); t.eq(pv.token, "tok-abc"); t.eq(pv.words.count, 2); t.eq(pv.words[1].value, "Hello\nthere") } else { t.ok(false, "preview") }
        if case .error = ViewActResult.parse(["v": 1, "kind": "preview", "title": "x", "words": [] as [Any]]) {} else { t.ok(false, "a preview with no hash or words is refused") }
        t.eq(ViewActResult.parse(["v": 1, "kind": "held", "message": "Waiting for your OK."]), .held(message: "Waiting for your OK."))
        t.eq(ViewActResult.parse(["v": 1, "kind": "needs", "code": "no_connection", "message": "Connect Gmail."]), .needs(code: "no_connection", message: "Connect Gmail.", need: nil))
        t.eq(ViewActResult.parse(["v": 1, "kind": "error", "code": "missing", "message": "Gone."]), .error(code: "missing", message: "Gone."))
        if case .error(let c, _) = ViewActResult.parse(["v": 3, "kind": "done"]) { t.eq(c, "old_capsule") } else { t.ok(false, "v3") }
    }

    t.test("links: an added module's link opens only as https, mailto or vyre") {
        t.eq(MainActor.assumeIsolated { ViewSession.safeLink("https://example.com/a") }?.host, "example.com")
        t.ok(MainActor.assumeIsolated { ViewSession.safeLink("mailto:dana@harlowlegal.example") } != nil)
        t.ok(MainActor.assumeIsolated { ViewSession.safeLink("vyre://thread/t1") } != nil)
        t.ok(MainActor.assumeIsolated { ViewSession.safeLink("vyre://thread/t1", added: true) } == nil, "an added module gets https and mailto only")
        t.ok(MainActor.assumeIsolated { ViewSession.safeLink("https://example.com", added: true) } != nil)
        for bad in ["http://example.com", "file:///etc/passwd", "javascript:alert(1)", "x-apple.systempreferences:", "https://", "not a link", ""] {
            t.ok(MainActor.assumeIsolated { ViewSession.safeLink(bad) } == nil, bad)
        }
    }

    t.test("icons: a symbol name or app:<bundle>, nothing else") {
        t.eq(ViewIcon.spec("envelope"), .symbol("envelope")); t.eq(ViewIcon.spec("rectangle.lefthalf.inset.filled"), .symbol("rectangle.lefthalf.inset.filled"))
        t.eq(ViewIcon.spec("app:com.apple.Notes"), .bundle("com.apple.Notes"))
        for bad in ["http://x/y.png", "../../etc/passwd", "Envelope Icon", "app:", "app:a b", "<svg>"] { t.ok(ViewIcon.spec(bad) == nil, bad) }
    }
}
